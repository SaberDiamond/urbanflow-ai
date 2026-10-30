// UrbanFlow AI — dashboard entry point.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Sim } from './sim.js';
import { CityView } from './scene.js';
import { CameraRig } from './cameras.js';
import { UI } from './ui.js';
import { NemotronClient } from './nemotron.js';
import { DemoDirector } from './demo.js';

const SIM_DT = 1 / 30;

function boot() {
  const viewport = document.getElementById('viewport');
  const canvas = document.getElementById('scene');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.localClippingEnabled = true;  // the intersection camera's see-through plane
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  // Night lighting: cool moonlight, navy sky fill, a little warm bounce from the street
  scene.add(new THREE.HemisphereLight(0x6a86b4, 0x1a1410, 1.0));
  const moon = new THREE.DirectionalLight(0xb9c9ff, 1.9);
  moon.position.set(-260, 420, 200);
  moon.castShadow = true;
  moon.shadow.mapSize.set(4096, 4096);
  Object.assign(moon.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 1200 });
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.4;
  scene.add(moon);
  const warm = new THREE.DirectionalLight(0xffb070, 0.25);
  warm.position.set(120, 60, -80);
  scene.add(warm);

  const sim = new Sim();
  const view = new CityView(scene, sim);
  const rig = new CameraRig(canvas, sim, view);

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, rig.active);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.5, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let speed = 1;
  const nemo = new NemotronClient(sim);
  const ui = new UI(sim, rig, view, { setSpeed: (s) => { speed = s; } }, nemo);
  const demo = new DemoDirector(sim, nemo);
  ui.attachDemo(demo);
  ui.renderAI();
  ui.update();
  // find out whether the local server and a key are available, then keep checking quietly
  nemo.refresh().then(() => ui.initController());
  setInterval(() => nemo.refresh(), 10000);

  function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
    rig.setAspect(w / h);
  }
  new ResizeObserver(resize).observe(viewport);
  resize();

  const clock = new THREE.Clock();
  let acc = 0, uiTimer = 0;
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    acc += dt * speed;
    let steps = 0;
    if (sim.paused) acc = 0;   // paused (demo warm-up, or the demo's pause button): the city holds still
    while (acc >= SIM_DT && steps < 10) { sim.step(SIM_DT); acc -= SIM_DT; steps++; }
    if (steps === 10) acc = 0;
    view.update(dt * speed);
    rig.update(dt);
    renderPass.camera = rig.active;
    composer.render();
    ui.frame(rig.active);
    uiTimer += dt;
    nemo.tick();
    if (uiTimer > 0.2) { uiTimer = 0; ui.update(); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.getElementById('boot').classList.add('gone');
  window.urbanflow = { sim, view, rig, ui, renderer, nemo, demo };
}

try {
  boot();
} catch (err) {
  const b = document.getElementById('boot');
  b.classList.add('error');
  b.textContent = `The 3D view could not start: ${err.message}. WebGL must be enabled in this browser.`;
  console.error(err);
}
