// Procedurally generated textures (no external image assets needed).
import * as THREE from 'three';
import { tileableNoise, mulberry32 } from './noise.js';

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finish(tex, renderer, srgb = true, repeat = true) {
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

function heightToNormalCanvas(h, size, strength) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Near-white detail map multiplied over terrain vertex colours. */
export function makeGroundDetail(renderer) {
  const size = 512;
  const n1 = tileableNoise(size, 8, 6, 11);
  const n2 = tileableNoise(size, 32, 3, 12);
  const rand = mulberry32(5);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const grain = rand() * 0.12;
    const v = 0.72 + n1[i] * 0.22 + n2[i] * 0.12 + grain - 0.06;
    // slight hue variation (greener / browner patches)
    const hue = n2[i] - 0.5;
    img.data[i * 4] = Math.min(255, v * (1 + hue * 0.1) * 255);
    img.data[i * 4 + 1] = Math.min(255, v * 255);
    img.data[i * 4 + 2] = Math.min(255, v * (1 - hue * 0.15) * 255);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeGroundNormal(renderer) {
  const size = 512;
  const h = tileableNoise(size, 16, 5, 21);
  const h2 = tileableNoise(size, 64, 2, 22);
  for (let i = 0; i < h.length; i++) h[i] = h[i] + h2[i] * 0.4;
  return finish(new THREE.CanvasTexture(heightToNormalCanvas(h, size, 6)), renderer, false);
}

export function makeWaterNormals(renderer) {
  const size = 256;
  const h = tileableNoise(size, 4, 5, 31);
  const h2 = tileableNoise(size, 12, 3, 32);
  for (let i = 0; i < h.length; i++) h[i] = h[i] + h2[i] * 0.5;
  return finish(new THREE.CanvasTexture(heightToNormalCanvas(h, size, 10)), renderer, false);
}

/** Asphalt with lane markings; u runs along the road. */
export function makeRoadTexture(renderer) {
  const w = 512, hgt = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  const n = tileableNoise(256, 32, 3, 41);
  const img = ctx.createImageData(w, hgt);
  const rand = mulberry32(42);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const v = 52 + n[(y % 256) * 256 + (x % 256)] * 30 + rand() * 18;
      const i = (y * w + x) * 4;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v + 3; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // kerbs / sidewalk
  ctx.fillStyle = '#9a9890';
  ctx.fillRect(0, 0, w, 22);
  ctx.fillRect(0, hgt - 22, w, 22);
  ctx.fillStyle = '#bdbab0';
  ctx.fillRect(0, 22, w, 3);
  ctx.fillRect(0, hgt - 25, w, 3);
  // edge lines
  ctx.fillStyle = 'rgba(235,235,225,0.85)';
  ctx.fillRect(0, 34, w, 4);
  ctx.fillRect(0, hgt - 38, w, 4);
  // dashed centre
  ctx.fillStyle = 'rgba(240,200,60,0.9)';
  for (let x = 0; x < w; x += 128) ctx.fillRect(x + 16, hgt / 2 - 3, 72, 6);
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeHelipadTexture(renderer) {
  const s = 512;
  const c = canvas(s);
  const ctx = c.getContext('2d');
  const n = tileableNoise(256, 16, 4, 51);
  const img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const x = i % s, y = (i / s) | 0;
    const v = 120 + n[(y % 256) * 256 + (x % 256)] * 40;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v - 4; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = '#f2f2f2';
  ctx.lineWidth = 14;
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#f2f2f2';
  ctx.font = `bold ${s * 0.42}px Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('H', s / 2, s / 2 + s * 0.02);
  ctx.strokeStyle = '#e8c021';
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, s - 16, s - 16);
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}

export function makeStripeTexture(renderer) {
  const c = canvas(64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff6a00';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#151515';
  ctx.fillRect(0, 0, 64, 32);
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeBarkTexture(renderer) {
  const s = 128;
  const n = tileableNoise(s, 4, 4, 61);
  const c = canvas(s);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const v = n[((y >> 3) % s) * s + x];
    const i = (y * s + x) * 4;
    img.data[i] = 70 + v * 50; img.data[i + 1] = 52 + v * 36; img.data[i + 2] = 38 + v * 24; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeFoliageTexture(renderer) {
  const s = 256;
  const n = tileableNoise(s, 16, 4, 71);
  const rand = mulberry32(72);
  const c = canvas(s);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s, s);
  for (let i = 0; i < s * s; i++) {
    const v = 0.6 + n[i] * 0.5 + (rand() - 0.5) * 0.25;
    img.data[i * 4] = Math.min(255, v * 230);
    img.data[i * 4 + 1] = Math.min(255, v * 255);
    img.data[i * 4 + 2] = Math.min(255, v * 220);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), renderer, true);
}
