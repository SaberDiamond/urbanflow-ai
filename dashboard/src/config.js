// UrbanFlow AI — shared city constants.
// Coordinates: x = east, z = south, y = up. Right-hand traffic.

export const NX = 8;            // north–south avenues (columns of intersections)
export const NY = 6;            // east–west streets (rows of intersections)
export const BLOCK = 72;        // distance between intersections (world units ≈ metres)
export const LW = 3.3;          // lane width
export const MEDIAN = 1.2;      // painted median between directions on two-lane roads

export const AVENUES = ['1st Ave', '2nd Ave', '3rd Ave', '4th Ave', '5th Ave', '6th Ave', '7th Ave', '8th Ave'];
export const STREETS = ['Maple St', 'Oak St', 'Elm St', 'Pine St', 'Cedar St', 'Harbor Blvd'];
// lanes per direction
export const AVENUE_LANES = [1, 2, 1, 2, 2, 1, 2, 1];
export const STREET_LANES = [2, 1, 2, 1, 1, 2];

// Hospitals sit beside an intersection; ambulances route to that intersection.
// `corner` says which block corner the campus occupies ([sx, sz] = ±1).
export const HOSPITALS = [
  { id: 'stmarys', name: "St. Mary's Hospital", node: [6, 1], corner: [1, -1] },
  { id: 'riverside', name: 'Riverside Medical Center', node: [1, 4], corner: [-1, 1] },
  { id: 'central', name: 'Central General', node: [4, 3], corner: [-1, -1] },
];
export const MIN_ROUTE_LINKS = 4; // dispatches start at least this many intersections from the hospital

// Districts (cell i,j sits between intersection columns i,i+1 and rows j,j+1; cells -1..NX-1 × -1..NY-1)
export const PARKS = [[2, 1], [5, 3]];
export const DOWNTOWN = { i0: 2, i1: 5, j0: 1, j1: 3 };
export const INDUSTRIAL_COLS = [-1, 0];   // west edge
export const RIVER_ROW = NY - 1;          // the row south of Harbor Blvd is the waterfront and river

// Signal timing (seconds)
export const FIXED_GREEN = 18;
export const YELLOW = 3;
export const ALL_RED = 1.2;
export const MIN_GREEN = 6;
export const MAX_GREEN = 40;
// Idle-green safeguard (Nemotron mode only): a green nobody is using, with cars waiting on red, ends after this long
export const IDLE_GREEN_S = 3;

// Vehicles
export const CAR_LEN = 4.4;
export const AMB_LEN = 6.6;
export const MIN_GAP = 2.2;
export const TARGET_CARS = 190;

// Earlier fixed-window corridor setting (no longer used: the Predictive Green Corridor works out each intersection's
// lead time from its queue and signal state; see corridorPlan() in sim.js)
export const PREEMPT_WINDOW = 20;
// Cars this far ahead of an ambulance on its road move over for it
export const YIELD_RANGE = 75;

export const DIRS = {
  E: { dx: 1, dz: 0 },
  W: { dx: -1, dz: 0 },
  S: { dx: 0, dz: 1 },
  N: { dx: 0, dz: -1 },
};
export const LEFT = { E: 'N', N: 'W', W: 'S', S: 'E' };
export const RIGHT = { E: 'S', S: 'W', W: 'N', N: 'E' };
export const OPPOSITE = { E: 'W', W: 'E', N: 'S', S: 'N' };
export const AXIS = { E: 'EW', W: 'EW', N: 'NS', S: 'NS' };
export const DIR_WORD = { E: 'eastbound', W: 'westbound', N: 'northbound', S: 'southbound' };

export function nodePos(i, j) {
  return { x: (i - (NX - 1) / 2) * BLOCK, z: (j - (NY - 1) / 2) * BLOCK };
}

export function isIntersection(i, j) {
  return i >= 0 && i < NX && j >= 0 && j < NY;
}

export function intersectionName(i, j) {
  return `${STREETS[j]} & ${AVENUES[i]}`;
}

// Road half width for a road with L lanes per direction
export function halfW(L) {
  return L === 2 ? MEDIAN / 2 + 2 * LW : 0.15 + LW;
}

// Lateral offset (to the right of travel) of lane k; k = 0 is the inner lane next to the centre line
export function laneOff(L, k) {
  return (L === 2 ? MEDIAN / 2 : 0.15) + (k + 0.5) * LW;
}

export function avenueLanes(i) { return AVENUE_LANES[Math.min(Math.max(i, 0), NX - 1)]; }
export function streetLanes(j) { return STREET_LANES[Math.min(Math.max(j, 0), NY - 1)]; }

// Unit vector pointing to the right of a travel direction
export function rightOf(dir) {
  const d = DIRS[dir];
  return { x: -d.dz, z: d.dx };
}

// Small seeded RNG so a demo scenario can replay exactly
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- hospital campus layout (shared by the simulation and the scene) ----------
// The campus fills the block at `corner` of the hospital's intersection. A forecourt drive runs
// parallel to the street, with ambulance bays under a canopy. Ambulances pull in from either of the
// two roads that border the campus on their right-hand side.
const OPP = { E: 'W', W: 'E', N: 'S', S: 'N' };
export function hospitalLayout(h) {
  const [i, j] = h.node, [sx, sz] = h.corner;
  const p = nodePos(i, j);
  const avHW = halfW(avenueLanes(i)), stHW = halfW(streetLanes(j));
  // leaving the intersection with the campus on the right / arriving with the campus on the right
  const outDir = sx === sz ? (sx > 0 ? 'E' : 'W') : (sz > 0 ? 'S' : 'N');
  const inDir = sx === -sz ? (sx > 0 ? 'W' : 'E') : (sz > 0 ? 'N' : 'S');
  const vDrive = stHW + 10;                  // forecourt drive lane, measured from the street centre line
  const vBay = vDrive + 4.2;                 // bays sit beside the drive lane, under the canopy
  const slots = [20, 35, 50].map((u) => ({ u, x: p.x + sx * (avHW + u), z: p.z + sz * vBay }));
  return {
    sx, sz, x: p.x, z: p.z, avHW, stHW, vDrive, vBay, slots,
    outDir, inDir, badDir: OPP[outDir],
    canopy: { x: p.x + sx * (avHW + 35), z: p.z + sz * vBay, w: 42, d: 6 },
    build: { u0: avHW + 8, u1: BLOCK - 8, v0: stHW + 19, v1: BLOCK - 8 },
  };
}
