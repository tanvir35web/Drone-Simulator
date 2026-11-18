// Settings persistence and the settings menu.
import { PROFILES, MODES } from './flight.js';
import { CHANNELS, CHANNEL_LABELS, ACTIONS, ACTION_LABELS } from './input.js';

const KEY = 'dronesim.settings.v1';

export const DEFAULTS = {
  profile: 'camera', mode: 'GPS', expo: 0.3, smoothing: 0.5, kbAmount: 0.6, throttleMid: true, maxAngle: 0, acroRate: 0, fpvTilt: 20,
  wind: 3, windDir: 250, gust: 0.4,
  sunElev: 38, sunAz: 135, fog: 2.8, clouds: 0.35,
  shadows: 2, pixelRatio: 1.5, waterRefl: true, grass: 1, sound: true, volume: 0.6, pip: false,
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
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};

// Static, trusted SVG markup for the tab icons.
const svg = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  flight: svg('<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.2 8.2l2.3 2.3M15.8 8.2l-2.3 2.3M8.2 15.8l2.3-2.3M15.8 15.8l-2.3-2.3"/><rect x="10" y="10" width="4" height="4" rx="1"/>'),
  controls: svg('<path d="M7 7h10a5 5 0 0 1 4.9 6l-.8 3.6a2.5 2.5 0 0 1-4.3 1.1L14.5 15h-5l-2.3 2.7a2.5 2.5 0 0 1-4.3-1.1L2.1 13A5 5 0 0 1 7 7z"/><path d="M7 10v3M5.5 11.5h3"/><circle cx="16" cy="10.5" r=".6"/><circle cx="17.5" cy="12.5" r=".6"/>'),
  environment: svg('<circle cx="9" cy="8" r="3"/><path d="M9 2v1.2M3 8h1.2M4.8 3.8l.9.9M13.2 3.8l-.9.9"/><path d="M8 20h9.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.3A2.9 2.9 0 0 0 8 20z"/>'),
  graphics: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M7 12l3-3 2 2 3-3 2 2"/>'),
};
const RESET_ICON = svg('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>');

