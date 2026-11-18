// Synthesised motor / propeller sound with Web Audio.
export class DroneAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.6;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Motor whine: two detuned sawtooth oscillators through a lowpass
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 2;
    this.filter.connect(this.master);
    this.oscs = [0, 1, 2].map((i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = 100;
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.5 : 0.22;
      o.connect(g).connect(this.filter);
      o.start();
      return o;
    });

    // Prop wash: filtered noise
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 600;
    this.noiseFilter.Q.value = 0.7;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.master);
    noise.start();
  }

  /** throttle: 0..1 average motor output; dist: listener distance in metres; racer: bool */
  update(throttle, dist, racer) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const spinning = throttle > 0.001;
    const base = racer ? 180 : 95;
    const f = base + Math.sqrt(throttle) * (racer ? 900 : 330);
    this.oscs[0].frequency.setTargetAtTime(f, t, 0.03);
    this.oscs[1].frequency.setTargetAtTime(f * 1.013, t, 0.03);
    this.oscs[2].frequency.setTargetAtTime(f * 2, t, 0.03);
    this.filter.frequency.setTargetAtTime(500 + throttle * 3000, t, 0.05);
    this.noiseFilter.frequency.setTargetAtTime(300 + throttle * 1500, t, 0.05);
    const att = 1 / (1 + Math.max(0, dist - 1) * 0.15);
    const vol = this.enabled && spinning ? this.volume * (0.15 + Math.sqrt(throttle) * 0.6) * att : 0;
    this.master.gain.setTargetAtTime(vol, t, 0.06);
    this.noiseGain.gain.setTargetAtTime(0.6 + throttle * 1.2, t, 0.05);
  }
}
