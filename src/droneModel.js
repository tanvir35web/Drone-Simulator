// Detailed procedural drone models: a large camera drone and a 5" FPV racer.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as HD from './texturesHD.js';

// Motor order: 0 front-right (CCW), 1 front-left (CW), 2 rear-left (CCW), 3 rear-right (CW)
export const MOTOR_DIRS = [1, -1, 1, -1]; // +1 = CCW seen from above

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const gimbalEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const gimbalWorldQuat = new THREE.Quaternion();
const bodyEuler = new THREE.Euler(0, 0, 0, 'YXZ');

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

function armBeam(a, b, width, height, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, dir.length(), 4, Math.min(width, height) * 0.35), mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Z, dir.normalize());
  return mesh;
}

function axialCylinder(radius, length, position, axis, mat, segments = 20) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), mat);
  mesh.position.copy(position);
  mesh.quaternion.setFromUnitVectors(Y, axis.clone().normalize());
  return mesh;
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
  const visual = p.visual || 'camera';
  const avata = visual === 'avata2';
  const bodySizes = {
    camera: [0.105, 0.058, 0.185],
    mini4pro: [0.06, 0.027, 0.105],
    air3: [0.078, 0.04, 0.14],
    mavic3pro: [0.085, 0.043, 0.155],
    avata2: [0.075, 0.042, 0.125],
  };
  const [bodyX, bodyY, bodyZ] = bodySizes[visual] || bodySizes.camera;
  const shellColor = p.shellColor || 0xe8eaeb;
  const white = new THREE.MeshPhysicalMaterial({ color: shellColor, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.12 });
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
  const body = ellipsoid(bodyX, bodyY, bodyZ, white);
  root.add(body);
  const cover = ellipsoid(bodyX * 0.8, bodyY * 0.78, bodyZ * 0.72, grey);
  cover.position.set(0, bodyY * 0.48, bodyZ * 0.08);
  root.add(cover);
  const visor = ellipsoid(bodyX * 0.68, bodyY * 0.58, bodyZ * 0.28, glass);
  visor.position.set(0, 0.006, -bodyZ * 0.82);
  root.add(visor);
  for (const sx of [-1, 1]) {
    const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 16).rotateX(Math.PI / 2), glass);
    sensor.position.set(sx * bodyX * 0.42, 0.006, -bodyZ * 0.98);
    root.add(sensor);
    const vent = new THREE.Mesh(new RoundedBoxGeometry(0.004, 0.022, 0.07, 2, 0.002), dark);
    vent.scale.set(1, bodyY / 0.058, bodyZ / 0.185);
    vent.position.set(sx * bodyX * 1.02, 0, bodyZ * 0.1);
    root.add(vent);
  }
  const gps = new THREE.Mesh(new THREE.SphereGeometry(Math.min(0.03, bodyY * 0.52), 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), white);
  gps.position.set(0, bodyY * 1.2, bodyZ * 0.4);
  root.add(gps);
  const batt = new THREE.Mesh(new RoundedBoxGeometry(bodyX * 1.15, bodyY * 0.86, bodyZ * 0.58, 3, Math.min(0.012, bodyY * 0.2)), grey);
  batt.position.set(0, 0.0, bodyZ * 0.92);
  root.add(batt);
  for (let i = 0; i < 4; i++) {
    const l = led(0x30ff60, 0.003);
    l.position.set(-0.018 + i * 0.012, bodyY * 0.2, bodyZ * 1.12);
    root.add(l);
  }
  const strobe = led(0xffffff, 0.009);
  strobe.position.set(0, bodyY * 1.3, bodyZ * 0.6);
  root.add(strobe);

  // Arms, motors, props
  const motorPos = [[d, -d], [-d, -d], [-d, d], [d, d]];
  const props = [], blurs = [];
  const propScale = p.propRadius;
  const armMat = avata ? dark : white;
  const armPivotMat = avata ? dark : grey;
  const motorRadius = Math.min(0.03, Math.max(0.006, propScale * 0.1));
  const motorHeight = motorRadius * 0.82 * Math.max(0.75, propScale / 0.2);
  const propOpts = {
    R: propScale, hub: propScale * 0.08, rootChord: propScale * 0.13,
    maxChord: propScale * 0.2, tipChord: propScale * 0.08,
    pitchRoot: 0.42, pitchTip: 0.12, thick: propScale * 0.03,
  };
  const blades = p.propBlades || 2;
  const propGeoCCW = propGeometry(propOpts, blades, true);
  const propGeoCW = propGeometry(propOpts, blades, false);
  motorPos.forEach(([mx, mz], i) => {
    const dir = new THREE.Vector3(mx, 0, mz).normalize();
    const start = dir.clone().multiplyScalar(bodyX * (avata ? 0.95 : 1.15));
    const motor = new THREE.Vector3(mx, 0, mz);
    const end = motor.clone().addScaledVector(dir, -motorRadius * 1.6);
    if (!avata) {
      root.add(armBeam(start, end, bodyY * 0.46, bodyY * 0.32, armMat));
      const pivot = ellipsoid(bodyY * 0.42, bodyY * 0.38, bodyY * 0.42, armPivotMat, 24);
      pivot.position.copy(start);
      root.add(pivot);
      const hingeAxis = new THREE.Vector3(-dir.z, 0, dir.x);
      const pinCenter = start.clone().addScaledVector(hingeAxis, bodyY * 0.14);
      const pinRadius = bodyY * 0.12;
      root.add(axialCylinder(pinRadius, bodyY * 0.72, pinCenter, hingeAxis, dark));
      for (const side of [-1, 1]) {
        const washerCenter = pinCenter.clone().addScaledVector(hingeAxis, side * bodyY * 0.27);
        root.add(axialCylinder(pinRadius * 1.25, bodyY * 0.08, washerCenter, hingeAxis, silver, 16));
        const screwCenter = washerCenter.clone().addScaledVector(hingeAxis, side * bodyY * 0.055);
        root.add(axialCylinder(pinRadius * 0.42, bodyY * 0.025, screwCenter, hingeAxis, dark, 12));
      }
      const armCollar = ellipsoid(bodyY * 0.2, bodyY * 0.19, bodyY * 0.2, armPivotMat, 20);
      armCollar.position.copy(motor).addScaledVector(dir, -motorRadius * 1.35);
      root.add(armCollar);
    } else {
      root.add(armBeam(start, end, bodyY * 0.52, bodyY * 0.46, dark));
      const duct = new THREE.Mesh(new THREE.TorusGeometry(propScale + 0.006, 0.005, 8, 36), dark);
      duct.rotation.x = Math.PI / 2;
      duct.position.set(mx, motorRadius * 0.95 + motorHeight, mz);
      root.add(duct);
      const ductBraceRadius = propScale * 0.72;
      for (const side of [-1, 1]) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(ductBraceRadius * 2, 0.003, 0.003),
          new THREE.MeshStandardMaterial({ color: 0x24292d, roughness: 0.55 }));
        brace.position.set(mx, motorRadius * 0.95 + motorHeight, mz);
        brace.rotation.y = side * Math.PI / 4;
        root.add(brace);
      }
    }
    const fair = ellipsoid(Math.min(0.03, bodyX * 0.3), Math.min(0.026, bodyY * 0.45), Math.min(0.055, bodyZ * 0.3), white, 24);
    fair.position.copy(start).addScaledVector(dir, bodyY * 0.25);
    fair.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    root.add(fair);

    const motorMount = new THREE.Mesh(new THREE.CylinderGeometry(motorRadius * 1.3, motorRadius * 1.45, motorRadius * 0.22, 24), armPivotMat);
    motorMount.position.set(mx, -motorRadius * 0.42, mz);
    root.add(motorMount);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(motorRadius, motorRadius * 0.84, motorRadius * 1.75, 28), white);
    pod.position.set(mx, 0, mz);
    pod.scale.y = Math.max(0.75, propScale / 0.2);
    root.add(pod);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(motorRadius * 0.92, motorRadius * 0.92, motorHeight, 28), bellMat);
    bell.position.set(mx, motorRadius * 0.62, mz);
    root.add(bell);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(motorRadius * 0.38, motorRadius * 0.44, motorRadius * 0.2, 20), silver);
    cap.position.set(mx, motorRadius * 0.62 + motorHeight * 0.55, mz);
    root.add(cap);
    const l = led(i < 2 ? 0xff2a1a : 0x22ff55, 0.008);
    l.position.set(mx, -motorRadius * 0.9, mz);
    root.add(l);

    const prop = new THREE.Mesh(MOTOR_DIRS[i] > 0 ? propGeoCCW : propGeoCW, propMat);
    prop.position.set(mx, motorRadius * 0.95 + motorHeight, mz);
    prop.rotation.y = i * 0.9;
    root.add(prop);
    props.push(prop);
    const blur = makeBlur(renderer, p.propRadius, blades);
    blur.position.set(mx, motorRadius * 0.96 + motorHeight, mz);
    root.add(blur);
    blurs.push(blur);
  });

  // Landing gear (two struts + skids)
  if (!avata) {
    const legY = -Math.max(0.025, p.gear - bodyY * 0.2);
    const skidX = Math.max(bodyX * 1.2, d * 1.15);
    const skidZ = Math.max(bodyZ * 0.78, 0.08);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        root.add(tube(new THREE.Vector3(sx * bodyX * 0.52, -bodyY * 0.45, sz * bodyZ * 0.3),
          new THREE.Vector3(sx * skidX, legY, sz * bodyZ * 0.36), Math.max(0.004, bodyY * 0.16), Math.max(0.0035, bodyY * 0.14), grey));
      }
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, skidZ * 2, 14).rotateX(Math.PI / 2), dark);
      skid.position.set(sx * skidX, legY, 0);
      root.add(skid);
      for (const sz of [-1, 1]) {
        const capR = new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 8), dark);
        capR.position.set(sx * skidX, legY, sz * skidZ);
        root.add(capR);
      }
    }
  }

  // Stabilized payload cameras
  const gimbal = new THREE.Group();
  const gimbalPosition = p.gimbalCam || [0, -0.05, -0.12];
  gimbal.position.set(...gimbalPosition);
  const gimbalScale = bodyX / 0.105;
  if (!avata) {
    const yawRadius = Math.min(0.02, bodyX * 0.2);
    const yawMotor = new THREE.Mesh(new THREE.CylinderGeometry(yawRadius, yawRadius, 0.022 * gimbalScale, 24), dark);
    gimbal.add(yawMotor);
    const arm = new THREE.Mesh(new RoundedBoxGeometry(0.014 * gimbalScale, 0.05 * gimbalScale, 0.014 * gimbalScale, 2, 0.004 * gimbalScale), dark);
    arm.position.set(0.045 * gimbalScale, -0.03 * gimbalScale, 0);
    gimbal.add(arm);
    const armTop = new THREE.Mesh(new RoundedBoxGeometry(0.05 * gimbalScale, 0.012 * gimbalScale, 0.014 * gimbalScale, 2, 0.004 * gimbalScale), dark);
    armTop.position.set(0.022 * gimbalScale, -0.01 * gimbalScale, 0);
    gimbal.add(armTop);
    const rollMotor = new THREE.Mesh(new THREE.CylinderGeometry(0.016 * gimbalScale, 0.016 * gimbalScale,
      0.012 * gimbalScale, 20).rotateZ(Math.PI / 2), dark);
    rollMotor.position.set(0.045 * gimbalScale, -0.065 * gimbalScale, 0);
    gimbal.add(rollMotor);
  }
  const head = new THREE.Group();
  head.position.set(0, avata ? 0 : -0.065 * gimbalScale, 0);
  const camBody = new THREE.Mesh(new RoundedBoxGeometry(bodyX * 0.68, bodyY * 0.78, bodyZ * 0.34, 4, Math.min(0.012, bodyY * 0.22)), grey);
  head.add(camBody);
  const lensRadius = Math.min(0.023, bodyY * 0.35);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(lensRadius, lensRadius * 1.12, 0.026, 32).rotateX(Math.PI / 2), dark);
  lens.position.set(0, 0, -bodyZ * 0.25);
  head.add(lens);
  const lensGlass = new THREE.Mesh(new THREE.CircleGeometry(lensRadius * 0.82, 32), glass);
  lensGlass.position.set(0, 0, -bodyZ * 0.25 - 0.014);
  lensGlass.rotation.y = Math.PI;
  head.add(lensGlass);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(lensRadius * 0.98, 0.0018, 8, 32), silver);
  ring.position.set(0, 0, -bodyZ * 0.25 - 0.013);
  head.add(ring);
  const extraCameras = visual === 'mavic3pro' ? [-1, 1] : visual === 'air3' ? [1] : [];
  for (const side of extraCameras) {
    const extraRadius = lensRadius * (visual === 'mavic3pro' ? 0.58 : 0.72);
    const extra = new THREE.Mesh(new THREE.CylinderGeometry(extraRadius, extraRadius * 1.1, 0.018, 24).rotateX(Math.PI / 2), dark);
    extra.position.set(side * bodyX * 0.25, -bodyY * 0.25, -bodyZ * 0.22);
    head.add(extra);
    const extraGlass = new THREE.Mesh(new THREE.CircleGeometry(extraRadius * 0.78, 20), glass);
    extraGlass.position.set(extra.position.x, extra.position.y, extra.position.z - 0.01);
    extraGlass.rotation.y = Math.PI;
    head.add(extraGlass);
  }
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
  const hardware = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.25, metalness: 1 });
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
    const motorMount = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.004, 28), anod);
    motorMount.position.set(mx, y0 + 0.003, mz);
    root.add(motorMount);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.002, 10), hardware);
      screw.position.set(mx + sx * 0.009, y0 + 0.006, mz + sz * 0.009);
      root.add(screw);
    }
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
    if (m.gimbalHead) {
      m.root.getWorldQuaternion(gimbalWorldQuat);
      bodyEuler.setFromQuaternion(gimbalWorldQuat, 'YXZ');
      gimbalEuler.set(gimbalPitch, bodyEuler.y, 0, 'YXZ');
      gimbalWorldQuat.setFromEuler(gimbalEuler);
      m.gimbalHead.quaternion.copy(m.root.quaternion).invert().multiply(gimbalWorldQuat);
    }
  };
  return m;
}
