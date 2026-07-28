/**
 * Procedural menu audio — no sample assets.
 *
 * Used by the boot / pause shell for:
 *   - short click / select / confirm beeps
 *   - a sparse low ambient loop ("briefing room" energy)
 *
 * The loop starts as soon as the title shell loads so a cold boot proves the
 * app has sound (that is the point of the bed). Autoplay-blocked browsers get
 * a one-shot gesture unlock; volume is shared with the game mixer via
 * `bindGameAudio`.
 */

import { ad, biquad, clamp, gain, hit, osc, series } from './dsp.js';

/* ------------------------------------------------------------------ */
/* One-shots                                                          */
/* ------------------------------------------------------------------ */

/**
 * Short radio squelch + band-limited hiss (matches the game's vox radio ends).
 * @param {BaseAudioContext} actx
 * @param {AudioNode} dest
 * @param {number} t0
 * @param {number} lvl
 */
function radioSquelch(actx, dest, t0, lvl) {
  // Crack at open / close of the "transmission".
  for (const st of [t0, t0 + 0.28]) {
    const n = Math.floor(actx.sampleRate * 0.05);
    const buf = actx.createBuffer(1, n, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = actx.createBufferSource();
    src.buffer = buf;
    const bp = biquad(actx, 'bandpass', 2600, 1.6);
    const g = gain(actx, 0);
    series(src, bp, g).connect(dest);
    hit(g.gain, st, 0.14 * lvl, 0.028);
    src.start(st);
    src.stop(st + 0.055);
  }
  // Thin static bed between the clicks.
  const n2 = Math.floor(actx.sampleRate * 0.32);
  const buf2 = actx.createBuffer(1, n2, actx.sampleRate);
  const d2 = buf2.getChannelData(0);
  for (let i = 0; i < n2; i++) d2[i] = Math.random() * 2 - 1;
  const src2 = actx.createBufferSource();
  src2.buffer = buf2;
  const hp = biquad(actx, 'highpass', 900, 0.7);
  const lp = biquad(actx, 'lowpass', 3400, 0.85);
  const g2 = gain(actx, 0);
  series(src2, hp, lp, g2).connect(dest);
  ad(g2.gain, t0 + 0.02, 0.07 * lvl, 0.02, 0.26);
  src2.start(t0);
  src2.stop(t0 + 0.34);
}

/**
 * @param {BaseAudioContext} actx
 * @param {string} kind  click | select | confirm | tick | open | close | ready
 * @param {{ when?: number, level?: number }} [o]
 */
export function menuUiSound(actx, kind, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const lvl = o.level ?? 1;
  const out = gain(actx, 1);

  switch (kind) {
    case 'ready': {
      // Deploy is live: radio open + two-tone clear + radio close.
      radioSquelch(actx, out, t0, lvl);
      const freqs = [660, 990];
      for (let i = 0; i < freqs.length; i++) {
        const bt = t0 + 0.1 + i * 0.07;
        const o1 = osc(actx, 'triangle', freqs[i]);
        const g = gain(actx, 0);
        const lp = biquad(actx, 'lowpass', 4200, 0.75);
        o1.connect(g);
        series(g, lp).connect(out);
        ad(g.gain, bt, 0.42 * lvl * (1 - i * 0.15), 0.005, 0.14);
        o1.start(bt);
        o1.stop(bt + 0.28);
      }
      break;
    }
    case 'tick': {
      // Soft slider grain — barely there.
      const o1 = osc(actx, 'sine', 1400);
      const g = gain(actx, 0);
      o1.connect(g);
      g.connect(out);
      hit(g.gain, t0, 0.16 * lvl, 0.018);
      o1.start(t0);
      o1.stop(t0 + 0.04);
      break;
    }
    case 'click': {
      const o1 = osc(actx, 'triangle', 920);
      const o2 = osc(actx, 'sine', 1840);
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 3200, 0.7);
      o1.connect(g);
      o2.connect(g);
      series(g, lp).connect(out);
      hit(g.gain, t0, 0.45 * lvl, 0.045);
      o1.start(t0);
      o2.start(t0);
      o1.stop(t0 + 0.08);
      o2.stop(t0 + 0.08);
      break;
    }
    case 'select': {
      // Two-step up — quality / toggle pick.
      for (let i = 0; i < 2; i++) {
        const bt = t0 + i * 0.04;
        const o1 = osc(actx, 'triangle', 660 * Math.pow(1.34, i));
        const g = gain(actx, 0);
        const lp = biquad(actx, 'lowpass', 2800, 0.8);
        o1.connect(g);
        series(g, lp).connect(out);
        ad(g.gain, bt, 0.4 * lvl, 0.004, 0.07);
        o1.start(bt);
        o1.stop(bt + 0.14);
      }
      break;
    }
    case 'confirm': {
      // Load / Deploy / Resume — short rising triad, not a jingle.
      const freqs = [520, 780, 1040];
      for (let i = 0; i < freqs.length; i++) {
        const bt = t0 + i * 0.048;
        const o1 = osc(actx, 'triangle', freqs[i]);
        const g = gain(actx, 0);
        const lp = biquad(actx, 'lowpass', 3600, 0.7);
        o1.connect(g);
        series(g, lp).connect(out);
        ad(g.gain, bt, 0.48 * lvl * (1 - i * 0.12), 0.006, 0.11);
        o1.start(bt);
        o1.stop(bt + 0.22);
      }
      break;
    }
    case 'open': {
      // Pause shell opens — soft swell up.
      const o1 = osc(actx, 'sine', 220);
      const o2 = osc(actx, 'sine', 330);
      const g = gain(actx, 0);
      const lp = biquad(actx, 'lowpass', 900, 0.9);
      o1.connect(g);
      o2.connect(g);
      series(g, lp).connect(out);
      ad(g.gain, t0, 0.32 * lvl, 0.04, 0.28);
      o1.frequency.setValueAtTime(180, t0);
      o1.frequency.exponentialRampToValueAtTime(280, t0 + 0.22);
      o1.start(t0);
      o2.start(t0);
      o1.stop(t0 + 0.45);
      o2.stop(t0 + 0.45);
      break;
    }
    case 'close':
    default: {
      const o1 = osc(actx, 'sine', 480);
      const g = gain(actx, 0);
      o1.connect(g);
      g.connect(out);
      o1.frequency.setValueAtTime(520, t0);
      o1.frequency.exponentialRampToValueAtTime(240, t0 + 0.12);
      ad(g.gain, t0, 0.28 * lvl, 0.004, 0.12);
      o1.start(t0);
      o1.stop(t0 + 0.2);
      break;
    }
  }

  return { node: out, end: t0 + 0.5 };
}

