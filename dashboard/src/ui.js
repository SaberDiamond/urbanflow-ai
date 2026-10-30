// UrbanFlow AI — dashboard HUD, floating info cards and side rail.

import * as THREE from 'three';
import * as C from './config.js';
import { fmtTime } from './sim.js';
import { modelLabel } from './nemotron.js';
import { SCENARIO, RUNS } from './demo.js';

const PREF_KEY = 'urbanflow.controller';
function readPref() { try { return localStorage.getItem(PREF_KEY); } catch { return null; } }
function writePref(v) { try { localStorage.setItem(PREF_KEY, v); } catch { /* storage unavailable: fine */ } }

const $ = (id) => document.getElementById(id);
const STATE_WORD = { G: 'GREEN', Y: 'YELLOW', R: 'RED' };
// who acted, as shown in the decision feed
const FEED_LABEL = { CORRIDOR: 'CORRIDOR', FLOW: 'LOCAL RULES', GUARDRAIL: 'SAFETY CHECK', IDLE: 'IDLE GREEN' };
const FEED_TIP = {
  NEMOTRON: 'Nemotron 3 Nano signal recommendation (live model), applied after the safety check',
  CORRIDOR: 'Predictive Green Corridor: deterministic emergency-priority code, not the model',
  GUARDRAIL: 'Safety controller refused a model recommendation',
  IDLE: 'Idle-green safeguard (deterministic code, not Nemotron): ends a green nobody has used for 3 s while cars wait on red',
  FALLBACK: 'Nemotron unavailable or too slow: local rules are timing the signals',
  FLOW: 'Local rules (no model) timing the signals',
  YIELD: 'Driver behaviour: cars making way for the ambulance',
};
const QUEUE_CARD = 5;

const MODE_NAME = { Nemotron: 'Nemotron', Rules: 'local rules', Fixed: 'fixed timers', Mixed: 'controller changed mid-trip' };

export class UI {
  constructor(sim, rig, view, handlers, nemo) {
    this.sim = sim;
    this.rig = rig;
    this.view = view;
    this.h = handlers;
    this.nemo = nemo;
    this.lastSeq = 0;
    this.overlay = $('overlay');
    this.octx = this.overlay.getContext('2d');
    this.tagLayer = $('tags');
    this.tags = new Map();
    this.hoverNode = null;
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._wire();
  }

