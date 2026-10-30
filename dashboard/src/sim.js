// UrbanFlow AI — in-browser traffic simulation.
//
// Multi-lane roads, lane changes, signals with exclusive emergency preemption, and an
// intersection reservation model: a vehicle only enters an intersection when no vehicle
// already inside is on a crossing path, its exit lane has room, and (for permissive left
// turns) no oncoming car is about to arrive. The signal controller here is a local rule-based
// stand-in; in Phase 3 the decision step (`_decide`) is replaced by Nemotron.

import * as C from './config.js';

const OTHER = { EW: 'NS', NS: 'EW' };
const ACCEL = 3.4;
const BRAKE = 7;
const CMF_DECEL = 4.5;
const CHANGE_RATE = 1.7;
// Predictive Green Corridor tuning (see corridorPlan)
const CORR = {
  STARTUP: 3.0,        // s for the first queued car to get going and cross (measured in this sim: median 2.9 s)
  HEADWAY: 2.7,        // s per further car in the same lane (measured: ~2.6–3.1 s)
  TURN_EXTRA: 1.0,     // s more for each of those cars that turns (it takes the corner slowly)
  MARGIN_BASE: 3.0,    // s of safety buffer...
  MARGIN_PER_S: 0.08,  // ...plus 8% of the ETA, since far estimates are less certain
  MARGIN_MAX: 6,
  PLAN_AHEAD: 10,      // PLANNED this many seconds before clearing must start
  CANCEL_HYST: 10,     // re-plan a hold only when the ambulance is this much later than needed
};  // m/s sideways during a lane change
// How far a yielding car edges right and a passing ambulance edges left, by lanes on the road.
// Sized so the two clear each other (car 1.95 m, ambulance 2.3 m wide) without either touching the next lane over.
const PULL_OFF = { 1: 1.5, 2: 0.95 };
const PASS_OFF = { 1: -0.95, 2: -1.05 };
const ease = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const MAX_YAW = 0.22;     // most a vehicle visibly angles while moving sideways (rad)

// Oriented rectangle around a vehicle centre; heading uses the sim convention atan2(-dz, dx)
export function footprint(p, hl, hw) {
  const c = Math.cos(p.heading), s = -Math.sin(p.heading);
  return { x: p.x, z: p.z, ax: [c, s], ay: [-s, c], hl, hw };
}

