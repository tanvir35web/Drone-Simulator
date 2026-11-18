// Detailed procedural drone models: a large camera drone and a 5" FPV racer.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as HD from './texturesHD.js';

// Motor order: 0 front-right (CCW), 1 front-left (CW), 2 rear-left (CCW), 3 rear-right (CW)
export const MOTOR_DIRS = [1, -1, 1, -1]; // +1 = CCW seen from above

const Y = new THREE.Vector3(0, 1, 0);

/** Twisted, tapered airfoil blade along +x, spinning about +y. ccw = leading edge toward -z at +x. */
function bladeGeometry({ R, hub, rootChord, maxChord, tipChord, pitchRoot, pitchTip, thick, segs = 14, ccw = true }) {
  const pos = [];
  const idx = [];
  const ring = 4;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const r = hub + (R - hub) * t;
    let c = t < 0.3 ? THREE.MathUtils.lerp(rootChord, maxChord, t / 0.3) : THREE.MathUtils.lerp(maxChord, tipChord, (t - 0.3) / 0.7);
    if (t > 0.88) c *= Math.max(0.2, Math.sqrt(1 - Math.pow((t - 0.88) / 0.12, 2)));
    const p = THREE.MathUtils.lerp(pitchRoot, pitchTip, t);
    const th = thick * (1 - 0.7 * t);
    const cs = Math.cos(p), sn = Math.sin(p);
    // chord direction from leading edge to trailing edge
    const chord = (a) => [r, -sn * a, cs * a];
    const up = [0, cs, sn];
    const le = chord(-0.35 * c), te = chord(0.65 * c), mid = chord(-0.05 * c);
    const top = [mid[0], mid[1] + up[1] * th * 0.5, mid[2] + up[2] * th * 0.5];
    const bot = [mid[0], mid[1] - up[1] * th * 0.15, mid[2] - up[2] * th * 0.15];
    pos.push(...le, ...top, ...te, ...bot);
  }
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < ring; k++) {
      const a = i * ring + k, b = i * ring + ((k + 1) % ring);
      const c2 = a + ring, d = b + ring;
      idx.push(a, c2, b, b, c2, d);
    }
  }
  const tip = segs * ring;
  idx.push(tip, tip + 1, tip + 2, tip, tip + 2, tip + 3);
  if (!ccw) {
    for (let i = 2; i < pos.length; i += 3) pos[i] = -pos[i];
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function propGeometry(opts, blades, ccw) {
  const parts = [];
  for (let b = 0; b < blades; b++) {
    const g = bladeGeometry({ ...opts, ccw });
    g.rotateY((b / blades) * Math.PI * 2);
    parts.push(g);
  }
  const hub = new THREE.CylinderGeometry(opts.hub * 1.1, opts.hub * 1.2, opts.thick * 2.6, 16);
  hub.deleteAttribute('uv');
  parts.push(hub);
  return mergeGeometries(parts);
}

/** Cylinder from a to b. */
function tube(a, b, r0, r1, mat, seg = 12) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, seg), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(Y, dir.normalize());
  return m;
}

function ellipsoid(sx, sy, sz, mat, seg = 40) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7)), mat);
  m.scale.set(sx, sy, sz);
  return m;
}

function led(color, r) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 4, roughness: 0.3 }));
}

