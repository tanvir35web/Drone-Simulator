// World: terrain, water, sky, lighting, town, trees, traffic, race gates and collision queries.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeSimplex2D, fbm, smoothstep, lerp, mulberry32 } from './noise.js';
import * as TX from './textures.js';
import * as HD from './texturesHD.js';

export const SIZE = 3000;
const SEG = 600;
const N = SEG + 1;
const STEP = SIZE / SEG;
const HALF = SIZE / 2;
export const TOWN_H = 2.0;
export const WATER_Y = 0.0;
export const LAKE = { x: 560, z: -120, r: 190 };
export const HOME = new THREE.Vector3(0, TOWN_H, 0);
export const PILOT_POS = new THREE.Vector3(0, TOWN_H + 1.7, 11);
const ROADS = [-200, -120, -40, 40, 120, 200];
const TOWN_EDGE = 240;
const ROAD_HALF = 6;
const TREE_TILE = 375;

const nA = makeSimplex2D(101);
const nB = makeSimplex2D(202);
const nC = makeSimplex2D(303);
const nD = makeSimplex2D(404);
const nE = makeSimplex2D(505);
const nF = makeSimplex2D(606);

function lakeFactor(x, z) {
  const ang = Math.atan2(z - LAKE.z, x - LAKE.x);
  const wobble = 1 + 0.22 * nF(Math.cos(ang) * 1.3 + 7, Math.sin(ang) * 1.3 + 7);
  const ld = Math.hypot(x - LAKE.x, z - LAKE.z) / (LAKE.r * wobble);
  return 1 - smoothstep(0.55, 1.25, ld);
}

function computeHeight(x, z) {
  const d = Math.max(Math.abs(x), Math.abs(z));
  const r = Math.hypot(x, z);
  let h = fbm(nA, x * 0.0016, z * 0.0016, 6) * 55 + 22;
  const ridgeN = 1 - Math.abs(fbm(nB, x * 0.0009, z * 0.0009, 5));
  const far = smoothstep(450, 1350, r);
  h += far * (ridgeN * ridgeN * 280 + 40);
  if (h < 5) h = 5 - (5 - h) * 0.2;
  const town = 1 - smoothstep(280, 430, d);
  h = lerp(h, TOWN_H, town);
  const lake = lakeFactor(x, z);
  h = lerp(h, -10, lake);
  return h;
}

export function forestDensity(x, z) {
  return smoothstep(0.05, 0.4, fbm(nE, x * 0.0025, z * 0.0025, 4));
}

