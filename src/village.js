// Villages and residential housing: pitched-roof houses, farmsteads, dirt roads and crop fields.
//
// - A residential quarter of small houses inside the town (south-west blocks, away from downtown)
// - Four countryside villages on flattened plateaus, linked to the town roads by dirt roads
// - A whole-map "rural" ground mask (roads, yards, fields) sampled by the terrain shader
import * as THREE from 'three';
import { mulberry32, smoothstep, lerp } from './noise.js';

/** Village centres, radius of the flat core and main-street bearing (radians). */
export const VILLAGES = [
  { name: 'West', x: -640, z: 160, r: 120, ang: 0.35 },
  { name: 'North', x: 140, z: 660, r: 105, ang: 1.25 },
  { name: 'South', x: -300, z: -660, r: 100, ang: -0.55 },
  { name: 'East', x: 720, z: 470, r: 95, ang: 2.35 },
];

const RURAL_RES = 2048;
const STREET_W = 5;
const TRACK_W = 3.4;

// ---------------------------------------------------------------------------
// Terrain flattening (called from computeHeight before the World exists)
// ---------------------------------------------------------------------------
let plateausReady = false;
function initPlateaus(baseFn) {
  for (const v of VILLAGES) {
    let s = 0, n = 0;
    for (let a = 0; a < 8; a++) {
      const r = a === 0 ? 0 : v.r * 0.6;
      s += baseFn(v.x + Math.cos(a) * r, v.z + Math.sin(a) * r);
      n++;
    }
    v.h = Math.max(4, s / n);
  }
  plateausReady = true;
}

/** Blends raw terrain height toward each village's plateau height. */
export function flattenVillages(h, x, z, baseFn) {
  if (!plateausReady) initPlateaus(baseFn);
  for (const v of VILLAGES) {
    const d = Math.hypot(x - v.x, z - v.z);
    if (d > v.r * 1.95) continue;
    h = lerp(h, v.h, 1 - smoothstep(v.r * 1.05, v.r * 1.9, d));
  }
  return h;
}

