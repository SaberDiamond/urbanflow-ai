// UrbanFlow AI — camera modes over one 3D scene.
// Omniscient view uses an orthographic isometric camera; Chase cam and Intersection cams use perspective.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as C from './config.js';
import { CITY_BOUNDS } from './scene.js';

const ISO_POLAR = Math.atan(Math.SQRT2);  // 54.7° from vertical: true isometric
const ISO_DIST = 700;
const VIEW_H = 200;                       // world units visible vertically at zoom 1

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  constructor(dom, sim, view) {
    this.sim = sim;
    this.view = view;
    this.mode = 'god';
    this.aspect = 1;

    this.iso = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 3000);
    this.persp = new THREE.PerspectiveCamera(60, 1, 0.5, 2000);
    this.active = this.iso;

    this.azimuth = Math.PI / 4;
    this.target = new THREE.Vector3(0, 0, 0);
    this._placeIso();
    this.iso.zoom = 1;

    this.controls = new OrbitControls(this.iso, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minPolarAngle = ISO_POLAR - 0.22;
    this.controls.maxPolarAngle = ISO_POLAR + 0.12;
    this.controls.minZoom = 0.7;
    this.controls.maxZoom = 14;  // close enough to watch a single intersection from above
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.target.copy(this.target);
    this.anim = null;

    this.chaseId = null;
    this.chaseIsAmbulance = false;
    this.chasePos = new THREE.Vector3();
    this.chaseLook = new THREE.Vector3();
    this.chaseReady = false;

    this.realNodes = [...sim.nodes.values()].filter((n) => n.real);
    this.camIndex = this.realNodes.findIndex((n) => n.i === 2 && n.j === 2);
    this.autoFollow = true;
    this.camNode = this.realNodes[this.camIndex];
    this.camFacing = 'S';
    this.lerpPos = new THREE.Vector3();
    this.lerpLook = new THREE.Vector3();
    this.camReady = false;
    this.camYaw = 0;          // user orbit around the intersection (radians)
    this.camYawShown = 0;
    this.seeThrough = true;
    this.camZoom = 1;         // scroll to pull the intersection camera back (1 = closest)   // fade out buildings between the camera and the intersection
    this.xray = view.xray;    // shared with the building materials; constant 1e6 clips nothing
  }

  _placeIso(az = this.azimuth, target = this.target, polar = ISO_POLAR) {
    const off = new THREE.Vector3().setFromSphericalCoords(ISO_DIST, polar, az);
    this.iso.position.copy(target).add(off);
    this.iso.lookAt(target);
  }

  setAspect(aspect) {
    this.aspect = aspect;
    // fit the whole diorama: its projected footprint is about (W + D)/√2 wide
    const b = CITY_BOUNDS;
    const span = ((b.x1 - b.x0) + (b.z1 - b.z0)) / Math.SQRT2;
    const h = Math.max(VIEW_H * 1.85, (span * 1.08) / aspect);
    this.iso.left = (-h * aspect) / 2;
    this.iso.right = (h * aspect) / 2;
    this.iso.top = h / 2;
    this.iso.bottom = -h / 2;
    this.iso.updateProjectionMatrix();
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
  }

  // Smoothly animate the iso camera: rotate by quarter turns, recenter, zoom
  _animate({ dAz = 0, target = null, zoom = null }, dur = 0.7) {
    const sph = new THREE.Spherical().setFromVector3(this.iso.position.clone().sub(this.controls.target));
    this.anim = {
      t: 0, dur,
      az0: sph.theta, az1: sph.theta + dAz,
      polar0: sph.phi, polar1: dAz || target ? ISO_POLAR : sph.phi,
      tg0: this.controls.target.clone(), tg1: target ? target.clone() : this.controls.target.clone(),
      z0: this.iso.zoom, z1: zoom ?? this.iso.zoom,
    };
  }

  rotate(dir) { this._animate({ dAz: dir * Math.PI / 2 }); }
  recenter() { this._animate({ target: new THREE.Vector3(0, 0, 0), zoom: 1, dAz: 0 }, 0.8); this.anim.az1 = this._nearestIsoAz(this.anim.az0); this.anim.polar1 = ISO_POLAR; }
  zoomBy(f) { this._animate({ zoom: THREE.MathUtils.clamp(this.iso.zoom * f, this.controls.minZoom, this.controls.maxZoom) }, 0.35); }
  focus(point, zoom = 2.2) { this._animate({ target: new THREE.Vector3(point.x, 0, point.z), zoom }, 0.9); }

  _nearestIsoAz(az) {
    const q = Math.PI / 2;
    return Math.round((az - Math.PI / 4) / q) * q + Math.PI / 4;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.controls.enabled = mode === 'god';
    this.chaseReady = false;
    this.camReady = false;
    this.active = mode === 'god' ? this.iso : this.persp;
    this.persp.fov = mode === 'chase' ? 62 : 55;
    this.persp.updateProjectionMatrix();
    this.view.setLabelsVisible(mode === 'god');
  }

  stepIntersection(delta) {
    this.autoFollow = false;
    this.camIndex = (this.camIndex + delta + this.realNodes.length) % this.realNodes.length;
    this.camNode = this.realNodes[this.camIndex];
    this.camFacing = 'S';
    this.camYaw = 0;
    this.camReady = false;
  }

  // Jump straight to one intersection, looking at the given approach (from a map callout)
  viewIntersection(node, facing = 'S') {
    this.autoFollow = false;
    this.camNode = node;
    this.camIndex = this.realNodes.indexOf(node);
    this.camFacing = facing;
    this.camYaw = 0;
    this.camReady = false;
  }

  // Orbit the intersection camera; it swings smoothly to the new angle
  orbit(delta) { this.camYaw += delta; }
  pullBack(f) { this.camZoom = THREE.MathUtils.clamp(this.camZoom * f, 1, 3.2); }

  setAutoFollow(on) { this.autoFollow = on; this.camReady = false; }

  focusAmbulance(v) {
    this.chaseId = v.id;
    this.chaseIsAmbulance = true;
    this.chaseReady = false;
  }

  _pickChaseTarget() {
    // stay with an ambulance while it pulls into the hospital bay, and a few seconds after it stops
    const cur = this.chaseId !== null ? this.sim.vehicles.get(this.chaseId) : null;
    if (cur && cur.type === 'parked' && (cur.park.state === 'in' || this.sim.t - cur.park.t < 4)) { this.chaseIsAmbulance = true; return; }
    const ambs = this.sim.ambulances();
    if (ambs.length) {
      if (!ambs.some((a) => a.id === this.chaseId)) { this.chaseId = ambs[ambs.length - 1].id; this.chaseReady = false; }
      this.chaseIsAmbulance = true;
      return;
    }
    if (this.chaseId === null || !this.sim.vehicles.has(this.chaseId) || this.chaseIsAmbulance) {
      const cars = [...this.sim.vehicles.values()].filter((v) => v.type === 'car' && v.link.from.real && v.link.to.real);
      if (cars.length) this.chaseId = cars[Math.floor(Math.random() * cars.length)].id;
      this.chaseIsAmbulance = false;
      this.chaseReady = false;
    }
  }

  chaseVehicle() {
    return this.chaseId !== null ? this.sim.vehicles.get(this.chaseId) ?? null : null;
  }

  update(dt) {
    if (this.mode !== 'intersection') this.xray.set(new THREE.Vector3(0, 1, 0), 1e6);
    if (this.mode === 'god') {
      if (this.anim) {
        const a = this.anim;
        a.t = Math.min(1, a.t + dt / a.dur);
        const e = ease(a.t);
        const tg = a.tg0.clone().lerp(a.tg1, e);
        this.controls.target.copy(tg);
        this._placeIso(a.az0 + (a.az1 - a.az0) * e, tg, a.polar0 + (a.polar1 - a.polar0) * e);
        this.iso.zoom = a.z0 + (a.z1 - a.z0) * e;
        this.iso.updateProjectionMatrix();
        if (a.t >= 1) this.anim = null;
      }
      // keep the view over the city
      const t = this.controls.target, b = CITY_BOUNDS;
      const cx = THREE.MathUtils.clamp(t.x, b.x0, b.x1), cz = THREE.MathUtils.clamp(t.z, b.z0, b.z1);
      if (cx !== t.x || cz !== t.z) {
        const d = new THREE.Vector3(cx - t.x, 0, cz - t.z);
        t.add(d);
        this.iso.position.add(d);
      }
      this.controls.update();
      return;
    }
    const cam = this.persp;
    if (this.mode === 'chase') {
      this._pickChaseTarget();
      const obj = this.chaseId !== null ? this.view.vehicleObject(this.chaseId) : null;
      if (!obj) return;
      const fwd = new THREE.Vector3(Math.cos(obj.rotation.y), 0, -Math.sin(obj.rotation.y));
      const back = this.chaseIsAmbulance ? 15 : 12;
      const wantPos = obj.position.clone().addScaledVector(fwd, -back).add(new THREE.Vector3(0, this.chaseIsAmbulance ? 6.2 : 5, 0));
      const wantLook = obj.position.clone().addScaledVector(fwd, 22).add(new THREE.Vector3(0, 2, 0));
      const k = this.chaseReady ? 1 - Math.exp(-dt * 4) : 1;
      this.chasePos.lerp(wantPos, k);
      this.chaseLook.lerp(wantLook, k);
      this.chaseReady = true;
      cam.position.copy(this.chasePos);
      cam.lookAt(this.chaseLook);
      return;
    }
    if (this.autoFollow) {
      const amb = this.sim.ambulances().at(-1);
      const ns = amb ? this.sim.nextSignal(amb) : null;
      if (ns && (ns.node !== this.camNode || ns.dir !== this.camFacing)) {
        this.camNode = ns.node;
        this.camFacing = ns.dir;
        this.camIndex = this.realNodes.indexOf(ns.node);
        this.camYaw = 0;
        this.camReady = false;
      }
    }
    // Mounted over the road just past the far side of the intersection, looking back at the
    // approaching lanes. Staying over the roadway keeps buildings, trees and lamps out of the shot,
    // and the height clears the signal arm so its heads sit in the lower part of the frame.
    const n = this.camNode;
    const d = C.DIRS[this.camFacing], r = C.rightOf(this.camFacing);
    const crossHW = C.AXIS[this.camFacing] === 'EW' ? C.halfW(C.avenueLanes(n.i)) : C.halfW(C.streetLanes(n.j));
    const ownHW = C.halfW(C.AXIS[this.camFacing] === 'EW' ? C.streetLanes(n.j) : C.avenueLanes(n.i));
    // the user can orbit the camera around the intersection; offsets are rotated about its centre
    const k = this.camReady ? 1 - Math.exp(-dt * 5) : 1;
    this.camZoomShown = this.camReady ? (this.camZoomShown ?? 1) + (this.camZoom - (this.camZoomShown ?? 1)) * k : this.camZoom;
    this.camYawShown = this.camReady ? this.camYawShown + (this.camYaw - this.camYawShown) * k : this.camYaw;
    const ahead = (crossHW + 12) * this.camZoomShown, side = -Math.min(1.5, ownHW * 0.25);
    const c = Math.cos(this.camYawShown), sn = Math.sin(this.camYawShown);
    const rot = (ox, oz) => [ox * c - oz * sn, ox * sn + oz * c];
    const [px, pz] = rot(d.dx * ahead + r.x * side, d.dz * ahead + r.z * side);
    const [lx, lz] = rot(-d.dx * 16 + r.x * ownHW * 0.45, -d.dz * 16 + r.z * ownHW * 0.45);
    const pos = new THREE.Vector3(n.x + px, 15 + (this.camZoomShown - 1) * 9, n.z + pz);
    const look = new THREE.Vector3(n.x + lx, 0, n.z + lz);
    // orbiting is a rotation, so move the camera along the circle rather than cutting across it
    if (this.camReady && (Math.abs(this.camYaw - this.camYawShown) > 1e-3 || Math.abs(this.camZoom - this.camZoomShown) > 1e-3)) { this.lerpPos.copy(pos); this.lerpLook.copy(look); }
    this.lerpPos.lerp(pos, k);
    this.lerpLook.lerp(look, k);
    this.camReady = true;
    cam.position.copy(this.lerpPos);
    cam.lookAt(this.lerpLook);
    // see-through: clip buildings on the camera's side of the intersection so cars stay in view
    if (this.seeThrough) {
      const ux = this.lerpPos.x - n.x, uz = this.lerpPos.z - n.z, ul = Math.hypot(ux, uz) || 1;
      const nx = -ux / ul, nz = -uz / ul, edge = Math.max(crossHW, ownHW) + 3;
      this.xray.normal.set(nx, 0, nz);
      this.xray.constant = -(nx * (n.x - nx * edge) + nz * (n.z - nz * edge));
    } else this.xray.set(new THREE.Vector3(0, 1, 0), 1e6);
  }
}