function makeBlur(renderer, R, blades) {
  const mat = new THREE.MeshBasicMaterial({
    map: HD.makePropBlurTexture(renderer, blades), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(R, 48).rotateX(-Math.PI / 2), mat);
  m.renderOrder = 2;
  return m;
}

// ---------------------------------------------------------------------------
function buildCameraDrone(p, renderer) {
  const root = new THREE.Group();
  const d = p.armLength / Math.SQRT2;
  const white = new THREE.MeshPhysicalMaterial({ color: 0xe8eaeb, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.12 });
  const grey = new THREE.MeshPhysicalMaterial({ color: 0x4d5257, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.45, metalness: 0.35 });
  const carbonTex = HD.makeCarbonTexture(renderer);
  carbonTex.repeat.set(1, 8);
  const carbon = new THREE.MeshPhysicalMaterial({ map: carbonTex, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.3, metalness: 0.85 });
  const silver = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.2, metalness: 1 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x04060a, roughness: 0.02, metalness: 0.4, clearcoat: 1 });
  const propMat = new THREE.MeshPhysicalMaterial({ color: 0x141518, roughness: 0.35, clearcoat: 0.6, side: THREE.DoubleSide });

  // Fuselage
  const body = ellipsoid(0.105, 0.058, 0.185, white);
  root.add(body);
  const cover = ellipsoid(0.085, 0.045, 0.135, grey);
  cover.position.set(0, 0.03, 0.015);
  root.add(cover);
  const visor = ellipsoid(0.072, 0.034, 0.05, glass);
  visor.position.set(0, 0.006, -0.155);
  root.add(visor);
  for (const sx of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 16).rotateX(Math.PI / 2), glass);
    s.position.set(sx * 0.03, 0.006, -0.198);
    root.add(s);
    const vent = new THREE.Mesh(new RoundedBoxGeometry(0.004, 0.022, 0.07, 2, 0.002), dark);
    vent.position.set(sx * 0.104, 0, 0.02);
    root.add(vent);
  }
  const gps = new THREE.Mesh(new THREE.SphereGeometry(0.03, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white);
  gps.position.set(0, 0.07, 0.07);
  root.add(gps);
  const batt = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.05, 0.1, 3, 0.012), grey);
  batt.position.set(0, 0.0, 0.16);
  root.add(batt);
  for (let i = 0; i < 4; i++) {
    const l = led(0x30ff60, 0.003);
    l.position.set(-0.018 + i * 0.012, 0.012, 0.211);
    root.add(l);
  }
  const strobe = led(0xffffff, 0.009);
  strobe.position.set(0, 0.075, 0.115);
  root.add(strobe);

  // Arms, motors, props
  const motorPos = [[d, -d], [-d, -d], [-d, d], [d, d]];
  const props = [], blurs = [];
  const propOpts = { R: p.propRadius, hub: 0.016, rootChord: 0.026, maxChord: 0.04, tipChord: 0.016, pitchRoot: 0.42, pitchTip: 0.12, thick: 0.006 };
  const propGeoCCW = propGeometry(propOpts, 2, true);
  const propGeoCW = propGeometry(propOpts, 2, false);
  motorPos.forEach(([mx, mz], i) => {
    const dir = new THREE.Vector3(mx, 0, mz).normalize();
    const start = dir.clone().multiplyScalar(0.075);
    const end = new THREE.Vector3(mx, 0, mz).addScaledVector(dir, -0.02);
    root.add(tube(start, end, 0.014, 0.012, carbon, 16));
    const fair = ellipsoid(0.03, 0.026, 0.055, white, 24);
    fair.position.copy(dir).multiplyScalar(0.085);
    fair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    root.add(fair);

    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.05, 28), white);
    pod.position.set(mx, 0, mz);
    root.add(pod);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.029, 0.029, 0.022, 28), bellMat);
    bell.position.set(mx, 0.036, mz);
    root.add(bell);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.008, 20), silver);
    cap.position.set(mx, 0.05, mz);
    root.add(cap);
    const l = led(i < 2 ? 0xff2a1a : 0x22ff55, 0.008);
    l.position.set(mx, -0.028, mz);
    root.add(l);

    const prop = new THREE.Mesh(MOTOR_DIRS[i] > 0 ? propGeoCCW : propGeoCW, propMat);
    prop.position.set(mx, 0.06, mz);
    prop.rotation.y = i * 0.9;
    root.add(prop);
    props.push(prop);
    const blur = makeBlur(renderer, p.propRadius, 2);
    blur.position.set(mx, 0.061, mz);
    root.add(blur);
    blurs.push(blur);
  });

  // Landing gear (two struts + skids)
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      root.add(tube(new THREE.Vector3(sx * 0.055, -0.03, sz * 0.05), new THREE.Vector3(sx * 0.13, -0.185, sz * 0.075), 0.009, 0.008, grey));
    }
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.32, 14).rotateX(Math.PI / 2), dark);
    skid.position.set(sx * 0.13, -0.19, 0);
    root.add(skid);
    for (const sz of [-1, 1]) {
      const capR = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 12, 8), dark);
      capR.position.set(sx * 0.13, -0.19, sz * 0.16);
      root.add(capR);
    }
  }

  // 3-axis gimbal + camera
  const gimbal = new THREE.Group();
  gimbal.position.set(0, -0.05, -0.12);
  const yawMotor = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.022, 24), dark);
  gimbal.add(yawMotor);
  const arm = new THREE.Mesh(new RoundedBoxGeometry(0.014, 0.05, 0.014, 2, 0.004), dark);
  arm.position.set(0.045, -0.03, 0);
  gimbal.add(arm);
  const armTop = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.012, 0.014, 2, 0.004), dark);
  armTop.position.set(0.022, -0.01, 0);
  gimbal.add(armTop);
  const rollMotor = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 20).rotateZ(Math.PI / 2), dark);
  rollMotor.position.set(0.045, -0.065, 0);
  gimbal.add(rollMotor);
  const head = new THREE.Group();
  head.position.set(0, -0.065, 0);
  const camBody = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.058, 0.062, 4, 0.012), grey);
  head.add(camBody);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.026, 0.026, 32).rotateX(Math.PI / 2), dark);
  lens.position.set(0, 0, -0.042);
  head.add(lens);
  const lensGlass = new THREE.Mesh(new THREE.CircleGeometry(0.019, 32), glass);
  lensGlass.position.set(0, 0, -0.0555);
  lensGlass.rotation.y = Math.PI;
  head.add(lensGlass);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0225, 0.0018, 8, 32), silver);
  ring.position.set(0, 0, -0.055);
  head.add(ring);
  gimbal.add(head);
  root.add(gimbal);

  return { root, props, blurs, gimbal, gimbalHead: head, strobe, propMat };
}

