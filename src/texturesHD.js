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
  const n3 = tileableNoise(S, 10, 3, 104);
  // Muted, natural turf: olive greens with soil showing through between tufts
  const { c, ctx } = pixels(S, (i) => {
    let base = mixc([58, 64, 34], [92, 94, 50], n1[i]);
    base = mixc(base, [96, 82, 58], Math.max(0, n3[i] - 0.55) * 1.4); // soil showing through
    const v = 0.78 + n2[i] * 0.34 + (rand() - 0.5) * 0.14;
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  ctx.lineCap = 'round';
  for (let k = 0; k < 11000; k++) {
    const x = rand() * S, y = rand() * S;
    const len = 3 + rand() * 7;
    const a = -Math.PI / 2 + (rand() - 0.5) * 1.6;
    const dry = rand() < 0.22;
    const l = dry ? 34 + rand() * 18 : 13 + rand() * 22;
    const h = dry ? 42 + rand() * 14 : 62 + rand() * 30;
    const s = dry ? 28 + rand() * 16 : 20 + rand() * 26;
    ctx.strokeStyle = `hsla(${h},${s}%,${l}%,0.7)`;
    ctx.lineWidth = 0.7 + rand() * 1.0;
    wrapped(S, x, y, 12, (px, py) => {
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); ctx.stroke();
    });
  }
  // clover / weed leaves
  for (let k = 0; k < 500; k++) {
    const x = rand() * S, y = rand() * S, r = 1.2 + rand() * 1.6;
    ctx.fillStyle = `hsla(${95 + rand() * 20},${30 + rand() * 15}%,${22 + rand() * 10}%,0.8)`;
    wrapped(S, x, y, 5, (px, py) => {
      for (let j = 0; j < 3; j++) {
        const a = j * 2.1 + rand();
        ctx.beginPath(); ctx.arc(px + Math.cos(a) * r, py + Math.sin(a) * r, r, 0, Math.PI * 2); ctx.fill();
      }
    });
  }
  for (let k = 0; k < 2200; k++) {
    const x = rand() * S, y = rand() * S;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(140,124,92,0.6)' : 'rgba(58,44,30,0.55)';
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

/** Compacted gravel path: dense small stones over packed dust. */
export function makeGravelAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 8, 4, 181);
  const rand = mulberry32(182);
  const { c, ctx } = pixels(S, (i) => {
    const base = mixc([92, 84, 70], [120, 110, 94], n1[i]);
    const v = 0.9 + (rand() - 0.5) * 0.18;
    return [base[0] * v, base[1] * v, base[2] * v];
  });
  for (let k = 0; k < 5200; k++) {
    const x = rand() * S, y = rand() * S, r = 1.2 + rand() * 3.2;
    const g = 78 + rand() * 80;
    const tint = rand();
    const rot = rand() * Math.PI;
    wrapped(S, x, y, 6, (px, py) => {
      ctx.fillStyle = 'rgba(35,30,25,0.4)';
      ctx.beginPath(); ctx.ellipse(px + 0.9, py + 1.1, r, r * 0.7, rot, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `rgb(${g + tint * 18},${g + tint * 8},${g - 6})`;
      ctx.beginPath(); ctx.ellipse(px, py, r, r * 0.7, rot, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.ellipse(px - r * 0.3, py - r * 0.3, r * 0.4, r * 0.28, rot, 0, Math.PI * 2); ctx.fill();
    });
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

/** Weathered concrete slabs (4 m tile with expansion joints). */
export function makeConcreteAlbedo(renderer) {
  const S = 512;
  const n1 = tileableNoise(S, 4, 5, 191);
  const n2 = tileableNoise(S, 48, 2, 192);
  const rand = mulberry32(193);
  const { c, ctx } = pixels(S, (i) => {
    const v = 0.82 + n1[i] * 0.18 + n2[i] * 0.08 + (rand() - 0.5) * 0.06;
    return [128 * v, 125 * v, 119 * v];
  });
  // stains
  for (let k = 0; k < 40; k++) {
    const x = rand() * S, y = rand() * S, r = 8 + rand() * 30;
    wrapped(S, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(60,55,48,0.18)'); g.addColorStop(1, 'rgba(60,55,48,0)');
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // expansion joints every half tile (2 m)
  ctx.fillStyle = 'rgba(40,38,34,0.55)';
  for (const p of [0, S / 2]) { ctx.fillRect(p, 0, 2, S); ctx.fillRect(0, p, S, 2); }
  // hairline cracks
  ctx.strokeStyle = 'rgba(45,42,38,0.45)';
  ctx.lineWidth = 0.8;
  for (let k = 0; k < 14; k++) {
    let x = rand() * S, y = rand() * S;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let j = 0; j < 8; j++) { x += (rand() - 0.5) * 24; y += (rand() - 0.5) * 24; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

/**
 * Helipad top surface (12 m x 12 m): weathered concrete slabs with worn paint markings,
 * skid scuffs and oil stains.
 */
export function makeHelipadTop(renderer, sizeM = 12) {
  const S = 1024;
  const m = S / sizeM; // pixels per metre
  const n1 = tileableNoise(S, 6, 5, 201);
  const n2 = tileableNoise(S, 64, 2, 202);
  const rand = mulberry32(203);
  const { c, ctx } = pixels(S, (i) => {
    const v = 0.8 + n1[i] * 0.2 + n2[i] * 0.07 + (rand() - 0.5) * 0.07;
    return [118 * v, 116 * v, 111 * v];
  });
  // slab joints every 3 m
  ctx.fillStyle = 'rgba(38,36,33,0.6)';
  for (let k = 1; k < sizeM / 3; k++) { ctx.fillRect(k * 3 * m - 1, 0, 2, S); ctx.fillRect(0, k * 3 * m - 1, S, 2); }
  // edge darkening (weathering at the slab rim)
  const eg = ctx.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.75);
  eg.addColorStop(0, 'rgba(0,0,0,0)'); eg.addColorStop(1, 'rgba(30,26,20,0.28)');
  ctx.fillStyle = eg; ctx.fillRect(0, 0, S, S);
  // oil / water stains
  for (let k = 0; k < 14; k++) {
    const x = S / 2 + (rand() - 0.5) * S * 0.7, y = S / 2 + (rand() - 0.5) * S * 0.7, r = (0.2 + rand() * 0.9) * m;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(25,22,18,0.28)'); g.addColorStop(1, 'rgba(25,22,18,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Paint layer
  const paint = document.createElement('canvas');
  paint.width = paint.height = S;
  const p = paint.getContext('2d');
  const inset = 0.35 * m;
  p.strokeStyle = '#d9ad1f'; p.lineWidth = 0.28 * m;
  p.strokeRect(inset, inset, S - inset * 2, S - inset * 2);
  p.strokeStyle = '#ecebe6'; p.lineWidth = 0.32 * m;
  p.beginPath(); p.arc(S / 2, S / 2, 4.4 * m, 0, Math.PI * 2); p.stroke();
  p.fillStyle = '#ecebe6';
  const hw = 2.2 * m, hh = 3.4 * m, bar = 0.55 * m;
  p.fillRect(S / 2 - hw / 2, S / 2 - hh / 2, bar, hh);
  p.fillRect(S / 2 + hw / 2 - bar, S / 2 - hh / 2, bar, hh);
  p.fillRect(S / 2 - hw / 2, S / 2 - bar / 2, hw, bar);
  // corner touchdown marks
  p.fillStyle = '#d9ad1f';
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    p.fillRect(S / 2 + sx * 3.9 * m - 0.6 * m * (sx < 0 ? 1 : 0), S / 2 + sy * 3.9 * m - 0.12 * m, 0.6 * m, 0.24 * m);
  }
  // wear: chip the paint away
  p.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 16000; k++) {
    const x = rand() * S, y = rand() * S;
    const centre = 1 - Math.min(1, Math.hypot(x - S / 2, y - S / 2) / (S * 0.5));
    const wear = n1[(y | 0) * S + (x | 0)];
    if (rand() > 0.35 + wear * 0.5 + centre * 0.3) continue;
    p.fillStyle = `rgba(0,0,0,${0.25 + rand() * 0.6})`;
    p.beginPath(); p.arc(x, y, 0.6 + rand() * 2.6, 0, Math.PI * 2); p.fill();
  }
  ctx.globalAlpha = 0.92;
  ctx.drawImage(paint, 0, 0);
  ctx.globalAlpha = 1;
  // skid scuffs across paint and concrete
  ctx.lineCap = 'round';
  for (let k = 0; k < 22; k++) {
    const r = (0.6 + rand() * 3.2) * m, a = rand() * Math.PI * 2;
    ctx.strokeStyle = `rgba(20,20,20,${0.06 + rand() * 0.12})`;
    ctx.lineWidth = (0.04 + rand() * 0.08) * m;
    ctx.beginPath(); ctx.arc(S / 2 + (rand() - 0.5) * m, S / 2 + (rand() - 0.5) * m, r, a, a + 0.3 + rand() * 0.8); ctx.stroke();
  }
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
}

/** Flat-roof concrete tiles (4 m tile, 0.5 m pavers) with grout, stains and damp streaks. */
export function makeRoofTiles(renderer) {
  const S = 512, cell = 64;
  const n1 = tileableNoise(S, 4, 5, 211);
  const rand = mulberry32(212);
  const tile = [];
  for (let i = 0; i < 64; i++) tile.push(0.85 + rand() * 0.25);
  const { c, ctx } = pixels(S, (i, x, y) => {
    const t = tile[((y / cell) | 0) * 8 + ((x / cell) | 0)];
    const v = t * (0.82 + n1[i] * 0.22) + (rand() - 0.5) * 0.05;
    return [124 * v, 115 * v, 104 * v];
  });
  ctx.fillStyle = 'rgba(55,50,44,0.7)';
  for (let k = 0; k <= S; k += cell) { ctx.fillRect(k - 1, 0, 2, S); ctx.fillRect(0, k - 1, S, 2); }
  for (let k = 0; k < 30; k++) {
    const x = rand() * S, y = rand() * S, r = 10 + rand() * 50;
    wrapped(S, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${rand() < 0.3 ? '50,60,40' : '40,36,30'},0.22)`); g.addColorStop(1, 'rgba(40,36,30,0)');
      ctx.fillStyle = g; ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  return finish(new THREE.CanvasTexture(c), renderer, true);
}

/** Orange / white windsock bands along the sock length (v axis). */
export function makeWindsockTexture(renderer) {
  const c = canvas(16, 160);
  const ctx = c.getContext('2d');
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ff5a10' : '#f2f2ee';
    ctx.fillRect(0, i * 32, 16, 32);
  }
  return finish(new THREE.CanvasTexture(c), renderer, true, false);
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
