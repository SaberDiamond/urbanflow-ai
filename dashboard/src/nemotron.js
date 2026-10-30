// UrbanFlow AI — Nemotron controller (browser side).
//
// Talks only to the local server (server.py), which holds the API key and relays calls to
// Nebius Token Factory. Every few sim-seconds it sends the intersections whose green could end
// and applies the switches Nemotron asks for; the simulation re-checks each one against the live
// state, adds the yellow and all-red, and keeps emergency preemption in code. If calls fail, the
// local rules take over until Nemotron answers again.

const SIGNAL_PROMPT = `You control the traffic signals for UrbanFlow, a city grid of signalised intersections.
Each intersection gives green to one road at a time. When you switch one, the system adds the yellow and all-red clearance, and a separate emergency system handles ambulances.
You receive only intersections whose green could reasonably end now. For each: id, name, green_road (the road that has green), green_for_s (seconds of green so far), waiting_on_green, red_road (the road that is waiting), waiting_on_red, approaching_red.
Switch an intersection when its red road clearly has more demand (waiting_on_red + approaching_red) than waiting_on_green, or when waiting_on_green is 0 while cars wait on red. Never switch when waiting_on_green is equal or larger. Leave every other intersection alone. Pick at most 6.
Reply with one JSON object only, no prose, no code fences:
{"switch":[{"id":"<id copied exactly>","why":"<one short sentence naming both roads and their counts>"}]}
Example: {"switch":[{"id":"3,1","why":"6 cars wait on Oak St while 3rd Ave green is empty"}]}
Use {"switch":[]} when nothing should change.`;

const DISPATCH_PROMPT = `You are the emergency routing planner for UrbanFlow. An ambulance must reach the hospital as fast and as safely as possible.
Signals along the chosen route are switched to green ahead of the ambulance, but queued cars still slow it down and every intersection is a crossing risk.
Compare the candidate routes (labelled A, B, C) using length_m, intersections, turns (each turn means slowing down), queued_cars, red_now and est_s, and pick one.
Reply with one JSON object only, no prose, no code fences:
{"route":"<letter>","why":"<one sentence, at most 18 words, comparing the routes by their letters>"}`;

const CADENCE = 4;          // sim-seconds between signal calls
const TIMEOUT_MS = 9000;    // give up on a call after this long; rules cover the gap
const MAX_SWITCHES = 8;     // per call, as a sanity limit
const LETTERS = 'ABC';
const SHOWN_PER_CALL = 3;   // decisions shown in full in the feed per call
const SLOW_MS = 4500;       // two replies slower than this in a row: rules take over until it speeds up

export function modelLabel(id = '') {
  const s = id.toLowerCase();
  if (s.startsWith('mock:')) return `Mock ${modelLabel(id.slice(5))}`;
  if (s.includes('ultra')) return 'Nemotron 3 Ultra';
  if (s.includes('super')) return 'Nemotron 3 Super';
  if (s.includes('omni')) return 'Nemotron 3 Nano Omni';
  if (s.includes('nano')) return 'Nemotron 3 Nano';
  return id || 'model';
}