// ---------------------------------------------------------------------------
function buildRacer(p, renderer) {
  const root = new THREE.Group();
  const d = p.armLength / Math.SQRT2;
  const y0 = -0.009;
  const carbonTex = HD.makeCarbonTexture(renderer);
  carbonTex.repeat.set(2, 2);
  const carbon = new THREE.MeshPhysicalMaterial({ map: carbonTex, roughness: 0.35, metalness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const anod = new THREE.MeshStandardMaterial({ color: 0x8a2be2, roughness: 0.25, metalness: 0.9 });
  const tpu = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.45, metalness: 0.3 });
  const bellMat = new THREE.MeshStandardMaterial({ color: 0xd8262c, roughness: 0.25, metalness: 0.9 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x05070c, roughness: 0.02, metalness: 0.4, clearcoat: 1 });
  const propMat = new THREE.MeshPhysicalMaterial({ color: 0xff7a1a, roughness: 0.25, transparent: true, opacity: 0.88, side: THREE.DoubleSide });

  // Bottom plate: centre + 4 arms
  const plate = new THREE.Mesh(new RoundedBoxGeometry(0.048, 0.004, 0.095, 2, 0.0015), carbon);
  plate.position.y = y0;
  root.add(plate);
  const motorPos = [[d, -d], [-d, -d], [-d, d], [d, d]];
  for (const [mx, mz] of motorPos) {
    const len = Math.hypot(mx, mz) + 0.012;
    const a = new THREE.Mesh(new RoundedBoxGeometry(0.022, 0.005, len, 2, 0.002), carbon);
    a.position.set(mx / 2, y0, mz / 2);
    a.rotation.y = Math.atan2(mx, mz);
    root.add(a);
  }
  // Top plate + standoffs + stack
  const top = new THREE.Mesh(new RoundedBoxGeometry(0.04, 0.003, 0.085, 2, 0.0012), carbon);
  top.position.y = y0 + 0.03;
  root.add(top);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.028, 10), anod);
    s.position.set(sx * 0.016, y0 + 0.015, sz * 0.036);
    root.add(s);
  }
  const stack = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.03), new THREE.MeshStandardMaterial({ color: 0x0f3d1e, roughness: 0.6 }));
  stack.position.set(0, y0 + 0.012, 0.005);
  root.add(stack);

  // FPV camera in TPU mount
  const camGroup = new THREE.Group();
  camGroup.position.set(0, y0 + 0.016, -0.046);
  camGroup.rotation.x = 0.42;
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new RoundedBoxGeometry(0.004, 0.026, 0.022, 2, 0.0015), tpu);
    side.position.set(sx * 0.0125, 0, 0);
    camGroup.add(side);
  }
  const cam = new THREE.Mesh(new RoundedBoxGeometry(0.019, 0.019, 0.02, 2, 0.003), dark);
  camGroup.add(cam);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.008, 0.012, 20).rotateX(Math.PI / 2), dark);
  lens.position.z = -0.015;
  camGroup.add(lens);
  const lg = new THREE.Mesh(new THREE.CircleGeometry(0.0062, 20), glass);
  lg.position.z = -0.0215; lg.rotation.y = Math.PI;
  camGroup.add(lg);
  root.add(camGroup);

  // Battery with strap
  const batTex = HD.makeBatteryTexture(renderer);
  const battMat = new THREE.MeshStandardMaterial({ map: batTex, roughness: 0.55 });
  const batt = new THREE.Mesh(new RoundedBoxGeometry(0.036, 0.03, 0.078, 3, 0.005), battMat);
  batt.position.set(0, y0 + 0.048, 0.006);
  root.add(batt);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.039, 0.033, 0.01), new THREE.MeshStandardMaterial({ color: 0xc81e1e, roughness: 0.8 }));
  strap.position.set(0, y0 + 0.047, 0.006);
  root.add(strap);
  const xt = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, 0.016), new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.5 }));
  xt.position.set(0, y0 + 0.036, 0.05);
  root.add(xt);

  // Antennas
  const ant = tube(new THREE.Vector3(0, y0 + 0.032, 0.045), new THREE.Vector3(0, y0 + 0.07, 0.085), 0.0022, 0.0022, dark, 8);
  root.add(ant);
  const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 12, 8), dark);
  antTip.position.set(0, y0 + 0.072, 0.087);
  root.add(antTip);
  for (const sx of [-1, 1]) {
    root.add(tube(new THREE.Vector3(sx * 0.01, y0 + 0.03, 0.04), new THREE.Vector3(sx * 0.04, y0 + 0.05, 0.075), 0.0016, 0.0016,
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.6 }), 6));
  }
  const ledBar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.003, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 4 }));
  ledBar.position.set(0, y0 - 0.002, 0.048);
  root.add(ledBar);

  // Motors + props
  const props = [], blurs = [];
  const propOpts = { R: p.propRadius, hub: 0.007, rootChord: 0.012, maxChord: 0.019, tipChord: 0.011, pitchRoot: 0.55, pitchTip: 0.2, thick: 0.0035 };
  const geoCCW = propGeometry(propOpts, 3, true);
  const geoCW = propGeometry(propOpts, 3, false);
  motorPos.forEach(([mx, mz], i) => {
    const stator = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.007, 20), dark);
    stator.position.set(mx, y0 + 0.006, mz);
    root.add(stator);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.0138, 0.0138, 0.013, 24), bellMat);
    bell.position.set(mx, y0 + 0.016, mz);
    root.add(bell);
    const prop = new THREE.Mesh(MOTOR_DIRS[i] > 0 ? geoCCW : geoCW, propMat);
    prop.position.set(mx, y0 + 0.027, mz);
    prop.rotation.y = i * 1.1;
    root.add(prop);
    props.push(prop);
    const blur = makeBlur(renderer, p.propRadius, 3);
    blur.material.color.set(0xff8a3a);
    blur.position.set(mx, y0 + 0.028, mz);
    root.add(blur);
    blurs.push(blur);
  });

  return { root, props, blurs, gimbal: new THREE.Group(), gimbalHead: null, strobe: null, propMat };
}

