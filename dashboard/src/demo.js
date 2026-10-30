// UrbanFlow AI — official demo: "Cross-Town Emergency: Conventional Traffic vs. UrbanFlow AI".
//
// Both runs start from the same city: same seed, same rush-hour traffic built up for the same time on ordinary
// fixed-time signals, and the same ambulance dispatched at the same sim time on the same fixed route. Then:
//   conventional: fixed-time signals, no adaptive timing, no emergency pre-emption (drivers still make way)
//   urbanflow:    Nemotron 3 Nano times the ordinary signals (live, through the local server) and the
//                 deterministic Predictive Green Corridor handles emergency priority
// Every number in the results comes from the run itself. Cameras are left to the person recording.

import { fmtTime } from './sim.js';
import { modelLabel } from './nemotron.js';

export const SCENARIO = {
  name: 'Cross-Town Emergency',
  title: 'Conventional Traffic vs. UrbanFlow AI',
  seed: 4242,
  cars: 300,                 // rush hour (the everyday city has 190)
  warmup: 75,                // sim-seconds of traffic on fixed-time signals before the run starts
  dispatchAt: 6,             // sim-seconds into the run
  start: '7,0>6,0',          // Maple St, between 8th and 7th Ave
  hospital: 'riverside',
  destination: 'Riverside Medical Center',
  // fixed for the comparison so both runs cross the same intersections (the shortest route in the warmed-up city)
  route: ['7,0>6,0', '6,0>5,0', '5,0>4,0', '4,0>3,0', '3,0>2,0', '2,0>1,0', '1,0>1,1', '1,1>1,2', '1,2>1,3', '1,3>1,4', '1,4>1,5'],
  routeLabel: 'Maple St → 2nd Ave',
  signals: 10,
  after: 5,                  // keep measuring this long after the ambulance arrives
  maxTime: 240,              // safety stop
};

export const RUNS = {
  conventional: { label: 'Conventional traffic', detail: 'Fixed-time signals (18 s), no emergency pre-emption' },
  urbanflow: { label: 'UrbanFlow AI (live Nemotron)', detail: 'Nemotron 3 Nano times the signals · Predictive Green Corridor handles emergency priority' },
};

const STORE = 'urbanflow.demo.v2';
const DT = 1 / 30;

function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}

// footprint overlap test (same as tools/collision-check.mjs)
function box(sim, v) {
  const p = sim.worldPos(v);
  const hl = v.len / 2 - 0.2, hw = (v.type !== 'car' ? 2.3 : 1.95) / 2 - 0.08;
  const c = Math.cos(p.heading), s = -Math.sin(p.heading);
  return { x: p.x, z: p.z, ax: [c, s], ay: [-s, c], hl, hw, v };
}
function overlap(a, b) {
  for (const axis of [a.ax, a.ay, b.ax, b.ay]) {
    const proj = (o) => Math.abs(o.ax[0] * axis[0] + o.ax[1] * axis[1]) * o.hl + Math.abs(o.ay[0] * axis[0] + o.ay[1] * axis[1]) * o.hw;
    if (Math.abs((b.x - a.x) * axis[0] + (b.z - a.z) * axis[1]) > proj(a) + proj(b)) return false;
  }
  return true;
}

export class DemoDirector {
  constructor(sim, nemo) {
    this.sim = sim;
    this.nemo = nemo;
    this.state = 'idle';       // idle | checking | preparing | running
    this.progress = 0;
    this.run = null;
    this.error = null;
    this.results = load();
    this.listeners = new Set();
    this.hooks = {};           // set by the UI: onDispatch(v), onFinish(result)
    this.saved = null;         // the dashboard's own settings, restored on exit
  }

  onChange(fn) { this.listeners.add(fn); }
  _emit() { for (const fn of this.listeners) fn(); }

  // What Run 2 would use right now: live Nemotron, an offline stand-in (server --mock), or nothing
  modelStatus() {
    const st = this.nemo.status;
    if (!st.server) return { ok: false, live: false, text: 'Local server not running (start dashboard/server.py).' };
    if (st.mock) return { ok: true, live: false, text: 'Offline stand-in model (server --mock). Results will be labelled as NOT live Nemotron.' };
    if (!st.hasKey) return { ok: false, live: false, text: 'No Nebius API key yet: add it with the gear button.' };
    return { ok: true, live: true, text: `Live: ${modelLabel(st.signalModel)} via Nebius Token Factory.` };
  }

