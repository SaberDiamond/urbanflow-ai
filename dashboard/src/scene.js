// UrbanFlow AI — night isometric city. Reads state from the simulation and draws it.
//
// Static city geometry is merged per material, and cars are instanced, so ~190 vehicles and a
// large city stay smooth. Traffic only runs inside the simulated grid; the outskirts beyond it are
// scenery that fades into the dark.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as C from './config.js';

const COL = {
  ground: 0x0b0f15,
  asphalt: 0x1a2029,
  junction: 0x1c222c,
  sidewalk: 0x2b323d,
  lot: 0x151b23,
  grass: 0x12261f,
  water: 0x0a1626,
  white: 0xc9cfd8,
  yellow: 0xd9a531,
  red: 0xff4a4f,
  amber: 0xffb21f,
  green: 0x2fe07c,
  route: 0x3fb6ff,
  lampWarm: 0xffc979,
  sodium: 0xff9a3c,
};

// Simulated area (the iso camera fits this) and the scenery ring around it
const SIM = {
  x0: C.nodePos(-1, 0).x, x1: C.nodePos(C.NX, 0).x,
  z0: C.nodePos(0, -1).z, z1: C.nodePos(0, C.NY).z,
};
export const CITY_BOUNDS = SIM;
// Seeded random so the city looks the same every load
let seed = 11;
function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
function rr(a, b) { return a + rnd() * (b - a); }
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

// ---------- road layout helpers ----------
const avX = (i) => C.nodePos(i, 0).x;
const stZ = (j) => C.nodePos(0, j).z;
const avL = (i) => (i >= 0 && i < C.NX ? C.AVENUE_LANES[i] : 1);
const stL = (j) => (j >= 0 && j < C.NY ? C.STREET_LANES[j] : 1);
const avHW = (i) => C.halfW(avL(i));
const stHW = (j) => C.halfW(stL(j));
// ---------- city shape ----------
// The traffic grid sits inside a beltway (a rounded "superellipse" ring road). Every simulated road runs
// out to it. A river winds along the south and bends away beyond the city; outside the beltway the
// roads curve off into suburbs, fields and forest that thin out into the dark.
const BELT = { rx: C.nodePos(C.NX, 0).x + 28, rz: C.nodePos(0, C.NY).z + 30, n: 4, hw: C.halfW(2) };
const beltZ = (x, s) => s * BELT.rz * Math.max(0, 1 - Math.abs(x / BELT.rx) ** BELT.n) ** (1 / BELT.n);
const beltX = (z, s) => s * BELT.rx * Math.max(0, 1 - Math.abs(z / BELT.rz) ** BELT.n) ** (1 / BELT.n);
const inBelt = (x, z, m = 0) => (Math.abs(x) / (BELT.rx - m)) ** BELT.n + (Math.abs(z) / (BELT.rz - m)) ** BELT.n < 1;
const HARBOR_EDGE = C.nodePos(0, C.NY - 1).z + C.halfW(C.STREET_LANES[C.NY - 1]);
const RIVER_MID = (HARBOR_EDGE + 12 + C.nodePos(0, C.NY).z - 9) / 2;
const riverZ = (x) => {
  const a = Math.abs(x), bend = a <= 380 ? 0 : a <= 900 ? ((a - 380) ** 2) / 900 : 300 + (a - 900) * 1.16;
  return RIVER_MID + 3 * Math.sin(x / 70 + 0.6) + bend;
};
const riverHW = (x) => 18 + Math.max(0, Math.abs(x) - 380) * 0.03;
const inRiver = (x, z, m = 0) => Math.abs(z - riverZ(x)) < riverHW(x) + m;
const inGrid = (i, j) => i >= -1 && i <= C.NX - 1 && j >= -1 && j <= C.NY - 2;
// blocks with a special use, to break up the grid
// (the blocks facing two of the hospital forecourts are kept low so the ambulance bays can be seen)
const SPECIAL = { '1,2': 'parking', '6,1': 'parking', '3,3': 'plaza', '0,2': 'school', '6,3': 'gas', '1,3': 'construction', '0,0': 'civic', '3,0': 'parking' };

// evenly spaced points around the beltway
function beltPoints(step = 6) {
  const raw = [];
  for (let k = 0; k < 4000; k++) {
    const t = (k / 4000) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    raw.push({ x: BELT.rx * Math.sign(c) * Math.abs(c) ** (2 / BELT.n), z: BELT.rz * Math.sign(s) * Math.abs(s) ** (2 / BELT.n) });
  }
  const out = [raw[0]];
  let acc = 0;
  for (let k = 1; k < raw.length; k++) {
    acc += Math.hypot(raw[k].x - raw[k - 1].x, raw[k].z - raw[k - 1].z);
    if (acc >= step) { out.push(raw[k]); acc = 0; }
  }
  return out;
}

// smooth value noise for organic patches
function hash2(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, z) => 0.6 * noise(x, z) + 0.3 * noise(x * 2.1 + 5, z * 2.1 + 9) + 0.1 * noise(x * 4.3 + 17, z * 4.3 + 3);

// polyline helpers
function offsetLine(pts, off, closed = false) {
  const n = pts.length;
  return pts.map((p, k) => {
    const a = pts[closed ? (k - 1 + n) % n : Math.max(0, k - 1)], b = pts[closed ? (k + 1) % n : Math.min(n - 1, k + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    return { x: p.x - tz * off, z: p.z + tx * off };
  });
}
// flat ribbon between two edge polylines, uv in metres / 26 (asphalt scale)
function ribbon(left, right, y, closed = false, uvScale = 26) {
  const pos = [], uv = [], idx = [];
  let along = 0;
  const n = left.length;
  for (let k = 0; k < n; k++) {
    if (k) along += Math.hypot(left[k].x - left[k - 1].x, left[k].z - left[k - 1].z);
    const w = Math.hypot(right[k].x - left[k].x, right[k].z - left[k].z);
    pos.push(left[k].x, y, left[k].z, right[k].x, y, right[k].z);
    uv.push(along / uvScale, 0, along / uvScale, w / uvScale);
    if (k) { const o = (k - 1) * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); }
  }
  if (closed) { const o = (n - 1) * 2; idx.push(o, 0, o + 1, o + 1, 0, 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure it faces up
  if (g.attributes.normal.getY(0) < 0) { const ix = g.index.array; for (let q = 0; q < ix.length; q += 3) { const t = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = t; } g.computeVertexNormals(); }
  return g;
}
const strip = (pts, off, width, y, closed = false) => ribbon(offsetLine(pts, off - width / 2, closed), offsetLine(pts, off + width / 2, closed), y, closed);
// split a polyline into dashes (or into runs that skip given junction mouths)
function runs(pts, skip = [], dash = 0, gap = 0) {
  const out = [];
  let cur = [], along = 0;
  for (let k = 0; k < pts.length; k++) {
    if (k) along += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
    const blocked = skip.some((s) => Math.hypot(pts[k].x - s.x, pts[k].z - s.z) < s.r);
    const on = dash ? along % (dash + gap) < dash : true;
    if (!blocked && on) cur.push(pts[k]);
    else { if (cur.length > 1) out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// coarse occupancy grid so outskirts houses, trees and roads do not overlap
class Occ {
  constructor(cell = 6) { this.cell = cell; this.m = new Set(); }
  key(x, z) { return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`; }
  has(x, z) { return this.m.has(this.key(x, z)); }
  disc(x, z, r) { for (let dx = -r; dx <= r; dx += this.cell / 2) for (let dz = -r; dz <= r; dz += this.cell / 2) if (dx * dx + dz * dz <= r * r) this.m.add(this.key(x + dx, z + dz)); }
  line(pts, r) { for (let k = 0; k < pts.length; k++) this.disc(pts[k].x, pts[k].z, r); }
  free(x, z, r) { for (let dx = -r; dx <= r; dx += this.cell / 2) for (let dz = -r; dz <= r; dz += this.cell / 2) if (this.m.has(this.key(x + dx, z + dz))) return false; return true; }
}
function resample(pts, step, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts;
  const out = [src[0]];
  let carry = 0;
  for (let k = 1; k < src.length; k++) {
    const a = src[k - 1], b = src[k], l = Math.hypot(b.x - a.x, b.z - a.z);
    let d = step - carry;
    while (d <= l) { out.push({ x: a.x + ((b.x - a.x) * d) / l, z: a.z + ((b.z - a.z) * d) / l }); d += step; }
    carry = l - (d - step);
  }
  if (closed) out.pop();
  return out;
}

// ---------- procedural textures ----------
function canvasTex(w, h, draw, { repeat = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function asphaltTex() {
  return canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#212833';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 9000; k++) {
      const g = 26 + Math.floor(rnd() * 24);
      ctx.fillStyle = `rgba(${g},${g + 4},${g + 10},${rr(0.2, 0.6)})`;
      ctx.fillRect(rnd() * w, rnd() * h, rr(1, 2.5), rr(1, 2.5));
    }
    for (let k = 0; k < 7; k++) {  // patched repairs
      ctx.fillStyle = `rgba(14,18,24,${rr(0.35, 0.6)})`;
      ctx.fillRect(rnd() * w, rnd() * h, rr(30, 90), rr(18, 60));
    }
    ctx.strokeStyle = 'rgba(8,10,14,0.7)';
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) {  // cracks
      ctx.beginPath();
      let x = rnd() * w, y = rnd() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) { x += rr(-24, 24); y += rr(-24, 24); ctx.lineTo(x, y); }
      ctx.stroke();
    }
  }, { repeat: true });
}

function concreteTex() {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#2d343f';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 2500; k++) {
      const g = 38 + Math.floor(rnd() * 18);
      ctx.fillStyle = `rgba(${g},${g + 4},${g + 10},0.5)`;
      ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
    }
    ctx.strokeStyle = 'rgba(16,20,26,0.75)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= w; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, { repeat: true });
}

const WIN = 3;
const WIN_CELLS = 8;
// window grid; lit = share of windows lit, palette = list of [threshold, colour]
function windowTex(lit, warm = true) {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const cs = w / WIN_CELLS;
    for (let y = 0; y < WIN_CELLS; y++) for (let x = 0; x < WIN_CELLS; x++) {
      const r = rnd();
      if (r > lit) continue;
      const q = r / lit;
      ctx.fillStyle = !warm ? (q > 0.6 ? '#cfe8ff' : '#7fa7cc') : q > 0.88 ? '#bfe3ff' : q > 0.55 ? '#ffe2a8' : q > 0.25 ? '#d9a75c' : '#6e5636';
      ctx.fillRect(x * cs + cs * 0.22, y * cs + cs * 0.2, cs * 0.56, cs * 0.5);
    }
  }, { repeat: true });
}

// glass curtain wall: lit floor bands with thin mullions
function glassTex() {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const rows = WIN_CELLS, rh = h / rows;
    for (let y = 0; y < rows; y++) {
      const lit = rnd();
      if (lit < 0.45) continue;
      const g = ctx.createLinearGradient(0, 0, w, 0);
      const col = lit > 0.85 ? '207,232,255' : '255,226,168';
      g.addColorStop(0, `rgba(${col},0.15)`);
      g.addColorStop(rr(0.2, 0.8), `rgba(${col},${rr(0.45, 0.85)})`);
      g.addColorStop(1, `rgba(${col},0.1)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, y * rh + rh * 0.18, w, rh * 0.62);
    }
    ctx.fillStyle = '#000';
    for (let x = 0; x < w; x += w / 16) ctx.fillRect(x, 0, 2, h);
  }, { repeat: true });
}

function radialTex(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,255,255,0.35)') {
  return canvasTex(128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.4, mid);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function beamTex() {
  return canvasTex(64, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(w * 0.38, h); ctx.lineTo(w * 0.62, h); ctx.lineTo(w, 0); ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
  });
}

function chevronTex() {
  return canvasTex(128, 64, (ctx, w, h) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(w * 0.32, h * 0.18); ctx.lineTo(w * 0.62, h * 0.5); ctx.lineTo(w * 0.32, h * 0.82);
    ctx.stroke();
  }, { repeat: true });
}

function bandTex() {
  return canvasTex(8, 64, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }, { repeat: true });
}

// painted lane arrows: kind = 'L' (left + straight), 'R' (straight + right), 'S' (straight)
function arrowTex(kind) {
  return canvasTex(64, 128, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    const stem = (x) => { ctx.fillRect(x - 4, 40, 8, 84); };
    const head = (x, y) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 14, y + 22); ctx.lineTo(x + 14, y + 22); ctx.closePath(); ctx.fill(); };
    stem(32); head(32, 14);
    if (kind !== 'S') {
      const s = kind === 'L' ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(32, 86); ctx.quadraticCurveTo(32, 62, 32 + s * 16, 60); ctx.lineTo(32 + s * 16, 52); ctx.lineTo(32 + s * 30, 64);
      ctx.lineTo(32 + s * 16, 76); ctx.lineTo(32 + s * 16, 68); ctx.quadraticCurveTo(40 - s * 2, 70, 36, 90);
      ctx.closePath();
      ctx.fill();
    }
  });
}

