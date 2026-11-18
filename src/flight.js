// Rigid-body quadcopter physics with a cascaded flight controller.
//
// Body axes: x = right, y = up, z = back (forward is -z).
// Positive body rates: x = nose up, y = yaw left, z = roll left.
// Motors: 0 front-right (CCW prop), 1 front-left (CW), 2 rear-left (CCW), 3 rear-right (CW).
import * as THREE from 'three';
import { WATER_Y } from './world.js';

const G = 9.81;
const RHO = 1.225;
const DEG = Math.PI / 180;

export const PROFILES = {
  camera: {
    name: 'Pro camera drone (3.2 kg)',
    style: 'camera',
    mass: 3.2, armLength: 0.31, propRadius: 0.2,
    inertia: [0.075, 0.13, 0.075],
    twr: 2.4, kYaw: 0.03, motorTau: 0.06,
    dragBody: [0.09, 0.18, 0.08], dragLin: 0.06,
    rateKp: 14, rateKi: 6, angleKp: 6,
    maxAngle: 35, yawRate: 110, acroRate: 300,
    gpsSpeed: 18, gpsClimb: 5, gpsDescend: 3.5,
    cells: 6, energyWh: 130, propEff: 0.55, avionicsW: 18,
    crashSpeed: 4, omegaMax: 600,
    gear: 0.212, // body origin -> ground when landed (skids sit just above pad decals)
    fpvCam: [0, 0.015, -0.218],
    gimbalCam: [0, -0.115, -0.15],
  },
  racer: {
    name: 'FPV racer 5" (650 g)',
    style: 'racer',
    mass: 0.65, armLength: 0.11, propRadius: 0.064,
    inertia: [0.0032, 0.006, 0.0032],
    twr: 7, kYaw: 0.014, motorTau: 0.02,
    dragBody: [0.014, 0.03, 0.012], dragLin: 0.05,
    rateKp: 40, rateKi: 20, angleKp: 11,
    maxAngle: 55, yawRate: 300, acroRate: 720,
    gpsSpeed: 25, gpsClimb: 8, gpsDescend: 5,
    cells: 6, energyWh: 24, propEff: 0.5, avionicsW: 12,
    crashSpeed: 6.5, omegaMax: 3000,
    gear: 0.022,
    fpvCam: [0, 0.028, -0.06],
    gimbalCam: [0, -0.02, -0.07],
  },
};

export const MODES = ['GPS', 'ANGLE', 'ACRO'];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

export class FlightModel {
  constructor(world, profileKey = 'camera') {
    this.world = world;
    this.setProfile(profileKey);
    this.mode = 'GPS';
    this.settings = { expo: 0.3, throttleMid: true, maxAngleOverride: 0, acroRateOverride: 0, smoothing: 0.5 };
    this.reset();
  }

  setProfile(key) {
    this.profileKey = key;
    this.p = PROFILES[key];
    this.tMax = (this.p.twr * this.p.mass * G) / 4;
    this.armD = this.p.armLength / Math.SQRT2;
    this.discArea = Math.PI * this.p.propRadius * this.p.propRadius;
    this.gear = this.p.gear;
  }

  reset(pos, yaw = 0) {
    this.pos = new THREE.Vector3();
    if (pos) this.pos.copy(pos);
    else this.pos.set(0, this.world.heightAt(0, 0) + this.gear + 0.001, 0);
    this.vel = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this.quat = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    this.omega = new THREE.Vector3();
    this.motorT = [0, 0, 0, 0];
    this.motorCmd = [0, 0, 0, 0];
    this.rateInt = new THREE.Vector3();
    this.velInt = new THREE.Vector3();
    this.altInt = 0;
    this.armed = false;
    this.crashed = false;
    this.crashReason = '';
    this.onGround = true;
    this.inWater = false;
    this.soc = 1;
    this.voltage = this.p.cells * 4.2;
    this.current = 0;
    this.power = 0;
    this.flightTime = 0;
    this.holdPos = null;
    this.holdAlt = null;
    this.landedTimer = 0;
    this.rth = null;
    this.turb = new THREE.Vector3();
    this.home = this.pos.clone();
    this.events = [];
    this.lastImpact = 0;
    // control shaping state
    this.rc = { thr: -1, yaw: 0, pitch: 0, roll: 0 };   // filtered stick setpoints
    this.vCmd = new THREE.Vector3();                     // shaped velocity command (GPS)
    this.aCmd = new THREE.Vector3();                     // its acceleration (feedforward)
    this.vzCmd = 0;
    this.ff = new THREE.Vector3();
    this.ffPrev = new THREE.Vector3();
    this.ffInit = false;
    this.lastMode = null;
  }