  async start(runId) {
    if (this.state !== 'idle' && this.state !== 'done') return;
    const sim = this.sim, nemo = this.nemo;
    this.error = null;
    if (!this.saved) this.saved = { ai: sim.aiEnabled, controller: sim.controller };
    let live = false, model = null;
    if (runId === 'urbanflow') {
      // check the model answers before starting, so a broken connection is reported instead of quietly running rules
      this.state = 'checking';
      this._emit();
      await nemo.refresh();
      const ms = this.modelStatus();
      if (!ms.ok) return this._fail(ms.text);
      let reply;
      try {
        reply = await nemo.test(nemo.status.signalModel);
        if (!reply || reply.error) throw new Error(reply?.error || 'no reply');
      } catch (e) {
        return this._fail(`Nemotron did not answer (${e.message}). The run was not started.`);
      }
      // live only if the server says so and the reply really came from the model, not the stand-in
      live = ms.live && !String(reply.model ?? '').startsWith('mock:');
      model = (live ? '' : 'stand-in for ') + modelLabel(String(nemo.status.signalModel).replace(/^mock:/, ''));
    }
    this.state = 'preparing';
    this.progress = 0;
    this._emit();
    // the same city every time: reset, then build rush hour on ordinary fixed-time signals
    sim.paused = true;
    nemo.resetRun();
    sim.setAI(false);
    sim.reset(SCENARIO.seed, { cars: SCENARIO.cars });
    const total = Math.round(SCENARIO.warmup / DT);
    for (let i = 0; i < total; i += 300) {
      for (let k = i; k < Math.min(total, i + 300); k++) sim.step(DT);
      this.progress = Math.min(1, (i + 300) / total);
      this._emit();
      await new Promise((r) => setTimeout(r, 0));
      if (this.state !== 'preparing') { sim.paused = false; return; }   // stopped meanwhile
    }
    // the control strategies diverge from here
    if (runId === 'urbanflow') { sim.setController('nemotron'); sim.setAI(true); }
    nemo.resetRun();
    const r = this.run = {
      id: runId, t0: sim.t, live, model, amb: null, arrivedAt: null,
      stoppedS: 0, slowS: 0, conflicts: 0, overlaps: 0, overlapPairs: new Set(), fallbackS: 0, fallbackEvents: 0, lastFallback: sim.fallback,
      nemo0: { ...nemo.stats, latencies: [...nemo.stats.latencies] }, lat: [], priority0: sim.priorityS, idle0: sim.idleSwitches, trips0: sim.trips.length, amb0: sim.ambTrips.length, every: 0,
    };
    const dispatch = () => {
      const v = sim.dispatch({ start: SCENARIO.start, hospital: SCENARIO.hospital, route: SCENARIO.route });
      if (!v) { sim.at(sim.t + 0.1, dispatch); return; }   // the start road is momentarily blocked
      r.amb = v;
      this.hooks.onDispatch?.(v);
    };
    sim.at(r.t0 + SCENARIO.dispatchAt, dispatch);
    this.observer = (s, dt) => this._measure(s, dt);
    sim.observers.add(this.observer);
    this._lat0 = nemo.stats.latencies.length;
    sim.log('SYSTEM', `Demo "${SCENARIO.name}": ${RUNS[runId].label}${runId === 'urbanflow' && !live ? ' (OFFLINE STAND-IN MODEL, not live Nemotron)' : ''}. Same rush-hour traffic and the same emergency every run.`);
    this.state = 'running';
    sim.paused = false;
    this._emit();
  }

  _fail(msg) {
    this.error = msg;
    this.state = 'idle';
    this.sim.paused = false;
    this._emit();
  }