/* ------------------------------------------------------------------ */
/* Menu loop                                                          */
/* ------------------------------------------------------------------ */

/** ~68 BPM, four-beat bar. Sparse A-minor briefing motif. */
const BAR = 3.52;
// MIDI-ish freqs: A2 drone, then motif A3 C4 E3 G3 F3
const DRONE = 110;
const MOTIF = [220, 261.63, 164.81, 196.0, 174.61];
const MOTIF_AT = [0.0, 0.88, 1.76, 2.2, 2.86]; // offsets within the bar

/**
 * Low, dry, looping "ops room" bed. Intentionally boring — space for UI beeps.
 */
export class MenuMusic {
  /**
   * @param {BaseAudioContext} actx
   * @param {AudioNode} dest
   */
  constructor(actx, dest) {
    this.actx = actx;
    this.bus = gain(actx, 0);
    this.bus.connect(dest);
    this._playing = false;
    this._next = 0;
    this._timer = 0;
    // Loud enough on first boot that a muted-tab visitor knows the app has sound.
    this._level = 0.32;
    this._noise = null;
    this._noiseGain = null;
  }

  start() {
    if (this._playing) return;
    this._playing = true;
    this._ensureBed();
    const t = this.actx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(Math.max(this.bus.gain.value, 0.0001), t);
    // Faster fade-in so the bed is obvious within the first second of load.
    this.bus.gain.exponentialRampToValueAtTime(this._level, t + 0.45);
    if (this._noiseGain) {
      this._noiseGain.gain.cancelScheduledValues(t);
      this._noiseGain.gain.setValueAtTime(0.0001, t);
      this._noiseGain.gain.exponentialRampToValueAtTime(0.1, t + 0.6);
    }
    this._next = t + 0.05;
    this._pump();
  }