/** Makes double-sided foliage keep its outward normal on both faces (soft, volumetric look). */
function keepNormal(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n normal = normalize(vNormal); nonPerturbedNormal = normal;');
  };
  return mat;
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.heights = new Float32Array(N * N);
    this.grassGrid = new Float32Array(N * N);
    this.buildings = [];
    this.treeGrid = new Map();
    this.trees = [];
    this.gates = [];
    this.time = 0;
    this.sunDir = new THREE.Vector3();
    this.night = 0;
    this.half = HALF; this.step = STEP; this.seg = SEG;
    this._hit = { hit: false, depth: 0, normal: new THREE.Vector3(), kind: '' };

    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        this.heights[iz * N + ix] = computeHeight(-HALF + ix * STEP, -HALF + iz * STEP);
      }
    }
    this.heightTexture = new THREE.DataTexture(this.heights, N, N, THREE.RedFormat, THREE.FloatType);
    this.heightTexture.minFilter = this.heightTexture.magFilter = THREE.NearestFilter;
    this.heightTexture.needsUpdate = true;

    this.buildSkyAndLights();
    this.buildTerrain();
    this.buildWater();
    this.buildTown();
    this.buildStreetProps();
    this.buildTrees();
    this.buildGates();
    this.buildMinimap();
    this.setTimeOfDay(38, 135);
  }

  // ---------- height queries ----------
  heightAt(x, z) {
    let fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    fx = Math.min(Math.max(fx, 0), SEG - 0.0001);
    fz = Math.min(Math.max(fz, 0), SEG - 0.0001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const H = this.heights;
    const ha = H[iz * N + ix], hd = H[iz * N + ix + 1];
    const hb = H[(iz + 1) * N + ix], hc = H[(iz + 1) * N + ix + 1];
    if (tx + tz <= 1) return ha + (hd - ha) * tx + (hb - ha) * tz;
    return hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  }

  slopeAt(x, z) {
    const e = 2;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  // ---------- sky / lighting ----------
  buildSkyAndLights() {
    const scene = this.scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    u.cloudCoverage.value = 0.35;
    u.cloudDensity.value = 0.5;
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.material = this.sky.material;
    this.envSky.scale.setScalar(10000);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = null;

    scene.fog = new THREE.FogExp2(0xb8c8d8, 0.00028);

    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x4a5a32, 0.5);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80;
    sc.near = 1; sc.far = 1200;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun);
    scene.add(this.sun.target);
  }

  setShadowQuality(level) {
    this.sun.castShadow = level > 0;
    if (level > 0) {
      const s = [0, 1024, 2048, 4096][level];
      if (this.sun.shadow.mapSize.x !== s) {
        this.sun.shadow.mapSize.set(s, s);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
  }

  setTimeOfDay(elevationDeg, azimuthDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);

    const day = smoothstep(-4, 12, elevationDeg);
    const golden = 1 - smoothstep(4, 25, elevationDeg);
    this.night = 1 - smoothstep(-3, 6, elevationDeg);

    const sunCol = new THREE.Color(1, 0.97, 0.92).lerp(new THREE.Color(1.0, 0.6, 0.34), golden * 0.9);
    this.sun.color.copy(sunCol);
    this.sun.intensity = 2.8 * day * (elevationDeg > -1 ? 1 : 0);
    this.hemi.intensity = 0.12 + 0.38 * day;

    const fogDay = new THREE.Color(0xbfd0e0);
    const fogGold = new THREE.Color(0xd8b394);
    const fogNight = new THREE.Color(0x0c1220);
    const fc = fogDay.clone().lerp(fogGold, golden * 0.7).lerp(fogNight, this.night);
    this.scene.fog.color.copy(fc);
    this.scene.environmentIntensity = 0.2 + 0.4 * day;

    if (this.water) this.water.material.uniforms.sunDirection.value.copy(this.sunDir).normalize();
    if (this.buildingMat) this.buildingMat.userData.uNight.value = this.night;
    if (this.lampHeadMat) this.lampHeadMat.emissiveIntensity = 0.05 + this.night * 6;

    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
  }

  // ---------- terrain (texture splatting) ----------
  buildTerrain() {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    geo.deleteAttribute('uv');
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.heights[i]);
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;

    const tint = new Float32Array(pos.count * 3);
    const splat = new Float32Array(pos.count * 4);
    const snowA = new Float32Array(pos.count);
    this.colorGrid = new Float32Array(N * N * 3);
    const mapCols = { grass: [70, 90, 36], dirt: [104, 86, 60], rock: [118, 112, 104], sand: [190, 172, 132], snow: [236, 240, 248] };

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = pos.getY(i);
      const ny = nrm.getY(i);
      const v = fbm(nC, x * 0.012, z * 0.012, 3) * 0.5 + 0.5;
      const dryAmt = smoothstep(0.55, 0.85, fbm(nD, x * 0.004, z * 0.004, 3) * 0.5 + 0.5);
      const town = 1 - smoothstep(260, 320, Math.max(Math.abs(x), Math.abs(z)));
      const forest = forestDensity(x, z) * (1 - town);
      const lake = lakeFactor(x, z);

      let wG = 1;
      let wD = dryAmt * 0.3 + forest * 0.5 + smoothstep(0.97, 0.86, ny) * 0.7;
      let wR = Math.max(smoothstep(0.86, 0.68, ny), smoothstep(150, 240, h) * 0.8) * 2.5;
      let wS = 0;
      if (lake > 0.02) {
        wS = smoothstep(4.5, 1.0, h) * smoothstep(0.02, 0.2, lake) * 3;
        wD += smoothstep(0.5, -3, h) * 3;
      }
      wD *= 1 - town * 0.9;
      const snow = smoothstep(230, 275, h + v * 30) * smoothstep(0.62, 0.85, ny);
      const sum = wG + wD + wR + wS;
      splat[i * 4] = wG / sum; splat[i * 4 + 1] = wD / sum; splat[i * 4 + 2] = wR / sum; splat[i * 4 + 3] = wS / sum;
      snowA[i] = snow;
      this.grassGrid[i] = (wG / sum) * (1 - snow) * (h > 0.6 ? 1 : 0) * (1 - smoothstep(0.85, 0.7, ny));

      // colour tint: dry patches yellower, forest floor darker, lawns lush
      let tr = 1, tg = 1, tb = 1;
      const dry = dryAmt * 0.55 * (1 - town);
      tr += dry * 0.25; tg += dry * 0.05; tb -= dry * 0.3;
      tr -= forest * 0.18; tg -= forest * 0.1; tb -= forest * 0.15;
      tg += town * 0.06;
      const vv = 0.9 + v * 0.2;
      if (h < 0) { tr *= 0.65; tg *= 0.65; tb *= 0.6; }
      tint[i * 3] = tr * vv; tint[i * 3 + 1] = tg * vv; tint[i * 3 + 2] = tb * vv;

      // minimap colour (sRGB 0..1)
      const w = [splat[i * 4], splat[i * 4 + 1], splat[i * 4 + 2], splat[i * 4 + 3]];
      const keys = ['grass', 'dirt', 'rock', 'sand'];
      for (let ch = 0; ch < 3; ch++) {
        let cval = 0;
        for (let k = 0; k < 4; k++) cval += mapCols[keys[k]][ch] * w[k];
        cval = cval * (1 - snow) + mapCols.snow[ch] * snow;
        this.colorGrid[i * 3 + ch] = Math.min(1, (cval / 255) * [tr, tg, tb][ch] * vv);
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(tint, 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
    geo.setAttribute('snow', new THREE.BufferAttribute(snowA, 1));

    const r = this.renderer;
    const tex = {
      tGrass: { value: HD.makeGrassAlbedo(r) },
      tDirt: { value: HD.makeDirtAlbedo(r) },
      tRock: { value: HD.makeRockAlbedo(r) },
      tSand: { value: HD.makeSandAlbedo(r) },
      tSnow: { value: HD.makeSnowAlbedo(r) },
      tMacro: { value: HD.makeMacroNoise(r) },
    };
    this.macroTex = tex.tMacro.value;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, tex);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 splat; attribute float snow;
          varying vec4 vSplat; varying float vSnow; varying vec3 vTPos; varying vec3 vTNrm;`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vSplat = splat; vSnow = snow;
          vTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vTNrm = normalize(mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tGrass, tDirt, tRock, tSand, tSnow, tMacro;
          varying vec4 vSplat; varying float vSnow; varying vec3 vTPos; varying vec3 vTNrm;
          vec3 antiTile(sampler2D t, vec2 uv) {
            vec3 a = texture2D(t, uv).rgb;
            vec3 b = texture2D(t, uv * 0.37 + vec2(0.31, 0.17)).rgb;
            float k = texture2D(tMacro, uv * 0.031).r;
            return mix(a, b, smoothstep(0.38, 0.62, k));
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          vec3 tn = normalize(vTNrm);
          vec2 wxz = vTPos.xz;
          float m1 = texture2D(tMacro, wxz * 0.0021).r;
          float m2 = texture2D(tMacro, wxz * 0.019).r;
          vec3 cG = antiTile(tGrass, wxz * 0.17);
          vec3 cD = antiTile(tDirt, wxz * 0.21);
          vec3 cS = antiTile(tSand, wxz * 0.15);
          vec3 cN = texture2D(tSnow, wxz * 0.09).rgb;
          vec3 bw = pow(abs(tn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
          vec3 cR = texture2D(tRock, vTPos.zy * 0.055).rgb * bw.x
                  + texture2D(tRock, vTPos.xz * 0.055).rgb * bw.y
                  + texture2D(tRock, vTPos.xy * 0.055).rgb * bw.z;
          vec4 w = vSplat;
          w.y *= 0.45 + m2 * 1.1;
          w.z *= 0.6 + m2 * 0.8;
          w = w * w * w;
          w /= max(dot(w, vec4(1.0)), 1e-4);
          vec3 alb = cG * w.x + cD * w.y + cR * w.z + cS * w.w;
          alb = mix(alb, cN, smoothstep(0.35, 0.65, vSnow + (m2 - 0.5) * 0.5));
          alb *= mix(0.8, 1.12, m1);
          diffuseColor.rgb *= alb;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.55, smoothstep(0.4, 0.8, vSnow));`);
    };
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  // ---------- water ----------
  buildWater() {
    const geo = new THREE.CircleGeometry(LAKE.r * 1.9, 96);
    geo.rotateX(-Math.PI / 2);
    const normals = TX.makeWaterNormals(this.renderer);
    this.water = new Water(geo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(0.5, 0.7, 0.3),
      sunColor: 0xffffff,
      waterColor: 0x0e3b47,
      distortionScale: 2.2,
      fog: true,
    });
    this.water.material.uniforms.size.value = 2.5;
    this.water.position.set(LAKE.x, WATER_Y, LAKE.z);
    this.scene.add(this.water);

    const simpleNormals = normals.clone();
    simpleNormals.repeat.set(40, 40);
    simpleNormals.needsUpdate = true;
    this.simpleWater = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x123f4c, roughness: 0.08, metalness: 0.1,
      normalMap: simpleNormals, normalScale: new THREE.Vector2(0.3, 0.3),
    }));
    this.simpleWater.position.copy(this.water.position);
    this.simpleWater.visible = false;
    this.scene.add(this.simpleWater);
  }

  setWaterReflections(on) {
    this.water.visible = on;
    this.simpleWater.visible = !on;
  }

  // ---------- town ----------
  buildTown() {
    const roadTex = TX.makeRoadTexture(this.renderer);
    roadTex.repeat.set((TOWN_EDGE * 2) / 24, 1);
    const roadMat = new THREE.MeshStandardMaterial({
      map: roadTex, roughness: 0.88, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const roadGeo = new THREE.PlaneGeometry(TOWN_EDGE * 2 + ROAD_HALF * 2, ROAD_HALF * 2);
    roadGeo.rotateX(-Math.PI / 2);
    ROADS.forEach((r, i) => {
      const a = new THREE.Mesh(roadGeo, roadMat);
      a.position.set(0, TOWN_H + 0.004, r);
      a.receiveShadow = true;
      this.scene.add(a);
      const b = new THREE.Mesh(roadGeo, roadMat);
      b.rotation.y = Math.PI / 2;
      b.position.set(r, TOWN_H + 0.006 + i * 0.0002, 0);
      b.receiveShadow = true;
      this.scene.add(b);
    });

    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: TX.makeHelipadTexture(this.renderer), roughness: 0.85,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
    );
    pad.position.set(0, TOWN_H + 0.009, 0);
    pad.receiveShadow = true;
    this.scene.add(pad);

    // Lots
    const rand = mulberry32(777);
    const edges = [-TOWN_EDGE, ...ROADS, TOWN_EDGE];
    const lots = [];
    this.parkBlocks = [];
    for (let bi = 0; bi < edges.length - 1; bi++) {
      for (let bj = 0; bj < edges.length - 1; bj++) {
        const x0 = edges[bi] + (bi === 0 ? 2 : ROAD_HALF + 2);
        const x1 = edges[bi + 1] - (bi === edges.length - 2 ? 2 : ROAD_HALF + 2);
        const z0 = edges[bj] + (bj === 0 ? 2 : ROAD_HALF + 2);
        const z1 = edges[bj + 1] - (bj === edges.length - 2 ? 2 : ROAD_HALF + 2);
        const central = x0 < 0 && x1 > 0 && z0 < 0 && z1 > 0;
        if (central || rand() < 0.1) { this.parkBlocks.push({ x0, x1, z0, z1, central }); continue; }
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const downtown = Math.exp(-Math.hypot(cx - 150, cz + 150) / 130);
        const nx = x1 - x0 > 50 ? 2 : 1, nz = z1 - z0 > 50 ? 2 : 1;
        const lw = (x1 - x0) / nx, ld = (z1 - z0) / nz;
        for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
          if (rand() > 0.88) continue;
          const w = lw * (0.6 + rand() * 0.32), dp = ld * (0.6 + rand() * 0.32);
          const lx = x0 + lw * a + lw / 2 + (rand() - 0.5) * (lw - w);
          const lz = z0 + ld * b + ld / 2 + (rand() - 0.5) * (ld - dp);
          const h = 7 + rand() * 14 + downtown * (20 + rand() * 90);
          // facade style: 0 punched windows, 1 glass curtain wall, 2 ribbon windows
          const style = h > 45 ? (rand() < 0.65 ? 1 : 2) : (rand() < 0.7 ? 0 : 2);
          lots.push({ x: lx, z: lz, w, d: dp, h, style, floorH: 3.0 + rand() * 0.8, colW: 2.6 + rand() * 1.4 });
        }
      }
    }

    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const styleAttr = new THREE.InstancedBufferAttribute(new Float32Array(lots.length * 3), 3);
    lots.forEach((l, i) => styleAttr.setXYZ(i, l.floorH, l.colW, l.style));
    geo.setAttribute('aStyle', styleAttr);

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.02 });
    const uNight = { value: 0 };
    mat.userData.uNight = uNight;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = uNight;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aStyle;\nvarying vec3 vStyle;\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vec4 wp4 = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp4 = instanceMatrix * wp4;
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWPos = (modelMatrix * wp4).xyz;
          vWNorm = normalize(mat3(modelMatrix) * wn);
          vStyle = aStyle;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uNight;
          varying vec3 vStyle;
          varying vec3 vWPos;
          varying vec3 vWNorm;
          float bhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float isWall = 1.0 - step(0.5, abs(vWNorm.y));
          vec2 fc = abs(vWNorm.x) > 0.5 ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y);
          vec2 cell = fc / vec2(vStyle.y, vStyle.x);
          vec2 fr = fract(cell);
          vec4 bnd = vStyle.z < 0.5 ? vec4(0.2, 0.8, 0.26, 0.82)
                   : (vStyle.z < 1.5 ? vec4(0.03, 0.97, 0.06, 0.94) : vec4(0.015, 0.985, 0.34, 0.86));
          float win = step(bnd.x, fr.x) * step(fr.x, bnd.y) * step(bnd.z, fr.y) * step(fr.y, bnd.w);
          float floorH = vWPos.y - ${TOWN_H.toFixed(1)};
          float ground = 1.0 - step(4.2, floorH);
          win *= isWall * (1.0 - ground);
          // window recess: darker rim inside each opening
          float ex = min(fr.x - bnd.x, bnd.y - fr.x) * vStyle.y;
          float ey = min(fr.y - bnd.z, bnd.w - fr.y) * vStyle.x;
          float rim = win * (1.0 - smoothstep(0.0, 0.09, min(ex, ey)));
          float slab = isWall * (1.0 - ground) * (1.0 - step(0.07, fr.y));
          float rnd = bhash(floor(cell) + floor(vWPos.xz * 0.01));
          vec3 glass = vStyle.z > 0.5 && vStyle.z < 1.5
            ? mix(vec3(0.08, 0.13, 0.17), vec3(0.18, 0.27, 0.32), rnd * 0.5)
            : mix(vec3(0.06, 0.07, 0.08), vec3(0.24, 0.27, 0.3), rnd);
          // ground floor shopfronts
          float shop = isWall * ground * step(0.6, floorH) * step(floorH, 3.6) * step(0.08, fr.x) * step(fr.x, 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.06, 0.06), shop);
          diffuseColor.rgb *= 1.0 - rim * 0.6;
          diffuseColor.rgb *= 1.0 - slab * 0.18;
          diffuseColor.rgb *= mix(1.0, 0.72, isWall * ground * (1.0 - shop));
          diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.0, 6.0, floorH));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.2, 0.21), step(0.5, vWNorm.y));
          float glassy = max(win * (1.0 - rim), shop);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.05, glassy);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
          metalnessFactor = mix(metalnessFactor, 0.85, glassy);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          float lit = step(0.5, bhash(floor(cell) * 1.7 + 3.1));
          totalEmissiveRadiance += (win * lit + shop) * uNight * vec3(1.0, 0.78, 0.5) * 1.8;`);
    };
    this.buildingMat = mat;

    const palette = [0xb7b2a6, 0xa59e90, 0xcfc8b8, 0x8f8a84, 0x9aa3ab, 0xc4b59d, 0x7d8690, 0xd6d2c8, 0xa88f78, 0x8c6f5c, 0x6f7a80];
    const inst = new THREE.InstancedMesh(geo, mat, lots.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    lots.forEach((l, i) => {
      m.makeScale(l.w, l.h, l.d);
      m.setPosition(l.x, TOWN_H, l.z);
      inst.setMatrixAt(i, m);
      col.setHex(l.style === 1 ? 0x5d6870 : palette[Math.floor(rand() * palette.length)], THREE.SRGBColorSpace);
      inst.setColorAt(i, col);
      this.buildings.push({
        minX: l.x - l.w / 2, maxX: l.x + l.w / 2,
        minZ: l.z - l.d / 2, maxZ: l.z + l.d / 2,
        minY: TOWN_H - 1, maxY: TOWN_H + l.h + 1.2,
      });
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    this.scene.add(inst);
    this.buildingMesh = inst;

    // Roof parapet / cornice and rooftop plant
    const capGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const caps = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.85 }), lots.length);
    const roofs = new THREE.InstancedMesh(capGeo, new THREE.MeshStandardMaterial({ color: 0x9a9a96, roughness: 0.5, metalness: 0.5 }), lots.length * 3);
    let k = 0;
    lots.forEach((l, i) => {
      m.makeScale(l.w + 0.5, 0.9, l.d + 0.5);
      m.setPosition(l.x, TOWN_H + l.h - 0.3, l.z);
      caps.setMatrixAt(i, m);
      for (let j = 0; j < 3; j++) {
        const sx = 1.2 + rand() * 3.5, sz = 1.2 + rand() * 3.5, sy = 0.8 + rand() * (j === 0 ? 3 : 1.5);
        m.makeScale(sx, sy, sz);
        m.setPosition(l.x + (rand() - 0.5) * Math.max(0, l.w - sx - 2), TOWN_H + l.h, l.z + (rand() - 0.5) * Math.max(0, l.d - sz - 2));
        roofs.setMatrixAt(k++, m);
      }
    });
    caps.castShadow = caps.receiveShadow = true;
    roofs.castShadow = roofs.receiveShadow = true;
    this.scene.add(caps, roofs);
    this.lots = lots;
  }

  // ---------- parked cars and street lamps ----------
  buildStreetProps() {
    const rand = mulberry32(4242);
    const cars = [];
    const nearCrossing = (s) => ROADS.some((q) => Math.abs(q - s) < ROAD_HALF + 5);
    for (const r of ROADS) {
      for (const along of ['x', 'z']) {
        for (const side of [-1, 1]) {
          let s = -TOWN_EDGE + 4 + rand() * 6;
          while (s < TOWN_EDGE - 4) {
            if (!nearCrossing(s) && rand() < 0.55) {
              const off = r + side * 3.85;
              const x = along === 'x' ? s : off;
              const z = along === 'x' ? off : s;
              const rot = (along === 'x' ? Math.PI / 2 : 0) + (side > 0 ? Math.PI : 0);
              cars.push({ x, z, rot, len: 4.0 + rand() * 0.8, color: rand() });
            }
            s += 5.6 + rand() * 6;
          }
        }
      }
    }
    // car = body + cabin glass + wheels (unit length 4.3 m)
    const body = mergeGeometries([
      new RoundedBoxGeometry(1.8, 0.6, 4.3, 3, 0.16).translate(0, 0.58, 0),
      new RoundedBoxGeometry(1.62, 0.3, 2.1, 3, 0.12).translate(0, 0.98, 0.25),
    ]);
    const glass = new RoundedBoxGeometry(1.58, 0.46, 2.0, 3, 0.16).translate(0, 1.1, 0.25);
    const wheelParts = [];
    for (const [wx, wz] of [[0.76, 1.35], [-0.76, 1.35], [0.76, -1.4], [-0.76, -1.4]]) {
      wheelParts.push(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateZ(Math.PI / 2).translate(wx, 0.33, wz));
    }
    const wheels = mergeGeometries(wheelParts);
    const lights = mergeGeometries([
      new THREE.BoxGeometry(0.35, 0.1, 0.05).translate(0.6, 0.72, -2.15),
      new THREE.BoxGeometry(0.35, 0.1, 0.05).translate(-0.6, 0.72, -2.15),
    ]);
    const bodyMat = new THREE.MeshPhysicalMaterial({ roughness: 0.32, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.08 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0b0f14, roughness: 0.04, metalness: 0.6 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.85 });
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xff2a1a, emissive: 0x550000, roughness: 0.3 });
    const meshes = [body, glass, wheels, lights].map((g, i) => {
      const im = new THREE.InstancedMesh(g, [bodyMat, glassMat, wheelMat, lightMat][i], cars.length);
      im.castShadow = true; im.receiveShadow = true;
      return im;
    });
    const carCols = [0xe8e8e8, 0x1b1c1e, 0x9ea3a8, 0x8a1c1c, 0x1d3f74, 0x5a5f63, 0xd9d2c0, 0x2e4d3a, 0xb8860b];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    cars.forEach((car, i) => {
      q.setFromAxisAngle(up, car.rot);
      p.set(car.x, TOWN_H + 0.02, car.z);
      sc.set(1, 1, car.len / 4.3);
      m.compose(p, q, sc);
      meshes.forEach((im) => im.setMatrixAt(i, m));
      meshes[0].setColorAt(i, c.setHex(carCols[Math.floor(car.color * carCols.length)], THREE.SRGBColorSpace));
      const hx = car.rot % Math.PI === 0 ? 0.9 : car.len / 2;
      const hz = car.rot % Math.PI === 0 ? car.len / 2 : 0.9;
      this.buildings.push({ minX: car.x - hx, maxX: car.x + hx, minZ: car.z - hz, maxZ: car.z + hz, minY: TOWN_H - 1, maxY: TOWN_H + 1.45 });
    });
    meshes.forEach((im) => { im.computeBoundingSphere(); this.scene.add(im); });

    // Street lamps
    const lamps = [];
    for (const r of ROADS) {
      let i = 0;
      for (let s = -TOWN_EDGE + 15; s < TOWN_EDGE; s += 32) {
        if (nearCrossing(s)) continue;
        const side = i++ % 2 ? 1 : -1;
        // local -z is the arm direction; point it back toward the road centre line
        lamps.push({ x: s, z: r + side * (ROAD_HALF - 0.45), rot: side > 0 ? 0 : Math.PI });
        lamps.push({ x: r + side * (ROAD_HALF - 0.45), z: s, rot: side > 0 ? Math.PI / 2 : -Math.PI / 2 });
      }
    }
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.11, 7.5, 8).translate(0, 3.75, 0),
      new THREE.CylinderGeometry(0.05, 0.05, 1.6, 6).rotateX(Math.PI / 2).translate(0, 7.35, -0.75),
    ]);
    const headGeo = new THREE.BoxGeometry(0.35, 0.12, 0.7).translate(0, 7.3, -1.5);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d40, roughness: 0.5, metalness: 0.7 });
    this.lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffd9a0, emissiveIntensity: 0.05, roughness: 0.3 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length);
    const heads = new THREE.InstancedMesh(headGeo, this.lampHeadMat, lamps.length);
    lamps.forEach((l, i) => {
      // arm points from the kerb toward the road centre
      q.setFromAxisAngle(up, l.rot);
      p.set(l.x, TOWN_H, l.z);
      m.compose(p, q, sc.set(1, 1, 1));
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      this.addTreeCollider({ x: l.x, z: l.z, y: TOWN_H, trunkR: 0.12, crownR: 0.12, crownY0: TOWN_H + 7.6, top: TOWN_H + 7.6 });
    });
    poles.castShadow = heads.castShadow = true;
    poles.computeBoundingSphere(); heads.computeBoundingSphere();
    this.scene.add(poles, heads);
  }

  addTreeCollider(t) {
    this.trees.push(t);
    const key = this.cellKey(t.x, t.z);
    if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
    this.treeGrid.get(key).push(t);
  }

  // ---------- trees ----------
  buildTreeGeometries() {
    const rand = mulberry32(31);
    // Deciduous
    const trunkParts = [new THREE.CylinderGeometry(0.028, 0.055, 0.62, 7).translate(0, 0.31, 0)];
    for (let b = 0; b < 4; b++) {
      const a = (b / 4) * Math.PI * 2 + rand();
      const g = new THREE.CylinderGeometry(0.01, 0.022, 0.32, 5).translate(0, 0.16, 0);
      g.rotateZ(0.7 + rand() * 0.3).rotateY(a).translate(0, 0.42 + rand() * 0.12, 0);
      trunkParts.push(g);
    }
    const decTrunk = mergeGeometries(trunkParts);
    const center = new THREE.Vector3(0, 0.74, 0);
    const cards = [];
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    for (let i = 0; i < 30; i++) {
      const g = new THREE.PlaneGeometry(0.46, 0.46);
      e.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      g.applyQuaternion(new THREE.Quaternion().setFromEuler(e));
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2, rr = Math.cbrt(rand());
      const s = Math.sqrt(1 - u * u);
      g.translate(center.x + s * Math.cos(th) * 0.27 * rr, center.y + u * 0.22 * rr, center.z + s * Math.sin(th) * 0.27 * rr);
      const p = g.attributes.position, n = g.attributes.normal;
      for (let k = 0; k < p.count; k++) {
        v.set(p.getX(k), p.getY(k), p.getZ(k)).sub(center);
        v.y += 0.12;
        v.normalize();
        n.setXYZ(k, v.x, v.y, v.z);
      }
      cards.push(g);
    }
    const decCrown = mergeGeometries(cards);

    // Conifer
    const conTrunk = new THREE.CylinderGeometry(0.014, 0.04, 1.0, 6).translate(0, 0.5, 0);
    const conCore = new THREE.ConeGeometry(0.15, 0.78, 8, 1).translate(0, 0.22 + 0.39, 0);
    const pos = [], nrm = [], uv = [], idx = [];
    const tiers = 11;
    for (let t = 0; t < tiers; t++) {
      const y = 0.17 + t * (0.76 / tiers);
      const len = 0.31 * (1 - t / (tiers + 0.6)) + 0.035;
      const per = t > tiers - 3 ? 4 : 6;
      for (let k = 0; k < per; k++) {
        const a = t * 2.39 + (k / per) * Math.PI * 2 + rand() * 0.3;
        const dx = Math.cos(a), dz = Math.sin(a);
        const px = -dz, pz = dx;
        const w = len * 0.42;
        const droop = len * (0.3 + rand() * 0.15);
        const base = pos.length / 3;
        const pts = [
          [-px * w * 0.3, y + 0.01, -pz * w * 0.3, 0, 0],
          [px * w * 0.3, y + 0.01, pz * w * 0.3, 0, 1],
          [dx * len - px * w, y - droop, dz * len - pz * w, 1, 0],
          [dx * len + px * w, y - droop, dz * len + pz * w, 1, 1],
        ];
        for (const [x, yy, z, uu, vv] of pts) {
          pos.push(x, yy, z);
          const nn = new THREE.Vector3(dx * 0.5, 1, dz * 0.5).normalize();
          nrm.push(nn.x, nn.y, nn.z);
          uv.push(uu, vv);
        }
        idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      }
    }
    const conBranches = new THREE.BufferGeometry();
    conBranches.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    conBranches.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    conBranches.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    conBranches.setIndex(idx);
    return { decTrunk, decCrown, conTrunk, conCore, conBranches };
  }

  buildTrees() {
    const rand = mulberry32(999);
    const pts = [];
    const tryAdd = (x, z, kind, scale) => {
      const h = this.heightAt(x, z);
      if (h < 1.2 || h > 215) return false;
      if (this.slopeAt(x, z) > 0.7) return false;
      if (lakeFactor(x, z) > 0.12) return false;
      pts.push({ x, z, y: h, kind, s: scale, rot: rand() * Math.PI * 2 });
      return true;
    };

    let attempts = 0;
    while (pts.length < 9000 && attempts < 90000) {
      attempts++;
      const x = (rand() - 0.5) * (SIZE - 120);
      const z = (rand() - 0.5) * (SIZE - 120);
      if (Math.max(Math.abs(x), Math.abs(z)) < 300) continue;
      const dens = forestDensity(x, z);
      if (rand() > dens * 0.9 + 0.025) continue;
      const h = this.heightAt(x, z);
      const conifer = h > 70 ? rand() < 0.85 : rand() < 0.35;
      tryAdd(x, z, conifer ? 0 : 1, 0.75 + rand() * 0.6);
    }
    for (const p of this.parkBlocks) {
      const count = p.central ? 26 : 22;
      for (let i = 0; i < count; i++) {
        const x = lerp(p.x0 + 3, p.x1 - 3, rand());
        const z = lerp(p.z0 + 3, p.z1 - 3, rand());
        if (p.central && Math.hypot(x, z) < 38) continue;
        tryAdd(x, z, rand() < 0.25 ? 0 : 1, 0.6 + rand() * 0.45);
      }
    }
    for (const r of ROADS) {
      for (let s = -TOWN_EDGE + 10; s < TOWN_EDGE; s += 18) {
        if (ROADS.some((q) => Math.abs(q - s) < 10)) continue;
        if (rand() < 0.35) continue;
        const side = rand() < 0.5 ? -1 : 1;
        const off = r + side * (ROAD_HALF + 1.2);
        if (rand() < 0.5) tryAdd(s, off, 1, 0.45 + rand() * 0.25);
        else tryAdd(off, s, 1, 0.45 + rand() * 0.25);
      }
    }
    const clear = pts.filter((t) => !this.buildings.some((b) =>
      t.x > b.minX - 2 && t.x < b.maxX + 2 && t.z > b.minZ - 2 && t.z < b.maxZ + 2));

    const G = this.buildTreeGeometries();
    const bark = TX.makeBarkTexture(this.renderer);
    const trunkMat = new THREE.MeshStandardMaterial({ map: bark, roughness: 0.95 });
    const leafMat = keepNormal(new THREE.MeshStandardMaterial({
      map: HD.makeLeafCard(this.renderer), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78,
    }));
    const needleMat = keepNormal(new THREE.MeshStandardMaterial({
      map: HD.makeNeedleCard(this.renderer), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.85,
    }));
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x1a2a14, roughness: 0.95 });

    // Group trees into spatial tiles so shadow and view frustum culling skip far tiles
    const tiles = new Map();
    for (const t of clear) {
      const key = `${Math.floor((t.x + HALF) / TREE_TILE)},${Math.floor((t.z + HALF) / TREE_TILE)}`;
      if (!tiles.has(key)) tiles.set(key, { con: [], dec: [] });
      tiles.get(key)[t.kind === 0 ? 'con' : 'dec'].push(t);
    }
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const make = (geo, mat, list, colorFn, shadow = true) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((t, i) => {
        const sz = t.kind === 0 ? 16 * t.s : 11 * t.s;
        s.set(sz, sz, sz);
        q.setFromAxisAngle(up, t.rot);
        p.set(t.x, t.y - 0.1, t.z);
        m.compose(p, q, s);
        im.setMatrixAt(i, m);
        if (colorFn) im.setColorAt(i, colorFn(t));
      });
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.computeBoundingBox();
      this.scene.add(im);
    };
    const tintCon = () => col.setHSL(0.3 + rand() * 0.06, 0.25 + rand() * 0.2, 0.42 + rand() * 0.14, THREE.SRGBColorSpace);
    const tintDec = () => col.setHSL(0.19 + rand() * 0.08, 0.3 + rand() * 0.25, 0.45 + rand() * 0.16, THREE.SRGBColorSpace);
    for (const { con, dec } of tiles.values()) {
      make(G.conTrunk, trunkMat, con);
      make(G.conCore, coreMat, con, null, false);
      make(G.conBranches, needleMat, con, tintCon);
      make(G.decTrunk, trunkMat, dec);
      make(G.decCrown, leafMat, dec, tintDec);
    }

    for (const t of clear) {
      const sz = t.kind === 0 ? 16 * t.s : 11 * t.s;
      this.addTreeCollider({
        x: t.x, z: t.z, y: t.y,
        trunkR: (t.kind === 0 ? 0.03 : 0.05) * sz,
        crownR: (t.kind === 0 ? 0.3 : 0.32) * sz,
        crownY0: t.y + (t.kind === 0 ? 0.2 : 0.48) * sz,
        top: t.y + (t.kind === 0 ? 0.98 : 0.98) * sz,
      });
    }
  }

  cellKey(x, z) {
    return (Math.floor(x / 16) + 1000) * 4000 + (Math.floor(z / 16) + 1000);
  }

  /** Grass density mask over the whole map (R8, size x size). */
  buildGrassMask(size = 1024) {
    const data = new Uint8Array(size * size);
    const px = SIZE / size;
    for (let y = 0; y < size; y++) {
      const z = -HALF + (y + 0.5) * px;
      const gz = Math.min(SEG, Math.round((z + HALF) / STEP));
      for (let x = 0; x < size; x++) {
        const wx = -HALF + (x + 0.5) * px;
        const gx = Math.min(SEG, Math.round((wx + HALF) / STEP));
        let d = this.grassGrid[gz * N + gx];
        if (Math.max(Math.abs(wx), Math.abs(z)) < TOWN_EDGE + ROAD_HALF + 1) {
          if (ROADS.some((r) => Math.abs(z - r) < ROAD_HALF + 0.6 || Math.abs(wx - r) < ROAD_HALF + 0.6)) d = 0;
          if (Math.abs(wx) < 6 && Math.abs(z) < 6) d = 0;
        }
        data[y * size + x] = Math.max(0, Math.min(255, d * 255));
      }
    }
    for (const b of this.buildings) {
      const x0 = Math.floor((b.minX + HALF) / px), x1 = Math.ceil((b.maxX + HALF) / px);
      const z0 = Math.floor((b.minZ + HALF) / px), z1 = Math.ceil((b.maxZ + HALF) / px);
      for (let y = z0; y <= z1; y++) for (let x = x0; x <= x1; x++) data[y * size + x] = 0;
    }
    return { data, size };
  }

  // ---------- race gates ----------
  buildGates() {
    const stripe = TX.makeStripeTexture(this.renderer);
    const R = 27;
    const heights = [3.2, 5, 8, 4, 3, 6.5, 10, 4.5];
    const inner = 4, bar = 0.3;
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * Math.PI * 2 + Math.PI / 2;
      const x = R * Math.cos(t), z = -R * Math.sin(t);
      const dirX = -Math.sin(t), dirZ = -Math.cos(t);
      const yaw = Math.atan2(dirX, dirZ);
      const ground = this.heightAt(x, z);
      const cy = ground + heights[i];
      const mat = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.5, emissive: 0x000000 });
      const postMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6, metalness: 0.5 });
      const g = new THREE.Group();
      const outer = inner + bar * 2;
      const top = new THREE.Mesh(new THREE.BoxGeometry(outer, bar, bar), mat);
      top.position.y = inner / 2 + bar / 2;
      const bot = top.clone(); bot.position.y = -inner / 2 - bar / 2;
      const left = new THREE.Mesh(new THREE.BoxGeometry(bar, inner, bar), mat);
      left.position.x = -inner / 2 - bar / 2;
      const right = left.clone(); right.position.x = inner / 2 + bar / 2;
      const postH = heights[i] - inner / 2 - bar;
      g.add(top, bot, left, right);
      if (postH > 0.05) {
        const pg = new THREE.CylinderGeometry(0.07, 0.09, postH, 8);
        for (const sx of [-1, 1]) {
          const pm = new THREE.Mesh(pg, postMat);
          pm.position.set(sx * (inner / 2 + bar / 2), -inner / 2 - bar - postH / 2, 0);
          g.add(pm);
        }
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.position.set(x, cy, z);
      g.rotation.y = yaw;
      this.scene.add(g);
      this.gates.push({
        index: i, group: g, mat, center: new THREE.Vector3(x, cy, z),
        yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), inner, bar, postH, ground,
      });
    }
  }

  toGateLocal(g, p, out) {
    const dx = p.x - g.center.x, dz = p.z - g.center.z;
    out.x = dx * g.cos - dz * g.sin;
    out.z = dx * g.sin + dz * g.cos;
    out.y = p.y - g.center.y;
    return out;
  }

  // ---------- collision ----------
  collide(p, r) {
    const hit = this._hit;
    hit.hit = false; hit.depth = 0; hit.kind = '';
    if (Math.max(Math.abs(p.x), Math.abs(p.z)) < TOWN_EDGE + 20) {
      for (const b of this.buildings) {
        if (p.y - r > b.maxY + 3) continue;
        const cx = Math.max(b.minX, Math.min(p.x, b.maxX));
        const cy = Math.max(b.minY, Math.min(p.y, b.maxY));
        const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
        const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2);
          if (d > 1e-5) { hit.normal.set(dx / d, dy / d, dz / d); hit.depth = r - d; }
          else {
            const opts = [
              [p.x - b.minX, -1, 0, 0], [b.maxX - p.x, 1, 0, 0],
              [p.z - b.minZ, 0, 0, -1], [b.maxZ - p.z, 0, 0, 1], [b.maxY - p.y, 0, 1, 0],
            ].sort((a, c) => a[0] - c[0])[0];
            hit.normal.set(opts[1], opts[2], opts[3]); hit.depth = opts[0] + r;
          }
          hit.hit = true; hit.kind = b.maxY - TOWN_H < 2 ? 'car' : 'building';
          return hit;
        }
      }
    }
    const ix = Math.floor(p.x / 16), iz = Math.floor(p.z / 16);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.treeGrid.get((ix + a + 1000) * 4000 + (iz + b + 1000));
      if (!list) continue;
      for (const t of list) {
        if (p.y - r > t.top || p.y + r < t.y) continue;
        const dx = p.x - t.x, dz = p.z - t.z;
        const dh = Math.hypot(dx, dz);
        let rad = t.trunkR;
        if (p.y > t.crownY0 && t.top > t.crownY0) {
          const k = 1 - (p.y - t.crownY0) / (t.top - t.crownY0);
          rad = Math.max(t.trunkR, t.crownR * Math.min(1, k * 1.25));
        }
        if (dh < rad + r) {
          if (dh > 1e-4) hit.normal.set(dx / dh, 0, dz / dh); else hit.normal.set(1, 0, 0);
          hit.depth = rad + r - dh;
          hit.hit = true; hit.kind = t.crownR < 0.2 ? 'lamp post' : 'tree';
          return hit;
        }
      }
    }
    const L = this._lp || (this._lp = new THREE.Vector3());
    for (const g of this.gates) {
      if (Math.abs(p.x - g.center.x) > 8 || Math.abs(p.z - g.center.z) > 8) continue;
      this.toGateLocal(g, p, L);
      const hi = g.inner / 2, b = g.bar;
      const boxes = [
        [-hi - b, hi + b, hi, hi + b],
        [-hi - b, hi + b, -hi - b, -hi],
        [-hi - b, -hi, -hi - b, hi + b],
        [hi, hi + b, -hi - b, hi + b],
        [-hi - b, -hi, -hi - b - g.postH - 1, -hi - b],
        [hi, hi + b, -hi - b - g.postH - 1, -hi - b],
      ];
      for (const [x0, x1, y0, y1] of boxes) {
        const cx = Math.max(x0, Math.min(L.x, x1));
        const cy = Math.max(y0, Math.min(L.y, y1));
        const cz = Math.max(-b / 2, Math.min(L.z, b / 2));
        const dx = L.x - cx, dy = L.y - cy, dz = L.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 1e-4;
          const lx = dx / d, lz = dz / d;
          hit.normal.set(lx * g.cos + lz * g.sin, dy / d, -lx * g.sin + lz * g.cos).normalize();
          hit.depth = r - d;
          hit.hit = true; hit.kind = 'gate';
          return hit;
        }
      }
    }
    return hit;
  }

  // ---------- minimap ----------
  buildMinimap() {
    const S = 600;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const gx = Math.round((x / (S - 1)) * SEG), gz = Math.round((y / (S - 1)) * SEG);
      const gi = gz * N + gx;
      const h = this.heights[gi];
      let r = this.colorGrid[gi * 3] * 255, g = this.colorGrid[gi * 3 + 1] * 255, b = this.colorGrid[gi * 3 + 2] * 255;
      if (h < WATER_Y && lakeFactor(-HALF + gx * STEP, -HALF + gz * STEP) > 0.05) { r = 40; g = 90; b = 120; }
      const hx = this.heights[gi + (gx < SEG ? 1 : 0)] - h;
      const shade = Math.max(0.6, Math.min(1.3, 1 - hx * 0.08));
      const i = (y * S + x) * 4;
      img.data[i] = r * shade; img.data[i + 1] = g * shade; img.data[i + 2] = b * shade; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const px = (v) => ((v + HALF) / SIZE) * S;
    ctx.fillStyle = '#5a5a5a';
    for (const r of ROADS) {
      ctx.fillRect(px(-TOWN_EDGE), px(r - ROAD_HALF), px(TOWN_EDGE) - px(-TOWN_EDGE), (ROAD_HALF * 2 * S) / SIZE + 0.5);
      ctx.fillRect(px(r - ROAD_HALF), px(-TOWN_EDGE), (ROAD_HALF * 2 * S) / SIZE + 0.5, px(TOWN_EDGE) - px(-TOWN_EDGE));
    }
    ctx.fillStyle = '#d8d4cc';
    for (const l of this.lots) {
      ctx.fillRect(px(l.x - l.w / 2), px(l.z - l.d / 2), Math.max(1, (l.w * S) / SIZE), Math.max(1, (l.d * S) / SIZE));
    }
    this.minimap = c;
    this.minimapScale = S / SIZE;
    this.minimapHalf = HALF;
  }

  // ---------- per frame ----------
  update(dt, focus) {
    this.time += dt;
    this.sky.material.uniforms.time.value = this.time;
    this.water.material.uniforms.time.value += dt * 0.5;
    const sc = this.sun.shadow.camera;
    const texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx, focus.y, fz).addScaledVector(this.sunDir, 500);
  }
}
