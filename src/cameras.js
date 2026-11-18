// Multiple camera views: chase, FPV, gimbal, pilot line-of-sight, top-down, free orbit. Plus picture-in-picture.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PILOT_POS } from './world.js';

export const VIEWS = [
  { id: 'chase', name: 'Chase (3rd person)' },
  { id: 'fpv', name: 'FPV (onboard)' },
  { id: 'gimbal', name: 'Gimbal camera' },
  { id: 'pilot', name: 'Pilot line-of-sight' },
  { id: 'top', name: 'Top-down' },
  { id: 'orbit', name: 'Free orbit (mouse)' },
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const X_AXIS = new THREE.Vector3(1, 0, 0);

export class CameraRig {
  constructor(dom, world) {
    this.world = world;
    this.main = new THREE.PerspectiveCamera(65, 1, 0.03, 15000);
    this.pipCam = new THREE.PerspectiveCamera(90, 16 / 9, 0.03, 15000);
    this.current = 0;
    this.pipOn = false;
    this.gimbalPitch = -8 * Math.PI / 180;
    this.fpvTilt = 20 * Math.PI / 180;
    this.chaseDist = 1;
    this.topHeight = 45;
    this.pilotZoom = 1;
    this.pilotAutoZoom = true;
    this.state = new Map();
    this.orbit = new OrbitControls(this.main, dom);
    this.orbit.enabled = false;
    this.orbit.enableDamping = true;
    this.orbit.maxDistance = 400;
    this.orbit.minDistance = 0.6;
    this.orbitLast = new THREE.Vector3();
    this.shake = 0;

    dom.addEventListener('wheel', (e) => {
      const id = VIEWS[this.current].id;
      const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      if (id === 'chase') this.chaseDist = THREE.MathUtils.clamp(this.chaseDist * f, 0.5, 6);
      else if (id === 'top') this.topHeight = THREE.MathUtils.clamp(this.topHeight * f, 8, 600);
      else if (id === 'pilot') { this.pilotAutoZoom = false; this.pilotZoom = THREE.MathUtils.clamp(this.pilotZoom / f, 0.5, 8); }
    }, { passive: true });
  }

  get view() { return VIEWS[this.current]; }

  setView(i, drone) {
    this.current = (i + VIEWS.length) % VIEWS.length;
    const id = VIEWS[this.current].id;
    this.orbit.enabled = id === 'orbit';
    if (id === 'orbit') {
      const p = drone.pos;
      this.main.up.set(0, 1, 0);
      this.main.position.copy(p).add(_v.set(4, 2, 5));
      this.orbit.target.copy(p);
      this.orbitLast.copy(p);
      this.orbit.update();
    }
    if (id === 'pilot') this.pilotAutoZoom = true;
  }

  st(view, cam) {
    const key = view + cam.uuid;
    let s = this.state.get(key);
    if (!s) { s = { pos: null, look: null, yaw: null }; this.state.set(key, s); }
    return s;
  }

  pipViewId() {
    return VIEWS[this.current].id === 'fpv' ? 'chase' : 'fpv';
  }

  update(dt, drone, model, scale) {
    this.applyView(VIEWS[this.current].id, this.main, dt, drone, model, scale);
    if (this.pipOn) this.applyView(this.pipViewId(), this.pipCam, dt, drone, model, scale);
  }

  applyView(id, cam, dt, drone, model, scale) {
    const p = drone.pos, q = drone.quat;
    const s = this.st(id, cam);
    cam.up.set(0, 1, 0);
    let fov = 65;
    switch (id) {
      case 'chase': {
        // Heading follows the drone's yaw through a critically damped spring (no snapping)
        const fwd = _v.set(0, 0, -1).applyQuaternion(q);
        fwd.y = 0;
        const yawT = fwd.lengthSq() > 0.01 ? Math.atan2(-fwd.x, -fwd.z) : (s.yaw ?? 0);
        if (s.yaw === null || s.yaw === undefined) { s.yaw = yawT; s.yawV = 0; }
        let dyaw = yawT - s.yaw;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        const wy = 4.5;
        s.yawV += (wy * wy * dyaw - 2 * wy * s.yawV) * dt;
        s.yaw += s.yawV * dt;
        const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);

        // Close follow distance so the drone fills more of the frame (mouse wheel zooms)
        const arm = drone.p.armLength;
        const dist = (0.55 + arm * 4.2) * this.chaseDist;
        const hgt = (0.12 + arm * 1.3) * this.chaseDist;
        const desired = _v2.set(p.x - fx * dist, p.y + hgt, p.z - fz * dist);
        desired.addScaledVector(drone.vel, -0.045); // slight lag conveys speed
        if (!s.pos) { s.pos = desired.clone(); s.vel = new THREE.Vector3(); s.look = p.clone(); s.lookV = new THREE.Vector3(); }
        const look = _v3.set(p.x + fx * arm * 2.5, p.y + arm * 0.55, p.z + fz * arm * 2.5);
        const steps = Math.max(1, Math.ceil(dt / 0.008));
        const hs = dt / steps;
        const wp = 9, wl = 16;
        for (let i = 0; i < steps; i++) {
          s.vel.x += (wp * wp * (desired.x - s.pos.x) - 2 * wp * s.vel.x) * hs;
          s.vel.y += (wp * wp * (desired.y - s.pos.y) - 2 * wp * s.vel.y) * hs;
          s.vel.z += (wp * wp * (desired.z - s.pos.z) - 2 * wp * s.vel.z) * hs;
          s.pos.addScaledVector(s.vel, hs);
          s.lookV.x += (wl * wl * (look.x - s.look.x) - 2 * wl * s.lookV.x) * hs;
          s.lookV.y += (wl * wl * (look.y - s.look.y) - 2 * wl * s.lookV.y) * hs;
          s.lookV.z += (wl * wl * (look.z - s.look.z) - 2 * wl * s.lookV.z) * hs;
          s.look.addScaledVector(s.lookV, hs);
        }
        const gh = this.world.heightAt(s.pos.x, s.pos.z) + 0.3;
        if (s.pos.y < gh) { s.pos.y = gh; s.vel.y = Math.max(0, s.vel.y); }
        cam.position.copy(s.pos);
        cam.lookAt(s.look);
        fov = 60;
        break;
      }
      case 'fpv': {
        cam.position.copy(_v.fromArray(drone.p.fpvCam).applyQuaternion(q).add(p));
        cam.quaternion.copy(q).multiply(_q.setFromAxisAngle(X_AXIS, this.fpvTilt));
        if (this.shake > 0) {
          const a = this.shake * 0.004;
          _e.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
          cam.quaternion.multiply(_q.setFromEuler(_e));
        }
        fov = 100;
        break;
      }
      case 'gimbal': {
        cam.position.copy(_v.fromArray(drone.p.gimbalCam).applyQuaternion(q).add(p));
        _e.setFromQuaternion(q, 'YXZ');
        if (s.yaw === null) s.yaw = _e.y;
        let dy = _e.y - s.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        s.yaw += dy * (1 - Math.exp(-dt * 5));
        _e.set(this.gimbalPitch, s.yaw, 0, 'YXZ');
        cam.quaternion.setFromEuler(_e);
        fov = 55;
        break;
      }
      case 'pilot': {
        cam.position.copy(PILOT_POS);
        if (!s.look) s.look = p.clone();
        s.look.lerp(p, 1 - Math.exp(-dt * 12));
        cam.lookAt(s.look);
        const dist = PILOT_POS.distanceTo(p);
        if (this.pilotAutoZoom) {
          fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5 / Math.max(dist, 0.1))), 14, 65);
        } else fov = 60 / this.pilotZoom;
        break;
      }
      case 'top': {
        if (!s.pos) s.pos = p.clone();
        s.pos.lerp(p, 1 - Math.exp(-dt * 6));
        cam.position.set(s.pos.x, s.pos.y + this.topHeight, s.pos.z + 0.001);
        cam.up.set(0, 0, -1);
        cam.lookAt(s.pos);
        fov = 55;
        break;
      }
      case 'orbit': {
        if (cam === this.main) {
          const delta = _v.copy(p).sub(this.orbitLast);
          cam.position.add(delta);
          this.orbit.target.copy(p);
          this.orbitLast.copy(p);
          this.orbit.update();
          const gh = this.world.heightAt(cam.position.x, cam.position.z) + 0.3;
          if (cam.position.y < gh) cam.position.y = gh;
        }
        fov = 60;
        break;
      }
    }
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}