  /** 0.35 (snappy) .. 1.65 (very smooth) */
  get smoothMul() { return 0.35 + (this.settings.smoothing ?? 0.5) * 1.3; }

  emit(type, text) { this.events.push({ type, text }); }

  get heading() {
    _e.setFromQuaternion(this.quat, 'YXZ');
    return _e.y;
  }

  arm() {
    if (this.crashed) { this.emit('warn', 'Drone crashed - press R to reset'); return; }
    if (this.soc <= 0.01) { this.emit('warn', 'Battery empty'); return; }
    if (this.mode !== 'GPS' && this.lastThrottle > 0.12) { this.emit('warn', 'Lower throttle to arm'); return; }
    if (_v1.set(0, 1, 0).applyQuaternion(this.quat).y < 0.7) { this.emit('warn', 'Cannot arm: drone not level'); return; }
    this.armed = true;
    this.rateInt.set(0, 0, 0);
    this.velInt.set(0, 0, 0);
    this.holdPos = null; this.holdAlt = null;
    this.emit('info', 'ARMED');
  }

  disarm(reason = 'DISARMED') {
    if (!this.armed) return;
    this.armed = false;
    this.rth = null;
    this.emit('info', reason);
  }

  startRTH() {
    if (!this.armed || this.crashed) return;
    if (this.mode !== 'GPS') { this.emit('warn', 'Return-to-home needs GPS mode'); return; }
    this.rth = { phase: 'climb', alt: Math.max(this.pos.y - this.world.heightAt(this.pos.x, this.pos.z), 30) };
    this.emit('info', 'RETURN TO HOME');
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;
    this.rth = null;
    this.crashReason = reason;
    this.omega.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 20);
    this.emit('crash', reason);
  }

  expo(x) {
    const e = this.settings.expo;
    return x * (1 - e) + x * x * x * e;
  }

  throttleCurve(t) {
    const x = (t + 1) / 2; // 0..1
    if (!this.settings.throttleMid) return x;
    const hover = 1 / this.p.twr;
    return x < 0.5 ? (x / 0.5) * hover : hover + ((x - 0.5) / 0.5) * (1 - hover);
  }

  /** Fixed-step integration. sticks: thr/yaw/pitch/roll in [-1,1]. env: { wind: Vector3, turbulence } */
  step(h, sticks, env) {
    const p = this.p;
    const I = p.inertia;
    const q = this.quat;
    const w = this.omega;
    const up = _v1.set(0, 1, 0).applyQuaternion(q);
    const groundH = this.world.heightAt(this.pos.x, this.pos.z);
    const agl = this.pos.y - this.gear - groundH;
    this.lastThrottle = this.throttleCurve(sticks.thr);

    // RC smoothing: low-pass the stick setpoints like a real flight controller does,
    // so keyboard steps and noisy gamepad sticks turn into smooth commands.
    const sm = this.smoothMul;
    const taus = this.mode === 'ACRO' ? { thr: 0.015, yaw: 0.015, pitch: 0.012, roll: 0.012 }
      : this.mode === 'ANGLE' ? { thr: 0.05, yaw: 0.07, pitch: 0.055, roll: 0.055 }
      : { thr: 0.12, yaw: 0.16, pitch: 0.06, roll: 0.06 };
    for (const k in taus) this.rc[k] += (sticks[k] - this.rc[k]) * (1 - Math.exp(-h / (taus[k] * sm)));
    const rc = this.rc;
    if (this.lastMode !== this.mode) {
      this.lastMode = this.mode;
      this.vCmd.copy(this.vel); this.aCmd.set(0, 0, 0); this.vzCmd = this.vel.y;
      this.holdPos = null; this.holdAlt = null;
    }
    const thrCmd = this.throttleCurve(rc.thr);

    // Any stick input cancels return-to-home
    if (this.rth && (Math.abs(sticks.pitch) > 0.3 || Math.abs(sticks.roll) > 0.3 || Math.abs(sticks.thr) > 0.5)) {
      this.rth = null;
      this.emit('info', 'RTH cancelled');
    }

    // ---------------- flight controller ----------------
    let thrust = 0;
    const rateDes = _v2.set(0, 0, 0);
    let idleOnly = false;
    if (this.armed && !this.crashed) {
      const maxAngle = (this.settings.maxAngleOverride || p.maxAngle) * DEG;
      const yawRate = p.yawRate * DEG;
      if (this.mode === 'ACRO') {
        const r = (this.settings.acroRateOverride || p.acroRate) * DEG;
        rateDes.set(-this.expo(rc.pitch) * r, -this.expo(rc.yaw) * yawRate * 1.5, -this.expo(rc.roll) * r);
        thrust = thrCmd * 4 * this.tMax;
        if (this.onGround && thrCmd < 0.05) idleOnly = true;
      } else if (this.mode === 'ANGLE') {
        const tp = this.expo(rc.pitch) * maxAngle;
        const tr = this.expo(rc.roll) * maxAngle;
        this.attitudeToRates(-tp, -tr, rateDes);
        rateDes.y += -this.expo(rc.yaw) * yawRate;
        thrust = thrCmd * 4 * this.tMax;
        if (this.onGround && thrCmd < 0.05) idleOnly = true;
      } else {
        const res = this.gpsController(h, rc, rateDes, agl);
        thrust = res.thrust;
        idleOnly = res.idle;
      }
    }

    // ---------------- rate controller + mixer ----------------
    const armedRunning = this.armed && !this.crashed;
    const idle = 0.035 * this.tMax;
    if (armedRunning) {
      if (idleOnly) {
        this.rateInt.set(0, 0, 0);
        this.ffInit = false;
        for (let i = 0; i < 4; i++) this.motorCmd[i] = idle;
      } else {
        const ex = rateDes.x - w.x, ey = rateDes.y - w.y, ez = rateDes.z - w.z;
        const ki = p.rateKi;
        this.rateInt.x = THREE.MathUtils.clamp(this.rateInt.x + ex * h, -0.5, 0.5);
        this.rateInt.y = THREE.MathUtils.clamp(this.rateInt.y + ey * h, -0.5, 0.5);
        this.rateInt.z = THREE.MathUtils.clamp(this.rateInt.z + ez * h, -0.5, 0.5);
        // gyroscopic compensation  w x (I w)
        const Iwx = I[0] * w.x, Iwy = I[1] * w.y, Iwz = I[2] * w.z;
        const gx = w.y * Iwz - w.z * Iwy, gy = w.z * Iwx - w.x * Iwz, gz = w.x * Iwy - w.y * Iwx;
        const tx = I[0] * (p.rateKp * ex + ki * this.rateInt.x) + gx;
        const ty = I[1] * (p.rateKp * 1.4 * ey + ki * this.rateInt.y) + gy;
        const tz = I[2] * (p.rateKp * ez + ki * this.rateInt.z) + gz;
        // setpoint feedforward: the derivative of the (smoothed) rate command drives the motors
        // directly, so the drone follows the sticks crisply without the P term overshooting
        if (!this.ffInit) { this.ffPrev.copy(rateDes); this.ff.set(0, 0, 0); this.ffInit = true; }
        const fa = 1 - Math.exp(-h / 0.02);
        this.ff.x += ((rateDes.x - this.ffPrev.x) / h - this.ff.x) * fa;
        this.ff.y += ((rateDes.y - this.ffPrev.y) / h - this.ff.y) * fa;
        this.ff.z += ((rateDes.z - this.ffPrev.z) / h - this.ff.z) * fa;
        this.ffPrev.copy(rateDes);
        const kff = 0.35;
        this.mix(thrust, tx + I[0] * this.ff.x * kff, ty + I[1] * this.ff.y * kff, tz + I[2] * this.ff.z * kff, idle);
      }
    } else {
      for (let i = 0; i < 4; i++) this.motorCmd[i] = 0;
    }

    // ---------------- battery ----------------
    const cells = p.cells;
    const ocv = cells * (3.45 + 0.75 * this.soc - 0.3 * Math.pow(1 - this.soc, 6));
    const thrustScale = Math.pow(Math.min(1, this.voltage / (cells * 4.2)), 1.6) * THREE.MathUtils.smoothstep(this.soc, 0, 0.02);

    // ---------------- motor dynamics ----------------
    let total = 0;
    let power = p.avionicsW * (this.armed ? 1 : 0.4);
    const k = 1 / Math.sqrt(2 * RHO * this.discArea);
    for (let i = 0; i < 4; i++) {
      const cmd = Math.min(this.motorCmd[i], this.tMax) * thrustScale;
      const tau = cmd > this.motorT[i] ? p.motorTau : p.motorTau * 1.8;
      this.motorT[i] += (cmd - this.motorT[i]) * (1 - Math.exp(-h / tau));
      total += this.motorT[i];
      power += (Math.pow(this.motorT[i], 1.5) * k) / p.propEff;
    }
    this.power = power;
    this.current = power / Math.max(1, this.voltage);
    this.voltage = Math.max(0, ocv - this.current * 0.012 * cells);
    if (this.armed || power > 20) this.soc = Math.max(0, this.soc - (power * h) / (p.energyWh * 3600));
    if (this.soc <= 0 && this.armed) this.disarm('BATTERY EMPTY - motors stopped');

    // ground effect
    const rotorZ = Math.max(agl + 0.04, p.propRadius / 3);
    const ge = Math.min(1.25, 1 / (1 - Math.pow(p.propRadius / (4 * rotorZ), 2)));

    const T = this.motorT;
    const d = this.armD;
    // torques from motor thrust differences
    let tqx = d * (T[0] + T[1] - T[2] - T[3]) * ge;
    let tqz = d * (T[0] + T[3] - T[1] - T[2]) * ge;
    let tqy = p.kYaw * (T[1] + T[3] - T[0] - T[2]);
    // aerodynamic rotational damping
    const ad = 0.0025 * p.mass;
    tqx -= ad * w.x; tqy -= ad * w.y * 2; tqz -= ad * w.z;
    // turbulence (filtered random torque scaled by wind)
    const windSpeed = env.wind.length();
    const turbK = env.turbulence * windSpeed * 0.00035 * p.mass * (agl > 0.2 ? 1 : 0);
    this.turb.x += ((Math.random() - 0.5) * turbK - this.turb.x) * Math.min(1, h * 8);
    this.turb.z += ((Math.random() - 0.5) * turbK - this.turb.z) * Math.min(1, h * 8);
    this.turb.y += ((Math.random() - 0.5) * turbK * 0.3 - this.turb.y) * Math.min(1, h * 8);
    tqx += this.turb.x * 30; tqy += this.turb.y * 30; tqz += this.turb.z * 30;

    // ---------------- rotational dynamics ----------------
    const Iwx = I[0] * w.x, Iwy = I[1] * w.y, Iwz = I[2] * w.z;
    const cx = w.y * Iwz - w.z * Iwy, cy = w.z * Iwx - w.x * Iwz, cz = w.x * Iwy - w.y * Iwx;
    w.x += ((tqx - cx) / I[0]) * h;
    w.y += ((tqy - cy) / I[1]) * h;
    w.z += ((tqz - cz) / I[2]) * h;
    const wl = w.length();
    if (wl > 1e-9) {
      _q1.setFromAxisAngle(_v2.copy(w).divideScalar(wl), wl * h);
      q.multiply(_q1).normalize();
    }

    // ---------------- translational dynamics ----------------
    up.set(0, 1, 0).applyQuaternion(q);
    const F = _v2.copy(up).multiplyScalar(total * ge);
    F.y -= p.mass * G;
    // drag in body frame (relative to air)
    const vrel = this.acc.copy(this.vel).sub(env.wind);
    _q2.copy(q).invert();
    vrel.applyQuaternion(_q2);
    const sp = vrel.length();
    const db = p.dragBody;
    vrel.set(
      -(db[0] * sp + p.dragLin * p.mass) * vrel.x,
      -(db[1] * sp + p.dragLin * 0.5 * p.mass) * vrel.y,
      -(db[2] * sp + p.dragLin * p.mass) * vrel.z,
    ).applyQuaternion(q);
    F.add(vrel);
    const acc = F.divideScalar(p.mass);
    this.acc.copy(acc);
    this.vel.addScaledVector(acc, h);
    this.pos.addScaledVector(this.vel, h);

    this.handleContacts(h, total);
    if (this.armed) this.flightTime += h;
  }

  /** Target attitude (pitch about x, roll about z) with current heading -> body-rate command. */
  attitudeToRates(pitch, roll, out) {
    _e.setFromQuaternion(this.quat, 'YXZ');
    _e.set(pitch, _e.y, roll, 'YXZ');
    _q1.setFromEuler(_e);
    _q2.copy(this.quat).invert().multiply(_q1);
    if (_q2.w < 0) { _q2.x = -_q2.x; _q2.y = -_q2.y; _q2.z = -_q2.z; _q2.w = -_q2.w; }
    const kp = this.p.angleKp;
    out.set(_q2.x * 2 * kp, _q2.y * 2 * kp, _q2.z * 2 * kp);
    return out;
  }

  gpsController(h, sticks, rateDes, agl) {
    const p = this.p;
    const psi = this.heading;
    const fx = -Math.sin(psi), fz = -Math.cos(psi);
    const rx = Math.cos(psi), rz = -Math.sin(psi);
    const dead = (v, d = 0.06) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
    let sp = dead(sticks.pitch), sr = dead(sticks.roll), st = dead(sticks.thr, 0.1), sy = dead(sticks.yaw);

    // Landed and throttle not pushed up: idle on the ground
    if (this.onGround && st <= 0.05 && !this.rth) {
      this.holdPos = null; this.holdAlt = null;
      this.velInt.set(0, 0, 0); this.altInt = 0;
      this.vCmd.set(0, 0, 0); this.aCmd.set(0, 0, 0); this.vzCmd = 0;
      if (st < -0.6) {
        this.landedTimer += h;
        if (this.landedTimer > 1.2) { this.landedTimer = 0; this.disarm('LANDED - motors off'); }
      } else this.landedTimer = 0;
      return { thrust: 0, idle: true };
    }
    this.landedTimer = 0;

    let vdx = (fx * sp + rx * sr) * p.gpsSpeed;
    let vdz = (fz * sp + rz * sr) * p.gpsSpeed;
    let vdy = st > 0 ? st * p.gpsClimb : st * p.gpsDescend;

    // Return to home automation
    if (this.rth) {
      sy = 0;
      const toHx = this.home.x - this.pos.x, toHz = this.home.z - this.pos.z;
      const dist = Math.hypot(toHx, toHz);
      const targetY = this.world.heightAt(this.pos.x, this.pos.z) + this.rth.alt;
      if (this.rth.phase === 'climb') {
        vdx = 0; vdz = 0;
        vdy = THREE.MathUtils.clamp((targetY - this.pos.y) * 0.8, -2, p.gpsClimb);
        if (Math.abs(targetY - this.pos.y) < 1) this.rth.phase = 'return';
      } else if (this.rth.phase === 'return') {
        const s = Math.min(10, dist * 0.5);
        vdx = (toHx / Math.max(dist, 0.01)) * s; vdz = (toHz / Math.max(dist, 0.01)) * s;
        vdy = THREE.MathUtils.clamp((targetY - this.pos.y) * 0.8, -2, 3);
        // turn nose toward home
        const want = Math.atan2(-toHx, -toHz);
        let dpsi = want - psi;
        while (dpsi > Math.PI) dpsi -= 2 * Math.PI;
        while (dpsi < -Math.PI) dpsi += 2 * Math.PI;
        if (dist > 5) sy = THREE.MathUtils.clamp(-dpsi * 1.5, -1, 1);
        if (dist < 1.0 && this.vel.length() < 0.6) this.rth.phase = 'land';
      } else {
        vdx = toHx * 0.6; vdz = toHz * 0.6;
        vdy = agl > 6 ? -3 : agl > 1.5 ? -1.2 : -0.6;
        if (this.onGround) { this.disarm('Landed at home'); return { thrust: 0, idle: true }; }
      }
    }

    // Position hold when sticks centred
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (!this.rth && sp === 0 && sr === 0) {
      if (!this.holdPos && hv < 0.7) this.holdPos = this.pos.clone();
      if (this.holdPos) {
        vdx = THREE.MathUtils.clamp((this.holdPos.x - this.pos.x) * 0.9, -3, 3);
        vdz = THREE.MathUtils.clamp((this.holdPos.z - this.pos.z) * 0.9, -3, 3);
      }
    } else this.holdPos = null;
    if (!this.rth && st === 0) {
      if (this.holdAlt === null && Math.abs(this.vel.y) < 0.5) this.holdAlt = this.pos.y;
      if (this.holdAlt !== null) vdy = THREE.MathUtils.clamp((this.holdAlt - this.pos.y) * 1.2, -2, 2);
    } else this.holdAlt = null;

    // Velocity -> acceleration (PI), with wind compensation integrator
    // Jerk-limited velocity shaping: the commanded velocity follows the stick through a
    // critically damped 2nd-order filter with an acceleration cap, so the drone eases into
    // motion and brakes smoothly instead of snapping to a new tilt.
    const sm = this.smoothMul;
    const wv = 2.8 / sm;
    const aLim = this.rth ? 3 : (p.style === 'racer' ? 10 : 5.5);
    const jx = wv * wv * (vdx - this.vCmd.x) - 2 * wv * this.aCmd.x;
    const jz = wv * wv * (vdz - this.vCmd.z) - 2 * wv * this.aCmd.z;
    this.aCmd.x += jx * h; this.aCmd.z += jz * h;
    const acl = Math.hypot(this.aCmd.x, this.aCmd.z);
    if (acl > aLim) { this.aCmd.x *= aLim / acl; this.aCmd.z *= aLim / acl; }
    this.vCmd.x += this.aCmd.x * h; this.vCmd.z += this.aCmd.z * h;

    const kv = 2.2;
    const ex = this.vCmd.x - this.vel.x, ez = this.vCmd.z - this.vel.z;
    this.velInt.x = THREE.MathUtils.clamp(this.velInt.x + ex * h * 0.8, -5, 5);
    this.velInt.z = THREE.MathUtils.clamp(this.velInt.z + ez * h * 0.8, -5, 5);
    let ax = ex * kv + this.velInt.x + this.aCmd.x;
    let az = ez * kv + this.velInt.z + this.aCmd.z;
    const maxTilt = Math.min(p.maxAngle, 35) * DEG;
    const amax = G * Math.tan(maxTilt);
    const al = Math.hypot(ax, az);
    if (al > amax) { ax *= amax / al; az *= amax / al; }
    const aF = ax * fx + az * fz;
    const aR = ax * rx + az * rz;
    const pitch = Math.atan(aF / G);
    const roll = Math.atan(aR / G);
    this.attitudeToRates(-pitch, -roll, rateDes);
    rateDes.y += -sy * p.yawRate * DEG * 0.8;

    // Vertical: velocity PI -> thrust
    const azLim = 4 / sm;
    this.vzCmd += THREE.MathUtils.clamp(vdy - this.vzCmd, -azLim * h, azLim * h);
    const evz = this.vzCmd - this.vel.y;
    this.altInt = THREE.MathUtils.clamp(this.altInt + evz * h * 1.5, -4, 4);
    const ay = evz * 3.2 + this.altInt;
    const up = _v1.set(0, 1, 0).applyQuaternion(this.quat);
    const tilt = Math.max(0.5, up.y);
    let thrust = (p.mass * (G + ay)) / tilt;
    thrust = THREE.MathUtils.clamp(thrust, 0.15 * 4 * this.tMax, 4 * this.tMax);
    return { thrust, idle: false };
  }

  mix(T, tx, ty, tz, idle) {
    const d = this.armD, ky = this.p.kYaw;
    const a = tx / (4 * d), b = tz / (4 * d), c = ty / (4 * ky);
    const D = this.motorCmd;
    D[0] = a + b - c;
    D[1] = a - b + c;
    D[2] = -a - b - c;
    D[3] = -a + b + c;
    let mx = -Infinity, mn = Infinity;
    for (let i = 0; i < 4; i++) { mx = Math.max(mx, D[i]); mn = Math.min(mn, D[i]); }
    const range = mx - mn;
    const avail = this.tMax - idle;
    if (range > avail) {
      const s = avail / range;
      for (let i = 0; i < 4; i++) D[i] *= s;
      mx *= s; mn *= s;
    }
    const base = THREE.MathUtils.clamp(T / 4, idle - mn, this.tMax - mx);
    for (let i = 0; i < 4; i++) D[i] = THREE.MathUtils.clamp(base + D[i], 0, this.tMax);
  }

  handleContacts(h, totalThrust) {
    const p = this.p;
    const groundH = this.world.heightAt(this.pos.x, this.pos.z);
    const up = _v1.set(0, 1, 0).applyQuaternion(this.quat);

    // Water
    if (groundH < WATER_Y && this.pos.y < WATER_Y + 0.05) {
      if (!this.crashed) this.crash('Drone fell into the lake');
      this.inWater = true;
      this.pos.y = WATER_Y + 0.02;
      this.vel.multiplyScalar(Math.exp(-h * 4));
      this.vel.y = 0;
      this.omega.multiplyScalar(Math.exp(-h * 6));
      this.onGround = true;
      return;
    }

    // Obstacles
    const hit = this.world.collide(this.pos, 0.6 * p.armLength + p.propRadius * 0.6);
    if (hit.hit) {
      const vn = this.vel.dot(hit.normal);
      this.pos.addScaledVector(hit.normal, hit.depth + 0.001);
      if (vn < 0) {
        const impact = -vn;
        if (!this.crashed && impact > 2.5) this.crash(`Crashed into a ${hit.kind}`);
        this.vel.addScaledVector(hit.normal, -vn * 1.3);
        this.vel.multiplyScalar(0.7);
        // knock the drone around
        this.omega.x += (Math.random() - 0.5) * impact * 3;
        this.omega.z += (Math.random() - 0.5) * impact * 3;
      }
    }

    // Ground
    const bottom = this.pos.y - this.gear;
    if (bottom <= groundH) {
      const impact = -this.vel.y;
      this.pos.y = groundH + this.gear;
      if (!this.crashed && (impact > p.crashSpeed || (up.y < 0.35 && (impact > 0.5 || this.armed)))) {
        this.crash(impact > p.crashSpeed ? `Hard impact (${impact.toFixed(1)} m/s)` : 'Drone flipped over');
      }
      if (this.vel.y < 0) this.vel.y = this.crashed ? -this.vel.y * 0.15 : 0;
      const weight = p.mass * G;
      if (totalThrust < weight * 0.95 || this.crashed) {
        const f = Math.exp(-h * (this.crashed ? 3 : 10));
        this.vel.x *= f; this.vel.z *= f;
        if (!this.crashed) {
          // settle level on landing gear
          _e.setFromQuaternion(this.quat, 'YXZ');
          _q1.setFromAxisAngle(UP, _e.y);
          this.quat.slerp(_q1, Math.min(1, h * 10));
          this.omega.multiplyScalar(Math.exp(-h * 25));
        } else {
          this.omega.multiplyScalar(Math.exp(-h * 4));
        }
      }
      this.onGround = true;
    } else {
      this.onGround = bottom - groundH < 0.03;
    }
    this.inWater = false;
  }
}
