// Settings persistence and the settings menu.
import { PROFILES, MODES } from './flight.js';
import { CHANNELS, CHANNEL_LABELS, ACTIONS, ACTION_LABELS } from './input.js';

const KEY = 'dronesim.settings.v1';

export const DEFAULTS = {
  profile: 'camera', mode: 'GPS', expo: 0.3, smoothing: 0.5, kbAmount: 0.6, throttleMid: true, maxAngle: 0, acroRate: 0, fpvTilt: 20,
  wind: 3, windDir: 250, gust: 0.4,
  sunElev: 38, sunAz: 135, fog: 2.8, clouds: 0.35,
  shadows: 2, pixelRatio: 1.5, waterRefl: true, grass: 2, sound: true, volume: 0.6, pip: false,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* storage unavailable */ }
  return { ...DEFAULTS };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};

export class Menu {
  constructor({ settings, input, apply }) {
    this.settings = settings;
    this.input = input;
    this.apply = apply; // (key) => void
    this.root = document.getElementById('menu');
    this.body = document.getElementById('menu-body');
    this.tabsEl = document.getElementById('tabs');
    this.tab = 'flight';
    this.live = null;
    this.tabs = { flight: 'Flight', controls: 'Controls', environment: 'Environment', graphics: 'Graphics & sound' };
    document.getElementById('menu-close').addEventListener('click', () => this.close());
    this.renderTabs();
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }
  open() { this.root.classList.remove('hidden'); this.render(); }
  close() { this.root.classList.add('hidden'); this.input.learn = null; }
  toggle() { this.isOpen ? this.close() : this.open(); }

  renderTabs() {
    this.tabsEl.innerHTML = '';
    for (const [k, label] of Object.entries(this.tabs)) {
      this.tabsEl.append(el('button', { class: `btn ${this.tab === k ? 'active' : ''}`, onclick: () => { this.tab = k; this.renderTabs(); this.render(); } }, label));
    }
  }

  set(key, value) {
    this.settings[key] = value;
    saveSettings(this.settings);
    this.apply(key);
  }

