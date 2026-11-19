import * as THREE from 'three';
import { World } from './world.js';
import { FlightModel, PROFILES, MODES } from './flight.js';
import { createDroneModel } from './droneModel.js';
import { CameraRig, VIEWS } from './cameras.js';
import { Input } from './input.js';
import { HUD } from './hud.js';
import { DroneAudio } from './audio.js';
import { Menu, loadSettings, saveSettings } from './ui.js';
import { GrassField } from './grass.js';
import { DroneShadow } from './droneShadow.js';


const PHYS_DT = 1 / 500;
const settings = loadSettings();

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.domElement.className = 'webgl';
document.getElementById('app').prepend(renderer.domElement);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();

let world, fm, model, rig, input, hud, audio, menu, grass, droneShadow;
let paused = true;
let simTime = 0;
let acc = 0;
const env = { wind: new THREE.Vector3(), turbulence: 0.4 };
const prevPos = new THREE.Vector3();
const race = { next: 0, total: 8, lapStart: null, last: null, best: null, now: 0 };
let lastT = performance.now();
const clock = { getDelta() { const n = performance.now(); const d = (n - lastT) / 1000; lastT = n; return d; } };
const omegas = [0, 0, 0, 0];
let startVisible = false;

const MODE_DESC = {
  GPS: 'Holds position and height when you let go of the sticks. The easiest way to start, like a consumer camera drone.',
  ANGLE: 'Keeps itself level, but you manage the throttle and height. The next step up.',
  ACRO: 'No self-levelling: the sticks set rotation speed. How FPV pilots fly flips and rolls.',
};

function setLoading(t, pct) {
  document.getElementById('loading-text').textContent = t;
  if (pct != null) {
    document.getElementById('loading-fill').style.width = `${pct}%`;
    document.getElementById('loading-pct').textContent = `${pct}%`;
  }
}
// Yield a frame so the loading screen repaints before the next blocking step
// (timer rather than rAF so loading still progresses in a background tab)
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (rig) {
    rig.main.aspect = window.innerWidth / window.innerHeight;
    rig.main.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);

function buildDrone() {
  if (model) scene.remove(model.root);
  model = createDroneModel(fm.p, renderer);
  scene.add(model.root);
  droneShadow.setModel(model, fm.p);
}

function resetDrone() {
  fm.reset();
  fm.mode = settings.mode;
  input.onModeChange(fm.mode, false);
  resetRace();
}

function resetRace() {
  race.next = 0; race.lapStart = null; race.last = null;
  highlightGates();
}

function highlightGates() {
  world.gates.forEach((g, i) => {
    if (i === race.next) g.mat.emissive.setRGB(0.05, 0.6, 0.15);
    else g.mat.emissive.setRGB(0, 0, 0);
  });
}

function applySetting(key) {
  const s = settings;
  switch (key) {
    case 'profile':
      fm.setProfile(s.profile);
      buildDrone();
      resetDrone();
      hud.toast(PROFILES[s.profile].name);
      break;
    case 'mode': {
      fm.mode = s.mode;
      const airborne = fm.armed && !fm.onGround;
      input.onModeChange(fm.mode, airborne);
      fm.holdPos = null; fm.holdAlt = null; fm.rth = null;
      break;
    }
    case 'expo': case 'throttleMid': case 'maxAngle': case 'acroRate': case 'smoothing': case 'kbAmount':
      fm.settings.smoothing = s.smoothing;
      input.kbAmount = s.kbAmount;
      fm.settings.expo = s.expo;
      fm.settings.throttleMid = s.throttleMid;
      fm.settings.maxAngleOverride = s.maxAngle;
      fm.settings.acroRateOverride = s.acroRate;
      break;
    case 'fpvTilt': rig.fpvTilt = THREE.MathUtils.degToRad(s.fpvTilt); break;
    case 'sunElev': case 'sunAz': world.setTimeOfDay(s.sunElev, s.sunAz); break;
    case 'fog': scene.fog.density = s.fog * 0.0001; break;
    case 'clouds': world.sky.material.uniforms.cloudCoverage.value = s.clouds; break;
    case 'shadows': world.setShadowQuality(s.shadows); break;
    case 'pixelRatio': resize(); break;
    case 'waterRefl': world.setWaterReflections(s.waterRefl); break;
    case 'pip': rig.pipOn = s.pip; break;
    case 'grass': grass.setQuality(s.grass); break;
    case 'sound': case 'volume': audio.enabled = s.sound; audio.volume = s.volume; break;
    default: break;
  }
}