  _wire() {
    document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => this.setCam(b.dataset.cam)));
    document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('[data-speed]').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      this.h.setSpeed(Number(b.dataset.speed));
    }));
    $('aiToggle').addEventListener('click', () => {
      this.sim.setAI($('aiToggle').getAttribute('aria-checked') !== 'true');
      this.renderAI();
      this.update();
    });
    $('dispatchBtn').addEventListener('click', () => {
      const v = this.sim.dispatch();
      if (v) {
        this.rig.focusAmbulance(v);
        this.nemo.planDispatch(v);
      }
      this.update();
    });
    this._wireConfig();
    $('camPrev').addEventListener('click', () => { this.rig.stepIntersection(-1); this.renderCamNav(); });
    $('camNext').addEventListener('click', () => { this.rig.stepIntersection(1); this.renderCamNav(); });
    $('camAuto').addEventListener('click', () => { this.rig.setAutoFollow(!this.rig.autoFollow); this.renderCamNav(); });
    // intersections still ahead of the ambulance: pick one to see the queue waiting there before it arrives
    $('routeBtn').addEventListener('click', () => this._routeMenuOpen($('routeMenu').hidden));
    document.addEventListener('pointerdown', (e) => {
      if (!$('routeMenu').hidden && !e.target.closest('#routeMenu, #routeBtn')) this._routeMenuOpen(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('routeMenu').hidden) { this._routeMenuOpen(false); $('routeBtn').focus(); } });
    $('isoLeft').addEventListener('click', () => this.rig.rotate(-1));
    $('isoRight').addEventListener('click', () => this.rig.rotate(1));
    $('isoHome').addEventListener('click', () => this.rig.recenter());
    this._wireCallouts();
    $('camRotL').addEventListener('click', () => this.rig.orbit(-Math.PI / 6));
    $('camRotR').addEventListener('click', () => this.rig.orbit(Math.PI / 6));
    $('camXray').addEventListener('click', () => {
      this.rig.seeThrough = !this.rig.seeThrough;
      $('camXray').setAttribute('aria-pressed', String(this.rig.seeThrough));
    });
    $('isoIn').addEventListener('click', () => this.rig.zoomBy(1.4));
    $('isoOut').addEventListener('click', () => this.rig.zoomBy(1 / 1.4));

    const canvas = $('scene');
    canvas.addEventListener('pointermove', (e) => {
      if (this.rig.mode !== 'god' || e.buttons) { this.hoverNode = null; return; }
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.rig.active);
      const hit = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(this.ground, hit)) { this.hoverNode = null; return; }
      let best = null, bd = 12;
      for (const n of this.rig.realNodes) {
        const d = Math.hypot(n.x - hit.x, n.z - hit.z);
        if (d < bd) { bd = d; best = n; }
      }
      this.hoverNode = best;
    });
    canvas.addEventListener('pointerleave', () => { this.hoverNode = null; });
    // drag sideways on the intersection camera to orbit it around the intersection
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.rig.mode !== 'intersection') return;
      drag = { x: e.clientX };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || this.rig.mode !== 'intersection') return;
      this.rig.orbit(((e.clientX - drag.x) / canvas.clientWidth) * Math.PI * 1.2);
      drag.x = e.clientX;
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.rig.mode !== 'intersection') return;
      e.preventDefault();
      this.rig.pullBack(e.deltaY > 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    const endDrag = () => { drag = null; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea')) return;
      if (e.key === '1') this.setCam('chase');
      if (e.key === '2') this.setCam('god');
      if (e.key === '3') this.setCam('intersection');
      if (e.key === 'd' || e.key === 'D') $('dispatchBtn').click();
      if (this.rig.mode === 'god' && (e.key === 'q' || e.key === 'Q')) this.rig.rotate(-1);
      if (this.rig.mode === 'god' && (e.key === 'e' || e.key === 'E')) this.rig.rotate(1);
      if (this.rig.mode === 'intersection' && (e.key === 'q' || e.key === 'Q')) this.rig.orbit(-Math.PI / 6);
      if (this.rig.mode === 'intersection' && (e.key === 'e' || e.key === 'E')) this.rig.orbit(Math.PI / 6);
      if (e.key === 'Escape' && !$('calloutMenu').hidden) this._calloutMenu(false);
    });
  }

  setCam(mode) {
    if (mode === this.rig.mode) return;
    const fade = $('fade');
    fade.classList.add('on');
    setTimeout(() => {
      this.rig.setMode(mode);
      document.querySelectorAll('[data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === mode)));
      $('legend').hidden = mode !== 'god';
      $('isoCtl').hidden = mode !== 'god';
      if (mode !== 'god') this._calloutMenu(false);
      $('approaches').hidden = mode !== 'intersection';
      $('camNav').hidden = mode !== 'intersection';
      $('camTag').hidden = mode !== 'intersection';
      this.tagLayer.hidden = mode !== 'god';
      $('viewport').classList.toggle('close-cam', mode !== 'god');
      this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      this.update();
      requestAnimationFrame(() => fade.classList.remove('on'));
    }, 180);
  }

  renderAI() {
    const sim = this.sim, nemo = this.nemo, st = nemo.status;
    const on = sim.aiEnabled;
    $('aiToggle').setAttribute('aria-checked', String(on));
    $('aiState').textContent = on ? 'ON' : 'OFF';
    $('aiState').classList.toggle('off', !on);
    $('aiLabel').textContent = sim.controller === 'nemotron' ? 'AI control' : 'Adaptive control';
    let text, dot = '';
    if (!on) { text = 'Fixed timers · 18 s'; dot = 'off'; }
    else if (sim.controller === 'nemotron' && !sim.fallback && nemo.available) {
      const ms = nemo.avgLatency();
      text = `${modelLabel(st.mock ? `mock:${st.signalModel}` : st.signalModel)} · ${ms ? `${ms} ms` : 'live'}`;
      dot = st.mock ? 'warn' : 'live';
    } else if (sim.controller === 'nemotron') { text = 'Nemotron unavailable · rules running'; dot = 'warn'; }
    else text = 'Local rules';
    $('controllerText').textContent = text;
    $('controllerDot').className = `dot ${dot}`;
    if (!$('cfgPanel').hidden) this._renderConfig();
  }

  // ---------- AI controller settings ----------
  _wireConfig() {
    const panel = $('cfgPanel'), btn = $('cfgBtn');
    const open = (show) => {
      panel.hidden = !show;
      btn.setAttribute('aria-expanded', String(show));
      if (show) { $('demoPanel').hidden = true; $('demoBtn').setAttribute('aria-expanded', 'false'); this._renderConfig(true); this.nemo.refresh(); $('cfgKey').focus(); }
    };
    btn.addEventListener('click', () => open(panel.hidden));
    $('cfgClose').addEventListener('click', () => open(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
    document.querySelectorAll('[data-ctrl]').forEach((b) => b.addEventListener('click', () => {
      this.sim.setController(b.dataset.ctrl);
      writePref(b.dataset.ctrl);
      this.renderAI();
      this._renderConfig();
    }));
    $('cfgShow').addEventListener('click', () => {
      const k = $('cfgKey'), show = k.type === 'password';
      k.type = show ? 'text' : 'password';
      $('cfgShow').textContent = show ? 'Hide' : 'Show';
      $('cfgShow').setAttribute('aria-pressed', String(show));
    });
    const result = (msg, cls = '') => { $('cfgResult').textContent = msg; $('cfgResult').className = `cfg-result ${cls}`; };
    const gather = () => {
      const cfg = { signalModel: $('cfgSignal').value.trim(), dispatchModel: $('cfgDispatch').value.trim(), baseUrl: $('cfgBase').value.trim(), saveToEnv: $('cfgSave').checked };
      const key = $('cfgKey').value.trim();
      if (key) cfg.apiKey = key;
      return cfg;
    };
    $('cfgApply').addEventListener('click', async () => {
      if (!this.nemo.status.server) { result('Start the local server first: python3 server.py', 'err'); return; }
      $('cfgApply').disabled = true;
      try {
        await this.nemo.saveConfig(gather());
        $('cfgKey').value = '';
        result($('cfgSave').checked ? 'Saved, and written to dashboard/.env.' : 'Saved for this session.', 'ok');
        this._loadModels();
      } catch (e) {
        result(`Could not save: ${e.message}`, 'err');
      } finally {
        $('cfgApply').disabled = false;
        this.renderAI();
      }
    });
    $('cfgTest').addEventListener('click', async () => {
      if (!this.nemo.status.server) { result('Start the local server first: python3 server.py', 'err'); return; }
      $('cfgTest').disabled = true;
      result('Calling Token Factory…');
      try {
        if ($('cfgKey').value.trim() || $('cfgSignal').value.trim() !== this.nemo.status.signalModel) await this.nemo.saveConfig(gather());
        $('cfgKey').value = '';
        const r = await this.nemo.test($('cfgSignal').value.trim());
        result(`Connected. ${modelLabel(r.model)} replied in ${r.latencyMs} ms.`, 'ok');
        this._loadModels();
      } catch (e) {
        result(`Connection failed: ${e.message}`, 'err');
      } finally {
        $('cfgTest').disabled = false;
        this.renderAI();
      }
    });
    this.nemo.onChange(() => this.renderAI());
  }

  async _loadModels() {
    try {
      const r = await this.nemo.models();
      $('cfgModels').replaceChildren(...r.models.map((m) => Object.assign(document.createElement('option'), { value: m, label: modelLabel(m) })));
    } catch { /* the built-in defaults stay */ }
  }

  _renderConfig(fillInputs = false) {
    const st = this.nemo.status, nemo = this.nemo;
    document.querySelectorAll('[data-ctrl]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ctrl === this.sim.controller)));
    const srv = $('cfgServer');
    if (!st.server) {
      srv.className = 'cfg-server bad';
      srv.replaceChildren('The local server is not running, so Nemotron cannot be reached. In the dashboard folder run ', Object.assign(document.createElement('code'), { textContent: 'python3 server.py' }), ' and open http://localhost:8000.');
    } else if (st.mock) {
      srv.className = 'cfg-server bad';
      srv.textContent = 'Server is in mock mode: decisions come from a labelled stand-in, not Nemotron. Restart without --mock to use your key.';
    } else if (!st.hasKey) {
      srv.className = 'cfg-server bad';
      srv.textContent = 'Local server connected. Add your API key below to turn Nemotron on.';
    } else {
      srv.className = 'cfg-server good';
      srv.textContent = `Local server connected. Key ${st.keySource === 'env' ? 'loaded from .env' : 'entered in this session'}${st.keyHint ? ` (${st.keyHint})` : ''}.`;
    }
    $('cfgKey').placeholder = st.hasKey && !st.mock ? 'Key set. Paste a new one to replace it' : 'Paste your key';
    if (fillInputs) {
      $('cfgSignal').value = st.signalModel ?? 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';
      $('cfgDispatch').value = st.dispatchModel ?? 'nvidia/nemotron-3-super-120b-a12b';
      $('cfgBase').value = st.baseUrl ?? 'https://api.tokenfactory.nebius.com/v1';
      if (!$('cfgModels').children.length && st.knownModels) {
        $('cfgModels').replaceChildren(...st.knownModels.map((m) => Object.assign(document.createElement('option'), { value: m, label: modelLabel(m) })));
      }
    }
    for (const id of ['cfgKey', 'cfgSignal', 'cfgDispatch', 'cfgBase', 'cfgSave', 'cfgApply', 'cfgTest']) $(id).disabled = !st.server;
    const s = nemo.stats, tok = st.stats ? st.stats.prompt_tokens + st.stats.completion_tokens : 0;
    const rows = [
      ['Model calls', `${s.ok}/${s.calls}`], ['Avg latency', nemo.avgLatency() ? `${nemo.avgLatency()} ms` : '—'],
      ['Signals switched', String(s.switches)], ['Held by guardrail', String(s.rejected ?? 0)], ['Routes chosen', String(s.routes)],
      ['Tokens used', tok ? tok.toLocaleString() : '—'], ['Last error', s.lastError ? s.lastError.slice(0, 40) : 'none'],
    ];
    $('cfgStats').replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v, title: k === 'Last error' && s.lastError ? `${s.lastError}${s.lastBadReply ? `\n\nReply was:\n${s.lastBadReply}` : ''}` : '' })]));
  }

  // Pick the starting controller once we know whether Nemotron is reachable
  initController() {
    const pref = readPref();
    this.sim.setController(pref === 'rules' ? 'rules' : this.nemo.available ? 'nemotron' : 'rules');
    this.renderAI();
  }

  renderCamNav() {
    $('camAuto').setAttribute('aria-pressed', String(this.rig.autoFollow));
    this._routeMenu();
  }

  // ---------- intersections ahead of the ambulance ----------
  _routeAmb() {
    const c = this.rig.chaseVehicle();
    if (c && c.type === 'ambulance') return c;
    return this.sim.ambulances().at(-1) ?? null;
  }

  _routeMenuOpen(open) {
    $('routeMenu').hidden = !open;
    $('routeBtn').setAttribute('aria-expanded', String(open));
    if (open) this._routeMenu();
  }

  _routeMenu() {
    const v = this._routeAmb(), btn = $('routeBtn'), menu = $('routeMenu');
    const show = this.rig.mode === 'intersection' && !!v;
    btn.hidden = !show;
    if (!show) { if (!menu.hidden) this._routeMenuOpen(false); return; }
    const items = this.sim.routeSignals(v);
    $('routeBtnText').textContent = `${items.length} intersection${items.length === 1 ? '' : 's'} ahead of ${v.name}`;
    $('routeMenuTitle').textContent = `Ahead of ${v.name} · ${v.hospital.name}`;
    if (menu.hidden) return;
    const list = $('routeList');
    if (!items.length) {
      if (!list.querySelector('.rm-empty')) {
        const p = document.createElement('div');
        p.className = 'rm-empty';
        p.textContent = `${v.name} has no more signals before the hospital.`;
        list.replaceChildren(p);
      }
      return;
    }
    // rebuild only when the set of intersections changes, so a row under the pointer or focus stays put
    const key = items.map((it) => it.node.id).join('|');
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...items.map((it, k) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rm-row';
        b.dataset.node = it.node.id;
        b.innerHTML = '<span class="rm-step"></span><span class="rm-dot"></span><span class="rm-name"><span class="nm"></span><small></small></span><span class="rm-q"></span>';
        b.querySelector('.rm-step').textContent = String(k + 1);
        b.querySelector('.nm').textContent = it.node.name;
        b.addEventListener('click', () => {
          const cur = this.sim.routeSignals(this._routeAmb() ?? v).find((x) => x.node === it.node) ?? it;
          this._openIntersection(it.node, cur.dir ?? 'S');
          this._routeMenuOpen(false);
        });
        return b;
      }));
    }
    const rows = list.children;
    items.forEach((it, k) => {
      const b = rows[k];
      if (!b) return;
      const st = this.sim.approachState(it.node, it.dir);
      const sig = this.sim.signals.get(it.node.id);
      const q = this.sim.queue(it.node, it.dir);
      const held = sig?.preempt?.amb === v.id;
      const dot = b.querySelector('.rm-dot');
      dot.className = `rm-dot ${st}`;
      const sub = b.querySelector('small');
      sub.className = st;
      sub.textContent = `${STATE_WORD[st]}${held ? ` · held for ${v.name}` : ''} · ${Math.round(it.dist)} m · ~${Math.max(1, Math.round(it.eta))} s`;
      const qEl = b.querySelector('.rm-q');
      qEl.classList.toggle('busy', q >= 5);
      qEl.innerHTML = '';
      const n = document.createElement('b');
      n.textContent = String(q);
      qEl.append(n, ` car${q === 1 ? '' : 's'} waiting`);
      b.setAttribute('aria-current', String(this.rig.camNode === it.node));
      b.setAttribute('aria-label', `${it.node.name}: ${STATE_WORD[st].toLowerCase()} for ${v.name}, ${q} cars waiting on its road, about ${Math.max(1, Math.round(it.eta))} seconds away. Open camera.`);
    });
  }

  update() {
    $('simClock').textContent = `SIM ${fmtTime(this.sim.t)}`;
    this._feed();
    this._kpis();
    this._eta();
    this._modeHud();
    this._routeMenu();
  }

  frame(camera) {
    this._drawOverlay(camera);
    this._cards(camera);
  }

  _feed() {
    const list = $('feed');
    const fresh = this.sim.events.filter((e) => e.seq > this.lastSeq);
    for (const e of fresh) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = fmtTime(e.t);
      const body = document.createElement('span');
      const k = document.createElement('span');
      k.className = `k k-${e.kind}`;
      k.textContent = FEED_LABEL[e.kind] ?? e.kind;
      if (FEED_TIP[e.kind]) k.title = FEED_TIP[e.kind];
      body.append(k, ` · ${e.text}`);
      li.append(time, body);
      list.prepend(li);
      this.lastSeq = e.seq;
    }
    while (list.children.length > 50) list.lastChild.remove();
  }

  _kpis() {
    const sim = this.sim, k = sim.kpis(), h = k.history;
    // refresh about twice a second; the numbers move slower than the frame rate
    if (this._kpiAt && performance.now() - this._kpiAt < 450) return;
    this._kpiAt = performance.now();

    const MODE = { Nemotron: ['Nemotron', 'var(--s-nemotron)'], Rules: ['Local rules', 'var(--s-rules)'], Fixed: ['Fixed timers', 'var(--s-fixed)'] };
    const [modeName, modeC] = MODE[k.mode];
    $('kMode').textContent = modeName;
    $('kMode').style.setProperty('--mode-c', modeC);

    // compare with two sim-minutes ago, in words, so the direction is never colour alone
    const past = h.length > 60 ? h[h.length - 61] : null;
    const delta = (now, then, unit, digits = 0) => {
      if (then == null || now == null) return null;
      const d = now - then;
      if (Math.abs(d) < (digits ? 0.5 : 1)) return 'about the same as 2 min ago';
      return `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(digits)}${unit} vs 2 min ago`;
    };

    $('kStopped').textContent = String(k.stopped);
    $('kStoppedOf').textContent = `of ${k.onRoad} cars`;
    this._subText('kStoppedSub', delta(k.stopped, past?.stopped, '') ?? 'at lights or in queues');

    const wait = k.avgWait ?? (sim.t > 10 ? k.avgWaitNow : null);
    $('kWait').textContent = wait == null ? '—' : wait.toFixed(1);
    this._subText('kWaitSub', k.avgWait == null ? 'so far, cars on the road' : delta(k.avgWait, past?.wait, ' s', 1) ?? 'average, last 2 min');

    $('kThru').textContent = k.throughput == null ? '—' : String(k.throughput);
    this._subText('kThruSub', delta(k.throughput, past?.thru, '') ?? 'cars reaching their destination');

    const fixed = k.mode === 'Fixed';
    $('kDec').textContent = fixed ? '0' : k.decisionsPerMin == null ? '—' : String(Math.round(k.decisionsPerMin));
    let decSub;
    if (fixed) decSub = 'fixed timers never adapt';
    else if (k.mode === 'Nemotron') {
      const ms = this.nemo.avgLatency();
      decSub = `${modelLabel(this.nemo.status.signalModel)}${ms ? ` · ${ms} ms` : ''}`;
    } else decSub = sim.controller === 'nemotron' ? 'rules covering for Nemotron' : 'queue rules, every 2 s';
    this._subText('kDecSub', decSub);

    for (const tile of document.querySelectorAll('.kpi[data-spark]')) this._spark(tile, h, tile.dataset.spark);
    this._ambCompare(k);
  }

  // sub-lines double as the hover readout for the sparkline, so keep the resting text separately
  _subText(id, text) {
    const el = $(id);
    el.dataset.rest = text;
    if (!el.dataset.hover) el.textContent = text;
  }

  _spark(tile, h, key) {
    const svg = tile.querySelector('.spark');
    const pts = h.slice(-90);   // last 3 sim-minutes
    if (pts.length < 2) { svg.innerHTML = ''; return; }
    const vals = pts.map((p) => p[key] ?? 0);
    const max = Math.max(1, ...vals) * 1.1;
    const x = (i) => (i / (pts.length - 1)) * 100, y = (v) => 25 - (v / max) * 24;
    const line = vals.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
    const hv = svg._hover ?? -1;
    svg.innerHTML = `<polygon class="ar" points="0,25 ${line} 100,25"></polygon><polyline class="ln" points="${line}"></polyline>` +
      (hv >= 0 && hv < pts.length ? `<line class="hv" x1="${x(hv)}" x2="${x(hv)}" y1="0" y2="25"></line>` : '');
    if (!svg._wired) {
      svg._wired = true;
      const sub = tile.querySelector('.kpi-sub');
      const unit = { stopped: ' cars stopped', wait: ' s stopped per trip', thru: ' trips / min', dec: ' decisions / min' }[key];
      const digits = key === 'wait' ? 1 : 0;
      svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect(), all = this.sim.history.slice(-90);
        if (all.length < 2) return;
        const i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (all.length - 1));
        svg._hover = i;
        const p = all[i];
        sub.dataset.hover = '1';
        sub.textContent = `${fmtTime(p.t)} · ${(p[key] ?? 0).toFixed(digits)}${unit}`;
        this._kpiAt = 0;
      });
      svg.addEventListener('pointerleave', () => {
        svg._hover = -1;
        delete sub.dataset.hover;
        sub.textContent = sub.dataset.rest ?? '';
        this._kpiAt = 0;
      });
    }
  }

  _ambCompare(k) {
    const modes = ['Nemotron', 'Rules', 'Fixed'];
    const max = Math.max(1, ...modes.map((m) => k.amb[m].mean ?? 0));
    const empty = {
      Nemotron: this.nemo.available ? 'no trips yet · choose Nemotron in ⚙' : 'connect Nemotron in ⚙ to measure',
      Rules: 'no trips yet · choose Local rules in ⚙',
      Fixed: 'no trips yet · turn control off for a baseline',
    };
    for (const m of modes) {
      const row = document.querySelector(`.amb-row[data-mode="${m}"]`), a = k.amb[m];
      row.classList.toggle('empty', !a.n);
      row.classList.toggle('current', k.mode === m);
      row.querySelector('.amb-bar').style.width = a.n ? `${((a.mean / max) * 100).toFixed(1)}%` : '0';
      row.querySelector('.amb-val').textContent = a.n ? fmtTime(a.mean) : '—';
      row.querySelector('.amb-sub').textContent = a.n
        ? `${a.n} trip${a.n > 1 ? 's' : ''} · ${a.stopped.toFixed(1)} s held up · best ${fmtTime(a.best)}`
        : empty[m];
    }
    // headline: the clearest single comparison available
    const fx = k.amb.Fixed, nm = k.amb.Nemotron, ru = k.amb.Rules;
    const vs = (a, name) => {
      const pct = Math.round(((fx.mean - a.mean) / fx.mean) * 100);
      const secs = Math.round(fx.mean - a.mean);
      return pct > 0
        ? `${name} gets ambulances there <b>${pct}% faster</b> than fixed timers (${secs} s saved per trip).`
        : `${name} is ${Math.abs(pct)}% slower than fixed timers so far. More trips will firm this up.`;
    };
    let head;
    if (fx.n && nm.n) head = vs(nm, this.nemo.status.mock ? 'The stand-in model (not live Nemotron) with the Predictive Green Corridor' : 'Nemotron with the Predictive Green Corridor');
    else if (fx.n && ru.n) head = vs(ru, 'Local rules');
    else if (nm.n || ru.n) head = 'Turn control off and dispatch one to record the fixed-timer baseline.';
    else if (fx.n) head = 'Baseline recorded. Turn control on and dispatch again to compare.';
    else head = 'Dispatch an ambulance to start measuring.';
    $('ambHeadline').innerHTML = head;
    const last = k.lastAmb;
    $('ambLast').textContent = last ? `Last: ${last.name} → ${last.hospital} in ${fmtTime(last.duration)} · ${MODE_NAME[last.mode] ?? last.mode}` : '';
  }

  _focusAmbulance() {
    const ambs = this.sim.ambulances();
    if (!ambs.length) return null;
    return ambs.find((a) => a.id === this.rig.chaseId) ?? ambs.at(-1);
  }

  _eta() {
    const v = this._focusAmbulance();
    const card = $('etaCard');
    if (!v) { card.hidden = true; return; }
    card.hidden = false;
    $('etaName').textContent = `AMBULANCE ${v.name} · EN ROUTE`;
    $('etaSpeed').textContent = `${Math.round(v.speed * 3.6)} km/h`;
    $('etaTime').textContent = fmtTime(this.sim.remainingDistance(v) / 13);
    $('etaDest').textContent = `ETA to ${v.hospital.name}`;
    const total = Math.max(1, v.totalNodes);
    const bar = $('etaBar');
    if (bar.children.length !== total) bar.replaceChildren(...Array.from({ length: total }, () => document.createElement('span')));
    [...bar.children].forEach((s, i) => { s.className = i < v.passed ? 'done' : i === v.passed ? 'next' : ''; });
    const ns = this.sim.nextSignal(v);
    const passed = Math.min(v.passed, total);
    $('etaNote').textContent = ns && !ns.final
      ? `${passed} of ${total} intersections passed · next: ${ns.node.name} in ${Math.round(ns.dist)} m`
      : `${passed} of ${total} intersections passed · arriving`;
  }

  _modeHud() {
    const mode = this.rig.mode;
    const banner = $('banner'), hint = $('hint');
    banner.hidden = true;
    hint.hidden = true;

    if (mode === 'chase') {
      const v = this.rig.chaseVehicle();
      if (v && v.type === 'ambulance') {
        const ns = this.sim.nextSignal(v);
        if (ns) {
          banner.hidden = false;
          const mine = this.sim.signals.get(ns.node.id)?.preempt?.amb === v.id;
          const switching = mine && ns.state !== 'G';
          $('bannerLight').className = `banner-light ${switching ? 'Y' : ns.state}`;
          $('bannerWhere').textContent = `Next signal · ${ns.node.name}`;
          const s = document.createElement('span');
          s.className = `st-${switching ? 'Y' : ns.state}`;
          s.textContent = switching ? 'CLEARING' : STATE_WORD[ns.state];
          const what = switching ? `switching to green for ${v.name}` : mine ? `held for ${v.name}` : C.DIR_WORD[ns.dir];
          $('bannerMain').replaceChildren(s, ` · ${what} · ${Math.round(ns.dist)} m`);
        }
      } else if (v && v.type === 'parked') {
        hint.hidden = false;
        hint.textContent = v.park.state === 'parked' ? `${v.name} is in the ambulance bay at ${v.hospital.name}.` : `${v.name} is pulling into ${v.hospital.name}.`;
      } else {
        hint.hidden = false;
        hint.textContent = 'Following traffic. Press Dispatch Ambulance to chase an ambulance.';
      }
    }

    if (mode === 'intersection') {
      const n = this.rig.camNode;
      const rec = document.createElement('span');
      rec.className = 'rec';
      $('camTag').replaceChildren(rec, `CAM ${String(this.rig.realNodes.indexOf(n) + 1).padStart(2, '0')} · ${n.name.toUpperCase()}`);
      const rows = [];
      const sig = this.sim.signals.get(n.id);
      for (const dir of ['N', 'S', 'E', 'W']) {
        if (!n.in[dir]) continue;
        const st = this.sim.approachState(n, dir);
        const road = C.AXIS[dir] === 'EW' ? C.STREETS[n.j] : C.AVENUES[n.i];
        const q = this.sim.queue(n, dir);
        const corridor = sig.preempt && sig.preempt.dir === dir;
        const row = document.createElement('div');
        row.className = 'ap-row';
        const name = document.createElement('span');
        name.textContent = `${road} ${C.DIR_WORD[dir]}`;
        const state = document.createElement('span');
        state.className = `ap-state ${st}`;
        state.append(document.createElement('i'), `${STATE_WORD[st]}${corridor ? ' · corridor' : q ? ` · ${q} queued` : ''}`);
        row.append(name, state);
        rows.push(row);
      }
      $('approachRows').replaceChildren(...rows);
      if (!this.sim.ambulances().length && this.rig.autoFollow) {
        hint.hidden = false;
        hint.textContent = 'Dispatch an ambulance and this camera jumps to each intersection ahead of it.';
      }
    }
  }


  // ---------- demo: Cross-Town Emergency ----------
  attachDemo(demo) {
    this.demo = demo;
    const panel = $('demoPanel'), btn = $('demoBtn');
    const open = (show) => {
      panel.hidden = !show;
      btn.setAttribute('aria-expanded', String(show));
      if (show) { $('cfgPanel').hidden = true; this.nemo.refresh().then(render); render(); }
    };
    $('dfDensity').textContent = `Rush hour · ${SCENARIO.cars} cars, built up for ${SCENARIO.warmup} s on ordinary signals`;
    $('dfAmb').textContent = `One (A-1), dispatched ${fmtTime(SCENARIO.dispatchAt)} into the run`;
    $('dfDest').textContent = SCENARIO.destination;
    $('dfRoute').textContent = `Fixed for the comparison: ${SCENARIO.routeLabel}, ${SCENARIO.signals} signals, the same in both runs`;
    const runLabel = (r) => (r.run === 'urbanflow' && !r.live ? 'UrbanFlow AI (stand-in model, not live)' : r.label);

    const render = () => {
      const busy = demo.state === 'checking' || demo.state === 'preparing' || demo.state === 'running';
      const ms = demo.modelStatus();
      document.querySelectorAll('[data-run]').forEach((b) => {
        b.disabled = busy || (b.dataset.run === 'urbanflow' && !ms.ok);
        const r = demo.results[b.dataset.run];
        $(`dlast-${b.dataset.run}`).textContent = r ? `Last run: A-1 ${r.trip == null ? 'did not arrive' : `in ${fmtTime(r.trip)}`}${r.run === 'urbanflow' && !r.live ? ' (stand-in model)' : ''}` : '';
      });
      $('demoModel').textContent = `Run 2 model: ${ms.text}`;
      $('demoModel').classList.toggle('warn', !ms.live);
      $('demoError').textContent = demo.error ?? '';
      $('demoError').className = `cfg-result${demo.error ? ' err' : ''}`;
      btn.hidden = busy;
      $('demoStatus').hidden = !busy;
      $('demoStatusText').textContent = demo.status();
      $('demoPause').hidden = demo.state !== 'running';
      $('demoPause').setAttribute('aria-pressed', String(!!this.sim.paused && demo.state === 'running'));
      $('demoPause').textContent = this.sim.paused && demo.state === 'running' ? 'Resume' : 'Pause';
      // a run in progress owns the controls that would change it
      $('dispatchBtn').disabled = busy;
      document.querySelectorAll('[data-ctrl]').forEach((b) => { b.disabled = busy; });
      $('aiToggle').disabled = busy;
      $('dispatchBtn').title = busy ? 'Not available during a demo run' : '';
    };
    this._renderDemo = render;
    const run = async (id) => {
      open(false);
      $('demoResults').hidden = true;
      try { await demo.start(id); } catch (e) { demo.error = e.message; }
      if (demo.error) open(true);
      this.renderAI();
    };
    btn.addEventListener('click', () => open(panel.hidden));
    $('demoClose').addEventListener('click', () => open(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); } });
    document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', () => run(b.dataset.run)));
    $('demoStop').addEventListener('click', () => { demo.stop(); this.renderAI(); });
    $('demoPause').addEventListener('click', () => { this.sim.paused = !this.sim.paused; render(); });
    $('demoCompare').addEventListener('click', () => { open(false); this._showResults(); });
    $('demoExit').addEventListener('click', () => { demo.exit(); open(false); $('demoResults').hidden = true; this.renderAI(); this.update(); });
    $('drClose').addEventListener('click', () => { $('demoResults').hidden = true; });
    $('drClear').addEventListener('click', () => { demo.clearResults(); this._showResults(); });
    $('drRun1').addEventListener('click', () => run('conventional'));
    $('drRun2').addEventListener('click', () => run('urbanflow'));
    demo.hooks = {
      // only picks which ambulance the chase cam follows; the camera mode is never changed
      onDispatch: (v) => this.rig.focusAmbulance(v),
      onFinish: () => { this.renderAI(); this._showResults(); },
    };
    demo.onChange(render);
    this.nemo.onChange(() => { if (!panel.hidden) render(); });
    setInterval(() => { if (demo.state !== 'idle' && demo.state !== 'done') $('demoStatusText').textContent = demo.status(); }, 250);
    this._runLabel = runLabel;
    render();
  }

  _showResults() {
    const res = this.demo.results, A = res.conventional, B = res.urbanflow;
    const box = $('demoResults');
    box.hidden = false;
    const f = {
      t: (x) => (x == null ? '—' : fmtTime(x)),
      s: (x) => (x == null ? '—' : `${x.toFixed(1)} s`),
      n: (x, d = 0) => (x == null ? '—' : x.toFixed(d)),
    };
    // headline from the measured trip times only
    let head = 'Run both to compare them.';
    if (A && B && A.trip != null && B.trip != null) {
      const d = A.trip - B.trip, pct = Math.round((d / A.trip) * 100);
      const who = B.live ? 'UrbanFlow AI with live Nemotron' : 'UrbanFlow AI with the stand-in model (not live Nemotron)';
      head = d > 0.5 ? `${who} got A-1 to ${SCENARIO.destination} <b>${Math.round(d)} s sooner</b> (${pct}% faster) than conventional traffic.`
        : d < -0.5 ? `${who} was ${Math.round(-d)} s slower than conventional traffic on this run.`
        : `${who} and conventional traffic took about the same time on this run.`;
    } else if (A || B) head = `Saved: ${[A, B].filter(Boolean).map((r) => this._runLabel(r)).join(', ')}. Run the other one to compare.`;
    $('drHeadline').innerHTML = head;
    const rows = [
      ['Ambulance travel time', 'dispatch → hospital', (r) => r.trip, f.t, 'low'],
      ['Time stopped', 'under 0.6 m/s', (r) => r.stoppedS, f.s, 'low'],
      ['Time held up by traffic', 'moving under 4 m/s', (r) => r.slowS, f.s, 'low'],
      ['Intersections traversed', '', (r) => r.intersections, (x) => f.n(x), null],
      ['Vehicle throughput', 'car trips completed per minute, during the run', (r) => r.throughput, (x) => f.n(x), 'high'],
      ['Average vehicle waiting time', 'stopped time per completed car trip', (r) => r.avgWait, f.s, 'low'],
      ['Emergency priority in use', 'intersection-seconds held for the ambulance', (r) => r.priorityS, f.s, null],
      ['Safety violations', 'conflicting greens · vehicle overlaps', (r) => r.conflicts + r.overlaps, (x, r) => `${r.conflicts} · ${r.overlaps}`, null],
    ];
    const cell = (r, row) => {
      if (!r) return '<td class="na">not run</td>';
      const v = row[2](r);
      const other = r === A ? B : A;
      const ov = other ? row[2](other) : null;
      let cls = '';
      if (row[4] && v != null && ov != null && Math.abs(v - ov) > 1e-6) cls = (row[4] === 'low' ? v < ov : v > ov) ? 'best' : '';
      if (row[0] === 'Safety violations' && v > 0) cls = 'warn';
      return `<td class="${cls}">${row[3](v, r)}</td>`;
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let html = `<thead><tr><th></th><th>Run 1 · ${esc(A ? this._runLabel(A) : RUNS.conventional.label)}</th><th>Run 2 · ${esc(B ? this._runLabel(B) : RUNS.urbanflow.label)}</th></tr></thead><tbody>`;
    for (const row of rows) html += `<tr><td>${row[0]}${row[1] ? `<span class="sub">${row[1]}</span>` : ''}</td>${cell(A, row)}${cell(B, row)}</tr>`;
    // model activity, only for run 2
    const nm = B?.nemotron;
    const nemoCell = nm ? `${nm.calls} call${nm.calls === 1 ? '' : 's'} (${nm.ok} answered, ${nm.failed} failed)${nm.avgLatency != null ? ` · avg ${nm.avgLatency} ms` : ''}<span class="sub">${nm.switches} signal switches applied · ${nm.refused} refused by the safety check${nm.idleGreen != null ? ` · ${nm.idleGreen} unused greens ended by the idle-green safeguard (not the model)` : ''}</span>` : (B ? '—' : 'not run');
    const fbCell = nm ? (nm.fallbackS > 0.05 ? `Local rules ran the signals for ${nm.fallbackS.toFixed(1)} s (${nm.fallbackEvents}×)${nm.lastError ? `<span class="sub">${esc(nm.lastError)}</span>` : ''}` : 'None: the model ran the signals throughout') : (B ? '—' : 'not run');
    html += `<tr><td>${B && !B.live ? 'Model calls (stand-in, not live)' : 'Nemotron calls'}<span class="sub">${B?.model ? esc(B.model) : 'Nemotron 3 Nano'}</span></td><td class="na">none (no model)</td><td class="${B && !B.live ? 'warn' : ''}">${nemoCell}</td></tr>`;
    html += `<tr><td>Fallback to local rules</td><td class="na">n/a</td><td class="${nm && nm.fallbackS > 0.05 ? 'warn' : ''}">${fbCell}</td></tr>`;
    html += '</tbody>';
    $('drTable').innerHTML = html;
    const when = [A, B].filter(Boolean).map((r) => `${r === A ? 'Run 1' : 'Run 2'} ${new Date(r.at).toLocaleString()}`).join(' · ');
    $('drNote').textContent = `Same seed (${SCENARIO.seed}), ${SCENARIO.cars} cars, same dispatch and the same fixed route in both runs. Every value is measured in the run. Emergency priority in Run 2 is deterministic code (Predictive Green Corridor), not the model; Run 1 has none.${when ? ` ${when}.` : ''}`;
  }

  // ---------- callout settings ----------
  _wireCallouts() {
    this.callouts = { route: true, amb: true, hosp: true, ai: true, queue: true };
    try {
      const saved = JSON.parse(localStorage.getItem('urbanflow.callouts') || 'null');
      if (saved && typeof saved === 'object') Object.assign(this.callouts, saved);
    } catch { /* storage unavailable: keep defaults */ }
    for (const box of document.querySelectorAll('[data-callout]')) {
      box.checked = this.callouts[box.dataset.callout] !== false;
      box.addEventListener('change', () => {
        this.callouts[box.dataset.callout] = box.checked;
        try { localStorage.setItem('urbanflow.callouts', JSON.stringify(this.callouts)); } catch { /* ignore */ }
      });
    }
    $('calloutBtn').addEventListener('click', () => this._calloutMenu($('calloutMenu').hidden));
    document.addEventListener('pointerdown', (e) => {
      if (!$('calloutMenu').hidden && !e.target.closest('#calloutMenu, #calloutBtn')) this._calloutMenu(false);
    });
  }

  _calloutMenu(open) {
    $('calloutMenu').hidden = !open;
    $('calloutBtn').setAttribute('aria-expanded', String(open));
  }

  // From a callout: open that intersection's camera, looking at the given approach
  _openIntersection(node, facing) {
    this.rig.viewIntersection(node, facing);
    this.renderCamNav();
    if (this.rig.mode !== 'intersection') this.setCam('intersection');
  }

  // ---------- floating cards pinned to the city (Omniscient view) ----------
  _tag(key, cls) {
    let el = this.tags.get(key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = `tag ${cls}`;
      el.innerHTML = '<div class="tag-k"><span class="tag-step"></span><span class="tag-n"></span></div><div class="tag-v"></div>';
      el.addEventListener('click', () => el._onClick?.());
      this.tagLayer.append(el);
      this.tags.set(key, el);
    }
    el.className = `tag ${cls}`;
    el.dataset.seen = '1';
    el._onClick = null;
    el.removeAttribute('title');
    return el;
  }

  // Make a card clickable: what it does, and how it is announced
  _clickable(el, label, fn) {
    el.classList.add('click');
    el._onClick = fn;
    el.title = label;
    el.setAttribute('aria-label', `${el.querySelector('.tag-n').textContent}. ${el.lastChild.textContent}. ${label}`);
  }

  // Place a card above its anchor; hide it if it would overlap a higher-priority card placed earlier this frame
  _place(el, world, camera, w, h) {
    const p = world.clone().project(camera);
    const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
    let hide = p.z > 1 || x < -60 || x > w + 60 || y < -40 || y > h + 80;
    let lift = 0;
    if (!hide) {
      const cw = el._w || (el._w = el.offsetWidth || 160), ch = el._h || (el._h = el.offsetHeight || 40);
      // if the spot is taken, raise the card on a longer leader line instead of hiding it
      hide = true;
      for (const up of [0, 46, 92, 138]) {
        const r = { l: x - cw / 2 - 4, r: x + cw / 2 + 4, t: y - ch - 18 - up, b: y - up };
        if (this._placed.some((o) => r.l < o.r && r.r > o.l && r.t < o.b && r.b > o.t)) continue;
        this._placed.push(r);
        hide = false;
        lift = up;
        break;
      }
    }
    el.style.display = hide ? 'none' : '';
    if (!hide) {
      el.style.setProperty('--lead', `${13 + lift}px`);
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - lift).toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  _set(el, k, v, step = '') {
    const kk = el.querySelector('.tag-n'), vv = el.lastChild, ss = el.querySelector('.tag-step');
    if (ss.textContent !== step) { ss.textContent = step; el._w = 0; }
    if (kk.textContent !== k || vv.textContent.length !== v.length) el._w = 0;
    if (kk.textContent !== k) kk.textContent = k;
    if (vv.textContent !== v) vv.textContent = v;
  }

  _cards(camera) {
    if (this.rig.mode !== 'god') return;
    const w = this.tagLayer.clientWidth, h = this.tagLayer.clientHeight;
    for (const el of this.tags.values()) el.dataset.seen = '';
    this._placed = [];
    const anchor = new THREE.Vector3();
    const show = this.callouts ?? {};
    const sim = this.sim, used = new Set();
    const ambs = sim.ambulances();

    // 1. ambulances (click: chase cam)
    if (show.amb !== false) for (const v of ambs) {
      const obj = this.view.vehicleObject(v.id);
      if (!obj) continue;
      const el = this._tag(`a:${v.id}`, 'tag-amb');
      this._set(el, `${v.name} → ${v.hospital.name}`, `ETA ${fmtTime(sim.remainingDistance(v) / 13)} · ${Math.round(v.speed * 3.6)} km/h`);
      this._clickable(el, 'Follow in the chase cam', () => { this.rig.focusAmbulance(v); this.setCam('chase'); });
      anchor.set(obj.position.x, 5.5, obj.position.z);
      this._place(el, anchor, camera, w, h);
    }

    // 2. every signal on each ambulance's remaining route, nearest first (click: intersection cam)
    if (show.route !== false) {
      const items = [];
      for (const v of ambs) {
        const list = sim.routeSignals(v), total = v.passed + list.length;
        list.forEach((it, k) => items.push({ v, ...it, step: v.passed + k + 1, total }));
        for (const p of v.passLog ?? []) if (sim.t - p.t < 5) items.push({ v, node: p.node, dir: null, eta: -1, done: true });
      }
      items.sort((a, b) => a.eta - b.eta);
      // emergency priority is deterministic code (Predictive Green Corridor), whoever times the other signals
      const planner = () => 'Predictive Green Corridor';
      for (const it of items) {
        const n = it.node;
        if (used.has(n.id)) continue;
        const v = it.v, sig = sim.signals.get(n.id);
        let cls, text;
        if (it.done) { cls = 'tag-done'; text = `✓ ${v.name} through`; }
        else if (!sim.aiEnabled) {
          const st = sim.approachState(n, it.dir);
          cls = 'tag-fixed';
          text = `Fixed timer · ${STATE_WORD[st]} now · not pre-cleared`;
        } else if (sig.preempt?.amb === v.id) {
          const st = sim.approachState(n, it.dir);
          cls = st === 'G' ? 'tag-go' : 'tag-corr';
          text = st === 'G' ? `GREEN for ${v.name} · ${Math.max(1, Math.round(it.eta))} s` : `Switching to green for ${v.name}`;
        } else if (sig.preempt) {
          cls = 'tag-plan';
          text = `Held for ${sim.vehicles.get(sig.preempt.amb)?.name ?? 'another ambulance'} first`;
        } else if ((sig.recoverUntil ?? 0) > sim.t && it.startIn != null && it.startIn <= 0) {
          cls = 'tag-plan';
          text = `Cross traffic first · then green for ${v.name}`;
        } else {
          cls = 'tag-plan';
          // predictive corridor: when this light has to start clearing for the ambulance
          const wait = Math.max(1, Math.round(it.startIn ?? 0));
          text = sim.approachState(n, it.dir) === 'G'
            ? `${planner(v)} · green now · priority in ~${wait} s`
            : `${planner(v)} · ${it.n ? `${it.n} queued · ` : ''}starts clearing in ~${wait} s`;
        }
        const el = this._tag(`n:${n.id}`, cls);
        this._set(el, n.name, text, it.step ? `${it.step}/${it.total}` : '');
        const facing = it.dir ?? 'S';
        this._clickable(el, 'Open this intersection camera', () => this._openIntersection(n, facing));
        anchor.set(n.x, 9, n.z);
        this._place(el, anchor, camera, w, h);
        used.add(n.id);
      }
    }

    // 3. hospitals (click: zoom to the campus)
    if (show.hosp !== false) for (const hsp of C.HOSPITALS) {
      const el = this._tag(`h:${hsp.id}`, 'tag-hosp');
      const inbound = ambs.filter((a) => a.hospital.id === hsp.id);
      const parked = [...sim.vehicles.values()].filter((p) => p.type === 'parked' && p.hospital.id === hsp.id).length;
      this._set(el, hsp.name, inbound.length ? `Incoming · ${inbound.map((a) => a.name).join(', ')}` : parked ? `${parked} ambulance${parked > 1 ? 's' : ''} in the bay` : 'Hospital · ready');
      el.classList.toggle('live', inbound.length > 0);
      const at = this.view.hospitalAnchors.get(hsp.id);
      this._clickable(el, 'Zoom to the hospital', () => this.rig.focus(at, 5));
      this._place(el, at, camera, w, h);
    }

    // 4. recent AI signal decisions, for a few seconds after each one
    if (show.ai !== false) {
      // Nemotron's own switches only (the local rules switch far too often to label), newest four
      const recent = [...sim.recentSwitch].filter(([, sw]) => sw.by === 'Nemotron' && sim.t - sw.t < 6).sort((a, b) => b[1].t - a[1].t).slice(0, 4);
      for (const [id, sw] of recent) {
        if (used.has(id)) continue;
        const n = sim.nodes.get(id);
        const el = this._tag(`n:${id}`, 'tag-ai');
        this._set(el, n.name, `${sw.by} · green to ${sw.to} (${sw.cars} car${sw.cars === 1 ? '' : 's'})`);
        const facing = C.AVENUES.includes(sw.to) ? 'S' : 'E';  // look along the road that just got green
        this._clickable(el, 'Open this intersection camera', () => this._openIntersection(n, facing));
        anchor.set(n.x, 9, n.z);
        this._place(el, anchor, camera, w, h);
        used.add(id);
      }
    }

    // 5. congestion
    if (show.queue !== false) for (const n of this.rig.realNodes) {
      if (used.has(n.id)) continue;
      let worst = null, q = 0;
      for (const dir of ['N', 'S', 'E', 'W']) {
        const qq = sim.queue(n, dir);
        if (qq > q) { q = qq; worst = dir; }
      }
      if (q < QUEUE_CARD) continue;
      const road = C.AXIS[worst] === 'EW' ? C.STREETS[n.j] : C.AVENUES[n.i];
      const el = this._tag(`n:${n.id}`, 'tag-queue');
      this._set(el, n.name, `Queue · ${q} on ${road} ${C.DIR_WORD[worst]}`);
      this._clickable(el, 'Open this intersection camera', () => this._openIntersection(n, worst));
      anchor.set(n.x, 9, n.z);
      this._place(el, anchor, camera, w, h);
      used.add(n.id);
    }

    const hn = this.hoverNode;
    if (hn && !used.has(hn.id)) {
      const el = this._tag(`n:${hn.id}`, 'tag-hover');
      const ns = sim.approachState(hn, 'N'), ew = sim.approachState(hn, 'E');
      this._set(el, hn.name, `${C.AVENUES[hn.i]} ${STATE_WORD[ns]} · ${C.STREETS[hn.j]} ${STATE_WORD[ew]}`);
      anchor.set(hn.x, 9, hn.z);
      this._place(el, anchor, camera, w, h);
    }

    for (const [key, el] of this.tags) {
      if (!el.dataset.seen) { el.remove(); this.tags.delete(key); }
    }
  }

  _ambDist(sig) {
    const obj = this.view.vehicleObject(sig.preempt.amb);
    return obj ? Math.hypot(obj.position.x - sig.node.x, obj.position.z - sig.node.z) : 1e8;
  }

  // Vision-style detection boxes drawn over the intersection camera
  _drawOverlay(camera) {
    const cv = this.overlay;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = this.octx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.rig.mode !== 'intersection') return;
    const n = this.rig.camNode;
    const corners = [];
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz]);
    const v3 = new THREE.Vector3();
    ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
    ctx.lineWidth = 1.5;
    for (const v of this.sim.vehicles.values()) {
      const obj = this.view.vehicleObject(v.id);
      if (!obj) continue;
      const dx = obj.position.x - n.x, dz = obj.position.z - n.z;
      if (dx * dx + dz * dz > 46 * 46) continue;
      const amb = v.type === 'ambulance';
      const hx = amb ? 3.6 : 2.2, hy = amb ? 2.9 : 2.0, hz = amb ? 1.2 : 1.0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, behind = false;
      for (const [sx, sy, sz] of corners) {
        v3.set(sx * hx, sy * hy, sz * hz).applyMatrix4(obj.matrixWorld).project(camera);
        if (v3.z > 1) { behind = true; break; }
        const px = (v3.x * 0.5 + 0.5) * w, py = (-v3.y * 0.5 + 0.5) * h;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      if (behind || maxX < 0 || minX > w || maxY < 0 || minY > h) continue;
      const col = amb ? '#ff8a8d' : '#7cc8ff';
      ctx.strokeStyle = col;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
      const label = amb ? `ambulance ${v.name}` : v.speed < 0.6 ? 'car · stopped' : 'car';
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(10,12,15,0.8)';
      ctx.fillRect(minX, minY - 16, tw, 15);
      ctx.fillStyle = col;
      ctx.fillText(label, minX + 4, minY - 5);
    }
  }
}