  // read-only measurements after every sim step
  _measure(sim, dt) {
    const r = this.run;
    if (!r) return;
    // signal safety: never green on both axes at once
    for (const sig of sim.signals.values()) {
      const n = sig.node;
      let ew = false, ns = false;
      for (const d of ['E', 'W', 'N', 'S']) if (n.in[d] && sim.approachState(n, d) === 'G') { if (d === 'E' || d === 'W') ew = true; else ns = true; }
      if (ew && ns) r.conflicts++;
    }
    // vehicle overlaps, twice a second
    if ((r.every = (r.every + 1) % 15) === 0) {
      const grid = new Map(), boxes = [];
      for (const v of sim.vehicles.values()) {
        const b = box(sim, v);
        boxes.push(b);
        const key = `${Math.floor(b.x / 10)},${Math.floor(b.z / 10)}`;
        (grid.get(key) ?? grid.set(key, []).get(key)).push(b);
      }
      for (const b of boxes) {
        const gx = Math.floor(b.x / 10), gz = Math.floor(b.z / 10);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const o of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (o.v.id <= b.v.id || !overlap(b, o)) continue;
          const k = `${b.v.id}-${o.v.id}`;
          if (!r.overlapPairs.has(k)) { r.overlapPairs.add(k); r.overlaps++; }
        }
      }
    }
    // fallback to local rules during the Nemotron run
    if (r.id === 'urbanflow') {
      if (sim.fallback) r.fallbackS += dt;
      if (sim.fallback && !r.lastFallback) r.fallbackEvents++;
      r.lastFallback = sim.fallback;
    }
    const v = r.amb;
    if (v && r.arrivedAt == null) {
      if (v.type === 'ambulance') {
        if (v.speed < 0.6) r.stoppedS += dt;
        if (v.speed < 4) r.slowS += dt;
      } else {
        r.arrivedAt = sim.t;
        r.passed = v.passed;
      }
    }
    const el = sim.t - r.t0;
    if (!r.finishing && ((r.arrivedAt != null && sim.t >= r.arrivedAt + SCENARIO.after) || el > SCENARIO.maxTime)) {
      r.finishing = true;
      queueMicrotask(() => this._finish());
    }
  }

  elapsed() { return this.run ? this.sim.t - this.run.t0 : 0; }

  status() {
    if (this.state === 'checking') return 'Checking the Nemotron connection…';
    if (this.state === 'preparing') return `Building rush-hour traffic · ${Math.round(this.progress * 100)}%`;
    if (this.state !== 'running' || !this.run) return '';
    const r = this.run, el = this.elapsed();
    const what = !r.amb ? `A-1 dispatched in ${Math.max(0, Math.ceil(SCENARIO.dispatchAt - el))} s`
      : r.arrivedAt == null ? `${r.amb.name} en route · ${r.amb.passed}/${SCENARIO.signals} signals` : `${r.amb.name} arrived`;
    return `${r.id === 'urbanflow' ? (r.live ? 'UrbanFlow AI' : 'UrbanFlow AI (stand-in model)') : 'Conventional'} · ${fmtTime(el)} · ${what}`;
  }

  _finish() {
    const sim = this.sim, r = this.run;
    if (!r || this.state !== 'running') return;
    sim.observers.delete(this.observer);
    const end = r.arrivedAt ?? sim.t;
    const span = end - r.t0;
    const trips = sim.trips.slice(r.trips0).filter((x) => x.t > r.t0 && x.t <= end);
    // this run's own arrival record (names like A-1 repeat from run to run)
    const trip = r.amb ? sim.ambTrips.slice(r.amb0).find((a) => a.name === r.amb.name) : null;
    const s0 = r.nemo0, s1 = this.nemo.stats;
    const lat = s1.latencies.slice(this._lat0);
    const result = {
      run: r.id, label: RUNS[r.id].label, live: r.live, model: r.model, at: Date.now(),
      seed: SCENARIO.seed, cars: SCENARIO.cars, route: SCENARIO.routeLabel, routeFixed: true,
      arrived: !!trip, trip: trip ? trip.duration : null,
      stoppedS: r.stoppedS, slowS: r.slowS, intersections: r.passed ?? r.amb?.passed ?? 0,
      throughput: span > 0 ? trips.length * 60 / span : null, carTrips: trips.length,
      avgWait: trips.length ? trips.reduce((a, x) => a + x.wait, 0) / trips.length : null,
      priorityS: sim.priorityS - r.priority0,
      conflicts: r.conflicts, overlaps: r.overlaps,
      nemotron: r.id === 'urbanflow' ? {
        calls: s1.calls - s0.calls, ok: s1.ok - s0.ok, failed: (s1.calls - s0.calls) - (s1.ok - s0.ok),
        switches: s1.switches - s0.switches, refused: s1.rejected - s0.rejected,
        avgLatency: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        fallbackS: r.fallbackS, fallbackEvents: r.fallbackEvents, lastError: s1.lastError,
        idleGreen: sim.idleSwitches - r.idle0,
      } : null,
    };
    this.results[r.id] = result;
    try { localStorage.setItem(STORE, JSON.stringify(this.results)); } catch { /* not kept */ }
    sim.log('SYSTEM', `Demo run finished (${result.label}${r.id === 'urbanflow' && !r.live ? ', stand-in model' : ''}): A-1 ${result.trip == null ? 'did not arrive' : `took ${fmtTime(result.trip)}`}.`);
    this.run = null;
    this.state = 'done';
    this._emit();
    this.hooks.onFinish?.(result);
  }

  // stop the current run; the city keeps going as it is
  stop() {
    if (this.state === 'idle' || this.state === 'done') return;
    if (this.observer) this.sim.observers.delete(this.observer);
    this.sim.timers = [];
    this.run = null;
    this.state = 'idle';
    this.sim.paused = false;
    this.sim.log('SYSTEM', 'Demo run stopped.');
    this._emit();
  }

  // leave demo mode: back to the everyday city with the dashboard's own settings
  exit() {
    this.stop();
    const sim = this.sim;
    this.nemo.resetRun();
    sim.setAI(false);
    sim.reset(20261030);
    if (this.saved) { sim.setController(this.saved.controller); sim.setAI(this.saved.ai); }
    this.saved = null;
    this.state = 'idle';
    sim.log('SYSTEM', 'Demo closed. Back to the everyday city.');
    this._emit();
  }

  clearResults() {
    this.results = {};
    try { localStorage.removeItem(STORE); } catch { /* ignore */ }
    this._emit();
  }
}
