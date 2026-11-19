// Keyboard + Gamepad (joystick / USB RC transmitter) input with mapping, calibration and learn mode.

const STORAGE_KEY = 'dronesim.input.v1';

export const CHANNELS = ['thr', 'yaw', 'pitch', 'roll'];
export const CHANNEL_LABELS = { thr: 'Throttle', yaw: 'Yaw', pitch: 'Pitch', roll: 'Roll' };
export const ACTIONS = ['arm', 'camera', 'mode', 'reset', 'pip', 'rth', 'gimbalUp', 'gimbalDown'];
export const ACTION_LABELS = {
  arm: 'Arm / Disarm', camera: 'Next camera', mode: 'Flight mode', reset: 'Reset drone',
  pip: 'Picture-in-picture', rth: 'Return to home', gimbalUp: 'Gimbal up', gimbalDown: 'Gimbal down',
};

// Standard gamepad layout, Mode 2 (left stick = throttle/yaw, right stick = pitch/roll)
export function defaultConfig() {
  return {
    channels: {
      thr: { axis: 1, invert: true },
      yaw: { axis: 0, invert: false },
      pitch: { axis: 3, invert: true },
      roll: { axis: 2, invert: false },
    },
    buttons: { arm: 0, camera: 3, mode: 2, reset: 8, pip: 4, rth: 1, gimbalUp: 12, gimbalDown: 13 },
    cal: {}, // axisIndex -> {min, max, center}
    deadzone: 0.05,
    gamepadIndex: -1, // -1 = first connected
  };
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      const d = defaultConfig();
      return { ...d, ...c, channels: { ...d.channels, ...c.channels }, buttons: { ...d.buttons, ...c.buttons } };
    }
  } catch (e) { /* storage unavailable */ }
  return defaultConfig();
}