// ---------------------------------------------------------------------------
export function createDroneModel(profile, renderer) {
  const m = profile.style === 'racer' ? buildRacer(profile, renderer) : buildCameraDrone(profile, renderer);
  m.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  m.blurs.forEach((b) => { b.castShadow = false; b.receiveShadow = false; });
  m.gearHeight = profile.gear;
  let t = 0;
  m.update = (dt, motorOmega, gimbalPitch = 0) => {
    t += dt;
    for (let i = 0; i < 4; i++) {
      const w = motorOmega[i];
      const blurAmt = THREE.MathUtils.smoothstep(w, 40, 220);
      // visible blade spin is capped to avoid wagon-wheel aliasing; the blur disc carries the motion
      m.props[i].rotation.y += Math.min(w, 45) * MOTOR_DIRS[i] * dt;
      m.props[i].visible = blurAmt < 0.97;
      m.blurs[i].material.opacity = blurAmt * 0.85;
      m.blurs[i].rotation.y += w * MOTOR_DIRS[i] * dt * 0.02;
    }
    if (m.strobe) {
      const ph = t % 1.3;
      m.strobe.visible = ph < 0.05 || (ph > 0.15 && ph < 0.2);
    }
    if (m.gimbalHead) m.gimbalHead.rotation.x = gimbalPitch;
  };
  return m;
}