function skyTex() {
  return canvasTex(512, 512, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, w * 0.75);
    g.addColorStop(0, '#111c2d');
    g.addColorStop(0.55, '#090f19');
    g.addColorStop(1, '#04070b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

function textSprite(text, { size = 40, color = '#8d97a5', scale = 0.1 } = {}) {
  const pad = 12;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `500 ${size}px Sora, system-ui, sans-serif`;
  ctx.font = font;
  const label = text.toUpperCase();
  const w = Math.ceil(ctx.measureText(label).width + label.length * 4) + pad * 2;
  const h = size + pad * 2;
  c.width = w; c.height = h;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '4px';
  ctx.fillText(label, pad, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(w * scale, h * scale, 1);
  return s;
}

// Box whose side UVs are scaled to world size so window grids never stretch
function windowBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const span = WIN * WIN_CELLS;
  const offU = Math.floor(rnd() * WIN_CELLS) / WIN_CELLS, offV = Math.floor(rnd() * WIN_CELLS) / WIN_CELLS;
  for (let f = 0; f < 6; f++) {
    const [fw, fh] = faces[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * (fw / span) + offU, uv.getY(i) * (fh / span) + offV);
    }
  }
  return g;
}

// Triangular prism (pitched roof) of width w (across), height h, length len along x
function prism(w, h, len) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0); shape.lineTo(w / 2, 0); shape.lineTo(0, h); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

// Collects geometry per material and merges it into one mesh each
class Batch {
  constructor(scene) { this.scene = scene; this.buckets = new Map(); }
  add(mat, geo, { x = 0, y = 0, z = 0, ry = 0, cast = true, recv = true } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((g.attributes.position.count) * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
    g.applyMatrix4(m);
    const key = mat.uuid;
    if (!this.buckets.has(key)) this.buckets.set(key, { mat, geos: [], cast, recv });
    this.buckets.get(key).geos.push(g);
  }
  flush() {
    this.meshes = [];
    for (const { mat, geos, cast, recv } of this.buckets.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(geos, false), mat);
      this.meshes.push(mesh);
      mesh.castShadow = cast;
      mesh.receiveShadow = recv;
      this.scene.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.buckets.clear();
  }
}

export class CityView {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.labels = [];
    this.blinkers = [];
    this.flash = 0;
    this.godMode = true;
    this.hospitalAnchors = new Map();
    this.hospitalMarkers = new Map();
    this.tex = {
      asphalt: asphaltTex(), concrete: concreteTex(),
      winWarm: windowTex(0.26), winBrick: windowTex(0.34), winHouse: windowTex(0.4), winDim: windowTex(0.1),
      winCool: windowTex(0.18, false), glass: glassTex(),
      glow: radialTex(), soft: radialTex('rgba(255,255,255,0.8)', 'rgba(255,255,255,0.18)'),
      beam: beamTex(), chevron: chevronTex(), band: bandTex(),
      arrowL: arrowTex('L'), arrowR: arrowTex('R'), arrowS: arrowTex('S'),
    };
    scene.background = skyTex();
    this.batch = new Batch(scene);
    this.trees = [];
    this.lamps = [];
    this.sodium = [];
    this._materials();
    this._ground();
    this._roads();
    this._river();
    this._blocks();
    this._outskirts();
    this._plantTrees();
    this._buildLamps();
    this.batch.flush();
    // anything tall (buildings, canopies, cranes, trees) can be cut away by the intersection camera's
    // see-through plane; roads, pavements and markings never are
    this.xray = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
    const clip = (mat) => { mat.clippingPlanes = [this.xray]; mat.clipShadows = true; };
    for (const m of this.batch.meshes) {
      m.geometry.computeBoundingBox();
      if (m.geometry.boundingBox.max.y > 2.5) clip(m.material);
    }
    for (const m of this.clipExtra ?? []) clip(m);
    this._signals();
    this._labels();
    this._fleet();
    this.routeViews = new Map();
  }