const KEY_ACTIONS = {
  Space: 'arm', KeyC: 'camera', KeyV: 'pip', KeyM: 'mode', KeyR: 'reset', KeyX: 'rth',
  KeyH: 'help', Escape: 'menu', KeyG: 'race', KeyO: 'osd',
  Digit1: 'cam1', Digit2: 'cam2', Digit3: 'cam3', Digit4: 'cam4', Digit5: 'cam5', Digit6: 'cam6',
};
const FLIGHT_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input {
  constructor() {
    this.config = loadConfig();
    this.keys = new Set();
    this.sticks = { thr: -1, yaw: 0, pitch: 0, roll: 0 };
    this.kb = { thr: -1, yaw: 0, pitch: 0, roll: 0 };
    this.kbVel = { thr: 0, yaw: 0, pitch: 0, roll: 0 };
    this.kbAmount = 0.6; // stick deflection for a key press without Shift
    this.thrHeld = 0;
    this.source = 'keyboard';
    this.listeners = [];
    this.prevButtons = [];
    this.prevAxes = [];
    this.prevTriggerArmCombo = false;
    this.gamepad = null;
    this.learn = null;      // { type: 'axis'|'button', target, baseline, until }
    this.calibrating = null; // { min:[], max:[] }
    this.enabled = true;

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (FLIGHT_KEYS.has(e.code) || e.code === 'Space') e.preventDefault();
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      if (FLIGHT_KEYS.has(e.code)) this.source = 'keyboard';
      const a = KEY_ACTIONS[e.code];
      if (a) this.fire(a);
      if (e.code === 'KeyQ') this.fire('gimbalDown');
      if (e.code === 'KeyE') this.fire('gimbalUp');
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => this.fire('gamepad', `Connected: ${e.gamepad.id}`));
    window.addEventListener('gamepaddisconnected', (e) => this.fire('gamepad', `Disconnected: ${e.gamepad.id}`));
  }

  on(fn) { this.listeners.push(fn); }
  fire(action, arg) { for (const fn of this.listeners) fn(action, arg); }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config)); } catch (e) { /* ignore */ }
  }

  resetConfig() {
    this.config = defaultConfig();
    this.save();
  }

  listGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads).filter(Boolean);
  }

  pickGamepad() {
    const pads = this.listGamepads();
    if (!pads.length) return null;
    const idx = this.config.gamepadIndex;
    return pads.find((p) => p.index === idx) || pads[0];
  }

  normAxis(axisIndex, raw, isThrottle) {
    const c = this.config.cal[axisIndex];
    if (!c) return raw;
    if (isThrottle) {
      const r = c.max - c.min;
      return r > 0.05 ? ((raw - c.min) / r) * 2 - 1 : raw;
    }
    if (raw >= c.center) return c.max - c.center > 0.02 ? (raw - c.center) / (c.max - c.center) : 0;
    return c.center - c.min > 0.02 ? (raw - c.center) / (c.center - c.min) : 0;
  }

  readChannel(gp, ch) {
    const m = this.config.channels[ch];
    if (!m || m.axis < 0 || m.axis >= gp.axes.length) return ch === 'thr' ? -1 : 0;
    let v = this.normAxis(m.axis, gp.axes[m.axis], ch === 'thr');
    if (m.invert) v = -v;
    v = Math.max(-1, Math.min(1, v));
    const dz = this.config.deadzone;
    if (ch !== 'thr' || !this.config.cal[m.axis]) {
      v = Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz);
    }
    return v;
  }

  startLearn(type, target) {
    const gp = this.pickGamepad();
    if (!gp) return false;
    this.learn = { type, target, baseline: gp.axes.slice(), until: performance.now() + 8000 };
    return true;
  }

  startCalibration() {
    const gp = this.pickGamepad();
    if (!gp) return false;
    this.calibrating = { min: gp.axes.slice(), max: gp.axes.slice() };
    return true;
  }

  finishCalibration() {
    const gp = this.pickGamepad();
    if (!gp || !this.calibrating) { this.calibrating = null; return; }
    const cal = {};
    gp.axes.forEach((v, i) => {
      const min = this.calibrating.min[i], max = this.calibrating.max[i];
      if (max - min > 0.2) cal[i] = { min, max, center: v };
    });
    this.config.cal = cal;
    this.calibrating = null;
    this.save();
  }

  /** mode: 'GPS' | 'ANGLE' | 'ACRO' */
  update(dt, mode) {
    // ---------- keyboard ----------
    const k = this.keys;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight');
    const kbFull = boost ? 1 : this.kbAmount;
    // Keys drive a virtual stick through a critically damped spring: pressing a key eases the
    // stick out (S-curve), releasing it eases back to centre - like a thumb on a real gimbal.
    const spring = (axis, target, w) => {
      const x = this.kb[axis], v = this.kbVel[axis];
      const steps = Math.max(1, Math.ceil(dt / 0.01));
      const hdt = dt / steps;
      let xx = x, vv = v;
      for (let i = 0; i < steps; i++) {
        vv += (w * w * (target - xx) - 2 * w * vv) * hdt;
        xx += vv * hdt;
      }
      this.kb[axis] = Math.max(-1, Math.min(1, xx));
      this.kbVel[axis] = vv;
    };
    const tPitch = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    const tRoll = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const tYaw = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const tThr = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    spring('pitch', tPitch * kbFull, 7);
    spring('roll', tRoll * kbFull, 7);
    spring('yaw', tYaw * kbFull, 6);
    if (mode === 'GPS') {
      spring('thr', tThr * kbFull, 6);
    } else {
      // throttle stays where you leave it (real transmitters have no throttle spring);
      // holding a key accelerates the change gently, Shift makes it faster
      const rate = (boost ? 1.0 : 0.45) * Math.min(1, (this.thrHeld += dt) * 2.5);
      if (!tThr) this.thrHeld = 0;
      this.kb.thr = Math.max(-1, Math.min(1, this.kb.thr + tThr * dt * rate));
    }

    // ---------- gamepad ----------
    const gp = this.pickGamepad();
    this.gamepad = gp;
    if (gp) {
      if (this.calibrating) {
        gp.axes.forEach((v, i) => {
          this.calibrating.min[i] = Math.min(this.calibrating.min[i] ?? v, v);
          this.calibrating.max[i] = Math.max(this.calibrating.max[i] ?? v, v);
        });
      }
      if (this.learn) this.processLearn(gp);

      // Activate gamepad source when its sticks move
      let moved = false;
      gp.axes.forEach((v, i) => {
        if (this.prevAxes[i] !== undefined && Math.abs(v - this.prevAxes[i]) > 0.08) moved = true;
      });
      this.prevAxes = gp.axes.slice();
      if (moved && !this.learn && !this.calibrating) this.source = 'gamepad';

      // Buttons (edge triggered)
      if (!this.learn) {
        // Standard Gamepad mapping: ZL/L2 = 6, ZR/R2 = 7.
        const zlPressed = gp.buttons[6] && (gp.buttons[6].pressed || gp.buttons[6].value > 0.5);
        const zrPressed = gp.buttons[7] && (gp.buttons[7].pressed || gp.buttons[7].value > 0.5);
        const triggerArmCombo = zlPressed && zrPressed;
        if (triggerArmCombo && !this.prevTriggerArmCombo) {
          this.source = 'gamepad';
          this.fire('arm', 'trigger-combo');
        }
        this.prevTriggerArmCombo = triggerArmCombo;

        gp.buttons.forEach((b, i) => {
          const pressed = b.pressed || b.value > 0.5;
          if (pressed && !this.prevButtons[i]) {
            for (const a of ACTIONS) if (this.config.buttons[a] === i) { this.source = 'gamepad'; this.fire(a); }
          }
        });
      }
      this.prevButtons = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    } else if (this.source === 'gamepad') {
      this.source = 'keyboard';
      this.prevTriggerArmCombo = false;
    }

    if (!this.enabled) return this.sticks;
    if (this.source === 'gamepad' && gp) {
      for (const ch of CHANNELS) this.sticks[ch] = this.readChannel(gp, ch);
      // keyboard keys still override individual axes while held
      if (tPitch) this.sticks.pitch = this.kb.pitch;
      if (tRoll) this.sticks.roll = this.kb.roll;
      if (tYaw) this.sticks.yaw = this.kb.yaw;
    } else {
      Object.assign(this.sticks, this.kb);
    }
    return this.sticks;
  }

  /** Called when the flight mode changes so keyboard throttle starts somewhere sensible. */
  onModeChange(mode, airborne = false) {
    // GPS: centred = hold altitude. Angle/Acro: start at idle on the ground, near hover in the air.
    this.kb.thr = mode === 'GPS' || airborne ? 0 : -1;
    this.kbVel.thr = 0;
  }

  processLearn(gp) {
    const L = this.learn;
    if (performance.now() > L.until) { this.learn = null; this.fire('learn', null); return; }
    if (L.type === 'axis') {
      let best = -1, bestD = 0.5;
      gp.axes.forEach((v, i) => {
        const d = Math.abs(v - L.baseline[i]);
        if (d > bestD) { bestD = d; best = i; }
      });
      if (best >= 0) {
        // invert so that "up / right" is positive: user is told to push stick up or right
        const dir = gp.axes[best] - L.baseline[best];
        this.config.channels[L.target] = { axis: best, invert: dir < 0 };
        this.learn = null;
        this.save();
        this.fire('learn', { target: L.target, axis: best });
      }
    } else {
      const idx = gp.buttons.findIndex((b, i) => (b.pressed || b.value > 0.5) && !this.prevButtons[i]);
      if (idx >= 0) {
        this.config.buttons[L.target] = idx;
        this.learn = null;
        this.save();
        this.fire('learn', { target: L.target, button: idx });
      }
    }
  }
}