  stop({ immediate = false } = {}) {
    if (!this._playing && !immediate) return;
    this._playing = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = 0;
    }
    const t = this.actx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    if (immediate) {
      this.bus.gain.setValueAtTime(0, t);
    } else {
      this.bus.gain.setValueAtTime(Math.max(this.bus.gain.value, 0.0001), t);
      this.bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      this.bus.gain.setValueAtTime(0, t + 0.58);
    }
    if (this._noiseGain) {
      this._noiseGain.gain.cancelScheduledValues(t);
      this._noiseGain.gain.setValueAtTime(Math.max(this._noiseGain.gain.value, 0.0001), t);
      this._noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    }
  }

  setLevel(v) {
    this._level = clamp(v, 0, 0.5);
    if (this._playing) {
      this.bus.gain.setTargetAtTime(this._level, this.actx.currentTime, 0.08);
    }
  }

  dispose() {
    this.stop({ immediate: true });
    try {
      this._noise?.stop?.();
    } catch {
      /* already stopped */
    }
    try {
      this._noise?.disconnect();
      this._noiseGain?.disconnect();
      this.bus.disconnect();
    } catch {
      /* noop */
    }
    this._noise = this._noiseGain = null;
  }

  _ensureBed() {
    if (this._noise) return;
    const actx = this.actx;
    // One-shot pink-ish buffer looped as a soft air bed.
    const sec = 2.5;
    const n = Math.floor(actx.sampleRate * sec);
    const buf = actx.createBuffer(1, n, actx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.04;
      b1 = 0.985 * b1 + w * 0.06;
      b2 = 0.95 * b2 + w * 0.1;
      d[i] = (b0 + b1 + b2) * 0.35;
    }
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = biquad(actx, 'lowpass', 420, 0.7);
    const g = gain(actx, 0);
    src.connect(lp);
    lp.connect(g);
    g.connect(this.bus);
    src.start();
    this._noise = src;
    this._noiseGain = g;
  }

  _pump() {
    if (!this._playing) return;
    const t = this.actx.currentTime;
    // Schedule ~1s ahead.
    while (this._next < t + 1.0) {
      this._scheduleBar(this._next);
      this._next += BAR;
    }
    this._timer = setTimeout(() => this._pump(), 180);
  }

  _scheduleBar(t0) {
    const actx = this.actx;
    // Sustained drone + fifth.
    this._tone(t0, BAR * 0.95, DRONE, 0.22, 'sine');
    this._tone(t0, BAR * 0.95, DRONE * 1.5, 0.11, 'sine');
    // Sparse motif.
    for (let i = 0; i < MOTIF.length; i++) {
      const at = t0 + MOTIF_AT[i];
      const f = MOTIF[i];
      this._tone(at, 0.55 + (i % 2) * 0.15, f, 0.14, 'triangle');
      // Soft octave ghost on the downbeats.
      if (i === 0 || i === 2) this._tone(at, 0.7, f * 0.5, 0.08, 'sine');
    }
  }

  _tone(t0, dur, freq, peak, type) {
    const actx = this.actx;
    const o1 = osc(actx, type, freq);
    const g = gain(actx, 0);
    const lp = biquad(actx, 'lowpass', Math.min(2400, freq * 4.5), 0.8);
    o1.connect(g);
    series(g, lp).connect(this.bus);
    // Soft attack / long release so the loop doesn't click.
    const a = Math.min(0.12, dur * 0.25);
    const r = Math.min(0.35, dur * 0.45);
    ad(g.gain, t0, peak, a, Math.max(0.05, dur - a));
    // Extra tail via second ramp if needed — ad already decays.
    o1.start(t0);
    o1.stop(t0 + dur + r + 0.05);
  }
}