export function villageAt(x, z, scale = 1) {
  return VILLAGES.find((v) => Math.hypot(x - v.x, z - v.z) < v.r * scale) || null;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function polyPoint(pts, s) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (s <= len || i === pts.length - 2) {
      const t = Math.min(1, s / len);
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / len, tz: (bz - az) / len };
    }
    s -= len;
  }
  return null;
}
function polyLength(pts) {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return L;
}
function distToPoly(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

/** Unit gable roof: slopes across x, ridge along z at y = 1, eaves at y = 0. */
function makeRoofGeometry() {
  const pos = [], uv = [], idx = [];
  const quad = (a, b, c, d, ua, ub, uc, ud) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(...ua, ...ub, ...uc, ...ud);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  // left slope (-x), right slope (+x); u along the ridge, v eave -> ridge
  quad([-0.5, 0, 0.5], [-0.5, 0, -0.5], [0, 1, -0.5], [0, 1, 0.5], [0, 0], [1, 0], [1, 1], [0, 1]);
  quad([0.5, 0, -0.5], [0.5, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5], [0, 0], [1, 0], [1, 1], [0, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Unit gable-end triangles at z = +-0.5 (filled with wall material). */
function makeGableGeometry() {
  const pos = [
    -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
    0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, -0.5,
  ];
  const uv = [0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Canvas textures
// ---------------------------------------------------------------------------
function canvasTex(renderer, draw, srgb = true, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function plaster(ctx, S, rand, base = 232) {
  ctx.fillStyle = `rgb(${base},${base - 3},${base - 9})`;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 2600; i++) {
    const v = (rand() - 0.5) * 22;
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 120})`;
    const r = 1 + rand() * 4;
    ctx.fillRect(rand() * S, rand() * S, r, r);
  }
  // damp plinth and soft grime under the eaves
  let g = ctx.createLinearGradient(0, S, 0, S * 0.82);
  g.addColorStop(0, 'rgba(70,64,56,0.55)'); g.addColorStop(0.35, 'rgba(70,64,56,0.35)'); g.addColorStop(0.36, 'rgba(70,64,56,0.08)'); g.addColorStop(1, 'rgba(70,64,56,0)');
  ctx.fillStyle = g; ctx.fillRect(0, S * 0.82, S, S * 0.18);
  g = ctx.createLinearGradient(0, 0, 0, S * 0.12);
  g.addColorStop(0, 'rgba(60,55,50,0.28)'); g.addColorStop(1, 'rgba(60,55,50,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S * 0.12);
}

/** Window in canvas units (x, y = top-left). emissive: draw only the lit glass. */
function windowAt(ctx, x, y, w, h, emissive, lit) {
  if (emissive) {
    if (lit) { ctx.fillStyle = '#ffd9a0'; ctx.fillRect(x + w * 0.1, y + h * 0.08, w * 0.8, h * 0.84); }
    return;
  }
  ctx.fillStyle = '#efe9df'; ctx.fillRect(x - w * 0.08, y + h, w * 1.16, h * 0.07); // sill
  ctx.fillStyle = '#4d3a2a'; ctx.fillRect(x, y, w, h);                              // frame
  const gx = x + w * 0.1, gy = y + h * 0.08, gw = w * 0.8, gh = h * 0.84;
  const g = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
  g.addColorStop(0, '#5d7484'); g.addColorStop(0.5, '#2a3742'); g.addColorStop(1, '#1d262e');
  ctx.fillStyle = g; ctx.fillRect(gx, gy, gw, gh);
  ctx.fillStyle = '#4d3a2a';
  ctx.fillRect(x + w * 0.47, gy, w * 0.06, gh);
  ctx.fillRect(gx, y + h * 0.45, gw, h * 0.05);
  // shutters
  ctx.fillStyle = 'rgba(60,82,64,0.9)';
  ctx.fillRect(x - w * 0.42, y, w * 0.36, h); ctx.fillRect(x + w * 1.06, y, w * 0.36, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 2;
  for (let k = 1; k < 7; k++) {
    const yy = y + (h * k) / 7;
    ctx.beginPath(); ctx.moveTo(x - w * 0.42, yy); ctx.lineTo(x - w * 0.06, yy); ctx.moveTo(x + w * 1.06, yy); ctx.lineTo(x + w * 1.42, yy); ctx.stroke();
  }
}

function doorAt(ctx, x, y, w, h, emissive) {
  if (emissive) return;
  ctx.fillStyle = '#e4ddd0'; ctx.fillRect(x - w * 0.12, y - h * 0.06, w * 1.24, h * 1.06);
  ctx.fillStyle = '#6b4329'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
  ctx.strokeRect(x + w * 0.15, y + h * 0.08, w * 0.7, h * 0.36);
  ctx.strokeRect(x + w * 0.15, y + h * 0.52, w * 0.7, h * 0.4);
  ctx.fillStyle = '#c9a54a'; ctx.beginPath(); ctx.arc(x + w * 0.82, y + h * 0.55, w * 0.05, 0, Math.PI * 2); ctx.fill();
}

/**
 * Wall faces for one- and two-storey houses. Face width is stretched over the
 * house side, so openings are laid out as fractions of the face.
 */
function makeWallSet(renderer, storeys, seed) {
  const faces = {};
  for (const face of ['front', 'side', 'back']) {
    for (const emissive of [false, true]) {
      const rand = mulberry32(seed + face.length * 31);
      faces[face + (emissive ? 'E' : '')] = canvasTex(renderer, (ctx, S) => {
        if (emissive) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S); } else plaster(ctx, S, rand);
        const lr = mulberry32(seed * 7 + face.length);
        const rows = storeys === 2 ? [S * 0.12, S * 0.6] : [S * 0.3];
        const wh = storeys === 2 ? S * 0.22 : S * 0.38;
        const ww = S * (storeys === 2 ? 0.13 : 0.14);
        rows.forEach((ry, ri) => {
          const ground = ri === rows.length - 1;
          let cols;
          if (face === 'front') cols = ground ? [0.7] : [0.28, 0.7];
          else if (face === 'side') cols = [0.5];
          else cols = [0.3, 0.7];
          for (const cx of cols) windowAt(ctx, S * cx - ww / 2, ry, ww, wh, emissive, lr() < 0.65);
        });
        if (face === 'front') {
          const dh = storeys === 2 ? S * 0.36 : S * 0.66;
          doorAt(ctx, S * 0.28 - S * 0.07, S - dh - S * 0.04, S * 0.14, dh, emissive);
        }
      }, !emissive);
    }
  }
  faces.plain = canvasTex(renderer, (ctx, S) => plaster(ctx, S, mulberry32(seed + 99)));
  return faces;
}

function makeBarnSet(renderer) {
  const planks = (door) => canvasTex(renderer, (ctx, S) => {
    const rand = mulberry32(door ? 51 : 52);
    ctx.fillStyle = '#d8d2c8'; ctx.fillRect(0, 0, S, S);
    const n = 22;
    for (let i = 0; i < n; i++) {
      const v = 200 + rand() * 40;
      ctx.fillStyle = `rgb(${v},${v - 6},${v - 12})`;
      ctx.fillRect((i * S) / n, 0, S / n - 2, S);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(((i + 1) * S) / n - 2, 0, 2, S);
    }
    ctx.fillStyle = 'rgba(40,30,20,0.35)'; ctx.fillRect(0, S * 0.9, S, S * 0.1);
    if (door) {
      const x = S * 0.3, w = S * 0.4, y = S * 0.25;
      ctx.fillStyle = '#5a3a22'; ctx.fillRect(x, y, w, S - y);
      ctx.strokeStyle = '#efe7da'; ctx.lineWidth = 8;
      ctx.strokeRect(x, y, w, S - y);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w / 2, S); ctx.lineTo(x + w, y);
      ctx.moveTo(x, S); ctx.lineTo(x + w / 2, y); ctx.lineTo(x + w, S); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, S); ctx.stroke();
    }
  });
  const side = planks(false);
  const black = canvasTex(renderer, (ctx, S) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S); }, false, 4);
  return { front: planks(true), side, back: side, plain: side, frontE: black, sideE: black, backE: black };
}

function makeRoofTexture(renderer) {
  return canvasTex(renderer, (ctx, S) => {
    const rand = mulberry32(606);
    ctx.fillStyle = '#cfcfcf'; ctx.fillRect(0, 0, S, S);
    const rows = 14, cols = 18;
    for (let r = 0; r < rows; r++) {
      const y0 = S - ((r + 1) * S) / rows;
      const off = (r % 2) * 0.5;
      for (let c = -1; c < cols + 1; c++) {
        const x0 = ((c + off) * S) / cols;
        const v = 175 + rand() * 70;
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(x0 + 1, y0, S / cols - 2, S / rows);
        const g = ctx.createLinearGradient(0, y0, 0, y0 + S / rows);
        g.addColorStop(0, 'rgba(0,0,0,0.38)'); g.addColorStop(0.25, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(255,255,255,0.12)');
        ctx.fillStyle = g; ctx.fillRect(x0 + 1, y0, S / cols - 2, S / rows);
      }
    }
    // weathering streaks
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(40,45,30,${rand() * 0.12})`;
      ctx.fillRect(rand() * S, 0, 2 + rand() * 10, S);
    }
  });
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const WALL_COLS = [0xf3eee2, 0xefe3c4, 0xe9d6b8, 0xdfe6e8, 0xf0dccf, 0xe6e0d2, 0xd9c8a9, 0xc9d6c2, 0xf5f1ea, 0xe8c9a6];
const ROOF_COLS = [0xb0532f, 0x9c4a2c, 0xc0673d, 0x5a5c60, 0x3f4247, 0x6b4a36, 0x8a3b2b, 0x4d5e4c];
const BARN_COLS = [0x8e2f24, 0x7a2a20, 0x6d5a45, 0x9a3a28];

function makeHouse(rand, x, z, y, rot, opts = {}) {
  const barn = !!opts.barn;
  const storeys = barn ? 1 : (opts.storeys || (rand() < 0.4 ? 2 : 1));
  const w = opts.w || (barn ? 9 + rand() * 3 : 7 + rand() * 3);
  const d = opts.d || (barn ? 14 + rand() * 5 : 7.5 + rand() * 3);
  const wallH = barn ? 4.6 + rand() * 1.2 : storeys === 2 ? 5.7 : 3.0;
  const ridgeX = barn ? false : rand() < 0.6; // ridge parallel to the street front
  const span = ridgeX ? d : w;
  const roofH = span * (barn ? 0.42 : 0.32 + rand() * 0.12);
  const hex = (arr) => arr[Math.floor(rand() * arr.length)];
  return {
    x, z, y, rot, w, d, wallH, roofH, ridgeX, storeys, barn,
    type: barn ? 'barn' : storeys === 2 ? 'h2' : 'h1',
    wallCol: barn ? hex(BARN_COLS) : hex(WALL_COLS),
    roofCol: barn ? (rand() < 0.5 ? 0x55585c : 0x6b4a36) : hex(ROOF_COLS),
    chimney: !barn && rand() < 0.7,
    cos: Math.cos(rot), sin: Math.sin(rot),
    rad: Math.hypot(w, d) / 2 + 0.6,
  };
}

function overlaps(list, h, gap = 2) {
  return list.some((o) => Math.hypot(o.x - h.x, o.z - h.z) < o.rad + h.rad + gap);
}

/** Base height under a footprint: lowest corner, so no wall floats above a slope. */
function footprintBase(world, x, z, rad) {
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const h = world.heightAt(x + a * rad * 0.7, z + b * rad * 0.7);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { base: lo - 0.15, spread: hi - lo };
}

function layoutResidentialBlock(world, b, rand, out, TOWN_H) {
  const setback = 3.5;
  const depth = b.z1 - b.z0;
  const rows = depth > 2 * (11 + setback) + 6 ? [-1, 1] : [-1];
  for (const side of rows) {
    let cur = b.x0 + 2 + rand() * 3;
    while (true) {
      const w = 7.5 + rand() * 3, d = 8 + rand() * 3;
      if (cur + w > b.x1 - 2) break;
      const x = cur + w / 2;
      cur += w + 3 + rand() * 3.5;
      if (rand() < 0.06) continue; // empty plot
      const front = side < 0 ? b.z0 : b.z1;
      const z = front - side * (setback + d / 2 + rand() * 1.5);
      const rot = side < 0 ? Math.PI : 0; // front (+z local) faces the road
      const h = makeHouse(rand, x, z, TOWN_H, rot, { w, d });
      if (overlaps(out.houses, h, 1.5)) continue;
      out.houses.push(h);
      // gravel drive from the front door to the kerb
      // the door is drawn at 28% across the front face (local -x side)
      const dx = x + w * 0.22 * (side < 0 ? 1 : -1);
      out.driveways.push({ x0: dx - 1.3, x1: dx + 1.3, z0: Math.min(front, z), z1: Math.max(front, z) });
      // garden trees behind the house
      const nt = rand() < 0.75 ? 1 + Math.floor(rand() * 2) : 0;
      for (let i = 0; i < nt; i++) {
        out.trees.push({ x: x + (rand() - 0.5) * w, z: z - side * (d / 2 + 3 + rand() * 4), kind: rand() < 0.2 ? 0 : 1, s: 0.45 + rand() * 0.3 });
      }
    }
  }
  // Houses along the two side streets, between the front rows
  for (const side of [-1, 1]) {
    let cur = b.z0 + 17 + rand() * 3;
    while (true) {
      const w = 7.5 + rand() * 3, d = 8 + rand() * 3;
      if (cur + w > b.z1 - 17) break;
      const z = cur + w / 2;
      cur += w + 3 + rand() * 3.5;
      if (rand() < 0.08) continue;
      const front = side < 0 ? b.x0 : b.x1;
      const x = front - side * (setback + d / 2 + rand() * 1.5);
      const h = makeHouse(rand, x, z, TOWN_H, side < 0 ? -Math.PI / 2 : Math.PI / 2, { w, d });
      if (overlaps(out.houses, h, 1.5)) continue;
      out.houses.push(h);
      // door at local x = -0.22 w; local +x maps to world +z when facing -x, -z when facing +x
      const dz = z + w * 0.22 * (side < 0 ? -1 : 1);
      out.driveways.push({ x0: Math.min(front, x), x1: Math.max(front, x), z0: dz - 1.3, z1: dz + 1.3 });
      if (rand() < 0.7) out.trees.push({ x: x - side * (d / 2 + 3 + rand() * 4), z: z + (rand() - 0.5) * w, kind: 1, s: 0.45 + rand() * 0.3 });
    }
  }
}

function layoutVillage(world, v, rand, out, townEnds) {
  const dir = [Math.cos(v.ang), Math.sin(v.ang)];
  const perp = [-dir[1], dir[0]];
  const street = (len, d, p, wob) => {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6 * 2 - 1;
      const off = Math.sin(t * 2.2 + wob) * v.r * 0.08;
      pts.push([v.x + d[0] * t * len / 2 + p[0] * off, v.z + d[1] * t * len / 2 + p[1] * off]);
    }
    return pts;
  };
  const streets = [street(v.r * 2, dir, perp, rand() * 6)];
  if (v.r >= 100) streets.push(street(v.r * 1.3, perp, dir, rand() * 6));
  for (const s of streets) out.roads.push({ pts: s, w: STREET_W });

  const vHouses = [];
  streets.forEach((pts, si) => {
    const L = polyLength(pts);
    for (let s = 10 + rand() * 6; s < L - 10; s += 12 + rand() * 8) {
      const p = polyPoint(pts, s);
      const nx = -p.tz, nz = p.tx;
      for (const side of [-1, 1]) {
        if (rand() < 0.22) continue;
        const d = 7.5 + rand() * 3;
        const off = STREET_W / 2 + 2.5 + rand() * 3 + d / 2;
        const x = p.x + nx * side * off, z = p.z + nz * side * off;
        if (Math.hypot(x - v.x, z - v.z) > v.r * 1.02) continue;
        if (streets.some((o, oi) => oi !== si && distToPoly(o, x, z) < d / 2 + 6)) continue;
        const fx = -nx * side, fz = -nz * side;
        const h = makeHouse(rand, x, z, 0, Math.atan2(fx, fz), { d });
        const fb = footprintBase(world, x, z, h.rad);
        h.y = fb.base;
        if (overlaps(vHouses, h)) continue;
        vHouses.push(h);
        out.yards.push({ x, z, r: h.rad * 1.5, a: 0.55 });
        if (rand() < 0.8) {
          const bx = x - fx * (h.d / 2 + 4 + rand() * 5) + (rand() - 0.5) * 6;
          const bz = z - fz * (h.d / 2 + 4 + rand() * 5) + (rand() - 0.5) * 6;
          out.trees.push({ x: bx, z: bz, kind: rand() < 0.15 ? 0 : 1, s: 0.5 + rand() * 0.35 });
        }
      }
    }
  });

  // Farmsteads on the edge: farmhouse + barn + yard, tracked back to the main street
  const nFarms = 2 + Math.floor(rand() * 2);
  for (let f = 0; f < nFarms; f++) {
    const a = rand() * Math.PI * 2;
    const dist = v.r * (1.2 + rand() * 0.3);
    const x = v.x + Math.cos(a) * dist, z = v.z + Math.sin(a) * dist;
    if (world.slopeAt(x, z) > 0.22 || world.heightAt(x, z) < 2) continue;
    const toC = Math.atan2(v.x - x, v.z - z);
    const house = makeHouse(rand, x, z, 0, toC, { storeys: 2 });
    house.y = footprintBase(world, x, z, house.rad).base;
    const bx = x + Math.cos(toC) * 16, bz = z - Math.sin(toC) * 16;
    const barn = makeHouse(rand, bx, bz, 0, toC + Math.PI / 2, { barn: true });
    barn.y = footprintBase(world, bx, bz, barn.rad).base;
    if (overlaps(vHouses, house, 6) || overlaps(vHouses, barn, 6)) continue;
    vHouses.push(house, barn);
    out.yards.push({ x: (x + bx) / 2, z: (z + bz) / 2, r: 20, a: 0.8 });
    // nearest point on the main street
    const main = streets[0];
    let best = null, bd = Infinity;
    for (let s = 0; s < polyLength(main); s += 4) {
      const p = polyPoint(main, s);
      const dd = Math.hypot(p.x - x, p.z - z);
      if (dd < bd) { bd = dd; best = p; }
    }
    out.roads.push({ pts: [[x, z], [(x + best.x) / 2 + (rand() - 0.5) * 12, (z + best.z) / 2 + (rand() - 0.5) * 12], [best.x, best.z]], w: TRACK_W });
    out.farms.push({ x, z, ang: toC });
  }
  out.houses.push(...vHouses);

  // Dirt road from the nearest town road end to the nearest end of the main street
  const main = streets[0];
  let bestEnd = null, bestTown = null, bd = Infinity;
  for (const e of [main[0], main[main.length - 1]]) {
    for (const t of townEnds) {
      const dd = Math.hypot(e[0] - t.x, e[1] - t.z);
      if (dd < bd) { bd = dd; bestEnd = e; bestTown = t; }
    }
  }
  const out0 = [bestTown.x + bestTown.dx * 30, bestTown.z + bestTown.dz * 30];
  const pts = [[bestTown.x - bestTown.dx * 2, bestTown.z - bestTown.dz * 2], out0];
  const n = 8;
  const ex = bestEnd[0] - out0[0], ez = bestEnd[1] - out0[1];
  const el = Math.hypot(ex, ez), px = -ez / el, pz = ex / el;
  const wob = rand() * 6;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const off = Math.sin(t * Math.PI * 2 + wob) * Math.min(60, el * 0.08) * Math.sin(t * Math.PI);
    pts.push([out0[0] + ex * t + px * off, out0[1] + ez * t + pz * off]);
  }
  pts.push(bestEnd);
  out.roads.push({ pts, w: STREET_W - 0.6 });

  // Crop fields around the village
  const fields = [];
  for (let i = 0, tries = 0; i < 18 && tries < 260; tries++) {
    const a = rand() * Math.PI * 2;
    const dist = v.r * (1.1 + rand() * 1.4);
    const cx = v.x + Math.cos(a) * dist, cz = v.z + Math.sin(a) * dist;
    const fw = 35 + rand() * 50, fd = 28 + rand() * 40;
    const f = { x0: cx - fw / 2, x1: cx + fw / 2, z0: cz - fd / 2, z1: cz + fd / 2, type: rand() < 0.5 ? 0 : 1 };
    let lo = Infinity, hi = -Infinity, ok = true;
    for (const [x, z] of [[cx, cz], [f.x0, f.z0], [f.x1, f.z0], [f.x0, f.z1], [f.x1, f.z1]]) {
      const h = world.heightAt(x, z);
      if (h < 2) ok = false;
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (!ok || hi - lo > 14 || world.slopeAt(cx, cz) > 0.3) continue;
    if (Math.max(Math.abs(cx), Math.abs(cz)) < 300) continue;
    const pad = 6;
    if (out.houses.concat(vHouses).some((h) => h.x > f.x0 - pad - h.rad && h.x < f.x1 + pad + h.rad && h.z > f.z0 - pad - h.rad && h.z < f.z1 + pad + h.rad)) continue;
    if (fields.some((o) => f.x0 < o.x1 + 3 && f.x1 > o.x0 - 3 && f.z0 < o.z1 + 3 && f.z1 > o.z0 - 3)) continue;
    fields.push(f);
    i++;
  }
  out.fields.push(...fields);
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------
function buildHouseMeshes(world, houses) {
  const r = world.renderer;
  const roofTex = makeRoofTexture(r);
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.82, side: THREE.DoubleSide });
  const chimneyMat = new THREE.MeshStandardMaterial({ color: 0x8a5a44, roughness: 0.9 });
  const sets = { h1: makeWallSet(r, 1, 11), h2: makeWallSet(r, 2, 23), barn: makeBarnSet(r) };
  world.houseWinMats = [];

  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roofGeo = makeRoofGeometry();
  const gableGeo = makeGableGeometry();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const finish = (im) => { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); world.scene.add(im); };

  for (const [type, set] of Object.entries(sets)) {
    const list = houses.filter((h) => h.type === type);
    if (!list.length) continue;
    const mk = (face) => {
      const mat = new THREE.MeshStandardMaterial({ map: set[face], roughness: 0.92 });
      if (set[face + 'E']) {
        mat.emissiveMap = set[face + 'E'];
        mat.emissive = new THREE.Color(0xffc988);
        mat.emissiveIntensity = 0;
        world.houseWinMats.push(mat);
      }
      return mat;
    };
    const plain = new THREE.MeshStandardMaterial({ map: set.plain, roughness: 0.92 });
    const side = mk('side');
    // BoxGeometry groups: +x, -x, +y, -y, +z (front), -z (back)
    const walls = new THREE.InstancedMesh(box, [side, side, plain, plain, mk('front'), mk('back')], list.length);
    const gables = new THREE.InstancedMesh(gableGeo, plain, list.length);
    const roofs = new THREE.InstancedMesh(roofGeo, roofMat, list.length);
    const chimneys = list.filter((h) => h.chimney);
    const chim = chimneys.length ? new THREE.InstancedMesh(box, chimneyMat, chimneys.length) : null;
    let ci = 0;
    list.forEach((h, i) => {
      q.setFromAxisAngle(up, h.rot);
      m.compose(p.set(h.x, h.y, h.z), q, s.set(h.w, h.wallH + 0.15, h.d));
      walls.setMatrixAt(i, m);
      walls.setColorAt(i, col.setHex(h.wallCol, THREE.SRGBColorSpace));
      const eave = h.y + h.wallH + 0.15;
      const roofRot = h.ridgeX ? h.rot + Math.PI / 2 : h.rot;
      const along = h.ridgeX ? h.w : h.d;   // ridge length
      const across = h.ridgeX ? h.d : h.w;  // roof span
      q.setFromAxisAngle(up, roofRot);
      m.compose(p.set(h.x, eave, h.z), q, s.set(across, h.roofH, along));
      gables.setMatrixAt(i, m);
      gables.setColorAt(i, col.setHex(h.wallCol, THREE.SRGBColorSpace));
      const o = h.barn ? 0.5 : 0.6; // overhang
      // roof sits a hair above the gable edges so the gable never pokes through
      m.compose(p.set(h.x, eave + 0.05 - (o * h.roofH * 2) / across, h.z), q, s.set(across + 2 * o, h.roofH * (1 + (2 * o) / across), along + 2 * o));
      roofs.setMatrixAt(i, m);
      roofs.setColorAt(i, col.setHex(h.roofCol, THREE.SRGBColorSpace));
      if (h.chimney) {
        // on the ridge, a third of the way along it
        const lz = along * 0.28 * (h.x > 0 ? 1 : -1);
        const sn = Math.sin(roofRot), cs = Math.cos(roofRot);
        const cx = h.x + lz * sn, cz = h.z + lz * cs;
        const y0 = eave + h.roofH * 0.45;
        q.setFromAxisAngle(up, roofRot);
        m.compose(p.set(cx, y0, cz), q, s.set(0.6, h.roofH * 0.55 + 0.9, 0.7));
        chim.setMatrixAt(ci++, m);
      }
    });
    finish(walls); finish(gables); finish(roofs);
    if (chim) finish(chim);
  }
}