function parseJSON(text) {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// Small models sometimes add prose or get cut off mid-list. Recover the complete entries instead of
// discarding the whole reply.
function parseSwitches(text) {
  const out = parseJSON(text);
  if (out && Array.isArray(out.switch)) return out.switch;
  if (!text || !/"?switch"?\s*:/.test(text)) return null;
  const found = [];
  const re = /\{\s*"id"\s*:\s*"?([^",}]+(?:,[^",}]+)?)"?\s*(?:,\s*"why"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  let m;
  while ((m = re.exec(text))) found.push({ id: m[1].trim(), why: m[2] ?? '' });
  return found.length || /"switch"\s*:\s*\[\s*\]/.test(text) ? found : null;
}

function parseRoute(text, n) {
  const out = parseJSON(text);
  let r = out?.route, why = out?.why ?? '';
  if (r == null && text) {
    const m = text.match(/"route"\s*:\s*"?([A-Ca-c0-2])"?/);
    if (m) r = m[1];
    const w = text.match(/"why"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (w) why = w[1];
  }
  if (typeof r === 'string' && /^[A-Ca-c]$/.test(r.trim())) r = LETTERS.indexOf(r.trim().toUpperCase());
  r = Number(r);
  return Number.isInteger(r) && r >= 0 && r < n ? { idx: r, why } : null;
}

async function api(path, body, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export class NemotronClient {
  constructor(sim) {
    this.sim = sim;
    this.status = { server: false };
    this.inflight = false;
    this.lastCall = -1e9;
    this.failStreak = 0;
    this.stats = { calls: 0, ok: 0, switches: 0, rejected: 0, latencies: [], routes: 0, lastError: null, lastBadReply: null };
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const fn of this.listeners) fn(); }

  get available() { return !!(this.status.server && this.status.hasKey); }

  avgLatency() {
    const l = this.stats.latencies;
    return l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null;
  }

  async refresh() {
    try {
      this.status = await api('/api/status', null, 2500);
    } catch {
      this.status = { server: false };
    }
    this._emit();
    return this.status;
  }

  async saveConfig(cfg) {
    this.status = await api('/api/config', cfg, 5000);
    this.failStreak = 0;
    this._emit();
    return this.status;
  }

  async test(model) { return api('/api/test', { model }, 20000); }
  async models() { return api('/api/models', null, 15000); }

  // called every frame
  tick() {
    const sim = this.sim;
    if (sim.controller !== 'nemotron' || !sim.aiEnabled) return;
    if (!this.available) { sim.setFallback(true, this.status.server ? 'no API key' : 'local server not running'); return; }
    if (this.inflight || sim.t - this.lastCall < CADENCE) return;
    this.lastCall = sim.t;
    this._signalCall();
  }

  _record(ok, ms, err) {
    this.stats.calls++;
    if (ok) {
      this.stats.ok++;
      this.failStreak = 0;
      this.stats.lastError = null;
      if (ms != null) { this.stats.latencies.push(ms); if (this.stats.latencies.length > 30) this.stats.latencies.shift(); }
      // fail-safe: a model that answers too slowly cannot keep up with the signals
      this.slowStreak = ms != null && ms > SLOW_MS ? (this.slowStreak ?? 0) + 1 : 0;
      if (this.slowStreak >= 2) this.sim.setFallback(true, `replies taking ${(ms / 1000).toFixed(1)} s`);
      else if (!this.slowStreak) this.sim.setFallback(false);
    } else {
      this.failStreak++;
      this.stats.lastError = err;
      if (this.failStreak >= 2) this.sim.setFallback(true, err);
    }
    this._emit();
  }

  // A fresh start for a scripted run: forget timers and streaks, and make sure a reply to a request from before
  // the reset is thrown away instead of being applied to the new run
  resetRun() {
    this.callToken = (this.callToken ?? 0) + 1;
    this.inflight = false;
    this.lastCall = -1e9;
    this.failStreak = 0;
    this.slowStreak = 0;
  }

  async _signalCall() {
    const snap = this.sim.signalSnapshot();
    if (!snap.intersections.length) return;
    this.inflight = true;
    const token = this.callToken ?? 0, epoch = this.sim.epoch;
    const stale = () => token !== (this.callToken ?? 0) || epoch !== this.sim.epoch;
    try {
      const res = await api('/api/chat', {
        model: this.status.signalModel,
        messages: [{ role: 'system', content: SIGNAL_PROMPT }, { role: 'user', content: JSON.stringify(snap) }],
        max_tokens: 900, temperature: 0.1, json: true,
      });
      if (stale()) { this.stats.stale = (this.stats.stale ?? 0) + 1; return; }   // asked about a city that has since been reset
      const list = parseSwitches(res.content);
      if (!list) {
        this.stats.lastBadReply = String(res.content ?? '').slice(0, 400);
        throw new Error('reply was not the expected JSON');
      }
      // show the first few decisions in full; summarise the rest so the feed stays readable
      let applied = 0;
      const quiet = [], held = [];
      for (const s of list.slice(0, MAX_SWITCHES)) {
        if (!s || s.id == null) continue;
        const name = this.sim.applySwitch(s.id, s.why, { silent: applied >= SHOWN_PER_CALL });
        if (name && name.rejected) { held.push(name.rejected); continue; }
        if (!name) continue;
        if (applied >= SHOWN_PER_CALL) quiet.push(name);
        applied++;
      }
      if (quiet.length) this.sim.log('NEMOTRON', `Also switched ${quiet.length} more: ${quiet.join(', ')}.`);
      if (held.length) this.sim.log('GUARDRAIL', `Kept the green at ${held.join(', ')}: Nemotron asked to switch, but the green road there is still as busy as the red one.`);
      this.stats.switches += applied;
      this.stats.rejected += held.length;
      this.lastModel = res.model;
      this._record(true, res.latencyMs);
    } catch (e) {
      if (!stale()) this._record(false, null, e.name === 'AbortError' ? 'timed out' : e.message);
    } finally {
      if (token === (this.callToken ?? 0)) this.inflight = false;
    }
  }

  // Let the dispatch model pick between the candidate routes for a new ambulance
  async planDispatch(v) {
    const sim = this.sim;
    if (sim.controller !== 'nemotron' || !sim.aiEnabled || !this.available || !v.candidates || v.candidates.length < 2) { v.holdUntil = 0; return; }
    const epoch = sim.epoch;
    sim.log('DISPATCH', `${v.name}: asking ${modelLabel(this.status.signalModel === this.status.dispatchModel ? this.status.signalModel : this.status.dispatchModel)} to choose between ${v.candidates.length} routes.`);
    const payload = {
      ambulance: v.name, hospital: v.hospital.name,
      routes: v.candidates.map((c) => ({ route: LETTERS[c.index], via: c.summary, length_m: c.length_m, intersections: c.intersections, turns: c.turns, queued_cars: c.queued_cars, red_now: c.red_now, est_s: c.est_s })),
    };
    try {
      const res = await api('/api/chat', {
        model: this.status.dispatchModel,
        messages: [{ role: 'system', content: DISPATCH_PROMPT }, { role: 'user', content: JSON.stringify(payload) }],
        max_tokens: 300, temperature: 0.1, json: true,
      }, 15000);
      if (epoch !== sim.epoch) return;   // the city was reset while it was deciding
      const pick = parseRoute(res.content, v.candidates.length);
      if (!pick) { this.stats.lastBadReply = String(res.content ?? '').slice(0, 400); throw new Error('route reply was not a valid choice'); }
      if (sim.chooseRoute(v, pick.idx, `${pick.why} (${modelLabel(res.model)}, ${res.latencyMs} ms)`)) this.stats.routes++;
      this._record(true, res.latencyMs);
    } catch (e) {
      v.holdUntil = 0;
      sim.log('FALLBACK', `${v.name}: route planner unavailable (${e.name === 'AbortError' ? 'timed out' : e.message}). Keeping the shortest route.`);
      this._record(false, null, e.message);
    }
  }
}
