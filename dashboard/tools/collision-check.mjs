// UrbanFlow AI — headless collision checker.
// Runs the simulation for a number of sim-minutes and reports any two vehicles whose
// footprints overlap. Run before recording: node tools/collision-check.mjs [minutes] [seed]

import { Sim, fmtTime } from '../src/sim.js';

const MINUTES = Number(process.argv[2] ?? 10);
const SEED = Number(process.argv[3] ?? 20261030);
const CARS = process.argv[4] ? Number(process.argv[4]) : null;   // optional: denser traffic, as in the demo
const DT = 1 / 30;

function box(sim, v) {
  const p = sim.worldPos(v);
  const hl = v.len / 2 - 0.2, hw = (v.type !== 'car' ? 2.3 : 1.95) / 2 - 0.08;
  const c = Math.cos(p.heading), s = -Math.sin(p.heading);  // forward = (c, s) in x/z
  return { x: p.x, z: p.z, ax: [c, s], ay: [-s, c], hl, hw };
}

function overlap(a, b) {
  for (const axis of [a.ax, a.ay, b.ax, b.ay]) {
    const proj = (o) => Math.abs(o.ax[0] * axis[0] + o.ax[1] * axis[1]) * o.hl + Math.abs(o.ay[0] * axis[0] + o.ay[1] * axis[1]) * o.hw;
    const d = Math.abs((b.x - a.x) * axis[0] + (b.z - a.z) * axis[1]);
    if (d > proj(a) + proj(b)) return false;
  }
  return true;
}

function run(ai) {
  const sim = new Sim(SEED);
  if (CARS) sim.reset(SEED, { cars: CARS });
  sim.setAI(ai);
  const steps = Math.round((MINUTES * 60) / DT);
  const hits = new Map();
  let nextDispatch = 15;
  let maxVeh = 0, stuck = 0;
  for (let i = 0; i < steps; i++) {
    sim.step(DT);
    if (sim.t >= nextDispatch && sim.ambulances().length < 2) { sim.dispatch(); nextDispatch = sim.t + 25; }
    maxVeh = Math.max(maxVeh, sim.vehicles.size);
    const grid = new Map();
    const boxes = [];
    for (const v of sim.vehicles.values()) {
      const b = box(sim, v);
      b.v = v;
      boxes.push(b);
      const key = `${Math.floor(b.x / 10)},${Math.floor(b.z / 10)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(b);
    }
    for (const b of boxes) {
      const gx = Math.floor(b.x / 10), gz = Math.floor(b.z / 10);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const o of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (o.v.id <= b.v.id || !overlap(b, o)) continue;
          const k = `${b.v.id}-${o.v.id}`;
          if (!hits.has(k)) hits.set(k, { t: sim.t, a: b.v, b: o.v, where: b.v.link.to.name, aLink: b.v.link.id, bLink: o.v.link.id, aBox: !!b.v.box, bBox: !!o.v.box, aLane: b.v.lane, bLane: o.v.lane });
        }
      }
    }
  }
  for (const v of sim.vehicles.values()) if ((v.still ?? 0) > 90) stuck++;
  return { sim, hits, maxVeh, stuck };
}

for (const ai of [true, false]) {
  const { sim, hits, maxVeh, stuck } = run(ai);
  const k = sim.kpis();
  const amb = ai ? k.ambAI : k.ambFixed, n = ai ? k.ambAICount : k.ambFixedCount;
  console.log(`${ai ? 'Adaptive' : 'Fixed   '} | ${MINUTES} min | vehicles up to ${maxVeh} | overlaps ${hits.size} | stopped >90s ${stuck} | ambulance avg ${amb === null ? '—' : fmtTime(amb)} (${n} trips) | car wait ${k.avgWait?.toFixed(1)} s | ${k.throughput} veh/min`);
  let shown = 0;
  for (const h of hits.values()) {
    if (shown++ >= 8) break;
    console.log(`   ${fmtTime(h.t)} ${h.a.type}#${h.a.id}(${h.aLink} L${h.aLane} box:${h.aBox}) x ${h.b.type}#${h.b.id}(${h.bLink} L${h.bLane} box:${h.bBox})`);
  }
}