// ---------------------------------------------------------------------------
// Rural ground mask: R = dirt roads, G = worn yards, B = field type A, A = field type B
// ---------------------------------------------------------------------------
function buildRuralMask(world, out, SIZE) {
  const S = RURAL_RES, HALF = SIZE / 2, k = S / SIZE;
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.setTransform(k, 0, 0, k, HALF * k, HALF * k);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    return { c, ctx };
  };
  const R = layer();
  for (const rd of out.roads) {
    R.ctx.lineWidth = rd.w;
    R.ctx.beginPath();
    rd.pts.forEach(([x, z], i) => (i ? R.ctx.lineTo(x, z) : R.ctx.moveTo(x, z)));
    R.ctx.stroke();
  }
  const G = layer();
  for (const y of out.yards) {
    const g = G.ctx.createRadialGradient(y.x, y.z, 0, y.x, y.z, y.r);
    g.addColorStop(0, `rgba(255,255,255,${y.a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    G.ctx.fillStyle = g;
    G.ctx.fillRect(y.x - y.r, y.z - y.r, y.r * 2, y.r * 2);
  }
  const FA = layer(), FB = layer();
  for (const f of out.fields) (f.type ? FB : FA).ctx.fillRect(f.x0, f.z0, f.x1 - f.x0, f.z1 - f.z0);

  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = S;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  const read = (L, blur) => {
    tctx.filter = blur ? `blur(${blur}px)` : 'none';
    tctx.clearRect(0, 0, S, S);
    tctx.drawImage(L.c, 0, 0);
    return tctx.getImageData(0, 0, S, S).data;
  };
  const r = read(R, 0.8), g = read(G, 0), b = read(FA, 0.6), a = read(FB, 0.6);
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = r[i * 4]; data[i * 4 + 1] = g[i * 4]; data[i * 4 + 2] = b[i * 4]; data[i * 4 + 3] = a[i * 4];
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(8, world.renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return { tex, data, size: S };
}

/** Rural mask sample (0..255 per channel) at a world position. */
export function ruralAt(world, x, z) {
  const rm = world.ruralMask;
  if (!rm) return null;
  const HALF = world.half;
  const px = Math.floor(((x + HALF) / (HALF * 2)) * rm.size);
  const pz = Math.floor(((z + HALF) / (HALF * 2)) * rm.size);
  if (px < 0 || pz < 0 || px >= rm.size || pz >= rm.size) return null;
  const i = (pz * rm.size + px) * 4;
  return rm.data.subarray(i, i + 4);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * Lays out the residential quarter and villages, builds their meshes and the
 * rural ground mask. Must run after the town (residential blocks) and before trees.
 */
export function buildVillages(world, { ROADS, TOWN_EDGE, ROAD_HALF, TOWN_H, SIZE }) {
  const rand = mulberry32(8080);
  const out = { houses: [], roads: [], yards: [], fields: [], trees: [], driveways: [], farms: [] };

  for (const b of world.residentialBlocks) layoutResidentialBlock(world, b, rand, out, TOWN_H);

  const E = TOWN_EDGE + ROAD_HALF;
  const townEnds = [];
  for (const r of ROADS) {
    townEnds.push({ x: E, z: r, dx: 1, dz: 0 }, { x: -E, z: r, dx: -1, dz: 0 });
    townEnds.push({ x: r, z: E, dx: 0, dz: 1 }, { x: r, z: -E, dx: 0, dz: -1 });
  }
  for (const v of VILLAGES) layoutVillage(world, v, rand, out, townEnds);

  buildHouseMeshes(world, out.houses);

  world.houses = out.houses;
  world.houseBoxes = out.houses.map((h) => ({ minX: h.x - h.rad, maxX: h.x + h.rad, minZ: h.z - h.rad, maxZ: h.z + h.rad }));
  world.villageRoads = out.roads;
  world.fields = out.fields;
  world.driveways = out.driveways;
  world.extraTrees = out.trees;
  world.ruralMask = buildRuralMask(world, out, SIZE);
  world.terrainUniforms.tRural.value = world.ruralMask.tex;
}

/** Oriented-box + gable-roof collision against one house. Fills `hit`, returns true on contact. */
export function collideHouse(h, p, r, hit) {
  const dx = p.x - h.x, dz = p.z - h.z;
  const lx = dx * h.cos - dz * h.sin;
  const lz = dx * h.sin + dz * h.cos;
  const eave = h.y + h.wallH + 0.15;
  const top = eave + h.roofH;
  if (p.y - r > top || p.y + r < h.y) return false;
  const cy = Math.max(h.y, Math.min(p.y, top));
  const k = cy > eave ? 1 - (cy - eave) / h.roofH : 1;
  // roof narrows toward the ridge across its span
  const hw = h.ridgeX ? h.w / 2 : (h.w / 2) * k;
  const hd = h.ridgeX ? (h.d / 2) * k : h.d / 2;
  const cx = Math.max(-hw, Math.min(lx, hw));
  const cz = Math.max(-hd, Math.min(lz, hd));
  const ex = lx - cx, ey = p.y - cy, ez = lz - cz;
  const d2 = ex * ex + ey * ey + ez * ez;
  if (d2 >= r * r) return false;
  let nx, ny, nz, depth;
  const d = Math.sqrt(d2);
  if (d > 1e-5) {
    nx = ex / d; ny = ey / d; nz = ez / d; depth = r - d;
  } else {
    const opts = [[lx + hw, -1, 0, 0], [hw - lx, 1, 0, 0], [lz + hd, 0, 0, -1], [hd - lz, 0, 0, 1], [top - p.y, 0, 1, 0]]
      .sort((a, b) => a[0] - b[0])[0];
    [, nx, ny, nz] = opts; depth = opts[0] + r;
  }
  // local -> world (rotation about y by h.rot)
  hit.normal.set(nx * h.cos + nz * h.sin, ny, -nx * h.sin + nz * h.cos).normalize();
  hit.depth = depth;
  hit.hit = true;
  hit.kind = h.barn ? 'barn' : 'house';
  return true;
}

/** Draws village roads, fields and houses onto the minimap canvas. */
export function drawVillageMinimap(world, ctx, px, scale) {
  ctx.save();
  for (const f of world.fields) {
    ctx.fillStyle = f.type ? '#6f8c3c' : '#c2a95e';
    ctx.fillRect(px(f.x0), px(f.z0), (f.x1 - f.x0) * scale, (f.z1 - f.z0) * scale);
  }
  ctx.strokeStyle = '#8f7a5a';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const rd of world.villageRoads) {
    ctx.lineWidth = Math.max(1, rd.w * scale * 1.2);
    ctx.beginPath();
    rd.pts.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), px(z)) : ctx.moveTo(px(x), px(z))));
    ctx.stroke();
  }
  for (const h of world.houses) {
    ctx.save();
    ctx.translate(px(h.x), px(h.z));
    ctx.rotate(-h.rot);
    ctx.fillStyle = '#' + h.roofCol.toString(16).padStart(6, '0');
    ctx.fillRect((-h.w / 2) * scale, (-h.d / 2) * scale, Math.max(1, h.w * scale), Math.max(1, h.d * scale));
    ctx.restore();
  }
  ctx.restore();
}