function onAction(a, arg) {
  const startVisible = !document.getElementById('start').classList.contains('hidden');
  if (a === 'help') { toggleStart(); return; }
  if (a === 'menu') {
    if (startVisible) { toggleStart(); return; }
    menu.toggle();
    paused = menu.isOpen;
    return;
  }
  if (a === 'gamepad') { hud.toast(arg); if (menu.isOpen) menu.render(); return; }
  if (a === 'learn') return;
  if (menu.isOpen || startVisible) {
    // Gamepad arm/start button closes the start screen for convenience
    if (startVisible && a === 'arm' && input.source === 'gamepad') {
      toggleStart();
      if (arg !== 'trigger-combo') return;
    } else {
      return;
    }
  }
  audio.start();
  switch (a) {
    case 'arm': fm.armed ? fm.disarm() : fm.arm(); break;
    case 'camera': rig.setView(rig.current + 1, fm); hud.toast(rig.view.name); break;
    case 'cam1': case 'cam2': case 'cam3': case 'cam4': case 'cam5': case 'cam6':
      rig.setView(Number(a.slice(3)) - 1, fm); hud.toast(rig.view.name); break;
    case 'pip': settings.pip = !settings.pip; saveSettings(settings); applySetting('pip'); break;
    case 'mode': {
      const i = MODES.indexOf(fm.mode);
      settings.mode = MODES[(i + 1) % MODES.length];
      saveSettings(settings);
      applySetting('mode');
      hud.toast(`Flight mode: ${settings.mode}`);
      break;
    }
    case 'reset': resetDrone(); hud.toast('Drone reset at home', 'good'); break;
    case 'rth': fm.startRTH(); break;
    case 'race': resetRace(); hud.toast('Race reset - fly through the green gate'); break;
    case 'osd': document.getElementById('hud').classList.toggle('hidden'); break;
    case 'gimbalUp': case 'gimbalDown': {
      const d = (a === 'gimbalUp' ? 5 : -5) * Math.PI / 180;
      if (rig.view.id === 'fpv') {
        settings.fpvTilt = THREE.MathUtils.clamp(settings.fpvTilt + (a === 'gimbalUp' ? 5 : -5), 0, 45);
        saveSettings(settings);
        applySetting('fpvTilt');
        hud.toast(`FPV uptilt ${settings.fpvTilt}°`);
      } else {
        rig.gimbalPitch = THREE.MathUtils.clamp(rig.gimbalPitch + d, -Math.PI / 2, 0.35);
        hud.toast(`Gimbal ${Math.round(THREE.MathUtils.radToDeg(rig.gimbalPitch))}°`);
      }
      break;
    }
    default: break;
  }
}

function toggleStart() {
  const st = document.getElementById('start');
  const show = st.classList.contains('hidden');
  st.classList.toggle('hidden', !show);
  if (show && menu.isOpen) menu.close();
  paused = show || menu.isOpen;
  startVisible = show;
  document.getElementById('hud').classList.toggle('hidden', show);
  document.getElementById('start-btn').textContent = 'Resume';
  if (show) syncStartScreen();
}