/* ------------------------------------------------------------------ */
/* Facade for the boot shell                                          */
/* ------------------------------------------------------------------ */

/**
 * Self-contained menu audio graph. Safe to construct at module load;
 * `ensure()` must run inside a user-gesture stack.
 */
export class MenuAudio {
  constructor() {
    this.actx = null;
    this.master = null;
    this.music = null;
    this.volume = 0.95;
    this._gameAudio = null;
    this._wantMusic = false;
    this._failed = false;
  }

  /**
   * Optional link to the game AudioSystem so the volume slider drives both.
   * @param {{ setMasterVolume?: (v: number) => void, start?: () => Promise<boolean> } | null} audio
   */
  bindGameAudio(audio) {
    this._gameAudio = audio || null;
    this._pushVolume();
  }

  /** Create / resume the graph. Idempotent; call from click handlers. */
  async ensure() {
    if (this._failed) return false;
    try {
      if (!this.actx) {
        const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AC) throw new Error('no AudioContext');
        const actx = new AC({ latencyHint: 'interactive' });
        this.actx = actx;
        this.master = gain(actx, this.volume);
        this.master.connect(actx.destination);
        this.music = new MenuMusic(actx, this.master);
      }
      if (this.actx.state === 'suspended') await this.actx.resume();
      // Nudge the game graph awake on the same gesture when present.
      try {
        await this._gameAudio?.start?.();
      } catch {
        /* game audio optional */
      }
      this._pushVolume();
      if (this._wantMusic) this.music?.start();
      return true;
    } catch (err) {
      console.warn('[menu-audio] disabled:', err?.message ?? err);
      this._failed = true;
      return false;
    }
  }

  setVolume(v) {
    this.volume = clamp(Number(v) || 0, 0, 1);
    this._pushVolume();
  }

  _pushVolume() {
    if (this.master && this.actx) {
      this.master.gain.setTargetAtTime(this.volume, this.actx.currentTime, 0.04);
    }
    this._gameAudio?.setMasterVolume?.(this.volume);
  }

  /**
   * @param {'click'|'select'|'confirm'|'tick'|'open'|'close'|'ready'} kind
   */
  play(kind, level = 1) {
    // Fire-and-forget; ensure is async but we schedule after resume when possible.
    const run = () => {
      if (!this.actx || this.actx.state === 'suspended') return;
      try {
        const voice = menuUiSound(this.actx, kind, { level: level * 0.9 });
        voice.node.connect(this.master);
        // Disconnect after tail so nodes can GC.
        const ms = Math.ceil((voice.end - this.actx.currentTime) * 1000) + 40;
        setTimeout(() => {
          try {
            voice.node.disconnect();
          } catch {
            /* noop */
          }
        }, ms);
      } catch {
        /* synthesis refused */
      }
    };
    if (this.actx && this.actx.state === 'running') {
      run();
      return;
    }
    this.ensure().then((ok) => {
      if (ok) run();
    });
  }

  startMusic() {
    this._wantMusic = true;
    if (this.actx && this.actx.state === 'running') this.music?.start();
    else this.ensure().then((ok) => {
      if (ok && this._wantMusic) this.music?.start();
    });
  }

  stopMusic(opts) {
    this._wantMusic = false;
    this.music?.stop(opts);
  }

  dispose() {
    this.stopMusic({ immediate: true });
    this.music?.dispose();
    try {
      this.master?.disconnect();
      if (this.actx && this.actx.state !== 'closed') this.actx.close();
    } catch {
      /* noop */
    }
    this.actx = this.master = this.music = null;
  }
}
