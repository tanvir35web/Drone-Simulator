// Higher-detail procedural textures: terrain albedo layers, foliage cards, drone materials.
import * as THREE from 'three';
import { tileableNoise, mulberry32 } from './noise.js';

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function finish(tex, renderer, srgb = true, repeat = true) {
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

function pixels(size, fn) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const [r, g, b] = fn(i, x, y);
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { c, ctx };
}

/** Draw something so it wraps across tile edges (keeps the texture tileable). */
function wrapped(size, x, y, margin, draw) {
  for (const dx of [-size, 0, size]) {
    if ((dx < 0 && x < size - margin) || (dx > 0 && x > margin)) continue;
    for (const dy of [-size, 0, size]) {
      if ((dy < 0 && y < size - margin) || (dy > 0 && y > margin)) continue;
      draw(x + dx, y + dy);
    }
  }
}

const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------------------
// Terrain layers
// ---------------------------------------------------------------------------

export function makeGrassAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 4, 5, 101);
  const n2 = tileableNoise(S, 24, 3, 102);
  const rand = mulberry32(103);
  const { c, ctx } = pixels(S, (i) => {
    const base = mixc([46, 66, 24], [92, 106, 42], n1[i]);
    const v = 0.8 + n2[i] * 0.35 + (rand() - 0.5) * 0.12;
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  ctx.lineCap = 'round';
  for (let k = 0; k < 14000; k++) {
    const x = rand() * S, y = rand() * S;
    const len = 4 + rand() * 9;
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.2;
    const l = 14 + rand() * 26, h = 70 + rand() * 30, s = 35 + rand() * 30;
    ctx.strokeStyle = `hsla(${h},${s}%,${l}%,0.75)`;
    ctx.lineWidth = 0.8 + rand() * 1.1;
    wrapped(S, x, y, 14, (px, py) => {
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); ctx.stroke();
    });
  }
  for (let k = 0; k < 1500; k++) {
    const x = rand() * S, y = rand() * S;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(150,135,80,0.55)' : 'rgba(60,45,30,0.5)';
    wrapped(S, x, y, 3, (px, py) => ctx.fillRect(px, py, 1.5, 1.5));
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeDirtAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 6, 5, 111);
  const n2 = tileableNoise(S, 40, 2, 112);
  const rand = mulberry32(113);
  const { c, ctx } = pixels(S, (i) => {
    const base = mixc([78, 60, 42], [124, 102, 74], n1[i]);
    const v = 0.85 + n2[i] * 0.3 + (rand() - 0.5) * 0.1;
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  for (let k = 0; k < 900; k++) {
    const x = rand() * S, y = rand() * S, r = 1 + rand() * 3.5;
    const g = 90 + rand() * 80;
    const rot = rand();
    wrapped(S, x, y, 6, (px, py) => {
      ctx.fillStyle = 'rgba(30,22,15,0.45)';
      ctx.beginPath(); ctx.ellipse(px + 0.8, py + 0.8, r, r * 0.75, rot, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgb(${g},${g * 0.9},${g * 0.78})`;
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.75, rot, 0, Math.PI * 2); ctx.fill();
    });
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeRockAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 4, 6, 121);
  const n2 = tileableNoise(S, 8, 5, 122);
  const n3 = tileableNoise(S, 32, 3, 123);
  const rand = mulberry32(124);
  const { c } = pixels(S, (i, x, y) => {
    const ridge = 1 - Math.abs(n2[i] * 2 - 1);
    const crack = Math.pow(ridge, 10);
    const strata = 0.5 + 0.5 * Math.sin((y / S) * Math.PI * 2 * 6 + n1[i] * 9);
    let base = mixc([84, 80, 74], [140, 134, 124], n1[i] * 0.7 + strata * 0.3);
    base = mixc(base, [120, 104, 84], n3[i] * 0.35);
    const v = (0.75 + n3[i] * 0.45 + (rand() - 0.5) * 0.08) * (1 - crack * 0.7);
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeSandAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 4, 4, 131);
  const n2 = tileableNoise(S, 64, 2, 132);
  const rand = mulberry32(133);
  const { c } = pixels(S, (i, x, y) => {
    const ripple = 0.5 + 0.5 * Math.sin(((y + n1[i] * 60) / S) * Math.PI * 2 * 18);
    const base = mixc([168, 150, 112], [206, 190, 150], n1[i] * 0.6 + ripple * 0.25);
    const v = 0.9 + n2[i] * 0.18 + (rand() - 0.5) * 0.14;
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

export function makeSnowAlbedo(renderer) {
  const S = 256;
  const n1 = tileableNoise(S, 4, 5, 141);
  const rand = mulberry32(142);
  const { c } = pixels(S, (i) => {
    const v = 0.86 + n1[i] * 0.14 + (rand() - 0.5) * 0.04;
    return [232 * v, 238 * v, 248 * v];
  });
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

/** Grayscale low-frequency noise used to break up tiling. */
export function makeMacroNoise(renderer) {
  const S = 256;
  const n = tileableNoise(S, 4, 6, 151);
  const { c } = pixels(S, (i) => { const v = n[i] * 255; return [v, v, v]; });
  return finish(new THREE.CanvasTexture(c), renderer, false);
}

// ---------------------------------------------------------------------------
// Foliage cards (alpha tested)
// ---------------------------------------------------------------------------

export function makeLeafCard(renderer) {
  const S = 256;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const rand = mulberry32(161);
  ctx.strokeStyle = 'rgb(70,55,38)';
  ctx.lineWidth = 2;
  for (let k = 0; k < 7; k++) {
    ctx.beginPath(); ctx.moveTo(S / 2, S * 0.95);
    ctx.quadraticCurveTo(S / 2 + (rand() - 0.5) * 60, S * 0.6, S * (0.15 + rand() * 0.7), S * (0.1 + rand() * 0.5));
    ctx.stroke();
  }
  for (let k = 0; k < 520; k++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * S * 0.44;
    const x = S / 2 + Math.cos(a) * r, y = S * 0.47 + Math.sin(a) * r * 0.92;
    const len = 9 + rand() * 9;
    const h = 78 + rand() * 32, s = 38 + rand() * 25, l = 16 + rand() * 22 + (y < S * 0.4 ? 6 : 0);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rand() * Math.PI * 2);
    ctx.fillStyle = `hsl(${h},${s}%,${l}%)`;
    ctx.beginPath(); ctx.ellipse(0, 0, len * 0.5, len * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = `hsla(${h},${s}%,${Math.max(5, l - 8)}%,0.7)`;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-len * 0.45, 0); ctx.lineTo(len * 0.45, 0); ctx.stroke();
    ctx.restore();
  }
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}

/** Conifer branch card: trunk at u=0, tip at u=1. */
export function makeNeedleCard(renderer) {
  const W = 256, H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const rand = mulberry32(171);
  ctx.strokeStyle = 'rgb(66,50,36)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W * 0.97, H / 2); ctx.stroke();
  for (let k = 0; k < 16; k++) {
    const x0 = 12 + k * 14;
    const spread = (H * 0.45) * (1 - (x0 / W) * 0.55);
    for (const side of [-1, 1]) {
      const x1 = Math.min(W - 4, x0 + 18 + rand() * 12), y1 = H / 2 + side * spread * (0.6 + rand() * 0.4);
      ctx.strokeStyle = 'rgb(60,46,32)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x0, H / 2); ctx.lineTo(x1, y1); ctx.stroke();
      for (let n = 0; n < 24; n++) {
        const t = n / 24;
        const px = x0 + (x1 - x0) * t, py = H / 2 + (y1 - H / 2) * t;
        const l = 12 + rand() * 11;
        ctx.strokeStyle = `hsl(${118 + rand() * 25},${32 + rand() * 20}%,${11 + rand() * 15}%)`;
        ctx.lineWidth = 1.4;
        for (const ns of [-1, 1]) {
          const ang = Math.atan2(y1 - H / 2, x1 - x0) + ns * (0.7 + rand() * 0.5);
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(ang) * l * 0.6, py + Math.sin(ang) * l * 0.6); ctx.stroke();
        }
      }
    }
  }
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}

// ---------------------------------------------------------------------------
// Drone materials
// ---------------------------------------------------------------------------

export function makeCarbonTexture(renderer) {
  const S = 128;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const cell = 16;
  for (let y = 0; y < S / cell; y++) for (let x = 0; x < S / cell; x++) {
    const horiz = (x + y) % 2 === 0;
    const g = ctx.createLinearGradient(x * cell, y * cell, horiz ? x * cell : (x + 1) * cell, horiz ? (y + 1) * cell : y * cell);
    g.addColorStop(0, '#141516'); g.addColorStop(0.5, '#3a3c40'); g.addColorStop(1, '#141516');
    ctx.fillStyle = g;
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

/** Motion blur disc for spinning propellers. */
export function makePropBlurTexture(renderer, blades = 2) {
  const S = 256;
  const c = canvas(S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - S / 2 + 0.5, dy = y - S / 2 + 0.5;
    const r = Math.hypot(dx, dy) / (S / 2);
    const a = Math.atan2(dy, dx);
    let alpha = 0;
    if (r < 1 && r > 0.1) {
      const streak = Math.pow(0.5 + 0.5 * Math.cos(a * blades), 6);
      alpha = (0.22 + 0.5 * streak) * Math.min(1, (r - 0.1) * 6) * (r > 0.94 ? (1 - r) / 0.06 : 1) * (0.6 + 0.4 * r);
    }
    const i = (y * S + x) * 4;
    img.data[i] = 30; img.data[i + 1] = 32; img.data[i + 2] = 36; img.data[i + 3] = alpha * 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}

/** Battery / label decal with stripes. */
export function makeBatteryTexture(renderer, accent = '#ffcc00') {
  const c = canvas(128, 64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1d1f22'; ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = accent; ctx.fillRect(0, 24, 128, 10);
  ctx.fillStyle = '#e8e8e8'; ctx.font = 'bold 13px Arial'; ctx.fillText('6S 1300', 10, 18);
  ctx.fillStyle = '#9aa0a6'; ctx.font = '9px Arial'; ctx.fillText('LiPo 22.2V', 10, 52);
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}
