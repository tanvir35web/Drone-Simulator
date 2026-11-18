// Heads-up display: telemetry, attitude indicator, stick monitor, minimap, toasts.
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class HUD {
  constructor(world) {
    this.world = world;
    this.el = {};
    for (const id of ['hud', 'h-armed', 'h-mode', 'h-view', 'h-input', 'h-profile', 'h-batt-bar', 'h-batt', 'h-volt', 'h-pwr',
      'h-time', 'h-wind', 'h-thr', 't-alt', 't-spd', 't-vs', 't-dist', 't-hdg', 'toast', 'crash', 'crash-reason', 'osd',
      'pip-frame', 'pip-label', 'hint', 'r-gate', 'r-lap', 'r-last', 'r-best', 'race']) this.el[id] = $(id);
    this.att = $('attitude').getContext('2d');
    this.sticksCtx = $('sticks').getContext('2d');
    this.map = $('minimap').getContext('2d');
    this.mapRange = 160; // metres from centre to edge
    this.lastText = {};
    this.frame = 0;
  }

  set(id, text) {
    if (this.lastText[id] !== text) { this.el[id].textContent = text; this.lastText[id] = text; }
  }

  toast(text, kind = '') {
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.textContent = text;
    this.el.toast.appendChild(d);
    while (this.el.toast.children.length > 4) this.el.toast.firstChild.remove();
    setTimeout(() => d.remove(), 3000);
  }

  setPip(rect, label) {
    const f = this.el['pip-frame'];
    if (!rect) { f.classList.add('hidden'); return; }
    f.classList.remove('hidden');
    Object.assign(f.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    this.set('pip-label', label);
  }

  update(s) {
    const { fm, sticks, viewName, viewId, inputName, wind, race } = s;
    this.frame++;
    const armed = fm.armed;
    const a = this.el['h-armed'];
    a.className = `badge ${armed ? 'on' : 'off'}`;
    this.set('h-armed', fm.crashed ? 'CRASHED' : armed ? (fm.rth ? 'RTH' : 'ARMED') : 'DISARMED');
    this.set('h-mode', fm.mode);
    this.set('h-view', viewName);
    this.set('h-input', inputName);
    this.set('h-profile', fm.p.name);

    const pct = Math.round(fm.soc * 100);
    this.el['h-batt-bar'].style.width = `${pct}%`;
    this.el['h-batt-bar'].style.background = pct > 30 ? 'var(--ok)' : pct > 15 ? 'var(--warn)' : 'var(--bad)';
    this.set('h-batt', `${pct}%`);
    this.set('h-volt', `${fm.voltage.toFixed(1)} V`);
    this.set('h-pwr', `${Math.round(fm.power)} W`);
    const t = Math.floor(fm.flightTime);
    this.set('h-time', `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    this.set('h-wind', `${wind.toFixed(1)} m/s`);

    const gh = this.world.heightAt(fm.pos.x, fm.pos.z);
    const agl = Math.max(0, fm.pos.y - fm.gear - gh);
    const hs = Math.hypot(fm.vel.x, fm.vel.z);
    _e.setFromQuaternion(fm.quat, 'YXZ');
    let hdg = Math.round(THREE.MathUtils.radToDeg(-_e.y)) % 360;
    if (hdg < 0) hdg += 360;
    this.set('t-alt', `${agl.toFixed(1)} m`);
    this.set('t-spd', `${Math.round(hs * 3.6)} km/h`);
    this.set('t-vs', `${fm.vel.y >= 0 ? '+' : ''}${fm.vel.y.toFixed(1)} m/s`);
    this.set('t-dist', `${Math.round(Math.hypot(fm.pos.x - fm.home.x, fm.pos.z - fm.home.z))} m`);
    this.set('t-hdg', `${String(hdg).padStart(3, '0')}°`);

    const thrAvg = (fm.motorT[0] + fm.motorT[1] + fm.motorT[2] + fm.motorT[3]) / (4 * fm.tMax);
    this.el['h-thr'].style.height = `${Math.round(Math.min(1, thrAvg) * 100)}%`;

    this.el.crash.classList.toggle('hidden', !fm.crashed);
    if (fm.crashed) this.set('crash-reason', fm.crashReason);
    this.el.osd.classList.toggle('hidden', !(viewId === 'fpv' || viewId === 'gimbal'));

    // race
    this.set('r-gate', `${race.next + 1}/${race.total}`);
    this.set('r-lap', race.lapStart !== null ? fmtTime(race.now - race.lapStart) : '--:--.-');
    this.set('r-last', race.last ? fmtTime(race.last) : '--');
    this.set('r-best', race.best ? fmtTime(race.best) : '--');

    // hints
    let hint = '';
    if (!fm.armed && !fm.crashed) hint = fm.mode === 'GPS' ? 'Press Space (or your Arm button) to arm, then push throttle up to take off'
      : 'Lower throttle fully, then press Space to arm';
    else if (fm.armed && fm.onGround && fm.mode === 'GPS') hint = 'Push throttle up (W) to take off';
    else if (fm.soc < 0.2 && fm.armed) hint = 'LOW BATTERY - land now (X = return to home)';
    this.set('hint', hint);

    this.drawAttitude(_e.x, _e.z);
    this.drawSticks(sticks);
    if (this.frame % 2 === 0) this.drawMap(fm, _e.y, s.gates, race.next);
  }

  drawAttitude(pitch, roll) {
    const c = this.att, W = 120, R = 56;
    c.clearRect(0, 0, W, W);
    c.save();
    c.translate(W / 2, W / 2);
    c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.clip();
    c.rotate(roll);
    const off = pitch * 90;
    c.fillStyle = '#3b7bc0'; c.fillRect(-R * 2, -R * 2 + off, R * 4, R * 2);
    c.fillStyle = '#7a5a36'; c.fillRect(-R * 2, off, R * 4, R * 2);
    c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(-R * 2, off); c.lineTo(R * 2, off); c.stroke();
    c.lineWidth = 1; c.font = '9px sans-serif'; c.fillStyle = '#fff';
    for (let d = -30; d <= 30; d += 10) {
      if (!d) continue;
      const y = off - (d * Math.PI / 180) * 90;
      const w = d % 20 === 0 ? 18 : 10;
      c.beginPath(); c.moveTo(-w, y); c.lineTo(w, y); c.stroke();
    }
    c.restore();
    c.save();
    c.translate(W / 2, W / 2);
    c.strokeStyle = '#ffb000'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(-28, 0); c.lineTo(-10, 0); c.lineTo(-5, 6); c.moveTo(28, 0); c.lineTo(10, 0); c.lineTo(5, 6); c.stroke();
    c.beginPath(); c.arc(0, 0, 2, 0, Math.PI * 2); c.fillStyle = '#ffb000'; c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.stroke();
    c.restore();
  }

  drawSticks(s) {
    const c = this.sticksCtx;
    c.clearRect(0, 0, 220, 100);
    const box = (x, sx, sy) => {
      c.strokeStyle = 'rgba(255,255,255,0.3)'; c.lineWidth = 1;
      c.strokeRect(x, 6, 88, 88);
      c.beginPath(); c.moveTo(x + 44, 6); c.lineTo(x + 44, 94); c.moveTo(x, 50); c.lineTo(x + 88, 50); c.stroke();
      c.fillStyle = '#ff7a1a';
      c.beginPath(); c.arc(x + 44 + sx * 40, 50 - sy * 40, 6, 0, Math.PI * 2); c.fill();
    };
    box(8, s.yaw, s.thr);
    box(122, s.roll, s.pitch);
  }

  drawMap(fm, yaw, gates, nextGate) {
    const c = this.map, S = 180, w = this.world;
    const range = this.mapRange;
    const sc = w.minimapScale;
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath(); c.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); c.clip();
    const sx = (fm.pos.x - range + w.minimapHalf) * sc;
    const sz = (fm.pos.z - range + w.minimapHalf) * sc;
    c.fillStyle = '#223';
    c.fillRect(0, 0, S, S);
    c.imageSmoothingEnabled = true;
    c.drawImage(w.minimap, sx, sz, range * 2 * sc, range * 2 * sc, 0, 0, S, S);
    const toMap = (x, z) => [S / 2 + ((x - fm.pos.x) / range) * (S / 2), S / 2 + ((z - fm.pos.z) / range) * (S / 2)];
    // gates
    gates.forEach((g, i) => {
      const [gx, gz] = toMap(g.center.x, g.center.z);
      c.fillStyle = i === nextGate ? '#3ddc84' : '#ff7a1a';
      c.beginPath(); c.arc(gx, gz, i === nextGate ? 4 : 2.5, 0, Math.PI * 2); c.fill();
    });
    // home
    const [hx, hz] = toMap(fm.home.x, fm.home.z);
    c.fillStyle = '#ffd400'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('H', Math.max(8, Math.min(S - 8, hx)), Math.max(8, Math.min(S - 8, hz)));
    // drone arrow
    c.translate(S / 2, S / 2);
    c.rotate(-yaw);
    c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, -9); c.lineTo(6, 7); c.lineTo(0, 3); c.lineTo(-6, 7); c.closePath(); c.fill(); c.stroke();
    c.restore();
    // north marker
    c.fillStyle = 'rgba(255,255,255,0.85)'; c.font = 'bold 11px sans-serif'; c.textAlign = 'center';
    c.fillText('N', S / 2, 12);
  }
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