export function boxesOverlap(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (dx * dx + dz * dz > (a.hl + a.hw + b.hl + b.hw) ** 2) return false;
  for (const axis of [a.ax, a.ay, b.ax, b.ay]) {
    const r = (o) => Math.abs(o.ax[0] * axis[0] + o.ax[1] * axis[1]) * o.hl + Math.abs(o.ay[0] * axis[0] + o.ay[1] * axis[1]) * o.hw;
    if (Math.abs(dx * axis[0] + dz * axis[1]) > r(a) + r(b)) return false;
  }
  return true;
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Sim {
  constructor(seed = 20261030) {
    this.targetCars = C.TARGET_CARS;   // how busy the city is (reset(seed, { cars }) can change it)
    this.rng = C.makeRng(seed);
    this.t = 0;
    this.aiEnabled = false;         // starts on fixed timers; the AI control switch turns adaptive control on
    this.controller = 'rules';      // who decides signal timing when adaptive: 'rules' or 'nemotron'
    this.fallback = false;          // nemotron selected but unavailable: rules take over
    this.nodes = new Map();
    this.links = [];
    this.signals = new Map();
    this.vehicles = new Map();
    this.events = [];
    this.eventSeq = 0;
    this.timers = [];               // [{t, fn}] run inside step() at an exact sim time (scripted runs replay exactly)
    this.observers = new Set();     // fn(sim, dt) called after every step; read-only (demo measurements)
    this.priorityS = 0;             // intersection-seconds under emergency priority since the last reset
    this.epoch = 0;                 // bumped on every reset, so late model replies from before it are ignored
    this.nextId = 1;
    this.nextAmb = 1;
    this.trips = [];
    this.ambTrips = [];
    this.decisionTimer = 0;
    this.decisions = [];   // sim times of signal switches chosen by a controller (rules or Nemotron)
    this.history = [];     // dashboard samples every 2 sim-seconds, for the sparklines
    this.recentSwitch = new Map();  // node id -> last controller switch there, for the map callouts
    this.idleSwitches = 0;          // greens ended by the idle-green safeguard (deterministic, not the model)
    this.idlePending = []; this.idleLogT = -1e9;
    this.lastSample = -1e9;
    this.lastLog = {};
    this._build();
    this._seed();
    this.log('SYSTEM', 'Simulation started on fixed 18 s signal timers. Turn on AI control to let the city adapt.');
  }

  rand(a = 0, b = 1) { return a + this.rng() * (b - a); }
  pick(arr) { return arr[Math.floor(this.rng() * arr.length)]; }

  // ---------- network ----------
  _build() {
    for (let i = -1; i <= C.NX; i++) {
      for (let j = -1; j <= C.NY; j++) {
        const real = C.isIntersection(i, j);
        const iOut = i === -1 || i === C.NX, jOut = j === -1 || j === C.NY;
        if (!real && iOut === jOut) continue;
        const p = C.nodePos(i, j);
        this.nodes.set(`${i},${j}`, { id: `${i},${j}`, i, j, x: p.x, z: p.z, real, name: real ? C.intersectionName(i, j) : 'city edge', out: {}, in: {}, occ: new Map() });
      }
    }
    const step = { E: [1, 0], W: [-1, 0], S: [0, 1], N: [0, -1] };
    for (const a of this.nodes.values()) {
      for (const dir of Object.keys(step)) {
        const b = this.nodes.get(`${a.i + step[dir][0]},${a.j + step[dir][1]}`);
        if (!b || (!a.real && !b.real)) continue;
        const L = C.AXIS[dir] === 'EW' ? C.streetLanes(a.real ? a.j : b.j) : C.avenueLanes(a.real ? a.i : b.i);
        const link = { id: `${a.id}>${b.id}`, from: a, to: b, dir, L, len: C.BLOCK, lanes: Array.from({ length: L }, () => []) };
        const crossAt = (n) => (C.AXIS[dir] === 'EW' ? C.avenueLanes(n.i) : C.streetLanes(n.j));
        link.turnIn = b.real ? C.halfW(crossAt(b)) + 0.6 : 0;
        link.turnOut = a.real ? C.halfW(crossAt(a)) + 0.6 : 0;
        link.stopS = b.real ? link.len - (C.halfW(crossAt(b)) + 2.6) : link.len;
        a.out[dir] = link;
        b.in[dir] = link;
        this.links.push(link);
      }
    }
    for (const h of C.HOSPITALS) {
      const n = this.nodes.get(`${h.node[0]},${h.node[1]}`), lay = C.hospitalLayout(h);
      n.hospital = { h, lay, outLink: n.out[lay.outDir], inLink: n.in[lay.inDir], badLink: n.in[lay.badDir], slots: lay.slots.map(() => null) };
    }
    for (const n of this.nodes.values()) {
      if (!n.real) continue;
      this.signals.set(n.id, {
        node: n, phase: this.rng() < 0.5 ? 'EW' : 'NS', stage: 'G', t: this.rand(0, C.FIXED_GREEN),
        preempt: null, drop: null, lastAxis: null, extendedLogged: false,
      });
      this._buildConflicts(n);
    }
  }

  // ---------- geometry ----------
  lanePoint(link, lane, s, lat = 0) {
    const d = C.DIRS[link.dir], r = C.rightOf(link.dir), off = C.laneOff(link.L, lane) + lat;
    return { x: link.from.x + d.dx * s + r.x * off, z: link.from.z + d.dz * s + r.z * off };
  }

  outLaneFor(inLink, inLane, outLink) {
    if (outLink.dir === C.LEFT[inLink.dir]) return 0;
    if (outLink.dir === C.RIGHT[inLink.dir]) return outLink.L - 1;
    return Math.min(inLane, outLink.L - 1);
  }

  // Bezier through the intersection from the in-lane to the out-lane
  _arc(inLink, inLane, outLink, outLane) {
    let D1 = inLink.turnIn, D2 = outLink.turnOut;
    if (outLink.dir === C.RIGHT[inLink.dir]) {
      // right turns hug the corner; start earlier and finish later so the radius is at least ~5.5 m
      D1 = Math.max(D1, C.laneOff(outLink.L, outLane) + 5.5);
      D2 = Math.max(D2, C.laneOff(inLink.L, inLane) + 5.5);
    }
    const E = this.lanePoint(inLink, inLane, inLink.len - D1);
    const X = this.lanePoint(outLink, outLane, D2);
    let P;
    if (inLink.dir === outLink.dir) P = { x: (E.x + X.x) / 2, z: (E.z + X.z) / 2 };
    else P = C.AXIS[inLink.dir] === 'EW' ? { x: X.x, z: E.z } : { x: E.x, z: X.z };
    return { E, P, X, D1, D2 };
  }

  _arcAt(a, t) {
    const u = 1 - t;
    const tx = 2 * u * (a.P.x - a.E.x) + 2 * t * (a.X.x - a.P.x);
    const tz = 2 * u * (a.P.z - a.E.z) + 2 * t * (a.X.z - a.P.z);
    return {
      x: u * u * a.E.x + 2 * u * t * a.P.x + t * t * a.X.x,
      z: u * u * a.E.z + 2 * u * t * a.P.z + t * t * a.X.z,
      heading: Math.atan2(-tz, tx),
    };
  }

  _mvKey(inDir, inLane, outDir) { return `${inDir}${inLane}${outDir}`; }

  // Which movements through this intersection have crossing or merging paths
  _buildConflicts(n) {
    const mvs = [];
    for (const [inDir, inLink] of Object.entries(n.in)) {
      for (let k = 0; k < inLink.L; k++) {
        for (const [outDir, outLink] of Object.entries(n.out)) {
          if (outDir === C.OPPOSITE[inDir]) continue;
          const ol = this.outLaneFor(inLink, k, outLink);
          const arc = this._arc(inLink, k, outLink, ol);
          // footprints along the path: one set sized like an ambulance (used whenever an ambulance is involved),
          // one sized like a car, so two cars whose paths only come close can share the intersection
          const SAMPLES = 18;
          const sweep = (hl, hw, endW) => {
            const boxes = [];
            for (let q = 0; q <= SAMPLES; q++) boxes.push(footprint(this._arcAt(arc, q / SAMPLES), hl, hw));
            // include the stretch just before and after the arc, where the rear is still in the box
            boxes.push(footprint({ ...arc.E, heading: this._arcAt(arc, 0).heading }, hl, endW));
            boxes.push(footprint({ ...arc.X, heading: this._arcAt(arc, 1).heading }, hl, endW));
            return boxes;
          };
          mvs.push({
            key: this._mvKey(inDir, k, outDir), inDir, inLane: k, outDir, outLane: ol,
            boxes: sweep(C.AMB_LEN / 2 + 0.3, 2.3 / 2 + 0.25, 1.4),
            carBoxes: sweep(C.CAR_LEN / 2 + 0.3, 1.95 / 2 + 0.2, 1.2),
          });
        }
      }
    }
    n.conflict = new Map(mvs.map((m) => [m.key, new Set()]));
    n.conflictCar = new Map(mvs.map((m) => [m.key, new Set()]));
    n.conflictAmbCar = new Map(mvs.map((m) => [m.key, new Set()]));   // ambulance on movement key × car on the movements in the set
    n.conflictCarAmb = new Map(mvs.map((m) => [m.key, new Set()]));   // car on movement key × ambulance on the movements in the set
    const crosses = (ba, bb) => {
      for (let p = 0; p < ba.length; p++) for (let q = 0; q < bb.length; q++) if (boxesOverlap(ba[p], bb[q])) return true;
      return false;
    };
    for (let a = 0; a < mvs.length; a++) for (let b = a + 1; b < mvs.length; b++) {
      const A = mvs[a], B = mvs[b];
      if (A.inDir === B.inDir && A.inLane === B.inLane) continue;
      const merge = A.outDir === B.outDir && A.outLane === B.outLane;
      if (merge || crosses(A.boxes, B.boxes)) { n.conflict.get(A.key).add(B.key); n.conflict.get(B.key).add(A.key); }
      if (merge || crosses(A.carBoxes, B.carBoxes)) { n.conflictCar.get(A.key).add(B.key); n.conflictCar.get(B.key).add(A.key); }
      // an ambulance and a car: each at its own size
      if (merge || crosses(A.boxes, B.carBoxes)) { n.conflictAmbCar.get(A.key).add(B.key); n.conflictCarAmb.get(B.key).add(A.key); }
      if (merge || crosses(A.carBoxes, B.boxes)) { n.conflictCarAmb.get(A.key).add(B.key); n.conflictAmbCar.get(B.key).add(A.key); }
    }
  }

  linkName(link) {
    const a = link.from, b = link.to;
    if (C.AXIS[link.dir] === 'EW') {
      const st = C.STREETS[a.real ? a.j : b.j];
      const i1 = Math.min(a.i, b.i), i2 = Math.max(a.i, b.i);
      if (i1 < 0 || i2 >= C.NX) return `${st} at the city edge`;
      return `${st} between ${C.AVENUES[i1]} and ${C.AVENUES[i2]}`;
    }
    const av = C.AVENUES[a.real ? a.i : b.i];
    const j1 = Math.min(a.j, b.j), j2 = Math.max(a.j, b.j);
    if (j1 < 0 || j2 >= C.NY) return `${av} at the city edge`;
    return `${av} between ${C.STREETS[j1]} and ${C.STREETS[j2]}`;
  }

  roadOf(link) {
    return C.AXIS[link.dir] === 'EW' ? C.STREETS[link.from.real ? link.from.j : link.to.j] : C.AVENUES[link.from.real ? link.from.i : link.to.i];
  }

  axisRoad(node, axis) { return axis === 'EW' ? C.STREETS[node.j] : C.AVENUES[node.i]; }

  // ---------- events ----------
  log(kind, text, minGap = 0) {
    if (minGap && this.t - (this.lastLog[kind] ?? -1e9) < minGap) return;
    this.lastLog[kind] = this.t;
    this.events.push({ seq: ++this.eventSeq, t: this.t, kind, text });
    if (this.events.length > 80) this.events.shift();
  }

  // ---------- signals ----------
  _covers(phase, dir) { return phase === dir || phase === C.AXIS[dir]; }

  approachState(node, dir) {
    if (!node.real) return 'G';
    const sig = this.signals.get(node.id);
    if (sig.drop === dir) return sig.dropT < C.YELLOW ? 'Y' : 'R';
    if (!this._covers(sig.phase, dir)) return 'R';
    return sig.stage === 'G' ? 'G' : sig.stage === 'Y' ? 'Y' : 'R';
  }

  _toYellow(sig) { sig.stage = 'Y'; sig.t = 0; }

  _nextPhase(sig) {
    if (sig.preempt) return sig.preempt.dir;
    if (sig.phase.length === 1) {
      // coming out of an emergency phase: serve the busier axis first
      const n = sig.node;
      return this.queue(n, 'EW') >= this.queue(n, 'NS') ? 'EW' : 'NS';
    }
    return OTHER[sig.phase];
  }

  _updateSignal(sig, dt) {
    sig.t += dt;
    if (sig.drop) {
      sig.dropT += dt;
      if (sig.dropT >= C.YELLOW + C.ALL_RED) { sig.phase = sig.preempt ? sig.preempt.dir : sig.phase; sig.drop = null; }
      return;
    }
    if (sig.stage === 'Y') { if (sig.t >= C.YELLOW) { sig.stage = 'R'; sig.t = 0; } return; }
    if (sig.stage === 'R') {
      if (sig.t >= C.ALL_RED) { sig.phase = this._nextPhase(sig); sig.stage = 'G'; sig.t = 0; sig.extendedLogged = false; }
      return;
    }
    // green
    if (sig.preempt) {
      const want = sig.preempt.dir;
      if (sig.phase === want) return;
      if (sig.preempt.hold && this._covers(sig.phase, want)) return;   // holding an existing green as it is
      if (sig.phase === C.AXIS[want]) { sig.drop = C.OPPOSITE[want]; sig.dropT = 0; return; }  // keep its direction green, drop the opposite one
      this._toYellow(sig);
      return;
    }
    if (sig.phase.length === 1) { this._toYellow(sig); return; }  // emergency over
    // PLANNED corridor: an ambulance will need this green shortly, so it isn't ended now
    if (sig.planned && sig.planned.until > this.t && this._covers(sig.phase, sig.planned.dir)) return;
    if (!this.aiEnabled && sig.t >= C.FIXED_GREEN) this._toYellow(sig);
    if (this.aiEnabled && sig.t >= C.MAX_GREEN) this._toYellow(sig);
  }

  queue(node, axisOrDir) {
    const dirs = axisOrDir === 'EW' ? ['E', 'W'] : axisOrDir === 'NS' ? ['N', 'S'] : [axisOrDir];
    let n = 0;
    for (const d of dirs) {
      const link = node.in[d];
      if (!link) continue;
      for (const lane of link.lanes) for (const v of lane) if (v.lane === lane.idx && v.s > link.stopS - 55 && v.speed < 1 && !v.box) n++;
    }
    return n;
  }

  // Stand-in for the Nemotron decision step: runs every 2 s of sim time while adaptive control is on.
  _decide() {
    for (const sig of this.signals.values()) {
      if (sig.stage !== 'G' || sig.preempt || sig.drop || sig.phase.length === 1 || sig.t < C.MIN_GREEN) continue;
      if (sig.planned && sig.planned.until > this.t) continue;   // an ambulance's corridor is about to need it
      const g = sig.phase, r = OTHER[g], n = sig.node;
      const qG = this.queue(n, g), qR = this.queue(n, r);
      if (qG === 0 && qR > 0) {
        this._toYellow(sig);
        this.decisions.push(this.t);
        this.recentSwitch.set(n.id, { t: this.t, by: 'Rules', to: this.axisRoad(n, r), cars: qR });
        this.log('FLOW', `${n.name}: nobody waiting on ${this.axisRoad(n, g)}. Switching early for ${qR} car${qR > 1 ? 's' : ''} on ${this.axisRoad(n, r)}.`, 7);
      } else if (qR >= qG + 5 && sig.t >= 12) {
        this._toYellow(sig);
        this.decisions.push(this.t);
        this.recentSwitch.set(n.id, { t: this.t, by: 'Rules', to: this.axisRoad(n, r), cars: qR });
        this.log('CONGESTION', `Queue of ${qR} on ${this.axisRoad(n, r)} at ${n.name}. Ending ${this.axisRoad(n, g)} green after ${Math.round(sig.t)} s.`, 3);
      } else if (qG >= 5 && sig.t >= C.FIXED_GREEN && !sig.extendedLogged) {
        sig.extendedLogged = true;
        this.log('CONGESTION', `Queue of ${qG} on ${this.axisRoad(n, g)} at ${n.name}. Holding green past the fixed ${C.FIXED_GREEN} s.`, 3);
      }
    }
  }

  // ---------- Nemotron controller hooks ----------
  // Which controller a trip counts for: the one chosen, even while rules briefly cover for Nemotron
  tripMode() {
    if (!this.aiEnabled) return 'Fixed';
    return this.controller === 'nemotron' ? 'Nemotron' : 'Rules';
  }

  modeLabel() {
    if (!this.aiEnabled) return 'Fixed';
    return this.controller === 'nemotron' && !this.fallback ? 'Nemotron' : 'Rules';
  }

  setController(mode) {
    if (mode === this.controller) return;
    this.controller = mode;
    for (const v of this.vehicles.values()) if (v.type === 'ambulance') v.mode = 'Mixed';
    this.log('SYSTEM', mode === 'nemotron' ? 'Signal decisions handed to Nemotron.' : 'Signal decisions back on the local rules.');
  }

  setFallback(on, reason = '') {
    if (on === this.fallback) return;
    this.fallback = on;
    if (on) this.log('FALLBACK', `Nemotron unavailable${reason ? ` (${reason})` : ''}. Local rules are running the signals until it is back.`);
    else this.log('NEMOTRON', 'Nemotron is back in control of the signals.');
  }

  _arriving(node, axis) {
    let n = 0;
    for (const d of axis === 'EW' ? ['E', 'W'] : ['N', 'S']) {
      const link = node.in[d];
      if (!link) continue;
      for (const lane of link.lanes) for (const v of lane) if (v.lane === lane.idx && !v.box && v.speed >= 1 && link.stopS - v.s < 60) n++;
    }
    return n;
  }

  // Compact state for the model: only intersections whose green could reasonably end now
  signalSnapshot() {
    const rows = [];
    for (const sig of this.signals.values()) {
      if (sig.stage !== 'G' || sig.preempt || sig.drop || sig.phase.length === 1 || sig.t < C.MIN_GREEN) continue;
      const n = sig.node, g = sig.phase, r = OTHER[g];
      const qG = this.queue(n, g), qR = this.queue(n, r), aR = this._arriving(n, r);
      if (qR === 0 && aR === 0) continue;  // nobody waiting on red: nothing to decide
      rows.push({
        id: n.id, name: n.name, green_road: this.axisRoad(n, g), green_for_s: Math.round(sig.t),
        waiting_on_green: qG, red_road: this.axisRoad(n, r), waiting_on_red: qR, approaching_red: aR,
      });
    }
    // most clear-cut first (nobody on green while cars wait on red, then the biggest imbalance), so the
    // intersections that matter most are never the ones left over when the model returns only a few
    const pri = (x) => (x.waiting_on_green === 0 && x.waiting_on_red > 0 ? 1000 : 0) + x.waiting_on_red + x.approaching_red - x.waiting_on_green;
    rows.sort((a, b) => pri(b) - pri(a));
    return { sim_time_s: Math.round(this.t), min_green_s: C.MIN_GREEN, max_green_s: C.MAX_GREEN, intersections: rows };
  }

  // Idle-green safeguard, deterministic and separate from the model. With Nemotron timing the signals, a green can
  // otherwise sit unused until the model gets to it (each reply covers only a handful of intersections) or until
  // MAX_GREEN. It acts only when, for IDLE_GREEN_S in a row: the green has run its minimum, nobody is stopped on or
  // approaching the green road, cars are stopped on the red road, and no ambulance corridor holds or plans it.
  // The switch goes through the normal yellow and all-red. Labelled IDLE GREEN in the feed, never as Nemotron.
  _idleGreen(dt) {
    for (const sig of this.signals.values()) {
      const n = sig.node;
      let idle = sig.stage === 'G' && !sig.preempt && !sig.drop && sig.phase.length === 2 && sig.t >= C.MIN_GREEN
        && !(sig.planned && sig.planned.until > this.t);
      let qR = 0;
      if (idle) {
        const g = sig.phase;
        qR = this.queue(n, OTHER[g]);
        idle = qR > 0 && this.queue(n, g) === 0 && this._arriving(n, g) === 0;
      }
      if (!idle) { sig.idleT = 0; continue; }
      sig.idleT = (sig.idleT ?? 0) + dt;
      if (sig.idleT < C.IDLE_GREEN_S) continue;
      sig.idleT = 0;
      this._toYellow(sig);
      this.idleSwitches++;
      const red = this.axisRoad(n, OTHER[sig.phase]);
      this.recentSwitch.set(n.id, { t: this.t, by: 'Idle green', to: red, cars: qR });
      this.idlePending.push(`${n.name} (${qR} on ${red})`);
    }
    // one summary line at most every 6 s, so the feed stays readable
    if (this.idlePending.length && this.t - this.idleLogT >= 6) {
      const list = this.idlePending, shown = list.slice(0, 2).join(', ');
      this.log('IDLE', `Ended ${list.length === 1 ? 'an unused green' : `${list.length} unused greens`} with cars waiting on red: ${shown}${list.length > 2 ? ` and ${list.length - 2} more` : ''}. Deterministic safeguard, not Nemotron.`);
      this.idlePending = []; this.idleLogT = this.t;
    }
  }

  // Apply one model decision, re-checked against the live state (it may have changed while the call was out)
  // Returns the intersection name if applied, or { rejected } when the live queues do not support it.
  applySwitch(id, why, { silent = false } = {}) {
    const sig = this.signals.get(String(id).trim());
    if (!sig || !this.aiEnabled || this.controller !== 'nemotron') return false;
    if (sig.stage !== 'G' || sig.preempt || sig.drop || sig.phase.length === 1 || sig.t < C.MIN_GREEN) return false;
    if (sig.planned && sig.planned.until > this.t) return false;   // held for an ambulance's corridor (deterministic code decides)
    const n = sig.node, g = sig.phase, r = OTHER[g];
    const qG = this.queue(n, g), qR = this.queue(n, r), aR = this._arriving(n, r);
    const green = this.axisRoad(n, g), red = this.axisRoad(n, r);
    // guardrail: never cut a green that is still busier than the road it would hand over to
    if (qR + aR === 0 || (qG > 0 && qR + aR <= qG)) return { rejected: n.name };
    this._toYellow(sig);
    this.decisions.push(this.t);
    this.recentSwitch.set(n.id, { t: this.t, by: 'Nemotron', to: red, cars: qR + aR });
    if (!silent) {
      // the numbers come from the live sim; the model's own words are added when they read well
      const reason = this._cleanWhy(why, [green, red]);
      this.log('NEMOTRON', `${n.name}: green to ${red} (${qR + aR} cars) from ${green} (${qG}).${reason ? ` "${reason}"` : ''}`);
    }
    return n.name;
  }

  // Keep the model's own words only when they read as a sentence about these roads
  _cleanWhy(why, roads) {
    const t = String(why || '').replace(/\s+/g, ' ').replace(/[_]/g, ' ').trim().slice(0, 120);
    const words = t.split(' ').filter((w) => /[a-z]{3,}/i.test(w));
    if (words.length < 4) return '';
    // it must name both roads at this intersection and no other road, or it is describing the wrong place
    const low = t.toLowerCase();
    if (!roads.every((rd) => low.includes(rd.toLowerCase()))) return '';
    const others = [...C.STREETS, ...C.AVENUES].filter((rd) => !roads.includes(rd));
    if (others.some((rd) => low.includes(rd.toLowerCase()))) return '';
    return t.replace(/\b1 cars\b/g, '1 car');
  }

  // Up to three distinct routes to the nearest hospital, for the dispatch model to choose from
  _candidates(start, goal) {
    const out = [], extra = new Map();
    for (let k = 0; k < 3; k++) {
      const r = this._route(start, goal, extra);
      if (!r) break;
      const key = r.links.map((l) => l.id).join('|');
      if (!out.some((c) => c.key === key)) out.push({ key, links: r.links });
      for (const l of r.links) extra.set(l, (extra.get(l) ?? 0) + 55);
    }
    return out.map((c, idx) => {
      let queued = 0, len = 0, reds = 0, turns = 0;
      c.links.forEach((l, k) => { if (k && l.dir !== c.links[k - 1].dir) turns++; });
      for (const l of c.links) {
        len += l.len;
        for (const lane of l.lanes) for (const v of lane) if (v.lane === lane.idx && v.speed < 1) queued++;
        if (l.to.real && this.approachState(l.to, l.dir) !== 'G') reds++;
      }
      return {
        index: idx, links: c.links, summary: this._routeSummary(c.links), length_m: Math.round(len),
        intersections: c.links.length, turns, queued_cars: queued, red_now: reds,
        est_s: Math.round(len / 13 + turns * 2.5 + queued * 1.6 + (this.aiEnabled ? 0 : reds * 6)),
      };
    });
  }

  chooseRoute(v, idx, why) {
    if (!this.vehicles.has(v.id) || !v.candidates) return false;
    const c = v.candidates[idx];
    if (!c) return false;
    const reason = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    v.holdUntil = 0;  // route decided: depart
    const changed = c.key !== v.route.map((l) => l.id).join('|');
    if (changed && (v.routeIdx !== 0 || v.link !== c.links[0] || v.box)) {
      this.log('NEMOTRON', `${v.name}: route ${String.fromCharCode(65 + idx)} chosen but ${v.name} has already committed, keeping its current path. ${reason}`);
      return false;
    }
    if (changed) {
      v.route = c.links;
      v.routeIdx = 0;
      v.totalNodes = v.passed + c.links.length;
      this._plan(v);
    }
    v.aiRoute = true;
    this.log('NEMOTRON', `${v.name}: route ${String.fromCharCode(65 + idx)} via ${c.summary}. ${reason}`);
    this.log('CORRIDOR', `Pre-clearing ${c.links.length} intersections for ${v.name}.`);
    return true;
  }

  setAI(on) {
    if (on === this.aiEnabled) return;
    this.aiEnabled = on;
    if (!on) {
      for (const sig of this.signals.values()) sig.preempt = null;
      for (const v of this.vehicles.values()) if (v.type === 'ambulance') v.mode = 'Fixed';
      this.log('SYSTEM', `Adaptive control off. All signals on fixed ${C.FIXED_GREEN} s timers, no emergency pre-clearing.`);
    } else {
      this.log('SYSTEM', 'Adaptive control on. Queue-based timing and emergency corridors active.');
    }
  }

  // ---------- vehicles ----------
  _addVehicle(link, lane, s, type = 'car', extra = {}) {
    const v = {
      id: this.nextId++, type, link, lane, s, len: type === 'car' ? C.CAR_LEN : C.AMB_LEN,
      speed: type === 'car' ? this.rand(5, 9) : 6, maxSpeed: type === 'car' ? this.rand(11, 14) : 17,
      wait: 0, born: this.t, tint: Math.floor(this.rng() * 1000), mv: null, prev: null, box: null,
      lat: 0, latVel: 0, oldLane: null, pull: 0, pullFor: null, passLat: 0, ...extra,
    };
    this.vehicles.set(v.id, v);
    this._plan(v);
    return v;
  }

  // Pick the next movement (and the lane it needs) at the end of the current link
  _plan(v) {
    const node = v.link.to;
    if (!node.real) { v.mv = null; return; }
    if (v.type === 'ambulance') {
      const out = v.route[v.routeIdx + 1];
      v.mv = out ? { out, outLane: null, want: v.lane } : null;
      if (v.mv && v.link.L === 2) v.mv.want = out.dir === C.RIGHT[v.link.dir] ? 1 : 0;
      v.entryS = this._entryS(v);
      return;
    }
    const d = v.link.dir, opts = [];
    if (node.out[d]) opts.push([node.out[d], 0.6]);
    if (node.out[C.LEFT[d]]) opts.push([node.out[C.LEFT[d]], 0.2]);
    if (node.out[C.RIGHT[d]]) opts.push([node.out[C.RIGHT[d]], 0.2]);
    let r = this.rng() * opts.reduce((a, o) => a + o[1], 0), out = opts[0][0];
    for (const [l, w] of opts) { r -= w; if (r <= 0) { out = l; break; } }
    let want = v.lane;
    if (out.dir === C.LEFT[d]) want = 0;
    else if (out.dir === C.RIGHT[d]) want = v.link.L - 1;
    v.mv = { out, want, outLane: null };
  }

  _fixMove(v) {
    // couldn't reach the needed lane in time: choose a movement allowed from the current lane
    const node = v.link.to, d = v.link.dir, L = v.link.L;
    const opts = [];
    if (node.out[d]) opts.push(node.out[d]);
    if (v.lane === 0 && node.out[C.LEFT[d]]) opts.push(node.out[C.LEFT[d]]);
    if (v.lane === L - 1 && node.out[C.RIGHT[d]]) opts.push(node.out[C.RIGHT[d]]);
    const out = opts[0];
    v.mv = { out, want: v.lane, outLane: null };
  }

  _occupies(v, lane) {
    return v.lane === lane || (v.oldLane === lane && Math.abs(v.lat) > 0.7);
  }

  _rebuildLanes() {
    for (const l of this.links) l.lanes.forEach((arr, k) => { arr.length = 0; arr.idx = k; });
    for (const v of this.vehicles.values()) {
      if (v.type === 'parked') {
        // pulling in: it blocks its lane and the lanes it crosses until it is off the road
        if (v.park.d < v.park.offRoad) for (let k = v.lane; k < v.link.L; k++) v.link.lanes[k].push(v);
        continue;
      }
      const lanes = v.link.lanes;
      lanes[v.lane].push(v);
      if (v.oldLane !== null && v.oldLane !== v.lane && Math.abs(v.lat) > 0.7) lanes[v.oldLane].push(v);
    }
    for (const l of this.links) for (const arr of l.lanes) arr.sort((a, b) => b.s - a.s);
  }

  // nearest vehicle ahead of v (same link) in any lane it occupies; ambulances ignore cars that have pulled over
  _leader(v) {
    let best = null;
    const lanes = v.oldLane !== null && Math.abs(v.lat) > 0.7 ? [v.lane, v.oldLane] : [v.lane];
    for (const k of lanes) {
      for (const o of v.link.lanes[k]) {
        if (o === v || o.s <= v.s) continue;
        if (this._passable(v, o)) continue;
        if (!best || o.s < best.s) best = o;
      }
    }
    return best;
  }

  // An ambulance may pass a car that has pulled over for it, once it has edged left itself
  _passable(v, o) {
    if (v.type !== 'ambulance' || o.type !== 'car' || o.pullFor !== v.id || o.pull < 0.85 || o.speed > 1.5) return false;
    return v.passLat < -0.9 || o.s - o.len - v.s > 8;
  }

  _tail(link, lane, forV = null) {
    let m = Infinity, who = null;
    for (const o of link.lanes[lane]) {
      if (forV && this._passable(forV, o)) continue;
      if (o.s - o.len < m) { m = o.s - o.len; who = o; }
    }
    return { gap: m, who };
  }

  _gapOk(v, lane) {
    // room to move into `lane`: no one alongside, enough space to the car ahead and behind
    for (const o of v.link.lanes[lane]) {
      if (o === v) continue;
      const ahead = o.s - o.len - v.s, behind = v.s - v.len - o.s;
      if (o.s >= v.s && ahead < Math.max(5, v.speed * 0.9)) return false;
      if (o.s < v.s && behind < Math.max(5, o.speed * 1.3)) return false;
      if (o.s >= v.s - v.len && o.s - o.len <= v.s) return false;
    }
    return true;
  }

  _startChange(v, lane) {
    v.oldLane = v.lane;
    v.lat = C.laneOff(v.link.L, v.lane) - C.laneOff(v.link.L, lane);
    v.lat0 = v.lat;   // the change follows an eased S-curve from here to 0
    v.chgP = 0;
    v.lane = lane;
  }

  // ---------- intersection reservation ----------
  // movement key for the conflict table; the exit lane always follows from the lane it actually enters from
  _mvOf(v) {
    const out = v.mv.out;
    if (!v.box) v.mv.outLane = this.outLaneFor(v.link, v.lane, out);
    return this._mvKey(v.link.dir, v.lane, out.dir);
  }

  _canEnter(v) {
    const node = v.link.to, link = v.link, out = v.mv.out;
    const key = this._mvOf(v);
    const conf = node.conflict.get(key), confCar = node.conflictCar.get(key);
    const confAC = node.conflictAmbCar.get(key), confCA = node.conflictCarAmb.get(key);
    for (const [oid, okey] of node.occ) {
      const o = this.vehicles.get(oid);
      // each vehicle's path is checked at its own size: car-sized for cars, ambulance-sized for ambulances
      const meAmb = v.type !== 'car', oAmb = !o || o.type !== 'car';
      const set = meAmb && oAmb ? conf : meAmb ? confAC : oAmb ? confCA : confCar;
      if (!set.has(okey)) continue;
      // an ambulance follows a moving car from its own lane through the intersection (keeping its distance)
      // instead of waiting for it to clear the whole box
      if (v.type === 'ambulance' && o && o.speed > 2 && this._sameLaneAhead(v, o)) continue;
      return false;
    }
    // exit lane needs room beyond the intersection for everyone already heading there
    let ahead = 0;
    for (const [oid] of node.occ) {
      const o = this.vehicles.get(oid);
      if (o && o.mv && o.mv.out === out && o.mv.outLane === v.mv.outLane) ahead += o.len + C.MIN_GAP;
    }
    const { gap, who } = this._tail(out, v.mv.outLane, v);
    const need = out.turnOut + ahead + v.len + C.MIN_GAP + 1;
    if (gap < need) {
      // an ambulance looks ahead: traffic that is already pulling away will have made room by the time it gets
      // there, so it keeps going instead of stopping at the line (the corridor holds cross traffic anyway)
      if (v.type !== 'ambulance' || !who || who.speed < 2.5) return false;
      const reach = (link.len - v.s + out.turnOut + v.len) / Math.max(v.speed, 4);
      if (gap + who.speed * reach * 0.8 < need) return false;
    }
    // permissive left turn: yield to oncoming traffic that is about to arrive
    if (out.dir === C.LEFT[link.dir] && v.type !== 'ambulance') {
      const opp = node.in[C.OPPOSITE[link.dir]];
      const oppY = opp && this.approachState(node, opp.dir) === 'Y';
      if (opp && this.approachState(node, opp.dir) !== 'R') {
        for (const lane of opp.lanes) for (const o of lane) {
          if (o.box || !o.mv) continue;
          const d = opp.stopS - o.s;
          if (o.mv.out.dir === C.LEFT[opp.dir]) continue;
          // on the oncoming yellow, cars that can still stop will stop: only the ones committed to going count,
          // so a waiting left turn gets its turn at the end of the green instead of waiting through cycle after cycle
          if (oppY && d > (o.speed * o.speed) / (2 * CMF_DECEL) + 1) continue;
          if (d > -1 && d < 38 && o.speed > 1.5) return false;
          // ...and to the first oncoming car waiting at the line to go straight or right: it has right of way
          // when the light turns green, so it isn't left sitting behind a car turning across it
          // (unless that car is itself stuck, so the two can never block each other for good)
          if (d > -1 && d < 6 && this.approachState(node, opp.dir) === 'G' && !o.pullFor && Math.min(o.still ?? 0, this.signals.get(node.id).t) < 3) return false;  // stuck = stopped 3 s into its green
        }
      }
    }
    return true;
  }

  // o entered (or is entering) this intersection from v's own lane, ahead of it
  _sameLaneAhead(v, o) {
    if (o.link === v.link) return o.lane === v.lane && o.s > v.s;
    return !!o.prev && o.prev.inLink === v.link && o.prev.inLane === v.lane;
  }

  // An ambulance is close behind this car in its lane (the car is in its way)
  _ambBehind(v) {
    // anywhere in the queue behind it, close enough that the driver can hear and see it
    for (const o of v.link.lanes[v.lane]) if (o.type === 'ambulance' && o.s < v.s && v.s - v.len - o.s < 45) return true;
    return false;
  }

  // No vehicle on another approach is so close and fast that it could not stop for the ambulance
  _crossClear(node, amb) {
    for (const [dir, link] of Object.entries(node.in)) {
      if (dir === amb.link.dir) continue;
      for (const lane of link.lanes) for (const o of lane) {
        if (o.box || o.lane !== lane.idx) continue;
        const gap = link.stopS - o.s;
        if (gap > -1 && o.speed > 1.5 && gap < (o.speed * o.speed) / (2 * BRAKE) + 3) return false;
      }
    }
    return true;
  }

  // Nothing in the intersection that crosses its path, and no cross traffic moving anywhere near:
  // safe to cross a red at a steady (reduced) speed rather than creeping
  _crossOpen(node, v) {
    const conf = node.conflict.get(this._mvOf(v));
    for (const [oid, k] of node.occ) if (oid !== v.id && conf?.has(k)) return false;
    for (const [dir, link] of Object.entries(node.in)) {
      if (dir === v.link.dir) continue;
      for (const lane of link.lanes) for (const o of lane) {
        if (o.box || o.lane !== lane.idx) continue;
        const gap = link.stopS - o.s;
        if (gap > -1 && gap < 40 && o.speed > 1.5) return false;
      }
    }
    return true;
  }

  _crossNear(node, v) {
    for (const [dir, link] of Object.entries(node.in)) {
      if (dir === v.link.dir) continue;
      for (const lane of link.lanes) for (const o of lane) {
        if (o.box || o.lane !== lane.idx) continue;
        const gap = link.stopS - o.s;
        if (gap > -1 && gap < 15 && o.speed > 2) return false;
      }
    }
    return true;
  }

  _commit(v) {
    v.box = v.link.to;
    v.box.occ.set(v.id, this._mvOf(v));
  }

  _release(v) {
    if (v.box) { v.box.occ.delete(v.id); v.box = null; }
  }

  // ---------- spawning ----------
  _seed() {
    const real = this.links.filter((l) => l.from.real && l.to.real);
    let tries = 0;
    while (this.vehicles.size < this.targetCars * 0.8 && tries++ < 6000) {
      const link = this.pick(real);
      const lane = Math.floor(this.rng() * link.L);
      const s = this.rand(6, link.stopS - 30);
      const clear = [...this.vehicles.values()].every((o) => o.link !== link || o.lane !== lane || Math.abs(o.s - s) > 10);
      if (clear) this._addVehicle(link, lane, s);
    }
    this._rebuildLanes();
  }

  _spawn() {
    let cars = 0;
    for (const v of this.vehicles.values()) if (v.type === 'car') cars++;
    if (cars >= this.targetCars || this.rng() > 0.45) return;
    const stubs = [...this.nodes.values()].filter((n) => !n.real);
    const n = this.pick(stubs);
    const link = Object.values(n.out)[0];
    if (!link) return;
    const lane = Math.floor(this.rng() * link.L);
    if (this._tail(link, lane).gap > C.CAR_LEN + 8) {
      const v = this._addVehicle(link, lane, 0);
      link.lanes[lane].push(v);
    }
  }

  // ---------- ambulances ----------
  _route(startLink, goalNode, extra = null) {
    const hos = goalNode.hospital;
    const penalty = (l) => {
      let p = extra?.get(l) ?? 0;
      // arriving with the campus on the far side would need a U-turn; a two-lane entry road is a fallback
      if (hos && l === hos.badLink) p += 400;
      if (hos && l === hos.inLink && l.L === 2) p += 60;
      if (!this.aiEnabled) return p;
      let q = 0;
      for (const lane of l.lanes) for (const v of lane) if (v.speed < 1) q++;
      return p + (q / l.L) * 7;
    };
    const dist = new Map(), prev = new Map(), done = new Set();
    const start = startLink.to;
    dist.set(start.id, 0);
    while (true) {
      let u = null, best = Infinity;
      for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id; }
      if (u === null || u === goalNode.id) break;
      done.add(u);
      const node = this.nodes.get(u);
      for (const l of Object.values(node.out)) {
        if (!l.to.real) continue;
        if (u === start.id && l.to === startLink.from) continue;
        // every turn costs time (slowing for it), so prefer long straight runs over a zigzag of equal length
        const inDir = (prev.get(u) ?? startLink).dir;
        const nd = best + l.len + penalty(l) + (l.dir !== inDir ? 30 : 0);
        if (nd < (dist.get(l.to.id) ?? Infinity)) { dist.set(l.to.id, nd); prev.set(l.to.id, l); }
      }
    }
    if (!dist.has(goalNode.id)) return null;
    const path = [];
    let cur = goalNode.id;
    while (cur !== start.id) { const l = prev.get(cur); path.unshift(l); cur = l.from.id; }
    // finish on a road with the campus on the right: either the approach itself, or the road leaving the intersection
    const last = path.at(-1) ?? startLink;
    if (hos && last !== hos.inLink && last !== hos.outLink && last !== hos.badLink) path.push(hos.outLink);
    return { links: [startLink, ...path], cost: dist.get(goalNode.id) };
  }

  _routeSummary(links) {
    const roads = [];
    for (const l of links) { const r = this.roadOf(l); if (roads[roads.length - 1] !== r) roads.push(r); }
    return roads.join(' → ');
  }

  // Restart the traffic from a seed, keeping the road network (the scene and cameras hold references to it).
  // Two resets with the same seed and the same controller give exactly the same traffic.
  reset(seed, opts = {}) {
    this.targetCars = opts.cars ?? C.TARGET_CARS;
    this.rng = C.makeRng(seed);
    this.t = 0;
    this.vehicles.clear();
    for (const l of this.links) l.lanes.forEach((arr) => { arr.length = 0; });
    for (const n of this.nodes.values()) {
      n.occ.clear();
      n.emHold = null;
      if (n.hospital) n.hospital.slots.fill(null);
    }
    for (const sig of this.signals.values()) {
      for (const k of Object.keys(sig)) if (k !== 'node') delete sig[k];
      Object.assign(sig, { phase: this.rng() < 0.5 ? 'EW' : 'NS', stage: 'G', t: this.rand(0, C.FIXED_GREEN), preempt: null, drop: null, lastAxis: null, extendedLogged: false, idleT: 0 });
    }
    this.nextAmb = 1;
    this.trips = [];
    this.decisionTimer = 0;
    this.decisions = [];
    this.history = [];
    this.recentSwitch.clear();
    this.idleSwitches = 0; this.idlePending = []; this.idleLogT = -1e9;
    this.lastSample = -1e9;
    this.lastLog = {};
    this.fallback = false;
    this.timers = [];
    this.priorityS = 0;
    this.epoch++;
    this._seed();
  }

  // Run fn when the sim clock reaches t (inside step, so it happens on the same step every replay)
  at(t, fn) { this.timers.push({ t, fn }); this.timers.sort((a, b) => a.t - b.t); }

  // opts.start (link id) and opts.hospital (id) fix the dispatch (for a scripted run); otherwise random
  dispatch(opts = {}) {
    const hospitalNodes = new Set(C.HOSPITALS.map((h) => `${h.node[0]},${h.node[1]}`));
    // appear 24 m down the road, clear of the intersection behind it, with room around it
    const SPAWN_S = 24;
    const cands = this.links.filter((l) => l.from.real && l.to.real && !hospitalNodes.has(l.to.id) &&
      l.lanes[0].every((o) => o.s - o.len > SPAWN_S + 8 || o.s < SPAWN_S - C.AMB_LEN - 6));
    const plan = (start) => {
      let best = null;
      for (const h of C.HOSPITALS) {
        if (opts.hospital && h.id !== opts.hospital) continue;
        const goal = this.nodes.get(`${h.node[0]},${h.node[1]}`);
        const r = this._route(start, goal);
        if (r && (!best || r.cost < best.r.cost)) best = { h, r, goal };
      }
      return best;
    };
    let start = null, best = null;
    if (opts.start) {
      const l = cands.find((c) => c.id === opts.start);
      if (!l) return null;   // that road is not clear yet; the caller tries again shortly
      start = l; best = plan(l);
    } else {
      const shuffled = cands.map((l) => [this.rng(), l]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      for (const l of shuffled) {
        const p = plan(l);
        if (p && p.r.links.length >= C.MIN_ROUTE_LINKS) { start = l; best = p; break; }
      }
    }
    if (!best) { this.log('SYSTEM', 'No clear road segment to start an ambulance. Try again in a moment.'); return null; }
    // opts.route: a fixed list of link ids (a scripted comparison drives the same intersections every run)
    let locked = null;
    if (opts.route) {
      locked = opts.route.map((id) => this.links.find((l) => l.id === id));
      const ok = locked.every(Boolean) && locked[0] === start && locked.every((l, k) => k === 0 || locked[k - 1].to === l.from);
      if (!ok) { this.log('SYSTEM', 'The scripted route does not match the road network.'); return null; }
      best.r = { links: locked, cost: 0 };
    }
    const name = `A-${this.nextAmb++}`;
    const v = this._addVehicle(start, 0, SPAWN_S, 'ambulance', {
      name, hospital: best.h, goal: best.goal, route: best.r.links, routeIdx: 0, lockedRoute: !!locked,
      dispatchedAt: this.t, mode: this.tripMode(), fallbackS: 0, preLogged: new Set(), passed: 0, totalNodes: best.r.links.length,
    });
    v.candidates = locked ? null : this._candidates(start, best.goal);
    // with Nemotron planning the route, the crew takes up to 3 s to load while it decides
    if (!locked && this.aiEnabled && this.controller === 'nemotron' && !this.fallback && v.candidates.length > 1) v.holdUntil = this.t + 3;
    this._plan(v);
    start.lanes[0].push(v);
    this.log('DISPATCH', `${name} dispatched from ${this.linkName(start)} to ${best.h.name}.`);
    if (locked) this.log('SYSTEM', `${name}: route fixed for this comparison, via ${this._routeSummary(locked)} (the same ${locked.filter((l) => l.to.real).length - 1} signals in every run; the route planner is not used).`);
    else if (v.holdUntil) { /* route planner decides first; corridor is logged once it has chosen */ }
    else if (this.aiEnabled) this.log('CORRIDOR', `Routing ${name} via ${this._routeSummary(best.r.links)}. ${best.r.links.length} intersections to pre-clear.`);
    else this.log('SYSTEM', `${name} is on the shortest path. Fixed timers: no signals will be pre-cleared.`);
    return v;
  }

  _reroute(v) {
    if (v.goal.hospital && v.link === v.goal.hospital.outLink) { this._plan(v); return; }  // already on the campus road
    const r = this._route(v.link, v.goal);
    if (!r) return;
    const oldNext = v.route[v.routeIdx + 1], newNext = r.links[1];
    if (oldNext && newNext && oldNext !== newNext) this.log('CORRIDOR', `Rerouting ${v.name} onto ${this.roadOf(newNext)} to avoid stopped traffic on ${this.roadOf(oldNext)}.`);
    v.route = r.links;
    v.routeIdx = 0;
    v.totalNodes = v.passed + r.links.length;
    this._plan(v);
  }

  // ---------- Predictive Green Corridor ----------
  // For every intersection still ahead of an ambulance:
  //   T_activation = T_switch + T_clear + T_margin
  // and priority starts once the ambulance's route-aware ETA falls inside that window. Each intersection moves
  // through NORMAL → PLANNED → CLEARING → PRIORITY_ACTIVE → RELEASED (see corridorState()).

  // Route-aware ETA to the stop line of every intersection ahead (also the hospital driveway), in seconds.
  // Accounts for: getting up to cruising speed from the current speed, slowing for each turn and speeding up
  // again afterwards, and stopped cars in its lane that it has to squeeze past. Cars it will meet at signals
  // are handled by the corridor itself, so they are not counted twice.
  _etaPlan(v) {
    const V = v.maxSpeed, u = Math.min(v.speed, V), hos = v.goal?.hospital;
    const items = [];
    let lost = (V - u) ** 2 / (2 * ACCEL * V);     // time lost accelerating from the current speed
    let start = -v.s;                               // distance from its front bumper to the start of route[k]
    let lane = v.lane;
    for (let k = v.routeIdx; k < v.route.length; k++) {
      const l = v.route[k], next = v.route[k + 1];
      // known congestion: stopped cars ahead in its lane on this road (it slows to ~9 m/s to pass each)
      let stopped = 0;
      for (const o of l.lanes[lane] ?? []) if (o !== v && o.lane === lane && !o.box && o.speed < 1 && (l !== v.link || o.s > v.s)) stopped++;
      lost += stopped * 0.35;
      const final = !next && !!hos;
      if (final) {
        const entry = this._entryOn(l, hos, v.len);
        if (entry != null) items.push({ k, link: l, node: l.to, dir: l.dir, lane, dist: start + entry, eta: Math.max(0, start + entry) / V + lost, final: true, entry });
        break;
      }
      // slowing for a turn at this intersection: braking before it (counted in the arrival) and speeding up after
      const vt = next && next.dir !== l.dir ? (next.dir === C.RIGHT[l.dir] ? 5.5 : 7) : V;
      const brake = (V - vt) ** 2 / (2 * CMF_DECEL * V);
      // "arrival" is where it commits to the intersection: its stopping distance before the line
      const commit = Math.min(l.stopS, (vt * vt) / (2 * CMF_DECEL) + 2);
      const dist = start + l.stopS;
      const left = !!next && next.dir === C.LEFT[l.dir];
      if (l.to.real && !(k === v.routeIdx && v.box === l.to)) items.push({ k, link: l, node: l.to, dir: l.dir, lane, dist, eta: Math.max(0, dist - commit) / V + lost + brake, turn: vt < V, left });
      lost += brake + (V - vt) ** 2 / (2 * ACCEL * V);
      if (next) lane = this.outLaneFor(l, lane, next);
      start += l.len;
    }
    return items;
  }

  // T_switch: seconds until this approach can show green, given the signal's current state
  _tSwitch(sig, dir, left = false) {
    const Y = C.YELLOW, AR = C.ALL_RED;
    if (sig.drop) return sig.drop === dir ? (Y + AR - sig.dropT) + Y + AR : Math.max(0, Y + AR - sig.dropT);
    if (this.approachState(sig.node, dir) === 'G') {
      // a valid green already exists: it only needs holding, unless it turns left across oncoming traffic that
      // also has green, which first has to be stopped (yellow + all-red)
      return left && sig.phase === C.AXIS[dir] ? Y + AR : 0;
    }
    if (sig.stage === 'Y') return Math.max(0, Y - sig.t) + AR;
    if (sig.stage === 'R') return Math.max(0, AR - sig.t);
    return Y + AR;                                               // the other road has green: yellow, then all-red
  }

  // Cars that must get through this intersection ahead of the ambulance: in its lane on the approach, ahead
  // of it. While the light is green for them, only cars already stopped or crawling count (the rest are flowing
  // through). While it is not, every one of them will be in the queue by the time it turns green, plus cars
  // still on the road before the approach that are heading into it.
  _queueAhead(v, it, tSwitch) {
    const l = it.link, green = tSwitch === 0;
    const ahead = (o, link) => o !== v && o.type !== 'parked' && !o.box && (link !== v.link || o.s > v.s);
    let n = 0, turning = 0;
    for (const o of l.lanes[it.lane] ?? []) {
      if (o.lane !== it.lane || !ahead(o, l)) continue;
      if (!green || o.speed < 3) { n++; if (o.mv && o.mv.out.dir !== l.dir) turning++; }
    }
    it.turning = turning;   // turning cars leave the line more slowly
    if (!green && it.k > v.routeIdx) {
      const before = v.route[it.k - 1];
      for (const lane of before.lanes) for (const o of lane) {
        if (o.lane !== lane.idx || !ahead(o, before) || o.mv?.out !== l) continue;
        if ((o.mv.outLane ?? this.outLaneFor(before, o.lane, l)) === it.lane) n++;
      }
    }
    return n;
  }

  // Room on the road after the intersection for the cars that have to leave (plus the ambulance), up to the
  // back of any standing queue on it
  _exitSlots(it, v) {
    const next = v.route[it.k + 1];
    if (!next) return Infinity;
    const lane = this.outLaneFor(it.link, it.lane, next);
    // only a standing queue takes up room: traffic that is moving on that road makes way as it goes
    let tail = Infinity;
    for (const o of next.lanes[lane] ?? []) if (o.lane === lane && o.speed < 3 && o.s - o.len < tail) tail = o.s - o.len;
    return tail === Infinity ? Infinity : Math.floor(Math.max(0, tail - next.turnOut) / (C.CAR_LEN + C.MIN_GAP));
  }

  // The corridor plan for one ambulance: every intersection ahead with its ETA, the three terms and when it must start
  corridorPlan(v) {
    const items = this._etaPlan(v), hos = v.goal?.hospital;
    const smooth = (v.etaS ??= new Map());
    let prev = null;
    for (const it of items) {
      const sig = this.signals.get(it.node.id);
      // smoothed ETA, so estimates don't flicker priority on and off
      const key = it.node.id + (it.final ? 'f' : '');
      const s0 = smooth.get(key);
      it.etaS = s0 == null || Math.abs(s0 - it.eta) > 8 ? it.eta : s0 + (it.eta - s0) * 0.12;
      smooth.set(key, it.etaS);
      if (!sig) { prev = null; continue; }
      it.sig = sig;
      // oncoming traffic must be stopped too if the ambulance turns left, or if a car ahead of it in its lane
      // is waiting to turn left (it would otherwise sit there giving way to oncoming cars)
      it.exclusive = it.left || (it.link.lanes[it.lane] ?? []).some((o) => o !== v && o.type === 'car' && !o.box && (it.link !== v.link || o.s > v.s) && o.mv && o.mv.out.dir === C.LEFT[it.dir]);
      it.tSwitch = this._tSwitch(sig, it.dir, it.exclusive);
      if (it.final) {
        // hospital road: the ambulance turns into the campus before the light at its end. That light only
        // matters if its queue has backed up past the driveway; then it gets green to drain the queue.
        let tail = Infinity, nCross = 0;
        for (const o of it.link.lanes[it.lane] ?? []) if (o !== v && o.lane === it.lane && !o.box && o.speed < 1 && (it.link !== v.link || o.s > v.s)) tail = Math.min(tail, o.s - o.len);
        const blockedTo = it.entry + 2;   // its front needs to get past the driveway
        if (tail < blockedTo) nCross = Math.ceil((blockedTo - tail) / (C.CAR_LEN + C.MIN_GAP));
        it.n = nCross;
        it.assist = nCross > 0;
        it.tClear = nCross ? CORR.STARTUP + CORR.HEADWAY * (nCross - 1) + 1.5 : 0;
      } else {
        it.n = this._queueAhead(v, it, it.tSwitch);
        const slots = this._exitSlots(it, v);
        it.slots = slots;
        it.spill = slots < it.n + 1;      // the road beyond can't take the queue and the ambulance
        // discharge of the longest relevant lane: the last of the n cars has to be through before the ambulance
        // reaches the spot where the back of that queue stood
        it.tClear = it.n ? CORR.STARTUP + CORR.HEADWAY * (it.n - 1) + CORR.TURN_EXTRA * it.turning + (it.n * (C.CAR_LEN + C.MIN_GAP)) / v.maxSpeed : 0;
        if (it.spill) it.tClear += CORR.STARTUP;   // waits for the road beyond to start moving
      }
      it.tMargin = Math.min(CORR.MARGIN_MAX, CORR.MARGIN_BASE + CORR.MARGIN_PER_S * it.etaS);
      it.tAct = it.tSwitch + it.tClear + it.tMargin;
      it.startIn = it.etaS - it.tAct;
      // downstream coordination: when the road beyond the previous intersection is full, this light (at its
      // far end) has to start draining it in time for the previous one to clear
      if (prev && prev.spill && prev.k + 1 === it.k) {
        // it has to have let enough cars off that road for the previous intersection's queue (and the ambulance)
        const room = Math.max(1, prev.n + 1 - prev.slots);
        const need = prev.startIn - (it.tSwitch + CORR.STARTUP + CORR.HEADWAY * (room - 1));
        if (need < it.startIn) { it.startIn = need; it.forSpill = prev.node; }
      }
      prev = it;
    }
    return items;
  }

  _preempt(dt = 1 / 30) {
    // drop holds whose ambulance is gone, or whose intersection is no longer ahead on its (possibly rerouted) path
    for (const sig of this.signals.values()) {
      if (!sig.preempt) continue;
      const a = this.vehicles.get(sig.preempt.amb);
      let ahead = false;
      if (a && a.type === 'ambulance') for (let k = a.routeIdx; k < a.route.length; k++) if (a.route[k].to === sig.node && a.route[k].dir === sig.preempt.dir) { ahead = true; break; }
      if (!ahead) this._releasePriority(sig, 'passed');
    }
    if (!this.aiEnabled) return;
    for (const v of this.vehicles.values()) {
      if (v.type !== 'ambulance' || (v.holdUntil && this.t < v.holdUntil)) continue;  // route not decided yet
      const plan = this.corridorPlan(v);
      v.plan = plan;
      for (const it of plan) {
        const sig = it.sig, node = it.node;
        if (!sig || it.etaS > 60) continue;
        if (it.final && !it.assist && sig.preempt?.amb !== v.id) continue;   // hospital road, nothing backed up: leave it alone
        const mine = sig.preempt?.amb === v.id;
        if (mine) {
          sig.corr = it;
          // re-evaluate: the ambulance is now much later than planned (stuck elsewhere). Release only while it is
          // not on this approach or in this intersection, so an established green is never pulled from under it.
          // "much later" = its ETA now is CANCEL_HYST seconds beyond what was predicted when the hold began
          // (a queue that has drained or a road beyond that has emptied is not a reason to let go)
          const near = v.link === it.link || v.box === node || it.etaS < 12;
          const late = it.etaS - (sig.preempt.eta0 - (this.t - sig.preempt.since));
          if (!near && late > CORR.CANCEL_HYST) this._releasePriority(sig, 'paused', v, it);
          continue;
        }
        if (sig.preempt && sig.preempt.amb !== v.id) {
          if (it.startIn <= 0) {
            const key = `${node.id}:${v.id}`;
            if (!this.lastLog[key]) {
              this.lastLog[key] = this.t;
              const first = this.vehicles.get(sig.preempt.amb);
              this.log('CORRIDOR', `${node.name}: two ambulances need this intersection. ${first?.name ?? 'The first'} goes first; ${v.name} gets green right after.`);
            }
          }
          continue;
        }
        // PLANNED: inside the planning horizon. If the light already shows green for it, keep that green from
        // ending (no visible change, the other road just isn't given the light yet).
        if (it.startIn <= CORR.PLAN_AHEAD) {
          sig.planned = { amb: v.id, dir: it.dir, until: this.t + 0.5 };
          sig.corr = it;
        }
        if (it.startIn > 0) continue;
        // after a corridor, the held directions get a short green before the next one (unless it is about to arrive)
        if ((sig.recoverUntil ?? 0) > this.t && it.etaS > 5) continue;
        // a valid green that only needs holding is held as it is (no change for anyone); otherwise the ambulance's
        // approach gets an exclusive green through the usual yellow and all-red
        const hold = !it.exclusive && this._covers(sig.phase, it.dir) && sig.stage === 'G' && !sig.drop;
        sig.preempt = { amb: v.id, dir: it.dir, since: this.t, eta0: it.etaS, assist: !!it.final, hold };
        sig.corr = it;
        if (!v.preLogged.has(node.id)) {
          v.preLogged.add(node.id);
          const why = it.final
            ? `${it.n} car${it.n === 1 ? '' : 's'} backed up past the ${v.hospital.name} entrance`
            : it.forSpill ? `the road to ${it.forSpill.name} is full; draining it so that intersection can clear`
            : it.n ? `${it.n} car${it.n === 1 ? '' : 's'} to clear (${Math.round(it.tClear)} s)` : 'nothing queued';
          const switching = sig.preempt.hold ? 'Already green, holding it' : `${it.tSwitch.toFixed(1)} s to switch`;
          this.log('CORRIDOR', `${node.name}: ${C.DIR_WORD[it.dir]} green for ${v.name}, arriving in ~${Math.max(1, Math.round(it.etaS))} s. ${switching}, ${why}. Other approaches held red.`);
        }
      }
    }
  }

  _releasePriority(sig, why, v = null, it = null) {
    sig.preempt = null;
    sig.recoverUntil = this.t + 9;
    if (why === 'paused' && v) this.log('CORRIDOR', `${sig.node.name}: ${v.name} is delayed (now ~${Math.round(it.etaS)} s away). Releasing the hold so cross traffic can move; it will be re-planned.`);
  }

  // Corridor state of an intersection, for the UI and tests
  corridorState(node) {
    const sig = this.signals.get(node.id);
    if (!sig) return 'NORMAL';
    if (sig.preempt) {
      const it = sig.corr;
      const exclusive = (sig.phase === sig.preempt.dir || (sig.preempt.hold && this._covers(sig.phase, sig.preempt.dir))) && sig.stage === 'G' && !sig.drop;
      // active once its green is up and nothing is left queued in its way
      const left = it && !it.final ? (it.link.lanes[it.lane] ?? []).some((o) => o.type === 'car' && !o.box && o.speed < 1 && o.s > (it.link === this.vehicles.get(sig.preempt.amb)?.link ? this.vehicles.get(sig.preempt.amb).s : -1)) : false;
      return exclusive && !left ? 'PRIORITY_ACTIVE' : 'CLEARING';
    }
    if (sig.planned && sig.planned.until > this.t) return 'PLANNED';
    if ((sig.recoverUntil ?? 0) > this.t) return 'RELEASED';
    return 'NORMAL';
  }

  // Cars ahead of an ambulance on its current and next road move over
  _yield() {
    for (const v of this.vehicles.values()) if (v.type === 'car' && v.pullFor && this.vehicles.get(v.pullFor)?.type !== 'ambulance') v.pullFor = null;
    // an ambulance that has not gained 2 m on its route in 3 s counts as held up
    for (const a of this.vehicles.values()) {
      if (a.type !== 'ambulance') continue;
      const rem = this.remainingDistance(a);
      if (!a.prog || rem < a.prog.d - 2) a.prog = { d: rem, t: this.t };
      a.stalled = this.t - a.prog.t > 3;
    }
    for (const a of this.vehicles.values()) {
      if (a.type !== 'ambulance') continue;
      const segs = [[a.link, a.s]];
      const nxt = a.route[a.routeIdx + 1];
      if (nxt) segs.push([nxt, -(a.link.len - a.s)]);
      for (const [link, aS] of segs) {
        // the lane it is in or about to move to (the outer one before a right turn)
        const aLane = link === a.link ? Math.max(a.lane, a.mv?.want ?? 0) : (a.mv ? this.outLaneFor(a.link, a.lane, a.mv.out) : 0);
        for (const lane of link.lanes) for (const o of lane) {
          if (o.type !== 'car' || o.box || o.lane !== lane.idx || o.pullFor || a.stalled || (a.still ?? 0) > 0.5) continue;
          if (link.L === 2 && (aLane !== 0 || o.lane !== 0)) continue;  // two lanes: only cars in the ambulance's inner lane move over
          if (link.L === 2 && !this._gapOk(o, 1)) continue;  // ...and only into a free gap; otherwise it drives on and clears ahead
          if (link.L === 2 && o.mv && o.mv.out.dir === C.LEFT[link.dir] && link.stopS - o.s < 40) continue;  // about to turn left from that lane: it clears ahead
          // cars just out of a box keep moving; the first cars at the light clear forward instead of pulling over
          if (o.s - o.len < (o.prev?.D2 ?? link.turnOut) + 4 || o.s > link.stopS - 8) continue;
          // beyond the next intersection, moving traffic just keeps going; only a stopped queue there makes room
          if (link !== a.link && o.speed > 1) continue;
          // a car that just crossed the red to make way drives on clear of the intersection before pulling over
          if (o.clearedFor === a.id && o.s < 40) continue;
          const ahead = o.s - aS;
          if (ahead > 0 && ahead < C.YIELD_RANGE) o.pullFor = a.id;
        }
      }
    }
    for (const v of this.vehicles.values()) {
      if (v.type !== 'car' || !v.pullFor) continue;
      const a = this.vehicles.get(v.pullFor);
      // released once the ambulance is clearly past, or if the ambulance itself is held up
      // (otherwise cars waiting for it could block the very intersection it is waiting on)
      const past = a.link === v.link ? a.s - a.len > v.s + 2 : !(a.route[a.routeIdx + 1] === v.link);
      const alongside = a.link === v.link && a.s > v.s - v.len + 0.5 && a.s - a.len < v.s;
      // two-lane road with the ambulance in the other lane: nothing to make room for
      const otherLane = a.link === v.link && v.link.L === 2 && a.lane !== v.lane && !alongside;
      if (otherLane && v.oldLane === null) { v.pullFor = null; continue; }
      // two lanes and the outer lane is taken: don't edge over into it, keep driving and clear at the light
      if (v.link.L === 2 && v.lane === 0 && v.oldLane === null && v.pull < 0.2 && !this._gapOk(v, 1)) { v.pullFor = null; continue; }
      if (past || v.box || ((a.stalled || (a.still ?? 0) > 2) && !alongside)) { v.pullFor = null; continue; }
      if (v.link.L === 2 && v.lane === 0 && a.lane === 0 && v.oldLane === null && v.pull < 0.2 && v.s < v.link.stopS - 8 && this._gapOk(v, 1)) {
        this._startChange(v, 1);
        if (v.mv && v.mv.out.dir === C.LEFT[v.link.dir]) this._fixMove(v);
      }
      // two lanes: a car still in the ambulance's lane that couldn't change lanes doesn't edge over or slow down
      // in its lane (that just leaves it stopped in the ambulance's way); it keeps driving and clears ahead
      if (v.link.L === 2 && v.lane === 0 && v.oldLane === null && a.link === v.link && a.lane === 0) v.pullFor = null;
      // ...and once in the outer lane it only waits at the curb if the ambulance stays in the inner one: when the
      // ambulance moves over too (to turn right), the car keeps going instead of stopping in front of it
      if (v.pullFor && v.link.L === 2 && a.link === v.link && (a.lane === 1 || a.mv?.want === 1)) v.pullFor = null;
    }
  }

  // ---------- hospital driveways ----------
  // Where (front-bumper s on its final road) an ambulance starts to pull into the campus, or null
  _entryS(v) {
    const hos = v.goal?.hospital;
    if (!hos || v.route.at(-1) !== v.link || v.routeIdx !== v.route.length - 1) return null;
    return this._entryOn(v.link, hos, v.len);
  }

  _entryOn(link, hos, len) {
    const lay = hos.lay, half = len / 2, street = C.AXIS[link.dir] === 'EW';
    if (link === hos.outLink) return (street ? lay.avHW + 2 : lay.vDrive - 9) + half;
    if (link === hos.inLink) return link.len - (street ? lay.avHW + 56 : lay.vDrive + 9) + half;
    return null;
  }

  _startParking(v) {
    const link = v.link, hos = v.goal.hospital, lay = hos.lay;
    // the lanes it will cross (and cars pulled over at the curb ahead) must be clear
    for (const lane of link.lanes) for (const o of lane) {
      if (o === v || o.lane !== lane.idx) continue;
      const crossing = o.lane > v.lane && o.s > v.s - 12 && o.s - o.len < v.s + 20;
      const curb = o.lane === v.lane && o.s > v.s && o.s - o.len < v.s + 20 && (o.pull ?? 0) > 0.1;
      if (crossing || curb) return;
    }
    // one ambulance at a time on the forecourt drive
    for (const o of this.vehicles.values()) if (o.type === 'parked' && o.park.hos === hos && o.park.state === 'in') return;
    // and nothing still crossing the intersection behind it toward those lanes
    if (link.from.real) for (const [oid] of link.from.occ) {
      const o = this.vehicles.get(oid);
      if (o && o !== v && o.mv?.out === link && (o.mv.outLane ?? 0) > v.lane) return;
    }
    const P = this.worldPos(v);
    const { k, evict } = this._bayChoice(P, link, hos);
    if (evict) this._remove(this.vehicles.get(hos.slots[k]));
    hos.slots[k] = v.id;
    this._startParkingRest(v, link, hos, k, this._bayPath(P, link, hos, k));
  }

  // a free bay that lies ahead along the drive; the oldest parked ambulance leaves if all are taken
  _bayChoice(P, link, hos) {
    const lay = hos.lay;
    const back = C.AXIS[link.dir] === 'EW' && link === hos.inLink ? -1 : 1;  // faces the way it drove in
    const db = { x: lay.sx * back, z: 0 };
    const d0 = { x: Math.cos(P.heading), z: -Math.sin(P.heading) };
    const ok = lay.slots.map((B) => {
      const Q = { x: B.x - db.x * 8, z: lay.z + lay.sz * lay.vDrive };
      return back < 0 ? (Q.x - P.x) * d0.x + (Q.z - P.z) * d0.z > 8 : true;
    });
    let k = hos.slots.findIndex((id, q) => ok[q] && (id === null || !this.vehicles.has(id)));
    if (k >= 0) return { k, evict: false };
    k = ok.indexOf(true);
    for (let q = k + 1; q < hos.slots.length; q++) if (ok[q] && this.vehicles.get(hos.slots[q]).park.t < this.vehicles.get(hos.slots[k]).park.t) k = q;
    return { k, evict: true };
  }

  // drive along the forecourt lane, then swing into the bay beside it
  _bayPath(P, link, hos, k) {
    const lay = hos.lay;
    const back = C.AXIS[link.dir] === 'EW' && link === hos.inLink ? -1 : 1;
    const db = { x: lay.sx * back, z: 0 };
    const d0 = { x: Math.cos(P.heading), z: -Math.sin(P.heading) };
    const B = lay.slots[k];
    const Q = { x: B.x - db.x * 8, z: lay.z + lay.sz * lay.vDrive };
    const pts = [];
    const bez = (A, da, Z, dz, n, skipFirst) => {
      // turn in promptly (short first handle) and line up with the drive lane early (long second handle),
      // so the path never swings out over the bays
      const dist = Math.hypot(Z.x - A.x, Z.z - A.z), k1 = Math.min(7, dist * 0.42), k2 = Math.max(Math.min(dist * 0.42, 6), dist * 0.55);
      const c1 = { x: A.x + da.x * k1, z: A.z + da.z * k1 }, c2 = { x: Z.x - dz.x * k2, z: Z.z - dz.z * k2 };
      for (let q = skipFirst ? 1 : 0; q <= n; q++) {
        const t = q / n, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
        pts.push({ x: a * A.x + b * c1.x + c * c2.x + d * Z.x, z: a * A.z + b * c1.z + c * c2.z + d * Z.z });
      }
    };
    bez(P, d0, Q, db, 36, false);
    bez(Q, db, B, db, 16, true);
    return pts;
  }

  _startParkingRest(v, link, hos, k, pts) {
    const cum = [0];
    for (let q = 1; q < pts.length; q++) cum.push(cum[q - 1] + Math.hypot(pts[q].x - pts[q - 1].x, pts[q].z - pts[q - 1].z));
    for (let q = 0; q < pts.length; q++) {
      const a = pts[Math.max(0, q - 1)], b = pts[Math.min(pts.length - 1, q + 1)];
      pts[q].heading = Math.atan2(-(b.z - a.z), b.x - a.x);
    }
    // off the road once the body has moved a lane and a half sideways
    const r = C.rightOf(link.dir), base = this.lanePoint(link, v.lane, 0);
    let offRoad = cum.at(-1);
    for (let q = 0; q < pts.length; q++) {
      // the rear of the long body swings last, so wait until it too is clear of the outermost lane
      const rx = pts[q].x - Math.cos(pts[q].heading) * v.len / 2, rz = pts[q].z + Math.sin(pts[q].heading) * v.len / 2;
      const lat = (x, z) => (x - base.x) * r.x + (z - base.z) * r.z;
      if (lat(pts[q].x, pts[q].z) > (link.L - v.lane) * C.LW + 1.6 && lat(rx, rz) > (link.L - 1 - v.lane) * C.LW + 2.8) { offRoad = cum[q]; break; }
    }
    v.type = 'parked';
    v.mv = null;
    v.passLat = 0;
    v.park = { pts, cum, len: cum.at(-1), d: 0, offRoad, s0: v.s, state: 'in', t: 0, hos, slot: k };
    this._arrive(v);
  }

  _parkStep(v, dt) {
    const p = v.park;
    if (p.state === 'in') {
      const vT = Math.min(6, Math.sqrt(2 * 2.2 * Math.max(0, p.len - p.d)));
      v.speed = v.speed < vT ? Math.min(vT, v.speed + ACCEL * dt) : Math.max(vT, v.speed - BRAKE * dt);
      p.d = Math.min(p.len, p.d + Math.max(v.speed, 0.4) * dt);
      v.s = p.s0 + p.d;
      if (p.d >= p.len - 0.05) { p.state = 'parked'; p.t = this.t; v.speed = 0; }
    } else if (this.t - p.t > 40) {
      if (p.hos.slots[p.slot] === v.id) p.hos.slots[p.slot] = null;
      this._remove(v);
    }
  }

  _parkPos(v) {
    const p = v.park, { pts, cum } = p;
    let q = 1;
    while (q < cum.length - 1 && cum[q] < p.d) q++;
    const t = Math.max(0, Math.min(1, (p.d - cum[q - 1]) / ((cum[q] - cum[q - 1]) || 1)));
    const a = pts[q - 1], b = pts[q];
    let dh = b.heading - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, heading: a.heading + dh * t };
  }

  _arrive(v) {
    const dur = this.t - v.dispatchedAt;
    const mode = v.mode;
    this.ambTrips.push({ name: v.name, duration: dur, mode, hospital: v.hospital.name, t: this.t, stoppedS: v.slowS ?? 0, fallbackS: v.fallbackS ?? 0 });
    let how = { Nemotron: 'Nemotron signal timing + Predictive Green Corridor', Rules: 'local-rules signal timing + Predictive Green Corridor', Fixed: 'fixed timers', Mixed: 'controller changed mid-trip' }[mode];
    if (mode === 'Nemotron' && v.fallbackS >= 1) how += `, local rules covered ${Math.round(v.fallbackS)} s of it`;
    this.log('ARRIVED', `${v.name} arrived at ${v.hospital.name} in ${fmtTime(dur)} (${how}).`);
  }

  _remove(v) {
    this._release(v);
    this.vehicles.delete(v.id);
  }

  // ---------- main step ----------
  step(dt) {
    this.t += dt;
    while (this.timers.length && this.timers[0].t <= this.t) this.timers.shift().fn();
    if (this.t - this.lastSample >= 2) this._sample();
    this._rebuildLanes();
    // intersections an ambulance is about to cross: other drivers stop for it
    for (const n of this.nodes.values()) n.emHold = null;
    for (const a of this.vehicles.values()) {
      if (a.type !== 'ambulance' || !a.link.to.real || a.box === a.link.to || a.holdUntil) continue;
      if (a.goal.hospital && a.link === a.goal.hospital.outLink) continue;
      // within earshot of the light, even when stuck in the queue: the cars ahead of it edge through
      // the red to make way, and cross traffic that sees the lights holds back for them
      if (a.link.stopS - a.s > 50) continue;
      // at a green only when something is waiting in front of it (a car turning left yields to oncoming traffic,
      // which stops for the siren)
      if (this.approachState(a.link.to, a.link.dir) === 'G') {
        const front = a.link.lanes[a.lane].filter((o) => o !== a && o.s > a.s && !o.box).sort((p, q) => q.s - p.s)[0];
        if (!front || !front.mv || front.mv.out.dir !== C.LEFT[a.link.dir] || a.link.stopS - front.s > 3) continue;
      }
      a.link.to.emHold = a.id;
    }
    for (const sig of this.signals.values()) this._updateSignal(sig, dt);
    this._preempt(dt);
    for (const sig of this.signals.values()) if (sig.preempt) this.priorityS += dt;
    this._yield();
    if (this.aiEnabled && this.controller === 'nemotron' && !this.fallback) this._idleGreen(dt);
    if (this.aiEnabled && (this.controller === 'rules' || this.fallback)) {
      this.decisionTimer += dt;
      if (this.decisionTimer >= 2) { this.decisionTimer = 0; this._decide(); }
    }

    const moves = [];
    for (const v of this.vehicles.values()) {
      if (v.type === 'parked') { this._parkStep(v, dt); continue; }
      const link = v.link;
      // lane changes for the next movement
      if (v.type !== 'ambulance' || v.link.L === 2) {
        if (v.mv && v.oldLane === null && !v.box && v.mv.want !== v.lane && !(v.pullFor && v.type === 'car')) {
          if (v.s < link.stopS - 24 && v.s - v.len > (v.prev?.D2 ?? link.turnOut) + 1) {
            if (this._gapOk(v, v.mv.want)) this._startChange(v, v.mv.want);
          } else if (v.s >= link.stopS - 24 && v.type === 'car') {
            this._fixMove(v);
          }
        }
      }

      let dist = Infinity;
      const lead = this._leader(v);
      // on a curve the real distance between two cars is shorter than along the lane, so keep more room
      const curveGap = (o) => ((v.box && v.mv && v.mv.out.dir !== link.dir) || (o && o.box && ((o.mv && o.mv.out.dir !== o.link.dir) || o.prev?.turn)) ? 3.2 : 0);
      if (lead) dist = lead.s - lead.len - C.MIN_GAP - curveGap(lead) - v.s;
      else if (v.mv) {
        const outLane = v.mv.outLane ?? this.outLaneFor(link, v.lane, v.mv.out);
        const { gap, who } = this._tail(v.mv.out, outLane, v);
        if (gap < Infinity) dist = link.len - v.s + gap - C.MIN_GAP - curveGap(who);
        // a car from this same lane that has turned off but is still crossing the intersection
        if (link.to.real) {
          for (const [oid] of link.to.occ) {
            const o = this.vehicles.get(oid);
            if (!o || o === v || !o.prev || o.prev.inLink !== link || o.prev.inLane !== v.lane || o.link === link) continue;
            // a turning car's rear corner swings across the lane, so leave extra room until it is clear
            const swing = o.prev.turn ? (o.type === 'ambulance' || v.type === 'ambulance' ? 7.5 : o.prev.outLink.dir === C.RIGHT[o.prev.inLink.dir] ? 6 : 4) : 0;  // a tight right turn swings the rear out most
            dist = Math.min(dist, link.len - v.s + o.s - o.len - C.MIN_GAP - swing);
          }
        }
      }

      const node = link.to;
      if (node.real && !v.box && v.mv) {
        const gapStop = link.stopS - v.s;
        const st = this.approachState(node, link.dir);
        const amb = v.type === 'ambulance';
        let go = st === 'G';
        if (st === 'Y' && gapStop < (v.speed * v.speed) / (2 * CMF_DECEL)) go = true;  // too close to stop
        if (st === 'Y' && v.speed < 0.5 && gapStop < 1.5 && v.mv.out.dir === C.LEFT[link.dir]) go = true;  // sneak a left on yellow
        // a car at the front of the queue with an ambulance right behind it moves through the red to clear the way
        const clearing = !amb && st !== 'G' && gapStop <= 2.5 && node.emHold && this._ambBehind(v);
        if ((amb || clearing) && st !== 'G') {
          // emergency vehicles (and cars clearing a path for one) may cross on red with caution: creep up to the
          // line at walking pace and roll through when no cross traffic is coming; stop only if something is
          go = false;
          // when the intersection is plainly empty, slow down but drive through instead of creeping
          v.redOpen = amb && gapStop < 30 && this._crossOpen(node, v);
          if (v.redOpen && gapStop <= 6 && v.speed < 8.5) go = true;
          else if (gapStop <= 2.5 && v.speed < 3.6 && this._crossClear(node, v)) go = true;
          v.creep = true;
        }
        if (!amb && v.pull > 0.3) go = false;  // straighten up before entering
        // drivers hear the siren: stop for an ambulance about to cross, unless too close to stop
        const hold = node.emHold && node.emHold !== v.id && !amb && !clearing && this.vehicles.get(node.emHold)?.link !== link;
        if (hold && gapStop > (v.speed * v.speed) / (2 * BRAKE) + 0.5) go = false;
        const horizon = (v.speed * v.speed) / (2 * CMF_DECEL) + 2;
        if (go && gapStop <= horizon) {
          if (this._canEnter(v)) {
            this._commit(v);
            v.redRun = (amb || clearing) && st !== 'G';
            v.redFast = v.redRun && amb && v.redOpen;
            if (clearing && st !== 'G') {
              v.clearedFor = node.emHold;   // it has just made way: let it drive on rather than stop again right after
              const a = this.vehicles.get(node.emHold);
              const key = `clear:${node.id}:${node.emHold}`;
              if (a && !this.lastLog[key]) { this.lastLog[key] = this.t; this.log('YIELD', `${node.name}: cars ahead of ${a.name} edge through the red light to make way.`); }
            }
          } else go = false;
        }
        if (!v.box) dist = Math.min(dist, gapStop - 0.3);
        if (amb && !v.box && st !== 'G' && gapStop < 24) dist = Math.min(dist, gapStop - 0.3 + 1.5);  // ease up to the line
      }

      if (v.type === 'ambulance' && v.entryS != null) dist = Math.min(dist, v.entryS - v.s + 0.6);  // slow for the driveway
      let vT = dist <= 0.3 ? 0 : Math.min(v.maxSpeed, Math.sqrt(2 * CMF_DECEL * Math.max(0, dist - 0.3)));
      if (v.mv && v.mv.out.dir !== link.dir && link.len - v.s < 26) vT = Math.min(vT, v.mv.out.dir === C.RIGHT[link.dir] ? 5.5 : 7);
      // creeping up to a red light it may cross: walking pace over the last stretch, so it can roll through
      if (v.creep) { v.creep = false; if (!v.box && link.stopS - v.s < 16) vT = Math.min(vT, v.redOpen ? 8 : Math.max(3.2, (link.stopS - v.s) * 0.6)); }
      // cross the hospital's own intersection slowly enough to turn straight into the forecourt after it
      if (v.type === 'ambulance' && v.mv && v.mv.out === v.goal?.hospital?.outLink && link.len - v.s < 30) vT = Math.min(vT, 7);
      if (v.type === 'ambulance' && v.box && v.goal?.hospital && v.link === v.goal.hospital.outLink) vT = Math.min(vT, 7);
      if (v.prev && v.s < link.turnOut + 2 && v.prev.turn) vT = Math.min(vT, 7);
      // (a car changing lanes to make way on a two-lane road keeps its speed: slowing down in front of the
      // ambulance while it moves across only holds the ambulance up)
      if (v.type === 'car' && v.pullFor && !(v.link.L === 2 && v.oldLane !== null)) {
        // keep rolling while edging over when the ambulance is still well back; stop once it is close
        const a = this.vehicles.get(v.pullFor);
        const gapBack = a && a.link === v.link ? v.s - v.len - a.s : Infinity;
        vT = Math.min(vT, gapBack > 28 ? 5 : v.pull > 0.85 ? 0 : 3);
      }
      // a car making room never creeps up to the stop line: the ambulance needs that space to finish passing and turn
      if (v.type === 'car' && v.pullFor && link.stopS - v.s < 9) vT = 0;
      if (v.oldLane !== null) vT = Math.min(vT, v.maxSpeed * 0.85);
      if (v.type === 'ambulance' && v.passLat < -0.1) vT = Math.min(vT, 9);  // slow while squeezing past
      // crossing against the light: slowly, but only while actually inside the intersection
      if (v.box && v.redRun && (v.link.to === v.box || v.s < v.link.turnOut + 2)) {
        // once in, it has the intersection to itself; speed up as soon as no cross traffic is bearing down on it
        if (!v.redFast && v.type === 'ambulance' && v.link.to === v.box && this._crossNear(v.box, v)) v.redFast = true;
        vT = Math.min(vT, v.redFast ? 8.5 : 4);
      }
      if (v.holdUntil && this.t < v.holdUntil) vT = 0;                       // waiting for the route planner

      if (v.speed < vT) v.speed = Math.min(vT, v.speed + ACCEL * dt);
      else v.speed = Math.max(vT, v.speed - BRAKE * dt);
      const prevS = v.s;
      v.s += v.speed * dt;
      if (lead) v.s = Math.min(v.s, Math.max(prevS, lead.s - lead.len - 0.5));  // never pushed backwards
      if (v.speed < 0.6) { v.wait += dt; v.still = (v.still ?? 0) + dt; } else v.still = 0;
      // ambulance time spent crawling or stopped (not counting the wait for the route planner)
      if (v.type === 'ambulance' && v.speed < 4 && !(v.holdUntil && this.t < v.holdUntil)) v.slowS = (v.slowS ?? 0) + dt;
      if (v.type === 'ambulance' && this.fallback && this.controller === 'nemotron' && this.aiEnabled) v.fallbackS = (v.fallbackS ?? 0) + dt;

      // sideways motion: lane changes, pulling over, ambulance passing
      const before = this._latOf(v);
      // sideways speed scales with forward speed, so nothing slides sideways while standing still
      const sideRate = Math.min(1, 0.12 + v.speed * 0.12);
      if (v.oldLane !== null) {
        // eased S-curve: starts and ends gently, same average sideways speed as before
        const lat0 = Math.abs(v.lat0 ?? v.lat) || 1;
        v.chgP = Math.min(1, (v.chgP ?? 0) + (CHANGE_RATE * sideRate * dt) / lat0);
        v.lat = (v.lat0 ?? v.lat) * (1 - ease(v.chgP));
        if (v.chgP >= 1) { v.lat = 0; v.oldLane = null; }
      }
      if (v.type === 'car') {
        const pullRate = Math.max(0.35, sideRate) * (v.pullFor && v.oldLane === null ? 0.9 : -0.7);
        v.pull = Math.max(0, Math.min(1, v.pull + pullRate * dt));
      }
      if (v.type === 'ambulance') {
        let passing = false;
        for (const o of link.lanes[v.lane]) {
          if (o.type === 'car' && o.pullFor === v.id && o.pull > 0.5 && o.s - v.s < 34 && v.s - v.len - o.s < 2) passing = true;
        }
        // edge toward the centre line, never into a neighbouring lane or toward an oncoming ambulance
        const opp = link.to.out[C.OPPOSITE[link.dir]];
        const oncomingAmb = opp && opp.to === link.from && opp.lanes[0].some((o) => o.type === 'ambulance');
        const canEdge = (link.L === 1 || v.lane === 0) && !oncomingAmb;
        // start a pass only well before the stop line, but never abandon one halfway
        // start a pass only well before the stop line; once edged out, stay out until fully past
        let alongside = false;
        for (const o of link.lanes[v.lane]) if (o !== v && o.type === 'car' && o.pull > 0.2 && o.s > v.s - v.len - 1 && o.s - o.len < v.s + 1) alongside = true;
        const want = (alongside && v.passLat < -0.3) || (!v.box && passing && canEdge && (link.stopS - v.s > 14 || v.passLat < -0.3)) ? PASS_OFF[link.L] : 0;
        v.passLat += Math.sign(want - v.passLat) * Math.min(Math.abs(want - v.passLat), 2.0 * Math.max(0.35, sideRate) * dt);
      }
      // heading follows the sideways velocity, low-passed so the body turns in and out smoothly
      const latVel = (this._latOf(v) - before) / dt;
      v.latVel = (v.latVel ?? 0) + (latVel - (v.latVel ?? 0)) * Math.min(1, dt * 6);

      if (v.type === 'ambulance' && v.entryS != null && v.s >= v.entryS - 0.6) this._startParking(v);
      else if (v.s >= link.len) moves.push(v);
      else if (v.type === 'ambulance' && !v.mv && v.entryS == null && v.s >= link.stopS - 2) moves.push(v);  // fallback: no driveway
    }

    for (const v of moves) {
      const link = v.link;
      if (!v.mv) {
        if (v.type === 'ambulance') this._arrive(v);
        else { this.trips.push({ t: this.t, wait: v.wait }); if (this.trips.length > 600) this.trips.shift(); }
        this._remove(v);
        continue;
      }
      if (!v.box && link.to.real) { v.s = link.len - 0.01; v.speed = 0; continue; }  // safety: never enter without a reservation
      const out = v.mv.out, outLane = v.mv.outLane ?? this.outLaneFor(link, v.lane, out);
      const arc = this._arc(link, v.lane, out, outLane);
      v.prev = { node: link.to, inLink: link, inLane: v.lane, outLink: out, outLane, turn: out.dir !== link.dir, D2: arc.D2 };
      v.s -= link.len;
      v.link = out;
      v.lane = outLane;
      v.lat = 0; v.oldLane = null; v.pull = 0; v.passLat = 0; v.latVel = 0;
      if (v.type === 'ambulance') {
        v.routeIdx++;
        v.passed++;
        (v.passLog ??= []).push({ node: link.to, t: this.t });
        const sig = this.signals.get(link.to.id);
        if (sig && sig.preempt && sig.preempt.amb === v.id) this._releasePriority(sig, 'passed');   // RELEASED: back to normal right away
        if (!this.aiEnabled) v.mode = 'Fixed';
        else if (v.mode !== 'Fixed' && v.mode !== this.tripMode()) v.mode = 'Mixed';
        if (this.aiEnabled && v.link.to.real && !v.lockedRoute) this._reroute(v);
        else this._plan(v);
      } else {
        this._plan(v);
      }
    }

    // release intersection reservations once a vehicle is clear of the box
    for (const v of this.vehicles.values()) {
      if (v.box && v.link.from === v.box && v.s - v.len > (v.prev?.D2 ?? v.link.turnOut) + 0.5) this._release(v);
    }

    this._spawn();
    for (const fn of this.observers) fn(this, dt);
  }

  // ---------- queries for the UI ----------
  // sideways offset from the lane centre; pulling over and the ambulance's pass both follow eased curves
  _latOf(v) { return v.lat + ease(v.pull) * PULL_OFF[v.link.L] + this._passOff(v); }
  _passOff(v) { return v.passLat ? PASS_OFF[v.link.L] * ease(v.passLat / PASS_OFF[v.link.L]) : 0; }

  // Centre of the vehicle body (v.s is its front bumper)
  worldPos(v) {
    if (v.type === 'parked') return this._parkPos(v);
    const l = v.link;
    const s = v.s - v.len / 2;
    let p;
    const arcIn = v.mv && v.box === l.to ? this._arc(l, v.lane, v.mv.out, v.mv.outLane ?? this.outLaneFor(l, v.lane, v.mv.out)) : null;
    if (arcIn && s > l.len - arcIn.D1) {
      const t = Math.min(1, (s - (l.len - arcIn.D1)) / (arcIn.D1 + arcIn.D2));
      p = this._arcAt(arcIn, t);
      // an ambulance still edged out from passing eases back onto its path in the first part of the turn
      const off = this._passOff(v) * Math.max(0, 1 - t / 0.4);
      if (off) { p.x += Math.sin(p.heading) * off; p.z += Math.cos(p.heading) * off; }
    } else if (v.prev && s < v.prev.D2) {
      const pr = v.prev;
      const arc = this._arc(pr.inLink, pr.inLane, pr.outLink, pr.outLane);
      p = this._arcAt(arc, Math.max(0, (arc.D1 + s) / (arc.D1 + arc.D2)));
    } else {
      const q = this.lanePoint(l, v.lane, s, this._latOf(v));
      const d = C.DIRS[l.dir];
      const base = Math.atan2(-d.dz, d.dx);
      // angle slightly into a lane change or pull-over; positive lateral motion is to the right (clockwise from above)
      const yaw = Math.max(-MAX_YAW, Math.min(MAX_YAW, Math.atan2(v.latVel, Math.max(v.speed, 3))));
      p = { x: q.x, z: q.z, heading: base - yaw };
    }
    return p;
  }

  // Remaining route as world points through the arcs, each with distance to the hospital
  routePolyline(v) {
    if (v.type === 'parked') {
      // pulling into the bay: what is left of the forecourt path
      const p = v.park, out = [];
      if (p.state !== 'in') return out;
      for (let q = 0; q < p.pts.length; q++) if (p.cum[q] >= p.d - (v.len / 2)) out.push({ x: p.pts[q].x, z: p.pts[q].z, toGoal: p.len - p.cum[q] });
      return out;
    }
    let toGoal = this.remainingDistance(v);
    const pts = [];
    const hos = v.goal?.hospital;
    let lane = v.lane;
    for (let k = v.routeIdx; k < v.route.length; k++) {
      const l = v.route[k], next = v.route[k + 1];
      const s0 = k === v.routeIdx ? v.s : 0;
      const outLane0 = next ? this.outLaneFor(l, lane, next) : 0;
      const arcNext = next ? this._arc(l, lane, next, outLane0) : null;
      // the last road ends where the ambulance turns off into the hospital forecourt
      const entry = !next && hos ? this._entryOn(l, hos, v.len) : null;
      const sEnd = next ? l.len - arcNext.D1 : entry != null ? entry - 0.6 - v.len / 2 : l.stopS;
      let startS = s0;
      if (k > v.routeIdx) startS = Math.max(startS, this._lastD2 ?? l.turnOut);
      if (k === v.routeIdx && v.prev && v.s < v.prev.D2) startS = v.prev.D2;
      if (startS > sEnd) startS = sEnd;
      const n = Math.max(1, Math.ceil((sEnd - startS) / 2));
      for (let q = 0; q <= n; q++) {
        const s = startS + ((sEnd - startS) * q) / n;
        const p = this.lanePoint(l, lane, s, k === v.routeIdx ? this._passOff(v) : 0);
        pts.push({ x: p.x, z: p.z, toGoal: toGoal - (s - s0) });
      }
      if (next) {
        const arc = arcNext;
        const base = toGoal - (sEnd - s0);
        for (let q = 1; q <= 10; q++) {
          const t = q / 10, p = this._arcAt(arc, t);
          pts.push({ x: p.x, z: p.z, toGoal: base - t * (arc.D1 + arc.D2) });
        }
        this._lastD2 = arc.D2;
        lane = outLane0;
      }
      if (entry != null) {
        // then follow the drive into the bay it will take
        const d = C.DIRS[l.dir];
        const c = this.lanePoint(l, lane, sEnd);
        const P = { x: c.x, z: c.z, heading: Math.atan2(-d.dz, d.dx) };
        const { k } = this._bayChoice(P, l, hos);
        const bay = this._bayPath(P, l, hos, k);
        let last = pts.at(-1), tg = last.toGoal;
        for (const q of bay) {
          tg -= Math.hypot(q.x - last.x, q.z - last.z);
          pts.push({ x: q.x, z: q.z, toGoal: Math.max(0, tg) });
          last = pts.at(-1);
        }
        break;
      }
      toGoal -= l.len - s0;
    }
    this._lastD2 = null;
    return pts;
  }

  // The signals still ahead of an ambulance, nearest first, with distance and a rough ETA
  routeSignals(v) {
    // intersections it will cross (not the light beyond the hospital entrance), with the route-aware ETA and,
    // when adaptive control is on, the corridor plan: when clearing must start and the corridor state
    const plan = this.aiEnabled && v.plan ? v.plan : this._etaPlan(v);
    return plan.filter((it) => !it.final && !(it.link === v.link && v.box === it.node)).map((it) => ({
      node: it.node, dir: it.dir, dist: it.dist, eta: it.etaS ?? it.eta,
      startIn: it.startIn, tAct: it.tAct, tSwitch: it.tSwitch, n: it.n, state: this.corridorState(it.node),
    }));
  }

  ambulances() { return [...this.vehicles.values()].filter((v) => v.type === 'ambulance'); }

  remainingDistance(v) {
    let d = v.link.len - v.s;
    for (let k = v.routeIdx + 1; k < v.route.length; k++) d += v.route[k].len;
    return d;
  }

  nextSignal(v) {
    let acc = 0;  // distance from the vehicle to the start of route[k]
    for (let k = v.routeIdx; k < v.route.length; k++) {
      const l = v.route[k];
      if (v.goal?.hospital && l === v.goal.hospital.outLink) return null;   // the hospital comes before that light
      if (k === v.routeIdx) {
        acc = l.len - v.s;
        if (v.box === l.to) continue;
        return { node: l.to, dir: l.dir, state: this.approachState(l.to, l.dir), dist: Math.max(0, l.stopS - v.s), final: k === v.route.length - 1 };
      }
      const res = { node: l.to, dir: l.dir, state: this.approachState(l.to, l.dir), dist: Math.max(0, acc + l.stopS), final: k === v.route.length - 1 };
      return res;
    }
    return null;
  }

  // Live city numbers right now
  _now() {
    let onRoad = 0, stopped = 0, waitSum = 0;
    for (const v of this.vehicles.values()) {
      if (v.type !== 'car') continue;
      onRoad++;
      waitSum += v.wait;
      if (v.speed < 0.6) stopped++;
    }
    return { onRoad, stopped, avgWaitNow: onRoad ? waitSum / onRoad : 0 };
  }

  _sample() {
    this.lastSample = this.t;
    const n = this._now();
    const thru = this.trips.filter((x) => this.t - x.t <= 60).length * (60 / Math.max(1, Math.min(60, this.t)));
    const dec = this.decisions.filter((x) => this.t - x <= 60).length;
    while (this.decisions.length && this.t - this.decisions[0] > 300) this.decisions.shift();
    this.history.push({ t: this.t, stopped: n.stopped, onRoad: n.onRoad, wait: this._recentWait() ?? n.avgWaitNow, thru, dec, mode: this.modeLabel() });
    if (this.history.length > 120) this.history.shift();   // last 4 sim-minutes
  }

  _recentWait() {
    const recent = this.trips.filter((x) => this.t - x.t <= 120);
    return recent.length >= 5 ? recent.reduce((a, x) => a + x.wait, 0) / recent.length : null;
  }

  kpis() {
    const avgWait = this._recentWait();
    const win = Math.min(60, this.t);
    const perMin = win > 0 ? (this.trips.filter((x) => this.t - x.t <= 60).length / win) * 60 : 0;
    const of = (m) => this.ambTrips.filter((a) => a.mode === m);
    const avg = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : null);
    const mean = (m) => avg(of(m), (x) => x.duration);
    return {
      ...this._now(),
      avgWait, throughput: this.t < 10 ? null : Math.round(perMin), active: this.ambulances().length,
      decisionsPerMin: this.t < 10 ? null : this.decisions.filter((x) => this.t - x <= 60).length * (60 / Math.min(60, this.t)),
      history: this.history,
      mode: this.modeLabel(),
      lastAmb: this.ambTrips.at(-1) ?? null,
      amb: Object.fromEntries(['Nemotron', 'Rules', 'Fixed'].map((m) => [m, {
        mean: mean(m), n: of(m).length, stopped: avg(of(m), (x) => x.stoppedS ?? 0),
        best: of(m).length ? Math.min(...of(m).map((x) => x.duration)) : null,
      }])),
      // kept for the collision checker: adaptive = whichever adaptive controller ran
      ambAI: mean('Rules') ?? mean('Nemotron'), ambFixed: mean('Fixed'),
      ambAICount: of('Rules').length + of('Nemotron').length,
      ambFixedCount: of('Fixed').length,
    };
  }

}