  // ---------- materials ----------
  _materials() {
    const winMat = (color, map, intensity, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.12, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: intensity, ...extra });
    this.m = {
      concrete: [0x2c3644, 0x333e4e, 0x283240].map((c) => winMat(c, this.tex.winWarm, 0.6)),
      brick: [0x4a3530, 0x553a31, 0x3f2f2c].map((c) => winMat(c, this.tex.winBrick, 0.7, { roughness: 0.9 })),
      glass: winMat(0x1e324a, this.tex.glass, 0.85, { roughness: 0.22, metalness: 0.65 }),
      glass2: winMat(0x243a56, this.tex.winCool, 0.8, { roughness: 0.25, metalness: 0.6 }),
      house: [0x5a5f68, 0x6b625a, 0x4e5866].map((c) => winMat(c, this.tex.winHouse, 0.55, { roughness: 0.9 })),
      warehouse: winMat(0x3b424d, this.tex.winDim, 0.5, { roughness: 0.85 }),
      dim: [0x232b36, 0x2a3240].map((c) => winMat(c, this.tex.winDim, 0.45)),
      roof: new THREE.MeshStandardMaterial({ color: 0x3a4555, roughness: 0.85 }),
      roofDark: new THREE.MeshStandardMaterial({ color: 0x252d38, roughness: 0.9 }),
      houseRoof: new THREE.MeshStandardMaterial({ color: 0x4a2f2a, roughness: 0.85 }),
      houseRoof2: new THREE.MeshStandardMaterial({ color: 0x2f3a46, roughness: 0.85 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x4a5566, roughness: 0.5, metalness: 0.5 }),
      cap: new THREE.MeshStandardMaterial({ color: 0x4b5669, roughness: 0.7 }),
      wood: new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9 }),
      sidewalk: (() => { const t = this.tex.concrete.clone(); t.needsUpdate = true; t.repeat.set(1 / 6, 1 / 6); return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.95 }); })(),
      lot: new THREE.MeshStandardMaterial({ color: COL.lot, roughness: 1 }),
      grass: new THREE.MeshStandardMaterial({ color: COL.grass, roughness: 1 }),
      path: new THREE.MeshStandardMaterial({ color: 0x2a313b, roughness: 1 }),
      parking: new THREE.MeshStandardMaterial({ color: 0x171c24, roughness: 1 }),
      shop: [0xff4f9a, 0x3fd6ff, 0xffb547, 0x8f7bff].map((c) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 0.95 })),
      bridge: new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.8 }),
      railing: new THREE.MeshStandardMaterial({ color: 0x5a6578, roughness: 0.5, metalness: 0.4 }),
      embank: new THREE.MeshStandardMaterial({ color: 0x1d232c, roughness: 0.95 }),
      road: (() => { const t = this.tex.asphalt.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.9 }); })(),
      junction: (() => { const t = this.tex.asphalt.clone(); t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(16 / 26, 16 / 26); return new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.9 }); })(),
      markWhite: new THREE.MeshBasicMaterial({ color: COL.white, transparent: true, opacity: 0.55 }),
      markYellow: new THREE.MeshBasicMaterial({ color: COL.yellow, transparent: true, opacity: 0.7 }),
      dirt: new THREE.MeshStandardMaterial({ color: 0x2a231c, roughness: 1 }),
      field: [0x16241a, 0x1d2a17, 0x231f16, 0x1a2a1f].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 })),
      furrow: new THREE.MeshStandardMaterial({ color: 0x0c120d, roughness: 1 }),
      drive: new THREE.MeshStandardMaterial({ color: 0x1d232c, roughness: 0.9 }),
      paint: new THREE.MeshBasicMaterial({ color: 0xc9cfd8, transparent: true, opacity: 0.6 }),
      bayRed: new THREE.MeshBasicMaterial({ color: 0xe5484d, transparent: true, opacity: 0.45 }),
      parkedCar: [0x9aa4b1, 0x3a4350, 0x2b4a74, 0x7b2f37, 0xd5dae0].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.4 })),
    };
  }

  _flat(w, d, mat, x, z, y, ry = 0) {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    this.batch.add(mat, g, { x, y, z, ry, cast: false });
  }

  _instanced(geo, mat, items, { cast = false, color = null } = {}) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    items.forEach((it, k) => {
      q.setFromAxisAngle(up, it.r ?? 0);
      m4.compose(new THREE.Vector3(it.x, it.y ?? 0, it.z), q, new THREE.Vector3(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.s ?? 1));
      mesh.setMatrixAt(k, m4);
      if (color) mesh.setColorAt(k, c.setHex(it.color ?? color));
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }

  // ---------- ground: dark land with the river cut out ----------
  _ground() {
    const glow = canvasTex(512, 512, (ctx, W, H) => {
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
      g.addColorStop(0, '#11161e'); g.addColorStop(0.28, '#0d1219'); g.addColorStop(0.55, '#080b10'); g.addColorStop(1, '#05070a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    });
    glow.repeat.set(1 / 3600, 1 / 3600);
    glow.offset.set(0.5, 0.5);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: glow, roughness: 1 });
    const bank = (s) => {
      const pts = [];
      for (let x = -6000; x <= 6000; x += x > -1400 && x < 1400 ? 8 : 200) pts.push(new THREE.Vector2(x, -(riverZ(x) + s * (riverHW(x) + 0.6))));
      return pts;
    };
    for (const s of [-1, 1]) {
      const edge = bank(s);
      const far = s < 0 ? 9000 : -9000;   // shape y = -z
      const shape = new THREE.Shape([...edge, new THREE.Vector2(6000, far), new THREE.Vector2(-6000, far)]);
      const m = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), mat);
      m.position.y = -0.02;
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }

  // ---------- roads and markings ----------
  _roads() {
    const road = this.m.road;
    const avs = [], sts = [];
    for (let i = 0; i < C.NX; i++) avs.push(i);
    for (let j = 0; j < C.NY; j++) sts.push(j);
    this.occ = new Occ();
    // simulated roads run straight out to the beltway
    this.mouths = [];
    for (const j of sts) {
      const z = stZ(j), hw = stHW(j), x0 = beltX(z, -1), x1 = beltX(z, 1);
      this.batch.add(road, ribbon([{ x: x0, z: z - hw }, { x: x1, z: z - hw }], [{ x: x0, z: z + hw }, { x: x1, z: z + hw }], 0.02), { cast: false });
      this.mouths.push({ x: x0, z, r: hw + 4 }, { x: x1, z, r: hw + 4 });
    }
    for (const i of avs) {
      const x = avX(i), hw = avHW(i), z0 = beltZ(x, -1), z1 = beltZ(x, 1);
      this.batch.add(road, ribbon([{ x: x + hw, z: z0 }, { x: x + hw, z: z1 }], [{ x: x - hw, z: z0 }, { x: x - hw, z: z1 }], 0.021), { cast: false });
      this.mouths.push({ x, z: z0, r: hw + 4 }, { x, z: z1, r: hw + 4 });
    }
    const juncMat = this.m.junction;
    for (const i of avs) for (const j of sts) this._flat(avHW(i) * 2, stHW(j) * 2, juncMat, avX(i), stZ(j), 0.03);

    // the beltway: two lanes each way around the whole city
    this.belt = beltPoints(6);
    this.batch.add(road, ribbon(offsetLine(this.belt, -BELT.hw, true), offsetLine(this.belt, BELT.hw, true), 0.022, true), { cast: false });
    this.occ.line(this.belt, BELT.hw + 5);

    // markings, gathered then instanced: [x, z, lengthAlongX, widthAlongZ]
    const white = [], yellow = [], stop = [], zebra = [];
    const arrows = { L: [], R: [], S: [] };
    const segs = (roadAxisIsX, cross, lo, hi) => {
      // spans along the road between junctions (beyond crosswalks)
      const out = [];
      const list = cross.map((k) => (roadAxisIsX ? [avX(k), avHW(k)] : [stZ(k), stHW(k)])).sort((a, b) => a[0] - b[0]);
      let start = lo;
      for (const [c, hw] of list) { out.push([start, c - hw - 3.2]); start = c + hw + 3.2; }
      out.push([start, hi]);
      return out.filter(([a, b]) => b - a > 2);
    };
    const line = (arr, axisX, along0, along1, offset, width, roadPos) => {
      const len = along1 - along0, mid = (along0 + along1) / 2;
      arr.push(axisX ? [mid, roadPos + offset, len, width] : [roadPos + offset, mid, width, len]);
    };
    const dashes = (arr, axisX, along0, along1, offset, roadPos) => {
      for (let a = along0 + 1; a + 3 < along1; a += 9) line(arr, axisX, a, a + 3, offset, 0.14, roadPos);
    };
    const roadLines = (axisX, pos, L, hw, a0, a1) => {
      if (L === 2) {
        line(yellow, axisX, a0, a1, C.MEDIAN / 2 - 0.1, 0.13, pos); line(yellow, axisX, a0, a1, -(C.MEDIAN / 2 - 0.1), 0.13, pos);
        dashes(white, axisX, a0, a1, C.MEDIAN / 2 + C.LW, pos); dashes(white, axisX, a0, a1, -(C.MEDIAN / 2 + C.LW), pos);
      } else {
        line(yellow, axisX, a0, a1, 0.11, 0.1, pos); line(yellow, axisX, a0, a1, -0.11, 0.1, pos);
      }
      line(white, axisX, a0, a1, hw - 0.3, 0.12, pos); line(white, axisX, a0, a1, -(hw - 0.3), 0.12, pos);
    };
    for (const j of sts) for (const [a, b] of segs(true, avs, beltX(stZ(j), -1) + BELT.hw + 2, beltX(stZ(j), 1) - BELT.hw - 2)) roadLines(true, stZ(j), stL(j), stHW(j), a, b);
    for (const i of avs) for (const [a, b] of segs(false, sts, beltZ(avX(i), -1) + BELT.hw + 2, beltZ(avX(i), 1) - BELT.hw - 2)) roadLines(false, avX(i), avL(i), avHW(i), a, b);

    // country roads leave the beltway in a few places; planned now so the beltway markings break for them
    this.spokes = this._planSpokes();
    // beltway markings follow the curve; they break at every road that joins it
    const fine = resample(this.belt, 1.5, true);
    const curveMark = (mat, off, width, dash = 0, gap = 0) => {
      const pts = offsetLine(fine, off, true);
      for (const r of runs(pts, this.mouths, dash, gap)) this.batch.add(mat, strip(r, 0, width, 0.045), { cast: false });
    };
    for (const s of [-1, 1]) {
      curveMark(this.m.markYellow, s * (C.MEDIAN / 2 - 0.1), 0.13);
      curveMark(this.m.markWhite, s * (C.MEDIAN / 2 + C.LW), 0.14, 3, 6);
      curveMark(this.m.markWhite, s * (BELT.hw - 0.3), 0.12);
    }

    // stop lines, crosswalks and lane arrows at simulated intersections
    for (const n of this.sim.nodes.values()) {
      if (!n.real) continue;
      for (const [dir, link] of Object.entries(n.in)) {
        const d = C.DIRS[dir], r = C.rightOf(dir), hwOwn = C.halfW(link.L);
        const hwCross = C.AXIS[dir] === 'EW' ? avHW(n.i) : stHW(n.j);
        const back = hwCross + 2.6, along = C.AXIS[dir] === 'EW';
        const cx = n.x - d.dx * back + r.x * (hwOwn / 2), cz = n.z - d.dz * back + r.z * (hwOwn / 2);
        stop.push(along ? [cx, cz, 0.45, hwOwn - 0.3] : [cx, cz, hwOwn - 0.3, 0.45]);
        const zb = hwCross + 1.35;
        for (let o = -hwOwn + 0.7; o <= hwOwn - 0.6; o += 1.25) {
          const zx = n.x - d.dx * zb + r.x * o, zz = n.z - d.dz * zb + r.z * o;
          zebra.push(along ? [zx, zz, 2.2, 0.6] : [zx, zz, 0.6, 2.2]);
        }
        if (link.L === 2) {
          for (let k = 0; k < 2; k++) {
            const off = C.laneOff(2, k), back2 = back + 9;
            arrows[k === 0 ? 'L' : 'R'].push({ x: n.x - d.dx * back2 + r.x * off, z: n.z - d.dz * back2 + r.z * off, r: Math.atan2(-d.dz, d.dx) - Math.PI / 2 });
          }
        }
      }
    }
    const markGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const asItems = (arr, y) => arr.map(([x, z, sx, sz]) => ({ x, z, y, sx, sz }));
    this._instanced(markGeo, this.m.markWhite, asItems(white, 0.045));
    this._instanced(markGeo, this.m.markYellow, asItems(yellow, 0.046));
    this._instanced(markGeo, new THREE.MeshBasicMaterial({ color: 0xe6e9ee, transparent: true, opacity: 0.8 }), asItems(stop, 0.047));
    this._instanced(markGeo, new THREE.MeshBasicMaterial({ color: COL.white, transparent: true, opacity: 0.42 }), asItems(zebra, 0.046));
    const arrowGeo = new THREE.PlaneGeometry(1.4, 2.8).rotateX(-Math.PI / 2);
    for (const k of ['L', 'R']) {
      this._instanced(arrowGeo, new THREE.MeshBasicMaterial({ map: this.tex[`arrow${k}`], transparent: true, opacity: 0.6, depthWrite: false }), arrows[k].map((a) => ({ ...a, y: 0.048 })));
    }
    // simulated roads are taken in the occupancy grid too
    for (const j of sts) this.occ.line(resample([{ x: beltX(stZ(j), -1), z: stZ(j) }, { x: beltX(stZ(j), 1), z: stZ(j) }], 6), stHW(j) + 4);
    for (const i of avs) this.occ.line(resample([{ x: avX(i), z: beltZ(avX(i), -1) }, { x: avX(i), z: beltZ(avX(i), 1) }], 6), avHW(i) + 4);
  }

  // A two-lane country road (or suburban street) along a polyline, with markings
  _sideRoad(pts, { hw = C.halfW(1), lit = true } = {}) {
    this.batch.add(this.m.road, ribbon(offsetLine(pts, -hw), offsetLine(pts, hw), 0.019), { cast: false });
    const fine = resample(pts, 1.5);
    for (const r of runs(offsetLine(fine, 0), this.mouths, 3, 6)) this.batch.add(this.m.markYellow, strip(r, 0, 0.14, 0.044), { cast: false });
    this.occ.line(resample(pts, 4), hw + 2);
    if (lit) {
      const L = resample(pts, 38);
      L.forEach((p, k) => {
        if (k === 0) return;
        const bright = k < 12;
        const a = L[k - 1], l = Math.hypot(p.x - a.x, p.z - a.z) || 1, nx = -(p.z - a.z) / l, nz = (p.x - a.x) / l, s = k % 2 ? 1 : -1;
        this.lamps.push({ x: p.x + nx * s * (hw + 1.2), z: p.z + nz * s * (hw + 1.2), dx: -nx * s, dz: -nz * s, dim: !bright });
      });
    }
  }

  // ---------- river: winds past the waterfront and bends away beyond the city ----------
  _river() {
    const xs = [];
    for (let x = -1400; x <= 1400; x += 6) xs.push(x);
    const mid = xs.map((x) => ({ x, z: riverZ(x) }));
    const north = xs.map((x) => ({ x, z: riverZ(x) - riverHW(x) })), south = xs.map((x) => ({ x, z: riverZ(x) + riverHW(x) }));
    const wGeo = ribbon(north.map((p) => ({ x: p.x, z: p.z - 3 })), south.map((p) => ({ x: p.x, z: p.z + 3 })), -2.4, false, 60);
    const wm = new THREE.Mesh(wGeo, new THREE.MeshStandardMaterial({ color: 0x14304f, roughness: 0.1, metalness: 0.6, emissive: 0x0b2747, emissiveIntensity: 1.0 }));
    wm.receiveShadow = true;
    this.scene.add(wm);
    // shimmering reflections of the city lights
    const shimmer = canvasTex(256, 256, (ctx, W, H) => {
      ctx.clearRect(0, 0, W, H);
      for (let k = 0; k < 260; k++) {
        const cool = rnd() < 0.35;
        ctx.fillStyle = cool ? `rgba(150,200,255,${rr(0.12, 0.4)})` : `rgba(255,${180 + Math.floor(rnd() * 60)},${120 + Math.floor(rnd() * 80)},${rr(0.15, 0.5)})`;
        ctx.fillRect(rnd() * W, rnd() * H, rr(6, 30), rr(1, 2.5));
      }
    }, { repeat: true });
    this.shimmer = shimmer;
    this.scene.add(new THREE.Mesh(ribbon(north, south, -2.35, false, 60),
      new THREE.MeshBasicMaterial({ map: shimmer, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    // embankment walls along both banks
    for (const bank of [north, south]) {
      const pos = [], idx = [];
      bank.forEach((p, k) => { pos.push(p.x, 0.02, p.z, p.x, -2.7, p.z); if (k) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); } });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1d232c, roughness: 0.95, side: THREE.DoubleSide }));
      this.scene.add(m);
    }
    // waterfront promenade on the north bank, between Harbor Blvd and the water, inside the beltway
    const prom = xs.filter((x) => Math.abs(x) < beltX(riverZ(x), 1) - BELT.hw - 3);
    this.batch.add(this.m.sidewalk, ribbon(prom.map((x) => ({ x, z: HARBOR_EDGE + 0.4 })), prom.map((x) => ({ x, z: riverZ(x) - riverHW(x) })), 0.05, false, 6), { cast: false });
    for (const x of prom) {
      if (x % 14 !== 0 || rnd() < 0.15) continue;
      this.trees.push({ x: x + rr(-2, 2), z: riverZ(x) - riverHW(x) - 4.5, s: rr(0.8, 1.1) });
    }
    for (const x of prom) if (x % 18 === 0) this.lamps.push({ x, z: riverZ(x) - riverHW(x) - 1.5, dx: 0, dz: 0 });
    // riverside park on the south bank: grass, a winding path and trees
    const southPark = xs.filter((x) => Math.abs(x) < BELT.rx - 30);
    this.batch.add(this.m.grass, ribbon(southPark.map((x) => ({ x, z: riverZ(x) + riverHW(x) })), southPark.map((x) => ({ x, z: Math.max(riverZ(x) + riverHW(x) + 2, beltZ(x, 1) - BELT.hw - 1) })), 0.03, false, 26), { cast: false });
    const path = southPark.map((x) => ({ x, z: riverZ(x) + riverHW(x) + 7 + 2.5 * Math.sin(x / 40) }));
    this.batch.add(this.m.path, strip(path, 0, 2.2, 0.04), { cast: false });
    for (const x of southPark) {
      if (x % 10 !== 0 || rnd() < 0.35) continue;
      const z0 = riverZ(x) + riverHW(x) + 3, z1 = beltZ(x, 1) - BELT.hw - 4;
      if (z1 - z0 < 4) continue;
      const z = rr(z0, z1);
      if (Math.abs(z - (riverZ(x) + riverHW(x) + 7 + 2.5 * Math.sin(x / 40))) < 3) continue;
      if (this.occ.has(x, z)) continue;
      this.trees.push({ x, z, s: rr(0.8, 1.3) });
    }
    // bridges: every avenue, and the beltway where it crosses
    const bridge = (ax, az, bx, bz, hw) => {
      const len = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax);
      const cx = (ax + bx) / 2, cz = (az + bz) / 2;
      this.batch.add(this.m.bridge, new THREE.BoxGeometry(len, 1.4, hw * 2 + 3), { x: cx, y: -0.7, z: cz, ry });
      for (const s of [-1, 1]) {
        const ox = -Math.sin(ry) * s * (hw + 1.3), oz = -Math.cos(ry) * s * (hw + 1.3);
        this.batch.add(this.m.railing, new THREE.BoxGeometry(len, 1.1, 0.25), { x: cx + ox, y: 0.55, z: cz + oz, ry });
        for (let t = 6; t < len - 2; t += 14) {
          const px = ax + ((bx - ax) * t) / len + ox * 0.95, pz = az + ((bz - az) * t) / len + oz * 0.95;
          this.lamps.push({ x: px, z: pz, dx: -ox / (hw + 1.3), dz: -oz / (hw + 1.3), bridge: true });
        }
      }
      for (const t of [0.33, 0.66]) this.batch.add(this.m.embank, new THREE.BoxGeometry(3, 2.6, hw * 1.4), { x: ax + (bx - ax) * t, y: -2.3, z: az + (bz - az) * t, ry });
    };
    for (let i = 0; i < C.NX; i++) {
      const x = avX(i);
      bridge(x, riverZ(x) - riverHW(x) - 2, x, riverZ(x) + riverHW(x) + 2, avHW(i));
    }
    let run = null;
    const belt = this.belt;
    for (let k = 0; k <= belt.length; k++) {
      const p = belt[k % belt.length];
      const wet = inRiver(p.x, p.z, 2);
      if (wet && !run) run = { a: belt[(k - 1 + belt.length) % belt.length] };
      if (!wet && run) { bridge(run.a.x, run.a.z, p.x, p.z, BELT.hw); run = null; }
    }
  }

  // ---------- blocks inside the beltway ----------
  _district(i, j) {
    for (const h of C.HOSPITALS) {
      const ci = h.corner[0] > 0 ? h.node[0] : h.node[0] - 1;
      const cj = h.corner[1] > 0 ? h.node[1] : h.node[1] - 1;
      if (ci === i && cj === j) return 'hospital';
    }
    if (C.PARKS.some(([a, b]) => a === i && b === j)) return 'park';
    if (SPECIAL[`${i},${j}`]) return SPECIAL[`${i},${j}`];
    const D = C.DOWNTOWN;
    if (i >= D.i0 && i <= D.i1 && j >= D.j0 && j <= D.j1) return 'downtown';
    if (i === -1) return 'industrial';
    if (j === -1 || i === C.NX - 1) return 'residential';
    return 'midtown';
  }

  _blocks() {
    for (let i = -1; i < C.NX; i++) {
      for (let j = -1; j < C.NY - 1; j++) {
        const kind = this._district(i, j);
        // the outer blocks run out to the beltway, which curves, so size them by its tightest point
        const zA = j === -1 ? stZ(-1) : stZ(j), zB = stZ(j + 1), xA = i === -1 ? avX(-1) : avX(i), xB = i === C.NX - 1 ? avX(C.NX) : avX(i + 1);
        const zWorst = Math.max(Math.abs(zA), Math.abs(zB)), xWorst = Math.max(Math.abs(xA), Math.abs(xB));
        const x0 = i === -1 ? beltX(zWorst, -1) + BELT.hw + 6 : avX(i) + avHW(i);
        const x1 = i === C.NX - 1 ? beltX(zWorst, 1) - BELT.hw - 6 : avX(i + 1) - avHW(i + 1);
        const z0 = j === -1 ? beltZ(xWorst, -1) + BELT.hw + 6 : stZ(j) + stHW(j);
        const z1 = stZ(j + 1) - stHW(j + 1);
        const w = x1 - x0, d = z1 - z0;
        if (w < 26 || d < 26) continue;   // too thin next to the beltway: left as a planted verge
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        this.occ.disc(cx, cz, 0);
        for (let x = x0; x <= x1; x += 4) for (let z = z0; z <= z1; z += 4) this.occ.m.add(this.occ.key(x, z));
        // raised sidewalk, then the lot
        this.batch.add(this.m.sidewalk, new THREE.BoxGeometry(w, 0.3, d), { x: cx, y: 0.15, z: cz, cast: false });
        const lw = w - 6, ld = d - 6;
        const lot = { x: cx, z: cz, w: lw, d: ld, i, j };
        const paved = { industrial: this.m.parking, parking: this.m.parking, gas: this.m.parking, plaza: this.m.sidewalk, construction: this.m.dirt };
        if (kind !== 'park' && kind !== 'school' && kind !== 'civic') this._flat(lw, ld, paved[kind] ?? this.m.lot, cx, cz, 0.31);
        const build = {
          hospital: () => this._hospital(lot), park: () => this._park(lot), downtown: () => this._downtown(lot), midtown: () => this._midtown(lot),
          residential: () => this._residential(lot, false), industrial: () => this._industrial(lot, false),
          parking: () => this._parkingLot(lot), plaza: () => this._plaza(lot), school: () => this._school(lot), gas: () => this._gasStation(lot),
          construction: () => this._construction(lot), civic: () => this._civic(lot),
        };
        build[kind]();
        // street trees along two-lane avenues
        if (!['park', 'plaza'].includes(kind)) {
          for (const [ax, side] of [[x0, 1], [x1, -1]]) {
            const ai = side > 0 ? i : i + 1;
            if (ai < 0 || ai >= C.NX || avL(ai) !== 2) continue;
            for (let z = z0 + 7; z < z1 - 6; z += 13) this.trees.push({ x: ax + side * 1.6, z, s: rr(0.7, 0.9) });
          }
        }
      }
    }
    // planted verge inside the beltway wherever no block reaches it
    for (let x = -BELT.rx; x <= BELT.rx; x += 9) for (let z = -BELT.rz; z <= HARBOR_EDGE; z += 9) {
      const px = x + rr(-3, 3), pz = z + rr(-3, 3);
      if (!inBelt(px, pz, BELT.hw + 4) || this.occ.has(px, pz) || rnd() < 0.45) continue;
      this.trees.push({ x: px, z: pz, s: rr(0.8, 1.2) });
    }
  }

  // ---------- special blocks ----------
  _parkingLot(lot) {
    const { x, z, w, d } = lot;
    const rows = Math.floor(d / 13), cols = Math.floor(w / 3);
    for (let r = 0; r < rows; r++) {
      const rz = z - d / 2 + 6.5 + r * 13;
      for (let c = 0; c < cols; c++) {
        const px = x - w / 2 + 1.5 + c * 3;
        this._flat(0.12, 5, this.m.paint, px - 1.5, rz, 0.32);
        if (rnd() < 0.42) continue;
        this.batch.add(pick(this.m.parkedCar), new THREE.BoxGeometry(1.8, 1.3, 4.1), { x: px, y: 0.95, z: rz + (r % 2 ? 0.2 : -0.2) });
      }
    }
    for (const [ox, oz] of [[-w / 4, 0], [w / 4, 0]]) this.sodium.push({ x: x + ox, z: z + oz });
    this.trees.push({ x: x - w / 2 + 2, z: z - d / 2 + 2, s: 0.8 }, { x: x + w / 2 - 2, z: z + d / 2 - 2, s: 0.8 });
  }

  _plaza(lot) {
    const { x, z, w, d } = lot;
    // paved square, a lit fountain, trees in a ring and low pavilions at two corners
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(9, 9.4, 0.8, 40), new THREE.MeshStandardMaterial({ color: 0x3a4555, roughness: 0.7 }));
    basin.position.set(x, 0.7, z);
    this.scene.add(basin);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(8.4, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0f2a44, emissive: 0x1f6fb0, emissiveIntensity: 0.9, roughness: 0.1 }));
    pool.position.set(x, 1.12, z);
    this.scene.add(pool);
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 1.2, 4, 12), new THREE.MeshBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.55 }));
    jet.position.set(x, 3, z);
    this.scene.add(jet);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      this.trees.push({ x: x + Math.cos(a) * 17, z: z + Math.sin(a) * 17, s: 0.85 });
    }
    for (const [sx, sz] of [[-1, -1], [1, 1]]) this._box(this.m.glass2, 12, 4.5, 8, x + sx * (w / 2 - 9), 0.3, z + sz * (d / 2 - 7), this.m.roofDark);
    for (const [dx, dz] of [[-10, 0], [10, 0], [0, -10], [0, 10]]) this.lamps.push({ x: x + dx * 2.2, z: z + dz * 2.2, dx: 0, dz: 0, park: true });
  }

  _school(lot) {
    const { x, z, w, d } = lot;
    this._flat(w + 6, d + 6, this.m.grass, x, z, 0.31);
    // L-shaped two-storey school on one half, a running track with a field on the other
    this._box(pick(this.m.brick), w * 0.42, 8, d * 0.3, x - w * 0.27, 0.3, z - d * 0.3);
    this._box(pick(this.m.brick), w * 0.16, 8, d * 0.5, x - w * 0.4, 0.3, z + d * 0.06);
    const tx = x + w * 0.2, tz = z + d * 0.05;
    const track = new THREE.Mesh(new THREE.RingGeometry(10, 13.5, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6a2c24, roughness: 0.9 }));
    track.scale.set(1.25, 1, 0.95);
    track.position.set(tx, 0.33, tz);
    this.scene.add(track);
    const field = new THREE.Mesh(new THREE.CircleGeometry(10, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b4a2c, roughness: 1 }));
    field.scale.set(1.25, 1, 0.95);
    field.position.set(tx, 0.32, tz);
    this.scene.add(field);
    for (const [dx, dz] of [[-16, -13], [16, -13], [-16, 13], [16, 13]]) this.sodium.push({ x: tx + dx, z: tz + dz, soft: true });
  }

  _gasStation(lot) {
    const { x, z, w, d } = lot;
    // canopy with a glowing underside over two pump islands, a small shop, and a few trees
    const cx = x - w * 0.12, cz = z - d * 0.1;
    this.batch.add(this.m.metal, new THREE.BoxGeometry(22, 0.8, 13), { x: cx, y: 5.4, z: cz });
    this.batch.add(this.m.shop[1], new THREE.BoxGeometry(22.2, 0.35, 13.2), { x: cx, y: 5.9, z: cz, cast: false });
    this.batch.add(new THREE.MeshBasicMaterial({ color: 0xeaf4ff }), new THREE.BoxGeometry(21, 0.05, 12), { x: cx, y: 4.98, z: cz, cast: false });
    for (const ox of [-5, 5]) for (const oz of [-2.5, 2.5]) this.batch.add(this.m.cap, new THREE.BoxGeometry(0.8, 1.6, 1.4), { x: cx + ox, y: 1.1, z: cz + oz });
    this.canopyLights = this.canopyLights ?? [];
    this.canopyLights.push({ x: cx - 5, z: cz }, { x: cx + 5, z: cz });
    this._box(pick(this.m.concrete), 14, 4.5, 9, x + w * 0.3, 0.3, z + d * 0.28, this.m.roofDark);
    this._shopBand(x + w * 0.3, z + d * 0.28, 14, 9);
    for (let k = 0; k < 6; k++) this.trees.push({ x: x - w / 2 + 3 + k * (w / 6), z: z + d / 2 - 2, s: 0.8 });
  }

  _construction(lot) {
    const { x, z, w, d } = lot;
    // half-built frame of columns and floor slabs, a tower crane with a red beacon, site fence lights
    const fw = w * 0.55, fd = d * 0.5, fx = x - w * 0.12, fz = z;
    for (let f = 0; f < 5; f++) this.batch.add(this.m.cap, new THREE.BoxGeometry(fw, 0.35, fd), { x: fx, y: 0.5 + f * 4, z: fz });
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 3; b++) this.batch.add(this.m.metal, new THREE.BoxGeometry(0.5, 16.5, 0.5), { x: fx - fw / 2 + (a * fw) / 4, y: 8.5, z: fz - fd / 2 + (b * fd) / 3 });
    const kx = x + w * 0.3, kz = z - d * 0.2;
    this.batch.add(this.m.shop[2], new THREE.BoxGeometry(1.4, 44, 1.4), { x: kx, y: 22, z: kz });
    this.batch.add(this.m.shop[2], new THREE.BoxGeometry(46, 1.1, 1.1), { x: kx - 12, y: 44, z: kz, ry: 0.5 });
    this.batch.add(this.m.cap, new THREE.BoxGeometry(5, 2.5, 3), { x: kx + 5, y: 44, z: kz });
    this._beacon(kx, 45.5, kz);
    for (let k = 0; k < 4; k++) this.sodium.push({ x: x - w / 2 + 6 + (k * (w - 12)) / 3, z: z + d / 2 - 4 });
  }

  _civic(lot) {
    const { x, z, w, d } = lot;
    // a museum or city hall: lawn, a wide low building with a colonnade, flagpoles and a fountain path
    this._flat(w + 6, d + 6, this.m.grass, x, z, 0.31);
    this._flat(5, d, this.m.path, x, z, 0.32);
    const bz = z + d * 0.12;
    this._box(pick(this.m.concrete), w * 0.7, 11, d * 0.42, x, 0.3, bz, this.m.roof);
    for (let k = 0; k < 10; k++) this.batch.add(new THREE.MeshStandardMaterial({ color: 0xd8dde5, roughness: 0.6, emissive: 0x404650, emissiveIntensity: 0.5 }), new THREE.CylinderGeometry(0.45, 0.45, 9, 10), { x: x - w * 0.3 + (k * w * 0.6) / 9, y: 4.8, z: bz - d * 0.21 - 1.6 });
    for (const ox of [-6, 6]) {
      this.batch.add(this.m.metal, new THREE.CylinderGeometry(0.1, 0.12, 12, 6), { x: x + ox, y: 6.3, z: z - d * 0.35 });
      this.batch.add(this.m.shop[1], new THREE.BoxGeometry(2.4, 1.4, 0.05), { x: x + ox + 1.2, y: 11.4, z: z - d * 0.35, cast: false });
    }
    for (let k = 0; k < 8; k++) this.trees.push({ x: x - w / 2 + 4 + k * ((w - 8) / 7), z: z - d / 2 + 3, s: 0.9 });
  }

  // ---------- outskirts: roads curving out of the beltway, suburbs, fields and forest ----------
  _outskirts() {
    const occ = this.occ;
    // keep the river and its banks clear
    for (let x = -1400; x <= 1400; x += 6) occ.line([{ x, z: riverZ(x) }], riverHW(x) + 8);
    const spokes = this.spokes;
    for (const p of spokes) this._sideRoad(p);
    // cul-de-sacs off the spokes, lined with houses
    const streets = [];
    for (const p of spokes) {
      for (const at of [10, 22, 34]) {
        if (at >= p.length - 2) continue;
        const a = p[at], b = p[at + 1], hd = Math.atan2(b.z - a.z, b.x - a.x);
        for (const side of [-1, 1]) {
          if (rnd() < 0.35) continue;
          let x = a.x, z = a.z, h = hd + side * Math.PI / 2;
          const pts = [{ x, z }];
          const len = Math.floor(rr(10, 18)), curl = rr(-0.07, 0.07);
          let ok = true;
          for (let k = 0; k < len; k++) {
            h += curl;
            x += Math.cos(h) * 8; z += Math.sin(h) * 8;
            if (k > 1 && !occ.free(x, z, 7)) { ok = false; break; }
            if (inBelt(x, z, -BELT.hw - 20) || inRiver(x, z, 14)) { ok = false; break; }
            pts.push({ x, z });
          }
          if (!ok && pts.length < 6) continue;
          streets.push(pts);
        }
      }
    }
    for (const s of streets) {
      this._sideRoad(s, { hw: 3.2, lit: false });
      const end = s.at(-1);
      this.batch.add(this.m.road, new THREE.CircleGeometry(9, 24).rotateX(-Math.PI / 2), { x: end.x, y: 0.019, z: end.z, cast: false });
      occ.disc(end.x, end.z, 12);
    }
    // houses along spokes (near the city) and along every cul-de-sac
    const houseAlong = (pts, from, to, setback) => {
      const L = resample(pts, 15);
      for (let k = Math.max(1, from); k < Math.min(L.length - 1, to); k++) {
        const a = L[k - 1], b = L[k], l = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
        for (const s of [-1, 1]) {
          if (rnd() < 0.22) continue;
          const hx = b.x + nx * s * setback, hz = b.z + nz * s * setback;
          if (!occ.free(hx, hz, 4) || inRiver(hx, hz, 10) || inBelt(hx, hz, -BELT.hw - 8)) continue;
          occ.disc(hx, hz, 7);
          this._house(hx, hz, Math.atan2(-(b.z - a.z), b.x - a.x), Math.hypot(hx, hz));
        }
      }
    };
    for (const p of spokes) houseAlong(p, 2, 30, 14);
    for (const s of streets) houseAlong(s, 1, 99, 13);
    this._mall(spokes);
    // fields: big dark rectangles with crop rows, a little way out
    for (let k = 0; k < 14; k++) {
      const ang = rr(0, Math.PI * 2), dist = rr(560, 900);
      const fx = Math.cos(ang) * dist * 1.1, fz = Math.sin(ang) * dist * 0.9;
      const fw = rr(70, 140), fd = rr(50, 100), ry = rr(-0.5, 0.5);
      if (!occ.free(fx, fz, Math.max(fw, fd) / 2) || inRiver(fx, fz, Math.max(fw, fd) / 2 + 10)) continue;
      for (let x = -fw / 2; x <= fw / 2; x += 6) for (let z = -fd / 2; z <= fd / 2; z += 6) occ.m.add(occ.key(fx + x, fz + z));
      this._flat(fw, fd, pick(this.m.field), fx, fz, 0.012, ry);
      for (let r = -fd / 2 + 3; r < fd / 2; r += 5) this.batch.add(this.m.furrow, new THREE.PlaneGeometry(fw - 4, 0.6).rotateX(-Math.PI / 2), { x: fx + Math.sin(ry) * r, y: 0.016, z: fz + Math.cos(ry) * r, ry, cast: false });
    }
    // forest in noisy patches, thinning out into the dark
    for (let x = -1300; x <= 1300; x += 11) for (let z = -1200; z <= 1300; z += 11) {
      const px = x + rr(-4, 4), pz = z + rr(-4, 4);
      const r = Math.hypot(px / 1.1, pz / 0.95);
      if (inBelt(px, pz, -BELT.hw - 14) || r > 1250) continue;
      const fade = r < 850 ? 1 : 1 - (r - 850) / 400;
      const dens = (fbm(px / 210, pz / 210) - 0.38) * 2.6 * fade + (r < 420 ? -0.35 : 0);
      if (rnd() > dens) continue;
      if (occ.has(px, pz) || inRiver(px, pz, 6)) continue;
      this.trees.push({ x: px, z: pz, s: rr(1.0, 1.7), y: 0 });
    }
  }

  // A retail park beside one of the country roads: a big-box store, a lit car park and a sign
  _mall(spokes) {
    const p = spokes[1];
    if (!p || p.length < 30) return;
    const a = p[24], b = p[25], l = Math.hypot(b.x - a.x, b.z - a.z), nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
    const cx = a.x + nx * 60, cz = a.z + nz * 60, ry = Math.atan2(-(b.z - a.z), b.x - a.x);
    if (!this.occ.free(cx, cz, 30)) return;
    for (let x = -55; x <= 55; x += 6) for (let z = -38; z <= 38; z += 6) this.occ.m.add(this.occ.key(cx + x * Math.cos(ry) + z * Math.sin(ry), cz - x * Math.sin(ry) + z * Math.cos(ry)));
    const at = (u, v) => ({ x: cx + u * Math.cos(ry) + v * Math.sin(ry), z: cz - u * Math.sin(ry) + v * Math.cos(ry) });
    this._flat(110, 74, this.m.parking, cx, cz, 0.015, ry);
    const store = at(0, 18);
    this.batch.add(this.m.warehouse, windowBox(80, 10, 30), { x: store.x, y: 5, z: store.z, ry });
    this.batch.add(this.m.roofDark, new THREE.BoxGeometry(80.2, 0.3, 30.2), { x: store.x, y: 10.15, z: store.z, ry, cast: false });
    const sign = at(0, 2.9);
    this.batch.add(this.m.shop[0], new THREE.BoxGeometry(22, 2.2, 0.3), { x: sign.x, y: 8, z: sign.z, ry, cast: false });
    for (let u = -45; u <= 45; u += 3.2) for (const v of [-30, -22, -12]) {
      if (rnd() < 0.5) continue;
      const c = at(u, v);
      this.batch.add(pick(this.m.parkedCar), new THREE.BoxGeometry(1.8, 1.3, 4.1), { x: c.x, y: 0.65, z: c.z, ry });
    }
    for (const u of [-40, -14, 14, 40]) { const c = at(u, -18); this.sodium.push({ x: c.x, z: c.z - 0.3 }); }
  }

  _planSpokes() {
    const beltAt = (deg) => {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      return { x: BELT.rx * Math.sign(c) * Math.abs(c) ** (2 / BELT.n), z: BELT.rz * Math.sign(s) * Math.abs(s) ** (2 / BELT.n), out: { x: c, z: s } };
    };
    const spokes = [];
    for (const [deg, bend] of [[-14, 0.35], [-52, -0.25], [-95, 0.3], [-133, -0.3], [176, 0.25], [118, -0.2], [70, 0.2]]) {
      const b = beltAt(deg);
      const pts = [];
      let x = b.x, z = b.z, hd = Math.atan2(b.out.z, b.out.x);
      for (let k = 0; k < 160; k++) {
        pts.push({ x, z });
        hd += Math.sin(k / 14 + deg) * 0.012 + bend * 0.004;
        x += Math.cos(hd) * 8; z += Math.sin(hd) * 8;
        if (inRiver(x, z, 12)) break;
      }
      if (pts.length > 10) { spokes.push(pts); this.mouths.push({ x: b.x, z: b.z, r: C.halfW(1) + 5 }); }
    }
    return spokes;
  }

  _house(x, z, ry, dist) {
    const h = rr(3.5, 5.5), bw = rr(7, 10), bd = rr(6, 8.5);
    const mat = dist > 520 ? pick(this.m.dim) : pick(this.m.house);
    this.batch.add(mat, windowBox(bw, h, bd), { x, y: h / 2, z, ry });
    this.batch.add(rnd() < 0.6 ? this.m.houseRoof : this.m.houseRoof2, prism(bd + 0.6, rr(2, 3), bw + 0.6), { x, y: h, z, ry });
    if (rnd() < 0.5) this.trees.push({ x: x + rr(-6, 6), z: z + rr(-6, 6), s: rr(0.7, 1), y: 0 });
  }


  _box(mat, w, h, d, x, y, z, roofMat = this.m.roof) {
    this.batch.add(mat, windowBox(w, h, d), { x, y: y + h / 2, z });
    // roof slab in its own material so tops read in iso view
    this.batch.add(roofMat, new THREE.BoxGeometry(w + 0.01, 0.12, d + 0.01), { x, y: y + h + 0.06, z, cast: false });
  }

  _beacon(x, y, z) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshStandardMaterial({ color: 0x220000, emissive: COL.red, emissiveIntensity: 3 }));
    b.position.set(x, y, z);
    this.scene.add(b);
    this.blinkers.push({ mat: b.material, phase: rnd() * 2 });
  }

  _downtown(lot) {
    const { x, z, w, d } = lot;
    const centre = 1.25 - Math.hypot(x, z) / 420;
    const plots = rnd() < 0.55 ? [[0, 0, w, d]] : [[-w / 4, 0, w / 2, d], [w / 4, 0, w / 2, d]];
    for (const [ox, oz, pw, pd] of plots) {
      // podium with shopfronts, then a tower
      const ph = rr(6, 10);
      this._box(pick(this.m.concrete), pw * 0.92, ph, pd * 0.92, x + ox, 0.3, z + oz, this.m.roofDark);
      this._shopBand(x + ox, z + oz, pw * 0.92, pd * 0.92);
      const tw = pw * rr(0.45, 0.65), td = pd * rr(0.45, 0.65);
      const th = rr(34, 78) * centre;
      const glass = rnd() < 0.7 ? this.m.glass : this.m.glass2;
      this._box(glass, tw, th, td, x + ox + rr(-2, 2), 0.3 + ph, z + oz + rr(-2, 2));
      let top = 0.3 + ph + th;
      if (rnd() < 0.6) {
        const cw = tw * 0.62, cd = td * 0.62, ch = rr(6, 14);
        this._box(glass, cw, ch, cd, x + ox, top, z + oz);
        top += ch;
      }
      this.batch.add(this.m.metal, new THREE.CylinderGeometry(0.18, 0.3, 8, 6), { x: x + ox, y: top + 4, z: z + oz });
      this._beacon(x + ox, top + 8.4, z + oz);
    }
  }

  _shopBand(x, z, w, d) {
    const mat = pick(this.m.shop);
    for (const [bw, bd, ox, oz] of [[w + 0.2, 0.15, 0, d / 2], [w + 0.2, 0.15, 0, -d / 2], [0.15, d + 0.2, w / 2, 0], [0.15, d + 0.2, -w / 2, 0]]) {
      if (rnd() < 0.35) continue;
      this.batch.add(mat, new THREE.BoxGeometry(bw, 0.5, bd), { x: x + ox, y: 3.4, z: z + oz, cast: false });
    }
  }

  _midtown(lot) {
    const { x, z, w, d } = lot;
    const cells = [[-w / 4, -d / 4], [w / 4, -d / 4], [-w / 4, d / 4], [w / 4, d / 4]];
    for (const [ox, oz] of cells) {
      const bw = (w / 2) * rr(0.7, 0.88), bd = (d / 2) * rr(0.7, 0.88), h = rr(10, 26);
      const mat = rnd() < 0.6 ? pick(this.m.brick) : pick(this.m.concrete);
      this._box(mat, bw, h, bd, x + ox, 0.3, z + oz);
      if (rnd() < 0.6) this._shopBand(x + ox, z + oz, bw, bd);
      if (rnd() < 0.45) this._waterTower(x + ox + rr(-bw / 4, bw / 4), 0.3 + h, z + oz + rr(-bd / 4, bd / 4));
      else if (rnd() < 0.7) this.batch.add(this.m.cap, new THREE.BoxGeometry(rr(2, 4), rr(1, 2), rr(2, 4)), { x: x + ox, y: 0.3 + h + 0.8, z: z + oz });
    }
  }

  _waterTower(x, y, z) {
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) this.batch.add(this.m.metal, new THREE.CylinderGeometry(0.1, 0.1, 3, 4), { x: x + lx, y: y + 1.5, z: z + lz });
    this.batch.add(this.m.wood, new THREE.CylinderGeometry(1.6, 1.6, 3, 12), { x, y: y + 4.5, z });
    this.batch.add(this.m.roofDark, new THREE.ConeGeometry(1.75, 1.4, 12), { x, y: y + 6.7, z });
  }

  _residential(lot, outskirts) {
    const { x, z, w, d } = lot;
    const nx = Math.max(2, Math.floor(w / 15)), nz = Math.max(2, Math.floor(d / 17));
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      if (rnd() < (outskirts ? 0.25 : 0.1)) { this.trees.push({ x: x - w / 2 + (a + 0.5) * (w / nx), z: z - d / 2 + (b + 0.5) * (d / nz), s: rr(0.9, 1.2) }); continue; }
      const px = x - w / 2 + (a + 0.5) * (w / nx), pz = z - d / 2 + (b + 0.5) * (d / nz);
      const hw = Math.min(w / nx, 11) * rr(0.55, 0.7), hd = Math.min(d / nz, 12) * rr(0.5, 0.65), h = rr(3.5, 6);
      const turn = rnd() < 0.5;
      const mat = outskirts ? pick(this.m.dim) : pick(this.m.house);
      const [bw, bd] = turn ? [hd, hw] : [hw, hd];
      this.batch.add(mat, windowBox(bw, h, bd), { x: px, y: 0.3 + h / 2, z: pz });
      const roof = prism(Math.min(bw, bd) + 0.6, rr(2, 3.2), Math.max(bw, bd) + 0.6);
      this.batch.add(rnd() < 0.6 ? this.m.houseRoof : this.m.houseRoof2, roof, { x: px, y: 0.3 + h, z: pz, ry: bw > bd ? 0 : Math.PI / 2 });
      if (rnd() < 0.6) this.trees.push({ x: px + (rnd() < 0.5 ? -1 : 1) * (bw / 2 + 2), z: pz + rr(-2, 2), s: rr(0.7, 1) });
    }
  }

  _industrial(lot, outskirts) {
    const { x, z, w, d } = lot;
    const n = rnd() < 0.5 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const ww = (n === 1 ? w * 0.78 : w * 0.42), wd = d * rr(0.5, 0.62), h = rr(8, 12);
      const wx = x + (n === 1 ? 0 : (k ? 1 : -1) * w * 0.24), wz = z - d * 0.12;
      this.batch.add(outskirts ? pick(this.m.dim) : this.m.warehouse, windowBox(ww, h, wd), { x: wx, y: 0.3 + h / 2, z: wz });
      // sawtooth roof
      const teeth = Math.max(3, Math.floor(ww / 6)), tw = ww / teeth;
      for (let t = 0; t < teeth; t++) {
        const shape = new THREE.Shape();
        shape.moveTo(0, 0); shape.lineTo(tw, 0); shape.lineTo(tw, 2.2); shape.closePath();
        const g = new THREE.ExtrudeGeometry(shape, { depth: wd, bevelEnabled: false });
        g.translate(-ww / 2 + t * tw, 0, -wd / 2);
        this.batch.add(this.m.roof, g, { x: wx, y: 0.3 + h, z: wz });
      }
      // loading doors lit along the front
      for (let q = 0; q < Math.floor(ww / 8); q++) this.batch.add(this.m.shop[2], new THREE.BoxGeometry(3, 0.25, 0.12), { x: wx - ww / 2 + 4 + q * 8, y: 4.2, z: wz + wd / 2 + 0.07, cast: false });
    }
    // shipping containers in the yard
    if (!outskirts) {
      const cols = [0x8a3b2e, 0x2e5f8a, 0x8a7a2e, 0x3d6b4a, 0x6b4a7a];
      this.containers = this.containers ?? [];
      for (let q = 0; q < 8; q++) {
        this.containers.push({ x: x - w / 2 + 5 + q * 6.5 * rr(0.95, 1.05), z: z + d * 0.34, y: 0.3 + 1.3 + (q % 3 === 0 ? 2.6 : 0), r: Math.PI / 2, color: pick(cols) });
      }
      this.sodium.push({ x: x - w / 3, z: z + d * 0.3 }, { x: x + w / 3, z: z + d * 0.3 });
    }
  }

  _park(lot) {
    const { x, z, w, d } = lot;
    this._flat(w + 6, d + 6, this.m.grass, x, z, 0.31);
    this._flat(w, 2.4, this.m.path, x, z, 0.32);
    this._flat(2.4, d, this.m.path, x, z, 0.321);
    const pond = new THREE.Mesh(new THREE.CircleGeometry(7, 40),
      new THREE.MeshStandardMaterial({ color: 0x0e2238, roughness: 0.15, metalness: 0.4, emissive: 0x0a1d33, emissiveIntensity: 0.6 }));
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(x, 0.33, z);
    this.scene.add(pond);
    for (let k = 0; k < 36; k++) {
      let px, pz, guard = 0;
      do { px = x + rr(-w / 2 + 2, w / 2 - 2); pz = z + rr(-d / 2 + 2, d / 2 - 2); } while ((Math.abs(px - x) < 3 || Math.abs(pz - z) < 3 || Math.hypot(px - x, pz - z) < 10) && guard++ < 20);
      this.trees.push({ x: px, z: pz, s: rr(0.8, 1.4) });
    }
    for (const [dx, dz] of [[-14, 1.8], [14, -1.8], [1.8, 14], [-1.8, -14]]) this.lamps.push({ x: x + dx, z: z + dz, dx: 0, dz: 0, park: true });
  }

  _hospital(lot) {
    const h = C.HOSPITALS.find((hh) => {
      const ci = hh.corner[0] > 0 ? hh.node[0] : hh.node[0] - 1, cj = hh.corner[1] > 0 ? hh.node[1] : hh.node[1] - 1;
      return ci === lot.i && cj === lot.j;
    });
    const L = C.hospitalLayout(h), { sx, sz, avHW, stHW, vDrive, vBay } = L;
    // campus-local coordinates: u runs along the street away from the intersection, v along the avenue
    const W = (u, v) => ({ x: L.x + sx * u, z: L.z + sz * v });
    const rect = (mat, u0, u1, v0, v1, y) => { const c = W((u0 + u1) / 2, (v0 + v1) / 2); this._flat(u1 - u0, v1 - v0, mat, c.x, c.z, y); };
    const box = (mat, u0, u1, v0, v1, y, hgt, roofMat) => { const c = W((u0 + u1) / 2, (v0 + v1) / 2); this._box(mat, u1 - u0, hgt, v1 - v0, c.x, y, c.z, roofMat); };
    const uEnd = C.BLOCK - 10, vEnd = C.BLOCK - 10;
    const drive = this.m.drive;

    // forecourt: a drive lane beside the street with the ambulance bays next to it, and three entrances
    rect(drive, avHW + 3, uEnd + 2, vDrive - 3.4, vBay + 2.4, 0.325);
    rect(drive, avHW + 3, avHW + 15, stHW, vDrive - 3.4, 0.322);          // from the street, near the corner
    rect(drive, uEnd - 14, uEnd + 2, stHW, vDrive - 3.4, 0.322);          // from the street, far end
    rect(drive, avHW, avHW + 3.2, vDrive - 3.4, vDrive + 3.4, 0.322);     // from the avenue
    // bay markings: white separators and a red-and-white hatched apron
    for (const k of [0, 1, 2, 3]) rect(this.m.paint, avHW + 12.5 + k * 15 - 0.1, avHW + 12.5 + k * 15 + 0.1, vBay - 2.2, vBay + 2.2, 0.33);
    rect(this.m.paint, avHW + 12.5, avHW + 57.5, vBay + 2.15, vBay + 2.35, 0.33);
    for (let k = 0; k < 3; k++) rect(this.m.bayRed, avHW + 15 + k * 15, avHW + 25 + k * 15, vBay - 0.5, vBay + 0.5, 0.331);
    for (let u = avHW + 6; u < uEnd; u += 6) rect(this.m.paint, u - 1.2, u + 1.2, vDrive - 0.07, vDrive + 0.07, 0.33);
    // canopy over the bays on slim posts, with a red edge light
    const cn = L.canopy;
    // a see-through glass roof on a metal frame, so the ambulances stay visible from above
    const glassRoof = new THREE.Mesh(new THREE.BoxGeometry(cn.w, 0.15, cn.d + 1), new THREE.MeshStandardMaterial({ color: 0x9fc4e8, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.3, depthWrite: false }));
    glassRoof.position.set(cn.x, 5.3, cn.z);
    (this.clipExtra ??= []).push(glassRoof.material);
    this.scene.add(glassRoof);
    const fr = W(avHW + 35, vBay + cn.d / 2 + 0.5);
    this.batch.add(this.m.metal, new THREE.BoxGeometry(cn.w, 0.35, 0.3), { x: fr.x, y: 5.2, z: fr.z });
    for (let k = 0; k <= 4; k++) { const q = W(avHW + 14 + k * (cn.w / 4), vBay); this.batch.add(this.m.metal, new THREE.BoxGeometry(0.25, 0.3, cn.d + 1), { x: q.x, y: 5.2, z: q.z }); }
    for (const du of [-cn.w / 2 + 1, -cn.w / 6, cn.w / 6, cn.w / 2 - 1]) {
      const pp = W(avHW + 35 + du, vBay + cn.d / 2 + 0.2);
      this.batch.add(this.m.metal, new THREE.CylinderGeometry(0.18, 0.18, 5, 8), { x: pp.x, y: 2.8, z: pp.z });
    }
    const edge = W(avHW + 35, vBay - cn.d / 2 - 0.5);
    this.batch.add(this.m.shop[0], new THREE.BoxGeometry(cn.w, 0.22, 0.16), { x: edge.x, y: 4.95, z: edge.z, cast: false });
    this.canopyLights = this.canopyLights ?? [];
    for (const k of [0, 1, 2]) { const q = W(avHW + 20 + k * 15, vBay); this.canopyLights.push({ x: q.x, z: q.z }); }

    // buildings set back behind the forecourt: a 20 m main block and a lower wing
    const wall = new THREE.MeshStandardMaterial({ color: 0xc3ccd8, roughness: 0.55, emissive: 0xffffff, emissiveMap: this.tex.winCool, emissiveIntensity: 0.55 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8e99a8, roughness: 0.8 });
    const v0 = vBay + 5;
    box(wall, avHW + 6, avHW + 40, v0, v0 + 22, 0.3, 20, roof);
    box(wall, avHW + 41, uEnd + 2, v0, vEnd, 0.3, 11, roof);
    // glass entrance lobby facing the forecourt
    box(this.m.glass2, avHW + 44, avHW + 56, v0 - 2.5, v0 + 0.2, 0.3, 5, this.m.roofDark);
    // visitor car park behind
    rect(this.m.parking, avHW + 6, avHW + 40, v0 + 24, vEnd, 0.326);
    for (let a = 0; a < 6; a++) for (let b = 0; b < 2; b++) {
      if (rnd() < 0.3) continue;
      const c = W(avHW + 9 + a * 5.4, v0 + 27.5 + b * 6.5);
      this.batch.add(pick(this.m.parkedCar), new THREE.BoxGeometry(1.9, 1.3, 4.2), { x: c.x, y: 0.95, z: c.z });
    }
    // helipad on the main roof
    const hp = W(avHW + 23, v0 + 11);
    this.batch.add(new THREE.MeshStandardMaterial({ color: 0x2b333e, roughness: 0.8 }), new THREE.CylinderGeometry(6, 6, 0.3, 40), { x: hp.x, y: 20.65, z: hp.z });
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 5.2, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.lampWarm }));
    ring.position.set(hp.x, 20.85, hp.z);
    this.scene.add(ring);
    const hMat = new THREE.MeshBasicMaterial({ color: 0xe8ecf1 });
    for (const [bw, bd, ox] of [[0.7, 4, -1.2], [0.7, 4, 1.2], [2.4, 0.7, 0]]) this.batch.add(hMat, new THREE.BoxGeometry(bw, 0.08, bd), { x: hp.x + ox, y: 20.86, z: hp.z, cast: false });
    // glowing red crosses on the walls facing the street and the avenue
    const crossMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: COL.red, emissiveIntensity: 3.2 });
    const cs = W(avHW + 23, v0 - 0.25), ca = W(avHW + 5.75, v0 + 11);
    for (const [c, ry] of [[cs, 0], [ca, Math.PI / 2]]) {
      this.batch.add(crossMat, new THREE.BoxGeometry(6, 1.8, 0.4), { x: c.x, y: 14, z: c.z, ry, cast: false });
      this.batch.add(crossMat, new THREE.BoxGeometry(1.8, 6, 0.4), { x: c.x, y: 14, z: c.z, ry, cast: false });
    }
    const dest = new THREE.Mesh(new THREE.RingGeometry(7, 8, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: COL.route, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    const bay = W(avHW + 35, vBay);
    dest.position.set(bay.x, 0.4, bay.z);
    this.scene.add(dest);
    this.hospitalMarkers.set(h.id, dest);
    this.hospitalAnchors.set(h.id, new THREE.Vector3(hp.x, 24, hp.z));
  }

  _plantTrees() {
    const crown = new THREE.IcosahedronGeometry(1.9, 0).translate(0, 3.6, 0);
    const trunk = new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6).translate(0, 1.2, 0);
    const items = this.trees.map((t) => ({ x: t.x, z: t.z, y: t.y ?? 0.3, s: t.s, r: rnd() * 6 }));
    const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    (this.clipExtra ??= []).push(crownMat);
    const crowns = this._instanced(crown, crownMat, items.map((it) => ({ ...it, color: pick([0x173a30, 0x1d4436, 0x1a3328, 0x24432f]) })), { cast: true, color: 0x173a30 });
    if (crowns) crowns.castShadow = true;
    this._instanced(trunk, new THREE.MeshStandardMaterial({ color: 0x2a2219, roughness: 1 }), items);
    if (this.containers) this._instanced(new THREE.BoxGeometry(6, 2.6, 2.4), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.3 }), this.containers, { cast: true, color: 0x8a3b2e });
  }

  // ---------- lamps, bus shelters ----------
  _buildLamps() {
    // street lamps along the simulated roads, alternating sides, and along the beltway
    const near = (v, arr) => arr.some(([c, hw]) => Math.abs(v - c) < hw + 6);
    const avList = [], stList = [];
    for (let i = 0; i < C.NX; i++) avList.push([avX(i), avHW(i)]);
    for (let j = 0; j < C.NY; j++) stList.push([stZ(j), stHW(j)]);
    let flip = 0;
    for (let j = 0; j < C.NY; j++) {
      const z = stZ(j), off = stHW(j) + 1.2;
      for (let x = beltX(z, -1) + BELT.hw + 8; x < beltX(z, 1) - BELT.hw - 8; x += 18) {
        if (near(x, avList)) continue;
        flip++;
        this.lamps.push({ x, z: z + (flip % 2 ? off : -off), dx: 0, dz: flip % 2 ? -1 : 1 });
      }
    }
    for (let i = 0; i < C.NX; i++) {
      const x = avX(i), off = avHW(i) + 1.2;
      const spans = [[beltZ(x, -1) + BELT.hw + 8, riverZ(x) - riverHW(x) - 3], [riverZ(x) + riverHW(x) + 3, beltZ(x, 1) - BELT.hw - 8]];
      for (const [za, zb] of spans) for (let z = za; z < zb; z += 18) {
        if (near(z, stList)) continue;
        flip++;
        this.lamps.push({ x: x + (flip % 2 ? off : -off), z, dx: flip % 2 ? -1 : 1, dz: 0 });
      }
    }
    const bl = resample(this.belt, 30, true);
    bl.forEach((p, k) => {
      const q = bl[(k + 1) % bl.length], l = Math.hypot(q.x - p.x, q.z - p.z) || 1, nx = -(q.z - p.z) / l, nz = (q.x - p.x) / l, sd = k % 2 ? 1 : -1;
      const lx = p.x + nx * sd * (BELT.hw + 1.2), lz = p.z + nz * sd * (BELT.hw + 1.2);
      if (this.mouths.some((m) => Math.hypot(lx - m.x, lz - m.z) < m.r + 2) || inRiver(lx, lz, 1)) return;
      this.lamps.push({ x: lx, z: lz, dx: -nx * sd, dz: -nz * sd });
    });
    const pole = new THREE.CylinderGeometry(0.12, 0.16, 5, 6).translate(0, 2.5, 0);
    const head = new THREE.BoxGeometry(1.1, 0.25, 0.5).translate(0, 5, 0);
    const bright = this.lamps.filter((l) => !l.dim);
    this._instanced(pole, new THREE.MeshStandardMaterial({ color: 0x343d49, roughness: 0.6, metalness: 0.4 }), this.lamps.map((l) => ({ x: l.x, z: l.z, y: 0.3 })));
    this._instanced(head, new THREE.MeshBasicMaterial({ color: 0xffe6b8 }), this.lamps.map((l) => ({ x: l.x + l.dx * 0.5, z: l.z + l.dz * 0.5, y: 0.3, r: l.dx ? 0 : Math.PI / 2 })));
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const pool = (color, opacity) => new THREE.MeshBasicMaterial({ map: this.tex.glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    this._instanced(poolGeo, pool(COL.lampWarm, 0.2), bright.map((l) => ({ x: l.x + l.dx * 2.6, z: l.z + l.dz * 2.6, y: 0.33, s: l.park ? 10 : 12 })));
    this._instanced(poolGeo, pool(COL.lampWarm, 0.09), this.lamps.filter((l) => l.dim).map((l) => ({ x: l.x + l.dx * 2.6, z: l.z + l.dz * 2.6, y: 0.33, s: 11 })));
    // light reflections on the river from bridge lamps
    this._instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.tex.glow, color: COL.lampWarm, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
      this.lamps.filter((l) => l.bridge).map((l) => ({ x: l.x + l.dx * 3, z: l.z, y: -2.3, sx: 3, sz: 9 })));
    // sodium yard lights in industrial lots
    this._instanced(poolGeo, pool(COL.sodium, 0.32), this.sodium.map((s) => ({ ...s, y: 0.34, s: 22 })));
    this._instanced(poolGeo, pool(0xe6f2ff, 0.3), (this.canopyLights ?? []).map((s) => ({ ...s, y: 0.36, s: 11 })));
    this._instanced(new THREE.CylinderGeometry(0.2, 0.25, 9, 6).translate(0, 4.5, 0), new THREE.MeshStandardMaterial({ color: 0x343d49 }), this.sodium.map((s) => ({ ...s, y: 0.3 })));
    this._instanced(new THREE.BoxGeometry(1.4, 0.3, 0.8).translate(0, 9, 0), new THREE.MeshBasicMaterial({ color: 0xffc27a }), this.sodium.map((s) => ({ ...s, y: 0.3 })));
    // a few glowing bus shelters
    const shelters = [];
    for (let k = 0; k < 10; k++) {
      const i = Math.floor(rr(0, C.NX)), j = Math.floor(rr(0, C.NY - 1));
      const x = avX(i) + avHW(i) + 1.4, z = stZ(j) + rr(16, 46);
      shelters.push({ x, z });
    }
    this._instanced(new THREE.BoxGeometry(1.4, 0.15, 4).translate(0, 2.6, 0), new THREE.MeshStandardMaterial({ color: 0x4b5669 }), shelters.map((s) => ({ ...s, y: 0.3 })));
    this._instanced(new THREE.BoxGeometry(0.12, 2.2, 1.6).translate(0.6, 1.3, -1.1), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xbfe3ff, emissiveIntensity: 1.4 }), shelters.map((s) => ({ ...s, y: 0.3 })));
  }

  // ---------- signals: mast arms over the lanes, a head per lane, glowing stop bars ----------
  _signals() {
    const poles = [], arms = [], heads = [], bars = [], halos = [];
    this.approaches = [];
    for (const n of this.sim.nodes.values()) {
      if (!n.real) continue;
      for (const [dir, link] of Object.entries(n.in)) {
        const d = C.DIRS[dir], r = C.rightOf(dir), along = C.AXIS[dir] === 'EW';
        const hwOwn = C.halfW(link.L), hwCross = along ? avHW(n.i) : stHW(n.j);
        // pole on the far-right corner of the intersection, arm reaching back over the approach lanes
        const far = hwCross + 1.4, side = hwOwn + 1.4;
        const px = n.x + d.dx * far + r.x * side, pz = n.z + d.dz * far + r.z * side;
        poles.push({ x: px, z: pz, y: 0 });
        const armLen = side - 0.4;
        arms.push({ x: px - r.x * armLen / 2, z: pz - r.z * armLen / 2, y: 7.55, sx: along ? 0.22 : armLen, sz: along ? armLen : 0.22, sy: 0.22 });
        const ap = { node: n, dir, lanes: [], bar: bars.length, halo: halos.length, last: null };
        for (let k = 0; k < link.L; k++) {
          const off = C.laneOff(link.L, k);
          ap.lanes.push(heads.length);
          heads.push({ x: n.x + d.dx * far + r.x * off, z: n.z + d.dz * far + r.z * off, y: 4.85, r: along ? 0 : Math.PI / 2, faceX: -d.dx, faceZ: -d.dz });
        }
        const back = hwCross + 3.4;  // just upstream of the white stop line
        const bx = n.x - d.dx * back + r.x * (hwOwn / 2), bz = n.z - d.dz * back + r.z * (hwOwn / 2);
        bars.push({ x: bx, z: bz, y: 0.07, sx: along ? 0.35 : hwOwn - 0.5, sz: along ? hwOwn - 0.5 : 0.35, sy: 0.06 });
        halos.push({ x: bx - d.dx * 2, z: bz - d.dz * 2, y: 0.07, sx: along ? 8 : hwOwn * 1.6, sz: along ? hwOwn * 1.6 : 8 });
        this.approaches.push(ap);
      }
    }
    const metal = new THREE.MeshStandardMaterial({ color: 0x3e4754, roughness: 0.55, metalness: 0.45 });
    this._instanced(new THREE.CylinderGeometry(0.2, 0.26, 7.8, 8).translate(0, 3.9, 0), metal, poles, { cast: true });
    this._instanced(new THREE.BoxGeometry(1, 1, 1), metal, arms);
    this._instanced(new THREE.BoxGeometry(0.9, 2.6, 0.9).translate(0, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0x0b0e12, roughness: 0.7 }), heads, { cast: true });
    // lamps: three per head, coloured per frame (dim when off)
    const lampGeo = new THREE.SphereGeometry(0.3, 12, 10);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, heads.length * 3);
    const m4 = new THREE.Matrix4(), c = new THREE.Color();
    heads.forEach((h, k) => {
      [2.1, 1.3, 0.5].forEach((dy, q) => {
        m4.makeTranslation(h.x + h.faceX * 0.48, h.y + dy, h.z + h.faceZ * 0.48);
        this.lampMesh.setMatrixAt(k * 3 + q, m4);
        this.lampMesh.setColorAt(k * 3 + q, c.setHex(0x1a1d22));
      });
    });
    this.scene.add(this.lampMesh);
    this.barMesh = this._instanced(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), bars, { color: COL.red });
    this.haloMesh = this._instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: this.tex.glow, color: 0xffffff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }), halos, { color: COL.red });
  }

  _syncSignals() {
    const c = new THREE.Color();
    const bright = { R: 0xff3b40, Y: 0xffb21f, G: 0x2fe07c };
    const off = [0x2a0b0c, 0x2a1d06, 0x08200f];
    let dirty = false;
    for (const ap of this.approaches) {
      const st = this.sim.approachState(ap.node, ap.dir);
      if (ap.last === st) continue;
      ap.last = st;
      dirty = true;
      for (const h of ap.lanes) {
        ['R', 'Y', 'G'].forEach((k, q) => this.lampMesh.setColorAt(h * 3 + q, c.setHex(st === k ? bright[k] : off[q])));
      }
      this.barMesh.setColorAt(ap.bar, c.setHex(bright[st]));
      this.haloMesh.setColorAt(ap.halo, c.setHex(bright[st]).multiplyScalar(st === 'G' ? 1 : 0.85));
    }
    if (dirty) {
      this.lampMesh.instanceColor.needsUpdate = true;
      this.barMesh.instanceColor.needsUpdate = true;
      this.haloMesh.instanceColor.needsUpdate = true;
    }
  }

  _labels() {
    for (let j = 0; j < C.NY; j++) {
      const s = textSprite(C.STREETS[j]);
      s.position.set(SIM.x0 + 30, 1.2, stZ(j) - stHW(j) - 4);
      this.scene.add(s);
      this.labels.push(s);
    }
    for (let i = 0; i < C.NX; i++) {
      const s = textSprite(C.AVENUES[i]);
      s.position.set(avX(i) + avHW(i) + 10, 1.2, SIM.z0 + 18);
      this.scene.add(s);
      this.labels.push(s);
    }
  }

  setLabelsVisible(v) {
    this.godMode = v;
    for (const l of this.labels) l.visible = v;
  }

  // ---------- vehicles: instanced cars, one group per ambulance ----------
  _fleet() {
    const CAP = 420;
    this.cap = CAP;
    const paints = [0xd5dae0, 0x9aa4b1, 0x3a4350, 0x2b4a74, 0x7b2f37, 0x4d6b5c, 0x1c1f24, 0xb9a27a];
    this.paints = paints;
    const std = (o) => new THREE.MeshStandardMaterial(o);
    const parts = [
      { geo: new THREE.BoxGeometry(4.2, 0.85, 1.95), mat: std({ color: 0xffffff, roughness: 0.4, metalness: 0.45 }), locals: [[0, 0.8, 0]], paint: true, cast: true },
      { geo: new THREE.BoxGeometry(2.2, 0.72, 1.7), mat: std({ color: 0x18202a, roughness: 0.2, metalness: 0.7 }), locals: [[-0.3, 1.58, 0]] },
      { geo: new THREE.BoxGeometry(1.9, 0.08, 1.5), mat: std({ color: 0xffffff, roughness: 0.4, metalness: 0.45 }), locals: [[-0.3, 1.98, 0]], paint: true },
      { geo: new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10).rotateX(Math.PI / 2), mat: std({ color: 0x0c0e11, roughness: 0.9 }), locals: [[1.35, 0.42, 0.9], [1.35, 0.42, -0.9], [-1.35, 0.42, 0.9], [-1.35, 0.42, -0.9]] },
      { geo: new THREE.BoxGeometry(0.1, 0.22, 0.42), mat: new THREE.MeshBasicMaterial({ color: 0xfff3d6 }), locals: [[2.11, 0.85, 0.62], [2.11, 0.85, -0.62]] },
      { geo: new THREE.BoxGeometry(0.1, 0.22, 0.42), mat: std({ color: 0x220000, emissive: 0xff2a2a, emissiveIntensity: 2 }), locals: [[-2.11, 0.9, 0.66], [-2.11, 0.9, -0.66]] },
      { geo: new THREE.PlaneGeometry(4.6, 9).rotateX(-Math.PI / 2).rotateY(-Math.PI / 2), mat: new THREE.MeshBasicMaterial({ map: this.tex.beam, color: 0xfff0d0, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }), locals: [[6.6, 0.09, 0]] },
      { geo: new THREE.BoxGeometry(0.7, 0.3, 0.3), mat: std({ color: 0x332200, emissive: 0xffd36b, emissiveIntensity: 2 }), locals: [[-0.3, 2.17, 0]], taxiOnly: true },
    ];
    for (const p of parts) {
      p.mesh = new THREE.InstancedMesh(p.geo, p.mat, CAP * p.locals.length);
      p.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      p.mesh.castShadow = !!p.cast;
      p.mesh.frustumCulled = false;
      p.mesh.count = 0;
      p.localM = p.locals.map(([x, y, z]) => new THREE.Matrix4().makeTranslation(x, y, z));
      if (p.paint) p.mesh.setColorAt(0, new THREE.Color(0xffffff));
      this.scene.add(p.mesh);
    }
    this.parts = parts;
    this.slots = new Map();
    this.freeSlots = [];
    this.nextSlot = 0;
    this.slotEpoch = this.sim.epoch;   // the simulation epoch these slots belong to (see _syncVehicles)
    this.pose = new Map();
    this.ambViews = new Map();
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.tmpM = new THREE.Matrix4();
    this.baseM = new THREE.Matrix4();
    this.scaleM = new THREE.Matrix4();
    this.taxiPaint = new THREE.Color(0xe8b53a);
  }

  _makeAmbulance() {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, metalness: 0.1, emissive: 0xdfe6ee, emissiveIntensity: 0.18 });
    const red = new THREE.MeshStandardMaterial({ color: 0xe5484d, roughness: 0.5, emissive: 0x5a0a0c, emissiveIntensity: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x18202a, roughness: 0.2, metalness: 0.7 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.0, 2.3, 2.3), white);
    body.position.set(-0.75, 1.55, 0);
    body.castShadow = true;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 2.2), white);
    cab.position.set(2.5, 1.15, 0);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.6, 1.9), glass);
    win.position.set(3.26, 1.5, 0);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(5.04, 0.36, 2.34), red);
    stripe.position.set(-0.75, 1.3, 0);
    const sirenL = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, 0.95), new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2a2a, emissiveIntensity: 3 }));
    sirenL.position.set(1.6, 2.85, 0.52);
    const sirenR = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, 0.95), new THREE.MeshStandardMaterial({ color: 0x000a33, emissive: 0x3d7dff, emissiveIntensity: 3 }));
    sirenR.position.set(1.6, 2.85, -0.52);
    g.add(body, cab, win, stripe, sirenL, sirenR);
    const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.9 });
    for (const [x, z] of [[2.3, 1.05], [2.3, -1.05], [-2.2, 1.05], [-2.2, -1.05]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10).rotateX(Math.PI / 2), tyre);
      w.position.set(x, 0.42, z);
      g.add(w);
    }
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(16, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: this.tex.glow, color: 0xff2a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.position.y = 0.1;
    const beam = new THREE.Mesh(this.parts[6].geo, this.parts[6].mat);
    beam.position.set(7.8, 0.09, 0);
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 5.3, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: COL.red, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.y = 0.12;
    g.add(pool, beam, ring);
    g.userData = { sirenL, sirenR, pool, ring };
    return g;
  }

  // Pose used by cameras, cards and the detection overlay (same shape for cars and ambulances)
  vehicleObject(id) {
    const p = this.pose.get(id);
    if (!p) return null;
    return p.obj;
  }

  // Instance slot for a car. Never hands out an index beyond the meshes' capacity: returns -1 instead
  // (that car is simply not drawn, rather than corrupting the whole instanced draw).
  _slot(id) {
    let s = this.slots.get(id);
    if (s === undefined) {
      if (this.freeSlots.length) s = this.freeSlots.pop();
      else if (this.nextSlot < this.cap) s = this.nextSlot++;
      else return -1;
      this.slots.set(id, s);
    }
    return s;
  }

  // Forget one vehicle's render state (pose, ambulance model, instance slot)
  _releaseVehicle(id) {
    this.pose.delete(id);
    const g = this.ambViews.get(id);
    if (g) { this.scene.remove(g); this.ambViews.delete(id); }
    const s = this.slots.get(id);
    if (s !== undefined) { this.slots.delete(id); this.freeSlots.push(s); }
  }

  _syncVehicles(dt) {
    const k = 1 - Math.exp(-dt * 18);
    // After sim.reset() (a demo run, Replay or Exit) every vehicle is new: drop all render state from the old
    // city and start the slot pool from zero, so the old and new fleets never need slots at the same time.
    if (this.slotEpoch !== this.sim.epoch) {
      for (const g of this.ambViews.values()) this.scene.remove(g);
      this.ambViews.clear();
      this.pose.clear();
      this.slots.clear();
      this.freeSlots = [];
      this.nextSlot = 0;
      this.slotEpoch = this.sim.epoch;
    }
    // release vehicles that left the city before allocating slots for new ones
    for (const id of [...this.pose.keys()]) if (!this.sim.vehicles.has(id)) this._releaseVehicle(id);
    const seen = new Set();
    const c = new THREE.Color();
    let colorsDirty = false;
    for (const v of this.sim.vehicles.values()) {
      seen.add(v.id);
      const target = this.sim.worldPos(v);
      let p = this.pose.get(v.id);
      if (!p) {
        p = { x: target.x, z: target.z, h: target.heading, born: 0, obj: { position: new THREE.Vector3(), rotation: { y: 0 }, matrixWorld: new THREE.Matrix4() } };
        this.pose.set(v.id, p);
        if (v.type === 'ambulance' || v.type === 'parked') {
          const g = this._makeAmbulance();
          this.scene.add(g);
          this.ambViews.set(v.id, g);
        } else {
          const s = this._slot(v.id);
          const taxi = v.tint % 8 === 3;
          p.taxi = taxi;
          if (s < 0) { if (!this.slotWarned) { this.slotWarned = true; console.warn(`UrbanFlow: more than ${this.cap} cars on screen; extra cars are not drawn.`); } }
          else {
          const paint = taxi ? this.taxiPaint : c.setHex(this.paints[v.tint % this.paints.length]);
          for (const part of this.parts) if (part.paint) part.mesh.setColorAt(s, paint);
          colorsDirty = true;
          }
        }
      } else {
        p.x += (target.x - p.x) * k;
        p.z += (target.z - p.z) * k;
        let da = target.heading - p.h;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        p.h += da * k;
      }
      p.born = Math.min(1, p.born + dt * 2.2);
      p.obj.position.set(p.x, 0, p.z);
      p.obj.rotation.y = p.h;
      p.obj.matrixWorld.makeRotationY(p.h).setPosition(p.x, 0, p.z);
      const g = this.ambViews.get(v.id);
      if (g) {
        g.position.set(p.x, 0, p.z);
        g.rotation.y = p.h;
        const ud = g.userData;
        // lights flash on the way in and switch off a few seconds after it stops in the bay
        const off = v.type === 'parked' && v.park.state === 'parked' && this.sim.t - v.park.t > 3;
        const phase = Math.floor(this.flash * 6) % 2 === 0;
        ud.sirenL.material.emissiveIntensity = off ? 0.15 : phase ? 4.5 : 0.2;
        ud.sirenR.material.emissiveIntensity = off ? 0.15 : phase ? 0.2 : 4.5;
        ud.pool.visible = !off;
        ud.pool.material.color.setHex(phase ? 0xff2a2a : 0x3d6dff);
        ud.pool.material.opacity = 0.42 + 0.12 * Math.sin(this.flash * 18);
        const pulse = (this.flash * 1.1) % 1;
        ud.ring.visible = this.godMode && v.type === 'ambulance';
        ud.ring.scale.setScalar(1 + pulse * 1.8);
        ud.ring.material.opacity = 0.6 * (1 - pulse);
      }
    }
    // (vehicles that left the city were released at the top)
    // write instance matrices
    const used = Math.min(this.nextSlot, this.cap);
    for (const part of this.parts) part.mesh.count = used * part.locals.length;
    const filled = new Set();
    for (const [id, s] of this.slots) {
      const p = this.pose.get(id);
      if (!p) continue;
      filled.add(s);
      this.baseM.copy(p.obj.matrixWorld);
      if (p.born < 1) this.baseM.multiply(this.scaleM.makeScale(p.born, p.born, p.born));
      for (const part of this.parts) {
        part.localM.forEach((lm, q) => {
          const idx = s * part.locals.length + q;
          if (part.taxiOnly && !p.taxi) part.mesh.setMatrixAt(idx, this.zero);
          else part.mesh.setMatrixAt(idx, this.tmpM.multiplyMatrices(this.baseM, lm));
        });
      }
    }
    for (let s = 0; s < used; s++) {
      if (filled.has(s)) continue;
      for (const part of this.parts) for (let q = 0; q < part.locals.length; q++) part.mesh.setMatrixAt(s * part.locals.length + q, this.zero);
    }
    for (const part of this.parts) {
      part.mesh.instanceMatrix.needsUpdate = true;
      if (colorsDirty && part.paint) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---------- emergency route: glowing band + flowing chevrons ----------
  _strip(pts, width, y) {
    const pos = [], uv = [], idx = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let tx = b.x - a.x, tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const nx = -tz * width / 2, nz = tx * width / 2;
      const p = pts[k];
      pos.push(p.x + nx, y, p.z + nz, p.x - nx, y, p.z - nz);
      const u = -p.toGoal / 3.2;
      uv.push(u, 0, u, 1);
      if (k > 0) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  _syncRoutes(dt) {
    const ambs = this.sim.ambulances();
    // keep drawing the route while an ambulance pulls into its bay, so it leads into the forecourt
    const routed = [...ambs];
    for (const v of this.sim.vehicles.values()) if (v.type === 'parked' && v.park?.state === 'in') routed.push(v);
    const ids = new Set(routed.map((a) => a.id));
    for (const [id, rv] of this.routeViews) {
      if (!ids.has(id)) { for (const m of rv.meshes) { this.scene.remove(m); m.geometry.dispose(); } this.routeViews.delete(id); }
    }
    for (const v of routed) {
      let rv = this.routeViews.get(v.id);
      if (!rv) {
        const chev = this.tex.chevron.clone();
        chev.needsUpdate = true;
        rv = {
          t: 1, chev, meshes: [],
          bandMat: new THREE.MeshBasicMaterial({ map: this.tex.band, color: COL.route, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
          chevMat: new THREE.MeshBasicMaterial({ map: chev, color: 0x9fdcff, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }),
        };
        this.routeViews.set(v.id, rv);
      }
      rv.chev.offset.x -= dt * 2.4;
      rv.t += dt;
      if (rv.t < 0.25) continue;
      rv.t = 0;
      for (const m of rv.meshes) { this.scene.remove(m); m.geometry.dispose(); }
      const pts = this.sim.routePolyline(v);
      if (pts.length < 2) { rv.meshes = []; continue; }
      const wide = this.godMode ? 1.5 : 1;  // thicker from above so the corridor reads at city scale
      const band = new THREE.Mesh(this._strip(pts, 4.6 * wide, 0.075), rv.bandMat);
      const chev = new THREE.Mesh(this._strip(pts, 2.1 * wide, 0.09), rv.chevMat);
      band.renderOrder = 2; chev.renderOrder = 3;
      this.scene.add(band, chev);
      rv.meshes = [band, chev];
    }
    const active = new Set(ambs.map((a) => a.hospital.id));
    for (const [hid, ring] of this.hospitalMarkers) ring.userData.active = active.has(hid);
  }

  update(dt) {
    this.flash += dt;
    this._syncSignals();
    this._syncVehicles(dt);
    this._syncRoutes(dt);
    if (this.shimmer) this.shimmer.offset.x += dt * 0.01;
    for (const b of this.blinkers) b.mat.emissiveIntensity = ((this.flash + b.phase) % 2) < 0.35 ? 4 : 0.15;
    for (const ring of this.hospitalMarkers.values()) {
      const pulse = (this.flash * 0.8) % 1;
      ring.material.opacity = ring.userData.active ? 0.85 * (1 - pulse) : 0;
      ring.scale.setScalar(1 + pulse * 0.6);
    }
  }
}