const TABS = {
  flight: { label: 'Flight', desc: 'Aircraft, flight mode and how the sticks feel.' },
  controls: { label: 'Controls', desc: 'Gamepad and RC transmitter mapping, calibration and live input.' },
  environment: { label: 'Environment', desc: 'Wind, time of day and weather.' },
  graphics: { label: 'Graphics & sound', desc: 'Rendering quality and audio. Lower these if the frame rate drops.' },
};
const TAB_KEYS = {
  flight: ['profile', 'mode', 'smoothing', 'kbAmount', 'expo', 'throttleMid', 'maxAngle', 'acroRate', 'fpvTilt'],
  environment: ['wind', 'windDir', 'gust', 'sunElev', 'sunAz', 'fog', 'clouds'],
  graphics: ['shadows', 'pixelRatio', 'grass', 'waterRefl', 'pip', 'sound', 'volume'],
};
const MODE_HELP = {
  GPS: 'Holds position and height when you let go of the sticks. Best for beginners and filming.',
  ANGLE: 'Keeps the drone level, but you control height with the throttle.',
  ACRO: 'How real FPV pilots fly: the stick sets rotation speed and the drone stays at whatever angle you leave it.',
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

export class Menu {
  constructor({ settings, input, apply, onClose }) {
    this.settings = settings;
    this.input = input;
    this.apply = apply; // (key) => void
    this.onClose = onClose;
    this.root = document.getElementById('menu');
    this.body = document.getElementById('menu-body');
    this.tabsEl = document.getElementById('tabs');
    this.titleEl = document.getElementById('tab-title');
    this.descEl = document.getElementById('tab-desc');
    this.resetBtn = document.getElementById('menu-reset');
    this.tab = 'flight';
    this.live = null;
    this.rowEls = {};
    this.resetArmed = null;

    document.getElementById('menu-close').addEventListener('click', () => this.close());
    document.getElementById('menu-x').addEventListener('click', () => this.close());
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.close(); });
    this.resetBtn.addEventListener('click', () => this.resetTab());
    // input.js ignores keys while a slider/select has focus, so handle Esc here.
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.code !== 'Escape') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) { e.preventDefault(); t.blur(); this.close(); }
    });
    this.renderTabs();
  }

  get isOpen() { return !this.root.classList.contains('hidden'); }
  open() {
    this.root.classList.remove('hidden');
    this.render();
  }
  close() {
    if (!this.isOpen) return;
    this.root.classList.add('hidden');
    this.input.learn = null;
    this.disarmReset();
    this.onClose?.();
  }
  toggle() { this.isOpen ? this.close() : this.open(); }

  renderTabs() {
    this.tabsEl.innerHTML = '';
    const keys = Object.keys(TABS);
    for (const k of keys) {
      const b = el('button', {
        type: 'button', role: 'tab', class: 's-tab', 'aria-selected': String(this.tab === k), tabindex: this.tab === k ? '0' : '-1',
        onclick: () => this.selectTab(k),
        onkeydown: (e) => {
          const i = keys.indexOf(k);
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
          if (!step) return;
          e.preventDefault();
          const next = keys[(i + step + keys.length) % keys.length];
          this.selectTab(next);
          this.tabsEl.querySelector(`[data-tab="${next}"]`)?.focus();
        },
      });
      b.dataset.tab = k;
      b.innerHTML = ICONS[k];
      b.append(el('span', {}, TABS[k].label));
      if (this.modifiedCount(k)) b.append(el('i', { class: 's-dot', title: 'Changed from default' }));
      this.tabsEl.append(b);
    }
  }

  selectTab(k) {
    if (this.tab === k) return;
    this.input.learn = null;
    this.tab = k;
    this.disarmReset();
    this.renderTabs();
    this.render();
    this.body.scrollTop = 0;
  }

  // ---- state helpers -------------------------------------------------

  isModified(key) { return key in DEFAULTS && String(this.settings[key]) !== String(DEFAULTS[key]); }
  modifiedCount(tab) { return (TAB_KEYS[tab] || []).filter((k) => this.isModified(k)).length; }

  set(key, value) {
    this.settings[key] = value;
    saveSettings(this.settings);
    this.apply(key);
    this.rowEls[key]?.classList.toggle('modified', this.isModified(key));
    this.refreshChrome();
  }

  resetKey(key) {
    this.set(key, DEFAULTS[key]);
    this.rerender();
  }

  resetTab() {
    if (!this.resetArmed) {
      this.resetArmed = setTimeout(() => this.disarmReset(), 3000);
      this.resetBtn.classList.add('armed');
      this.resetBtn.lastChild.textContent = 'Click again to confirm';
      return;
    }
    this.disarmReset();
    if (this.tab === 'controls') this.input.resetConfig();
    else for (const k of TAB_KEYS[this.tab]) if (this.isModified(k)) this.set(k, DEFAULTS[k]);
    this.rerender();
  }

  disarmReset() {
    clearTimeout(this.resetArmed);
    this.resetArmed = null;
    this.resetBtn.classList.remove('armed');
    this.resetBtn.lastChild.textContent = 'Reset tab';
  }

  rerender() {
    const top = this.body.scrollTop;
    this.render();
    this.body.scrollTop = top;
  }

  /** Header text, tab dots and reset-button state. */
  refreshChrome() {
    this.titleEl.textContent = TABS[this.tab].label;
    this.descEl.textContent = TABS[this.tab].desc;
    const canReset = this.tab === 'controls' || this.modifiedCount(this.tab) > 0;
    this.resetBtn.disabled = !canReset;
    for (const b of this.tabsEl.children) {
      const has = this.modifiedCount(b.dataset.tab) > 0;
      const dot = b.querySelector('.s-dot');
      if (has && !dot) b.append(el('i', { class: 's-dot', title: 'Changed from default' }));
      else if (!has && dot) dot.remove();
    }
  }

  // ---- building blocks ----------------------------------------------

  card(title, ...rows) {
    return el('section', { class: 's-card' }, title ? el('h4', {}, title) : null, ...rows);
  }

  row(key, label, hint, controls, { wide = false } = {}) {
    const reset = key in DEFAULTS
      ? el('button', { type: 'button', class: 's-reset', title: 'Reset to default', 'aria-label': `Reset ${label} to default`, onclick: () => this.resetKey(key) })
      : null;
    if (reset) reset.innerHTML = RESET_ICON;
    const r = el('div', { class: `s-row${wide ? ' wide' : ''}${this.isModified(key) ? ' modified' : ''}` },
      el('div', { class: 's-label' }, el('span', { class: 's-name' }, label, reset), hint ? el('small', {}, hint) : null),
      el('div', { class: 's-ctl' }, ...controls));
    if (key) this.rowEls[key] = r;
    return r;
  }

  rangeInput(value, min, max, step, label, onInput) {
    const inp = el('input', { type: 'range', class: 's-range', min, max, step, value, 'aria-label': label });
    const paint = (v) => inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    paint(value);
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); paint(v); onInput(v); });
    return inp;
  }

  slider(key, label, hint, min, max, step, fmt = (v) => v) {
    const out = el('output', { class: 's-val' }, fmt(this.settings[key]));
    const inp = this.rangeInput(this.settings[key], min, max, step, label, (v) => { out.textContent = fmt(v); this.set(key, v); });
    return this.row(key, label, hint, [inp, out]);
  }

  segmented(key, label, hint, options, { onPick, wide = false, cards = false } = {}) {
    const wrap = el('div', { class: `s-seg${cards ? ' cards' : ''}`, role: 'radiogroup', 'aria-label': label });
    const sync = () => {
      for (const b of wrap.children) {
        const on = String(this.settings[key]) === b.dataset.value;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      }
    };
    for (const [v, text, sub] of options) {
      const b = el('button', { type: 'button', role: 'radio', onclick: () => {
        const val = typeof DEFAULTS[key] === 'number' ? Number(v) : v;
        this.set(key, val);
        sync();
        onPick?.(val);
      } }, el('span', {}, text), sub ? el('small', {}, sub) : null);
      b.dataset.value = String(v);
      wrap.append(b);
    }
    sync();
    return this.row(key, label, hint, [wrap], { wide });
  }

  switchInput(checked, label, onChange) {
    const c = el('input', { type: 'checkbox', role: 'switch', 'aria-label': label });
    c.checked = !!checked;
    c.addEventListener('change', () => onChange(c.checked));
    return el('label', { class: 's-switch' }, c, el('span', { class: 's-track' }));
  }

  toggle(key, label, hint, onChange) {
    const sw = this.switchInput(this.settings[key], label, (v) => { this.set(key, v); onChange?.(v); });
    return this.row(key, label, hint, [sw]);
  }

  // ---- tabs -----------------------------------------------------------

  render() {
    this.live = null;
    this.rowEls = {};
    this.body.innerHTML = '';
    this.body.setAttribute('aria-labelledby', 'tab-title');
    const b = this.body;
    const auto = (unit) => (v) => (v ? `${v}${unit}` : 'Auto');

    if (this.tab === 'flight') {
      const modeHelp = el('p', { class: 's-help' }, MODE_HELP[this.settings.mode] || '');
      b.append(
        this.card('Aircraft',
          this.segmented('profile', 'Drone', null,
            Object.entries(PROFILES).map(([k, p]) => {
              const m = p.name.match(/^(.*?)\s*\((.*)\)$/);
              return [k, m ? m[1] : p.name, m ? m[2] : null];
            }), { wide: true, cards: true }),
          this.segmented('mode', 'Flight mode', null, MODES.map((m) => [m, { GPS: 'GPS', ANGLE: 'Angle', ACRO: 'Acro' }[m] || m]),
            { wide: true, onPick: (v) => { modeHelp.textContent = MODE_HELP[v] || ''; } }),
          modeHelp),
        this.card('Stick feel',
          this.slider('smoothing', 'Control smoothing', 'Snappy for racing, cinematic for filming.', 0, 1, 0.05,
            (v) => (v < 0.25 ? 'Snappy' : v > 0.75 ? 'Cinematic' : 'Normal')),
          this.slider('expo', 'Stick expo', 'Softens the centre of the sticks for fine control.', 0, 0.9, 0.05, (v) => v.toFixed(2)),
          this.slider('kbAmount', 'Keyboard stick amount', 'Hold Shift for 100%.', 0.2, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
          this.toggle('throttleMid', 'Throttle centre = hover', 'Angle and Acro modes only.')),
        this.card('Limits & camera',
          this.slider('maxAngle', 'Max tilt angle', 'Auto uses the drone’s default.', 0, 75, 1, auto('°')),
          this.slider('acroRate', 'Acro rate', 'Auto uses the drone’s default.', 0, 1200, 10, auto('°/s')),
          this.slider('fpvTilt', 'FPV camera uptilt', 'Also adjustable in flight with Q / E.', 0, 45, 1, (v) => `${v}°`)),
      );
    } else if (this.tab === 'environment') {
      b.append(
        this.card('Wind',
          this.slider('wind', 'Wind speed', null, 0, 15, 0.5, (v) => `${v} m/s`),
          this.slider('windDir', 'Wind from', 'Compass bearing the wind blows from.', 0, 359, 1, (v) => `${v}° ${compass(v)}`),
          this.slider('gust', 'Gusts & turbulence', null, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)),
        this.card('Sky & light',
          this.slider('sunElev', 'Sun elevation', 'Sets the time of day. Below 0° is dusk.', -6, 85, 1, (v) => `${v}°`),
          this.slider('sunAz', 'Sun direction', null, 0, 359, 1, (v) => `${v}° ${compass(v)}`),
          this.slider('fog', 'Haze & fog', null, 0, 10, 0.1, (v) => v.toFixed(1)),
          this.slider('clouds', 'Cloud cover', null, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)),
      );
    } else if (this.tab === 'graphics') {
      const vol = this.slider('volume', 'Volume', null, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`);
      const setVolEnabled = (on) => { vol.classList.toggle('disabled', !on); vol.querySelector('input').disabled = !on; };
      setVolEnabled(this.settings.sound);
      b.append(
        this.card('Quality',
          this.segmented('shadows', 'Shadows', 'Biggest impact on frame rate.', [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']]),
          this.segmented('grass', '3D grass', null, [[0, 'Off'], [1, 'Low'], [2, 'Medium'], [3, 'High']]),
          this.slider('pixelRatio', 'Render resolution', 'Pixel ratio cap. Lower is faster.', 0.5, 2, 0.25, (v) => `${v}x`),
          this.toggle('waterRefl', 'Water reflections', null)),
        this.card('Display',
          this.toggle('pip', 'Picture-in-picture', 'Second camera view in the corner. Toggle in flight with V.')),
        this.card('Audio',
          this.toggle('sound', 'Motor sound', null, setVolEnabled),
          vol),
      );
    } else if (this.tab === 'controls') {
      this.renderControls(b);
    }
    this.refreshChrome();
  }

  renderControls(b) {
    const inp = this.input;
    const pads = inp.listGamepads();

    // Controller
    const padSel = el('select', { class: 's-select', 'aria-label': 'Controller' });
    padSel.append(el('option', { value: -1 }, 'First connected'));
    for (const p of pads) {
      const o = el('option', { value: p.index }, `#${p.index}: ${p.id.slice(0, 60)}`);
      if (inp.config.gamepadIndex === p.index) o.selected = true;
      padSel.append(o);
    }
    padSel.addEventListener('change', () => { inp.config.gamepadIndex = Number(padSel.value); inp.save(); });
    const status = el('span', { class: `s-chip${pads.length ? ' ok' : ''}` }, pads.length ? `${pads.length} connected` : 'None found');
    const ctrlCard = this.card('Controller', this.row(null, 'Device', null, [padSel, status]));
    if (!pads.length) {
      ctrlCard.append(el('p', { class: 's-note' }, 'No controller detected. Plug in a gamepad, joystick or USB RC transmitter (set it to USB joystick / HID mode), then press a button or move a stick. Browsers only expose a controller after you interact with it.'));
    }
    b.append(ctrlCard);

    // Stick channels
    const rows = {};
    const chCard = this.card('Stick channels',
      el('p', { class: 's-help' }, 'Click Learn, then push that stick UP (throttle, pitch) or RIGHT (yaw, roll). Axis and direction are detected automatically.'));
    for (const ch of CHANNELS) {
      const m = inp.config.channels[ch];
      const axisSel = el('select', { class: 's-select', 'aria-label': `${CHANNEL_LABELS[ch]} axis` });
      for (let i = 0; i < Math.max(8, pads[0]?.axes.length || 0); i++) {
        const o = el('option', { value: i }, `Axis ${i}`);
        if (m.axis === i) o.selected = true;
        axisSel.append(o);
      }
      axisSel.addEventListener('change', () => { m.axis = Number(axisSel.value); inp.save(); });
      const invSw = this.switchInput(m.invert, `Invert ${CHANNEL_LABELS[ch]}`, (v) => { m.invert = v; inp.save(); });
      const inv = invSw.querySelector('input');
      const bar = el('div', { class: 'axis-bar' }, el('div'));
      const learnBtn = el('button', { type: 'button', class: 'btn small', onclick: () => {
        if (inp.startLearn('axis', ch)) { learnBtn.textContent = 'Move stick...'; learnBtn.classList.add('active'); }
      } }, 'Learn');
      rows[ch] = { bar, learnBtn, axisSel, inv };
      chCard.append(el('div', { class: 's-map' },
        el('b', {}, CHANNEL_LABELS[ch]), axisSel,
        el('span', { class: 's-inv' }, invSw, el('small', {}, 'Invert')),
        bar, learnBtn));
    }
    const dzOut = el('output', { class: 's-val' }, inp.config.deadzone.toFixed(2));
    const dz = this.rangeInput(inp.config.deadzone, 0, 0.3, 0.01, 'Deadzone', (v) => { inp.config.deadzone = v; dzOut.textContent = v.toFixed(2); inp.save(); });
    chCard.append(this.row(null, 'Deadzone', 'Ignores small stick movements around centre.', [dz, dzOut]));
    b.append(chCard);

    // Calibration
    const calNote = el('p', { class: 's-help' }, 'For RC transmitters whose sticks do not reach full range.');
    const calBtn = el('button', { type: 'button', class: 'btn', onclick: () => {
      if (inp.calibrating) {
        inp.finishCalibration(); calBtn.textContent = 'Calibrate sticks'; calBtn.classList.remove('active'); calNote.textContent = 'Calibration saved.';
      } else if (inp.startCalibration()) {
        calBtn.textContent = 'Done - save calibration'; calBtn.classList.add('active');
        calNote.textContent = 'Move every stick to all extremes, then centre them (throttle fully down) and click Done.';
      }
    } }, inp.calibrating ? 'Done - save calibration' : 'Calibrate sticks');
    b.append(this.card('Calibration', calNote,
      el('div', { class: 's-actions' }, calBtn,
        el('button', { type: 'button', class: 'btn', onclick: () => { inp.config.cal = {}; inp.save(); calNote.textContent = 'Calibration cleared.'; } }, 'Clear calibration'))));

    // Buttons
    const btnRows = {};
    const btnCard = this.card('Buttons');
    for (const a of ACTIONS) {
      const label = el('span', { class: 's-chip mono' }, `Button ${inp.config.buttons[a]}`);
      const lb = el('button', { type: 'button', class: 'btn small', onclick: () => {
        if (inp.startLearn('button', a)) { lb.textContent = 'Press button...'; lb.classList.add('active'); }
      } }, 'Learn');
      btnRows[a] = { label, lb };
      btnCard.append(this.row(null, ACTION_LABELS[a], null, [label, lb]));
    }
    b.append(btnCard);

    // Raw input
    const raw = el('div', { class: 'raw-axes' });
    const chips = el('div', { class: 'btn-chips' });
    b.append(this.card('Raw controller input', raw, chips));

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
      if (!gp) { raw.textContent = 'No controller connected'; raw.classList.add('empty'); chips.textContent = ''; return; }
      raw.classList.remove('empty');
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