  slider(label, key, min, max, step, fmt = (v) => v) {
    const val = el('span', { class: 'val' }, fmt(this.settings[key]));
    const inp = el('input', { type: 'range', min, max, step, value: this.settings[key] });
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = fmt(v); this.set(key, v); });
    return el('div', { class: 'field' }, el('label', {}, label), inp, val);
  }

  select(label, key, options, note = '') {
    const s = el('select');
    for (const [v, t] of options) {
      const o = el('option', { value: v }, t);
      if (String(this.settings[key]) === String(v)) o.selected = true;
      s.append(o);
    }
    s.addEventListener('change', () => {
      const raw = s.value;
      const num = Number(raw);
      this.set(key, raw !== '' && !Number.isNaN(num) && typeof this.settings[key] === 'number' ? num : raw);
    });
    return el('div', { class: 'field' }, el('label', {}, label), s, el('span', { class: 'val' }, note));
  }

  check(label, key) {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!this.settings[key];
    c.addEventListener('change', () => this.set(key, c.checked));
    return el('div', { class: 'field' }, el('label', {}, label), el('div', {}, c), el('span'));
  }

  render() {
    this.live = null;
    this.body.innerHTML = '';
    const b = this.body;
    if (this.tab === 'flight') {
      b.append(
        this.select('Drone', 'profile', Object.entries(PROFILES).map(([k, p]) => [k, p.name])),
        this.select('Flight mode', 'mode', MODES.map((m) => [m, {
          GPS: 'GPS - position & altitude hold (beginner)',
          ANGLE: 'Angle - self-levelling, manual throttle',
          ACRO: 'Acro - rate mode, no self-levelling (expert)',
        }[m]])),
        this.slider('Control smoothing', 'smoothing', 0, 1, 0.05, (v) => (v < 0.25 ? 'snappy' : v > 0.75 ? 'cinematic' : 'normal')),
        this.slider('Keyboard stick amount (Shift = 100%)', 'kbAmount', 0.2, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
        this.slider('Stick expo', 'expo', 0, 0.9, 0.05, (v) => v.toFixed(2)),
        this.check('Throttle centre = hover (Angle/Acro)', 'throttleMid'),
        this.slider('Max tilt angle (0 = drone default)', 'maxAngle', 0, 75, 1, (v) => (v ? `${v}°` : 'auto')),
        this.slider('Acro rate (0 = drone default)', 'acroRate', 0, 1200, 10, (v) => (v ? `${v}°/s` : 'auto')),
        this.slider('FPV camera uptilt', 'fpvTilt', 0, 45, 1, (v) => `${v}°`),
        el('p', { class: 'muted' }, 'GPS mode holds position and height when you let go of the sticks. Angle mode keeps the drone level but you control height. Acro mode is how real FPV pilots fly: the stick sets rotation speed and the drone stays at whatever angle you leave it.'),
      );
    } else if (this.tab === 'environment') {
      b.append(
        this.slider('Wind speed', 'wind', 0, 15, 0.5, (v) => `${v} m/s`),
        this.slider('Wind from (bearing)', 'windDir', 0, 359, 1, (v) => `${v}°`),
        this.slider('Gusts / turbulence', 'gust', 0, 1, 0.05, (v) => v.toFixed(2)),
        this.slider('Sun elevation (time of day)', 'sunElev', -6, 85, 1, (v) => `${v}°`),
        this.slider('Sun direction', 'sunAz', 0, 359, 1, (v) => `${v}°`),
        this.slider('Haze / fog', 'fog', 0, 10, 0.1, (v) => v.toFixed(1)),
        this.slider('Cloud cover', 'clouds', 0, 1, 0.05, (v) => v.toFixed(2)),
      );
    } else if (this.tab === 'graphics') {
      b.append(
        this.select('Shadows', 'shadows', [[0, 'Off'], [1, 'Low (1024)'], [2, 'Medium (2048)'], [3, 'High (4096)']]),
        this.slider('Render resolution (pixel ratio cap)', 'pixelRatio', 0.5, 2, 0.25, (v) => `${v}x`),
        this.select('3D grass', 'grass', [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']]),
        this.check('Water reflections', 'waterRefl'),
        this.check('Picture-in-picture view', 'pip'),
        this.check('Motor sound', 'sound'),
        this.slider('Volume', 'volume', 0, 1, 0.05, (v) => v.toFixed(2)),
      );
    } else if (this.tab === 'controls') {
      this.renderControls(b);
    }
  }

  renderControls(b) {
    const inp = this.input;
    const pads = inp.listGamepads();
    const padSel = el('select');
    padSel.append(el('option', { value: -1 }, 'First connected'));
    for (const p of pads) {
      const o = el('option', { value: p.index }, `#${p.index}: ${p.id.slice(0, 60)}`);
      if (inp.config.gamepadIndex === p.index) o.selected = true;
      padSel.append(o);
    }
    padSel.addEventListener('change', () => { inp.config.gamepadIndex = Number(padSel.value); inp.save(); });
    b.append(el('div', { class: 'field' }, el('label', {}, 'Controller'), padSel,
      el('span', { class: 'val' }, pads.length ? `${pads.length} found` : 'none')));
    if (!pads.length) {
      b.append(el('p', { class: 'muted' }, 'No controller detected. Plug in a gamepad, joystick or USB RC transmitter (set it to USB joystick / HID mode) and press a button or move a stick - browsers only expose a controller after you interact with it.'));
    }

    b.append(el('div', { class: 'section-title' }, 'Stick channels'));
    b.append(el('p', { class: 'muted' }, 'Click "Learn", then push that stick UP (throttle, pitch) or RIGHT (yaw, roll). The axis and direction are detected automatically.'));
    const rows = {};
    for (const ch of CHANNELS) {
      const m = inp.config.channels[ch];
      const axisSel = el('select');
      for (let i = 0; i < Math.max(8, pads[0]?.axes.length || 0); i++) {
        const o = el('option', { value: i }, `Axis ${i}`);
        if (m.axis === i) o.selected = true;
        axisSel.append(o);
      }
      axisSel.addEventListener('change', () => { m.axis = Number(axisSel.value); inp.save(); });
      const inv = el('input', { type: 'checkbox' });
      inv.checked = m.invert;
      inv.addEventListener('change', () => { m.invert = inv.checked; inp.save(); });
      const bar = el('div', { class: 'axis-bar' }, el('div'));
      const learnBtn = el('button', { class: 'btn small', onclick: () => {
        if (inp.startLearn('axis', ch)) { learnBtn.textContent = 'Move stick...'; learnBtn.classList.add('active'); }
      } }, 'Learn');
      rows[ch] = { bar, learnBtn, axisSel, inv };
      b.append(el('div', { class: 'map-row' }, el('b', {}, CHANNEL_LABELS[ch]), axisSel,
        el('label', {}, inv, ' Invert'), bar, learnBtn));
    }

    b.append(el('div', { class: 'field' }, el('label', {}, 'Deadzone'),
      (() => {
        const r = el('input', { type: 'range', min: 0, max: 0.3, step: 0.01, value: inp.config.deadzone });
        r.addEventListener('input', () => { inp.config.deadzone = parseFloat(r.value); inp.save(); });
        return r;
      })(), el('span')));

    const calBtn = el('button', { class: 'btn', onclick: () => {
      if (inp.calibrating) { inp.finishCalibration(); calBtn.textContent = 'Calibrate sticks'; calBtn.classList.remove('active'); calNote.textContent = 'Calibration saved.'; }
      else if (inp.startCalibration()) { calBtn.textContent = 'Done - save calibration'; calBtn.classList.add('active'); calNote.textContent = 'Move every stick to all extremes, then centre them (throttle fully down) and click Done.'; }
    } }, 'Calibrate sticks');
    const calNote = el('span', { class: 'muted' }, 'Use for RC transmitters whose sticks do not reach full range.');
    b.append(el('div', { class: 'row', style: 'gap:10px;margin:10px 0' }, calBtn,
      el('button', { class: 'btn', onclick: () => { inp.config.cal = {}; inp.save(); calNote.textContent = 'Calibration cleared.'; } }, 'Clear calibration'),
      el('button', { class: 'btn', onclick: () => { inp.resetConfig(); this.render(); } }, 'Reset to defaults')));
    b.append(calNote);

    b.append(el('div', { class: 'section-title' }, 'Buttons'));
    const btnRows = {};
    for (const a of ACTIONS) {
      const label = el('span', { class: 'val', style: 'text-align:left' }, `Button ${inp.config.buttons[a]}`);
      const lb = el('button', { class: 'btn small', onclick: () => {
        if (inp.startLearn('button', a)) { lb.textContent = 'Press button...'; lb.classList.add('active'); }
      } }, 'Learn');
      btnRows[a] = { label, lb };
      b.append(el('div', { class: 'field' }, el('label', {}, ACTION_LABELS[a]), label, lb));
    }

    b.append(el('div', { class: 'section-title' }, 'Raw controller input'));
    const raw = el('div', { class: 'raw-axes' });
    const chips = el('div', { class: 'btn-chips' });
    b.append(raw, el('div', { style: 'height:8px' }), chips);

    this.live = () => {
      const gp = inp.pickGamepad();
      for (const ch of CHANNELS) {
        const v = gp ? inp.readChannel(gp, ch) : inp.sticks[ch];
        const bar = rows[ch].bar.firstChild;
        bar.style.left = `${50 + Math.min(0, v) * 50}%`;
        bar.style.width = `${Math.abs(v) * 50}%`;
        const m = inp.config.channels[ch];
        if (String(m.axis) !== rows[ch].axisSel.value) rows[ch].axisSel.value = String(m.axis);
        rows[ch].inv.checked = m.invert;
        if (!(inp.learn && inp.learn.target === ch)) { rows[ch].learnBtn.textContent = 'Learn'; rows[ch].learnBtn.classList.remove('active'); }
      }
      for (const a of ACTIONS) {
        btnRows[a].label.textContent = `Button ${inp.config.buttons[a]}`;
        if (!(inp.learn && inp.learn.target === a)) { btnRows[a].lb.textContent = 'Learn'; btnRows[a].lb.classList.remove('active'); }
      }
      if (!gp) { raw.textContent = 'No controller'; chips.textContent = ''; return; }
      if (raw.children.length !== gp.axes.length) {
        raw.innerHTML = '';
        gp.axes.forEach((_, i) => raw.append(el('div', {}, el('span', {}, `A${i}`), el('div', { class: 'axis-bar' }, el('div')))));
      }
      gp.axes.forEach((v, i) => {
        const bar = raw.children[i].children[1].firstChild;
        bar.style.left = `${50 + Math.min(0, v) * 50}%`;
        bar.style.width = `${Math.abs(v) * 50}%`;
      });
      if (chips.children.length !== gp.buttons.length) {
        chips.innerHTML = '';
        gp.buttons.forEach((_, i) => chips.append(el('span', {}, `B${i}`)));
      }
      gp.buttons.forEach((bt, i) => chips.children[i].classList.toggle('on', bt.pressed || bt.value > 0.5));
    };
  }

  update() {
    if (this.isOpen && this.live) this.live();
  }
}