function syncStartScreen() {
  document.querySelectorAll('#pick-drone .pick').forEach((b) => b.classList.toggle('active', b.dataset.profile === settings.profile));
  document.querySelectorAll('#pick-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === settings.mode));
  document.getElementById('mode-desc').textContent = MODE_DESC[settings.mode] || '';
}

function setupStartScreen() {
  document.querySelectorAll('#pick-drone .pick').forEach((b) => b.addEventListener('click', () => {
    if (settings.profile !== b.dataset.profile) {
      settings.profile = b.dataset.profile;
      saveSettings(settings);
      applySetting('profile');
    }
    syncStartScreen();
  }));
  document.querySelectorAll('#pick-mode button').forEach((b) => b.addEventListener('click', () => {
    settings.mode = b.dataset.mode;
    saveSettings(settings);
    applySetting('mode');
    syncStartScreen();
  }));
  document.getElementById('start-settings').addEventListener('click', () => {
    toggleStart();
    menu.open();
    paused = true;
  });
  window.addEventListener('keydown', (e) => {
    if (startVisible && e.code === 'Enter') { e.preventDefault(); document.getElementById('start-btn').click(); }
  });
  syncStartScreen();
}

/** Fixed camera framing the parked drone behind the title screen. */
function cinematicCamera() {
  const cam = rig.main;
  const arm = fm.p.armLength;
  const r = 0.55 + arm * 7.5;
  const ang = 2.4;
  const p = fm.pos;
  cam.up.set(0, 1, 0);
  cam.position.set(p.x + Math.sin(ang) * r, p.y + 0.25 + arm * 2.2, p.z + Math.cos(ang) * r);
  // aim to the left of the drone so it sits in the open right half of the screen
  const dir = new THREE.Vector3().subVectors(p, cam.position).normalize();
  const right = new THREE.Vector3().crossVectors(dir, cam.up).normalize();
  const look = p.clone().addScaledVector(right, -r * 0.2);
  look.y -= r * 0.13;
  cam.lookAt(look);
  if (Math.abs(cam.fov - 50) > 0.01) { cam.fov = 50; cam.updateProjectionMatrix(); }
}

function updateWind() {
  const b = THREE.MathUtils.degToRad(settings.windDir);
  const t = simTime;
  const g = settings.gust;
  const gust = 1 + g * (0.5 * Math.sin(t * 0.63) + 0.3 * Math.sin(t * 1.71 + 1.3) + 0.25 * Math.sin(t * 3.7 + 0.5));
  const agl = Math.max(0.3, fm.pos.y - world.heightAt(fm.pos.x, fm.pos.z));
  const profile = THREE.MathUtils.clamp(Math.pow(agl / 10, 0.16), 0.45, 1.5);
  const speed = Math.max(0, settings.wind * gust * profile);
  const swing = g * 0.35 * Math.sin(t * 0.37 + 2);
  env.wind.set(-Math.sin(b + swing) * speed, g * 0.3 * Math.sin(t * 1.3) * settings.wind * 0.1, Math.cos(b + swing) * speed);
  env.turbulence = g;
}

const _A = new THREE.Vector3();
const _B = new THREE.Vector3();
function updateRace() {
  race.now = simTime;
  const g = world.gates[race.next];
  world.toGateLocal(g, prevPos, _A);
  world.toGateLocal(g, fm.pos, _B);
  if (_A.z < 0 && _B.z >= 0 && !fm.crashed) {
    const t = -_A.z / (_B.z - _A.z);
    const x = _A.x + (_B.x - _A.x) * t, y = _A.y + (_B.y - _A.y) * t;
    if (Math.abs(x) < g.inner / 2 && Math.abs(y) < g.inner / 2) {
      if (race.next === 0) {
        if (race.lapStart !== null) {
          const lap = simTime - race.lapStart;
          race.last = lap;
          const isBest = !race.best || lap < race.best;
          if (isBest) race.best = lap;
          hud.toast(`Lap ${lap.toFixed(2)} s${isBest ? ' - best lap!' : ''}`, 'good');
        } else hud.toast('Race started!', 'good');
        race.lapStart = simTime;
      }
      race.next = (race.next + 1) % race.total;
      highlightGates();
    }
  }
  // pulse the next gate
  const pulse = 0.35 + 0.25 * Math.sin(simTime * 6);
  world.gates[race.next].mat.emissive.setRGB(0.05 * pulse, pulse, 0.15 * pulse);
}

function setGimbalVisibility(viewId) {
  const hide = viewId === 'fpv' || viewId === 'gimbal';
  // Onboard cameras sit inside the frame: hide parts that would block the lens
  for (const b of model.blurs) b.visible = !hide;
  model.gimbal.visible = !hide;
}

function render() {
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  setGimbalVisibility(startVisible ? 'chase' : rig.view.id);
  renderer.render(scene, rig.main);
  if (rig.pipOn && !startVisible) {
    const pw = Math.round(Math.min(W * 0.3, 420));
    const ph = Math.round((pw * 9) / 16);
    const px = W - pw - 16;
    const top = 112;
    const glY = H - top - ph;
    rig.pipCam.aspect = pw / ph;
    rig.pipCam.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(px, glY, pw, ph);
    renderer.setViewport(px, glY, pw, ph);
    setGimbalVisibility(rig.pipViewId());
    renderer.render(scene, rig.pipCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    hud.setPip({ x: px, y: top, w: pw, h: ph }, rig.pipViewId().toUpperCase());
  } else hud.setPip(null);
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  const sticks = input.update(dt, fm.mode);
  menu.update();

  if (!paused) {
    simTime += dt;
    updateWind();
    prevPos.copy(fm.pos);
    acc += dt;
    let n = 0;
    while (acc >= PHYS_DT && n < 50) {
      fm.step(PHYS_DT, sticks, env);
      acc -= PHYS_DT;
      n++;
    }
    for (const ev of fm.events) {
      hud.toast(ev.text, ev.type === 'crash' ? 'crash' : ev.type === 'warn' ? 'warn' : '');
    }
    fm.events.length = 0;
    updateRace();
  }

  model.root.position.copy(fm.pos);
  model.root.quaternion.copy(fm.quat);
  let thrAvg = 0;
  for (let i = 0; i < 4; i++) {
    const f = Math.max(0, fm.motorT[i] / fm.tMax);
    omegas[i] = Math.sqrt(f) * fm.p.omegaMax;
    thrAvg += f / 4;
  }
  model.update(paused ? 0 : dt, omegas, rig.gimbalPitch);
  const groundH = world.heightAt(fm.pos.x, fm.pos.z);
  grass.update(world.time, rig.main.position,
    { pos: fm.pos, thrustFrac: thrAvg, agl: Math.max(0, fm.pos.y - fm.gear - groundH), size: fm.p.armLength / 0.18 }, env.wind);
  world.update(dt, fm.pos);
  world.updateWindsock(dt, env.wind, world.time);
  droneShadow.update(fm.pos);

  const scale = fm.p.armLength / 0.18;
  rig.shake = fm.armed ? 0.3 + thrAvg * 1.5 : 0;
  if (startVisible) cinematicCamera();
  else rig.update(dt, fm, model, scale);
  if (startVisible && hud.frame % 30 === 0) {
    const pads = input.listGamepads();
    const chip = document.getElementById('pad-status');
    chip.textContent = pads.length ? `Gamepad: ${pads[0].id.replace(/\(.*\)/, '').trim().slice(0, 32)}` : 'Keyboard \u00b7 no gamepad';
    chip.classList.toggle('on', pads.length > 0);
  }

  hud.update({
    fm, sticks,
    viewName: rig.view.name, viewId: rig.view.id,
    inputName: input.source === 'gamepad' && input.gamepad ? `Gamepad: ${input.gamepad.id.slice(0, 22)}` : 'Keyboard',
    wind: env.wind.length(), race, gates: world.gates,
  });

  const listenerDist = rig.view.id === 'fpv' || rig.view.id === 'gimbal' ? 0.5 : rig.main.position.distanceTo(fm.pos);
  audio.update(paused ? 0 : thrAvg, listenerDist, fm.profileKey === 'racer');

  render();
}

async function init() {
  setLoading('Generating terrain, town and forests...', 10);
  await nextFrame();
  resize();
  world = new World(scene, renderer);
  droneShadow = new DroneShadow(scene, renderer, world);
  setLoading('Setting up flight systems...', 55);
  await nextFrame();
  fm = new FlightModel(world, settings.profile);
  fm.mode = settings.mode;
  input = new Input();
  audio = new DroneAudio();
  hud = new HUD(world);
  rig = new CameraRig(renderer.domElement, world);
  setLoading('Planting grass...', 70);
  await nextFrame();
  const mask = world.buildGrassMask(1024);
  grass = new GrassField(scene, world, mask.data, mask.size);
  setLoading('Assembling drone...', 90);
  await nextFrame();
  buildDrone();
  resetDrone();
  // Any way of closing settings (Resume, X, backdrop, Esc) unpauses the sim
  menu = new Menu({ settings, input, apply: applySetting, onClose: () => { paused = startVisible; } });
  for (const k of ['expo', 'fpvTilt', 'sunElev', 'fog', 'clouds', 'shadows', 'waterRefl', 'pip', 'sound', 'grass']) applySetting(k);
  input.on(onAction);
  rig.setView(0, fm);
  resize();

  setLoading('Ready', 100);
  document.getElementById('loading').classList.add('done');
  setupStartScreen();
  toggleStart();
  document.getElementById('start-btn').textContent = 'Start flying';
  document.getElementById('start-btn').addEventListener('click', () => {
    audio.start();
    toggleStart();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clock.getDelta(); });
  window.__sim = { fm, world, rig, input, settings };
  loop();
}

init().catch((e) => {
  console.error(e);
  document.getElementById('loading').classList.add('error');
  setLoading(`Failed to start: ${e.message}. WebGL 2 support is required.`);
});
