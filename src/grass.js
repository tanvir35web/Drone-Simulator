// GPU grass field around the camera: blades placed on the terrain in the vertex shader,
// swaying in the wind and pushed flat by the drone's rotor downwash.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

const QUALITY = [
  null,
  { radius: 22, spacing: 0.5 },
  { radius: 32, spacing: 0.44 },
  { radius: 44, spacing: 0.38 },
];

function makeTuft() {
  const rand = mulberry32(9);
  const pos = [], ys = [], idx = [];
  const BLADES = 4;
  const levels = [0, 0.45, 0.8, 1];
  for (let b = 0; b < BLADES; b++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.12;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const face = rand() * Math.PI;
    const fx = Math.cos(face), fz = Math.sin(face);
    const leanA = rand() * Math.PI * 2;
    const lean = 0.12 + rand() * 0.25;
    const lx = Math.cos(leanA) * lean, lz = Math.sin(leanA) * lean;
    const hb = 0.7 + rand() * 0.3;
    const w = 0.022 + rand() * 0.014;
    const start = pos.length / 3;
    levels.forEach((t, li) => {
      const cx = bx + lx * t * t, cz = bz + lz * t * t, cy = hb * t;
      if (li === levels.length - 1) {
        pos.push(cx, cy, cz); ys.push(t);
      } else {
        const ww = w * Math.pow(1 - t, 0.7);
        pos.push(cx - fx * ww, cy, cz - fz * ww, cx + fx * ww, cy, cz + fz * ww);
        ys.push(t, t);
      }
    });
    // two quads + tip triangle
    for (let s = 0; s < 2; s++) {
      const i0 = start + s * 2;
      idx.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
    idx.push(start + 4, start + 5, start + 6);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aY', new THREE.Float32BufferAttribute(ys, 1));
  g.setIndex(idx);
  return g;
}

export class GrassField {
  constructor(scene, world, maskData, maskSize) {
    this.world = world;
    this.scene = scene;
    this.level = 0;
    this.uniforms = {
      uOrigin: { value: new THREE.Vector2() },
      uCam: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uSpacing: { value: 0.44 },
      uRadius: { value: 32 },
      uHeights: { value: world.heightTexture },
      uMask: { value: null },
      uHalf: { value: world.half },
      uStep: { value: world.step },
      uSeg: { value: world.seg },
      uWind: { value: new THREE.Vector2(1, 0) },
      uWindAmt: { value: 0.3 },
      uDrone: { value: new THREE.Vector3(0, -1000, 0) },
      uWash: { value: 0 },
      uWashR: { value: 3 },
      uBase: { value: new THREE.Color(0x1f3009) },
      uTip: { value: new THREE.Color(0x7d8f34) },
    };
    const mask = new THREE.DataTexture(maskData, maskSize, maskSize, THREE.RedFormat, THREE.UnsignedByteType);
    mask.magFilter = THREE.LinearFilter;
    mask.minFilter = THREE.LinearFilter;
    mask.needsUpdate = true;
    this.uniforms.uMask.value = mask;

    this.geometry = makeTuft();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec2 aGrid;
          attribute float aY;
          uniform vec2 uOrigin; uniform vec3 uCam; uniform float uTime; uniform float uSpacing; uniform float uRadius;
          uniform sampler2D uHeights; uniform sampler2D uMask; uniform float uHalf; uniform float uStep; uniform float uSeg;
          uniform vec2 uWind; uniform float uWindAmt; uniform vec3 uDrone; uniform float uWash; uniform float uWashR;
          varying float vGY; varying float vTint;
          float ghash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float gH(ivec2 i){ return texelFetch(uHeights, clamp(i, ivec2(0), ivec2(int(uSeg))), 0).r; }
          float terrainH(vec2 p){
            vec2 f = clamp((p + uHalf) / uStep, vec2(0.0), vec2(uSeg - 0.001));
            ivec2 i = ivec2(floor(f)); vec2 t = f - floor(f);
            float ha = gH(i), hd = gH(i + ivec2(1, 0)), hb = gH(i + ivec2(0, 1)), hc = gH(i + ivec2(1, 1));
            return (t.x + t.y <= 1.0) ? ha + (hd - ha) * t.x + (hb - ha) * t.y
                                      : hc + (hb - hc) * (1.0 - t.x) + (hd - hc) * (1.0 - t.y);
          }`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          vec2 cellId = aGrid + floor(uOrigin / uSpacing);
          vec2 wp = cellId * uSpacing;
          float h1 = ghash(cellId), h2 = ghash(cellId + 17.31), h3 = ghash(cellId + 41.7);
          wp += (vec2(h1, h2) - 0.5) * uSpacing * 0.95;
          float dens = texture2D(uMask, (wp + uHalf) / (uHalf * 2.0)).r;
          float dist = length(wp - uCam.xz);
          float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius, dist);
          float sc = step(h3, dens * 1.15) * fade;
          float bladeH = (0.12 + h1 * 0.22) * (0.7 + 0.3 * dens);
          float ang = h2 * 6.2831;
          vec3 p = position;
          p.xz *= (0.8 + h3 * 0.6);
          p = vec3(p.x * cos(ang) - p.z * sin(ang), p.y, p.x * sin(ang) + p.z * cos(ang));
          p.y *= bladeH;
          float bend = aY * aY;
          float wv = sin(uTime * 1.6 + wp.x * 0.31 + wp.y * 0.19) * 0.6 + sin(uTime * 3.3 + wp.x * 0.83 - wp.y * 0.5) * 0.25;
          p.xz += uWind * (wv * 0.5 + 0.6) * uWindAmt * bend * 0.18;
          vec2 dd = wp - uDrone.xz;
          float dl = length(dd);
          float wash = uWash * (1.0 - smoothstep(0.0, uWashR, dl));
          float flutter = 0.65 + 0.35 * sin(uTime * 23.0 + h1 * 40.0);
          p.xz += (dd / max(dl, 0.05)) * wash * flutter * bend * 0.32;
          p.y *= 1.0 - wash * 0.45 * bend;
          p *= sc;
          vec3 transformed = vec3(wp.x + p.x, terrainH(wp) + p.y - 0.02, wp.y + p.z);
          vGY = aY; vTint = h1 * h3;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uBase; uniform vec3 uTip; varying float vGY; varying float vTint;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 gcol = mix(uBase, uTip, pow(vGY, 0.8));
          gcol = mix(gcol, gcol * vec3(1.35, 1.1, 0.55), vTint);
          diffuseColor.rgb *= gcol;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize(vNormal); nonPerturbedNormal = normal;`);
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  setQuality(level) {
    this.level = level;
    const q = QUALITY[level];
    if (!q) { this.mesh.visible = false; return; }
    const n = Math.ceil(q.radius / q.spacing);
    const grid = new Float32Array((2 * n + 1) * (2 * n + 1) * 2);
    let k = 0;
    for (let z = -n; z <= n; z++) for (let x = -n; x <= n; x++) {
      if (x * x + z * z > n * n) continue;
      grid[k++] = x; grid[k++] = z;
    }
    this.geometry.setAttribute('aGrid', new THREE.InstancedBufferAttribute(grid.slice(0, k), 2));
    this.geometry.instanceCount = k / 2;
    this.uniforms.uSpacing.value = q.spacing;
    this.uniforms.uRadius.value = q.radius;
  }

  /** cam: camera position, drone: {pos, thrustFrac, agl}, wind: Vector3 */
  update(time, cam, drone, wind) {
    if (!this.level) { this.mesh.visible = false; return; }
    const groundH = this.world.heightAt(cam.x, cam.z);
    const camAgl = cam.y - groundH;
    this.mesh.visible = camAgl < this.uniforms.uRadius.value * 1.6;
    const U = this.uniforms;
    U.uTime.value = time;
    U.uOrigin.value.set(cam.x, cam.z);
    U.uCam.value.copy(cam);
    const ws = Math.hypot(wind.x, wind.z);
    if (ws > 0.01) U.uWind.value.set(wind.x / ws, wind.z / ws);
    U.uWindAmt.value = Math.min(1.5, ws / 6);
    U.uDrone.value.copy(drone.pos);
    const aglFactor = 1 - THREE.MathUtils.smoothstep(drone.agl, 0.3, 4.5 * drone.size);
    U.uWash.value = Math.min(1, drone.thrustFrac * 2.2) * aglFactor;
    U.uWashR.value = (1.2 + drone.agl * 0.6) * drone.size;
  }
}
