/**
 * Boot / title shell controller — also the in-game pause menu.
 *
 * Markup + CSS live in index.html for first paint. One layout from the start:
 *   progress · graphics (pre-Load) or weapons (post-Load) · controls · settings · CTA
 *
 * CTA modes: Load → Loading… → Deploy → (in-game) Resume
 * After Load, graphics cards swap for the weapons briefing (incl. grenade).
 * Pause keeps weapons up. Look prefs apply live once `bindConfig` is called.
 *
 * Menu audio (procedural clicks + sparse loop) starts on title load so a cold
 * boot proves the app has sound — no sample assets.
 *
 * Capture / tooling paths call hideImmediate() so the overlay starts hidden;
 * pause can still re-open it as the settings shell.
 */

import { MenuAudio } from '../audio/menu.js';
import { RunRecorder, formatBytes, formatDuration } from './recorder.js';

const STAGE_LABELS = {
  boot: 'Booting…',
  gpu: 'Detecting GPU…',
  systems: 'Loading systems…',
  render: 'Renderer',
  materials: 'Materials',
  sky: 'Atmosphere',
  world: 'Building the AO',
  physics: 'Collision',
  player: 'Operator',
  weapons: 'Arsenal',
  fx: 'Effects',
  ai: 'Hostiles',
  ui: 'HUD',
  audio: 'Audio',
  prewarm: 'Compiling shaders',
  ready: 'Ready',
};

/**
 * Copy + denser card meta for the quality grid (chips / cost bars / foot).
 * Mirrors the arsenal cards so the 2×2 boxes don't look half-empty.
 */
export const QUALITY_BLURBS = {
  low: {
    tag: 'Fast boot',
    desc: 'Lower res, basic post. Boots quick so you can play and iterate — expect fewer fancy lights and reflections.',
    chips: ['0.72× RES', '1K SHADOWS', 'BASIC POST', 'FAST BOOT'],
    stats: { fidelity: 32, gpu: 28, boot: 92 },
    foot: 'Iterate · laptop / integrated',
  },
  medium: {
    tag: 'Balanced',
    desc: 'TAA, ambient occlusion, volumetrics. Solid default for a real GPU without melting the fans.',
    chips: ['TAA', 'AO', 'VOLUMETRICS', '2K SHADOWS'],
    stats: { fidelity: 58, gpu: 52, boot: 68 },
    foot: 'Default · mid-range discrete',
  },
  high: {
    tag: 'Full stack',
    desc: 'SSR, sharper scales, heavier particles. Needs a modern card for a smooth firefight.',
    chips: ['SSR', 'FULL SCALE', 'HEAVY FX', '4 CASCADE'],
    stats: { fidelity: 82, gpu: 78, boot: 42 },
    foot: 'Firefight · modern discrete',
  },
  ultra: {
    tag: 'Max fidelity',
    desc: 'Biggest shadows, densest FX, capture baselines. Opt-in only — not the everyday boot.',
    chips: ['4K SHADOWS', 'MAX FX', 'CAPTURE', 'OPT-IN'],
    stats: { fidelity: 100, gpu: 96, boot: 22 },
    foot: 'Capture · high-end only',
  },
};

/** Build the denser card body (chips + bars + foot) shared by static + fallback markup. */
function qualityCardMetaHtml(blurb) {
  const chips = (blurb?.chips ?? [])
    .map((c) => `<span class="boot-q-chip">${c}</span>`)
    .join('');
  const s = blurb?.stats ?? { fidelity: 50, gpu: 50, boot: 50 };
  return (
    `<div class="boot-q-specs">${chips}</div>` +
    `<div class="boot-q-stats" aria-hidden="true">` +
    `<div class="boot-q-stat"><span>FIDELITY</span><div class="boot-q-bar"><i style="--v:${s.fidelity}%"></i></div></div>` +
    `<div class="boot-q-stat"><span>GPU</span><div class="boot-q-bar"><i style="--v:${s.gpu}%"></i></div></div>` +
    `<div class="boot-q-stat"><span>BOOT</span><div class="boot-q-bar"><i style="--v:${s.boot}%"></i></div></div>` +
    `</div>` +
    `<div class="boot-q-card-foot">${blurb?.foot ?? ''}</div>`
  );
}

const PRESETS = ['low', 'medium', 'high', 'ultra'];
const PREFS_KEY = 'grok-ops-boot-prefs';
const BASE_SENS = 0.0022;

function labelFor(stage, fallback) {
  if (fallback) return fallback;
  if (!stage) return 'Loading…';
  return STAGE_LABELS[stage] ?? String(stage);
}

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota */
  }
}

export class LoadScreen {
  constructor(root = document.getElementById('boot')) {
    this.root = root;
    this.blurbEl = root?.querySelector('#boot-blurb') ?? null;
    this.graphicsBlock = root?.querySelector('#boot-graphics-block') ?? null;
    this.weaponsBlock = root?.querySelector('#boot-weapons-block') ?? null;
    this.qualityHost = root?.querySelector('#boot-quality') ?? null;
    this.qLabel = root?.querySelector('#boot-q-label') ?? null;
    this.qWarn = root?.querySelector('#boot-q-warn') ?? null;
    this.qLive = root?.querySelector('#boot-q-live') ?? null;
    this.labelEl = root?.querySelector('#boot-label') ?? null;
    this.pctEl = root?.querySelector('#boot-pct') ?? null;
    this.fillEl = root?.querySelector('#boot-fill') ?? null;
    this.metaEl = root?.querySelector('#boot-meta') ?? null;
    this.hintEl = root?.querySelector('#boot-hint') ?? null;
    this.deployBtn = root?.querySelector('#boot-deploy') ?? null;
    this.deployLabel = root?.querySelector('.boot-deploy-label') ?? null;
    this.fullscreenInput = root?.querySelector('#boot-fullscreen') ?? null;
    this.recordInput = root?.querySelector('#boot-record') ?? null;
    this.lastRunEl = root?.querySelector('#boot-last-run') ?? null;
    this.lastRunLink = root?.querySelector('#boot-last-run-link') ?? null;
    this.lastRunMeta = root?.querySelector('#boot-last-run-meta') ?? null;
    this.retreatBtn = root?.querySelector('#boot-retreat') ?? null;
    this.sensInput = root?.querySelector('#boot-sens') ?? null;
    this.sensVal = root?.querySelector('#boot-sens-val') ?? null;
    this.fovInput = root?.querySelector('#boot-fov') ?? null;
    this.fovVal = root?.querySelector('#boot-fov-val') ?? null;
    this.volInput = root?.querySelector('#boot-vol') ?? null;
    this.volVal = root?.querySelector('#boot-vol-val') ?? null;
    this.invertHost = root?.querySelector('#boot-invert') ?? null;
    this.kickerEl = root?.querySelector('.boot-kicker') ?? null;

    // idle | loading | ready | playing | paused
    this._phase = 'idle';
    this._progress = 0;
    this._ready = false;
    this._inGame = false;
    this._dismissed = false;
    this._qualityLocked = false;
    this._selectedQuality = 'medium';
    this._recommended = 'medium';
    this._loadResolvers = [];
    this._deployResolvers = [];
    this._resumeHandler = null;
    this._retreatHandler = null;
    this._config = null;
    this._camera = null;
    this._input = null;
    this._qCards = [];
    this._hideTimer = 0;
    this._readyFlashTimer = 0;
    this._menuAudio = new MenuAudio();
    this._recorder = new RunRecorder();
    this._lastTickAt = 0;
    this._musicArmed = false;

    const saved = readPrefs() || {};
    this.prefs = {
      sensMult: clampNum(saved.sensMult, 0.2, 3, 1),
      fov: clampNum(saved.fov, 65, 120, 80),
      invertY: !!saved.invertY,
      masterVol: clampNum(saved.masterVol, 0, 1, 0.95),
      // Default on: fullscreen is what lets Ctrl-crouch survive Ctrl+W in Chrome.
      fullscreen: saved.fullscreen !== false,
      /** Opt-in local canvas capture for the next Deploy. */
      recordRun: !!saved.recordRun,
      quality: PRESETS.includes(saved.quality) ? saved.quality : null,
    };
    this._menuAudio.setVolume(this.prefs.masterVol);

    this._onCtaClick = () => this._resolveCta();
    this._onRetreatClick = () => this._resolveRetreat();
    this._onKey = (e) => {
      if (this._dismissed) return;
      if (e.code !== 'Enter' && e.code !== 'Space') return;
      if (this._phase === 'idle' || this._phase === 'ready' || this._phase === 'paused') {
        e.preventDefault();
        this._resolveCta();
      }
    };

    if (this.deployBtn) this.deployBtn.addEventListener('click', this._onCtaClick);
    if (this.retreatBtn) this.retreatBtn.addEventListener('click', this._onRetreatClick);
    addEventListener('keydown', this._onKey);

    this._bindLookControls();
    this._bindFullscreenToggle();
    this._bindRecordToggle();
    this._syncLastRunUi();
    this._setActionButton('load');

    // Quality cards live in index.html for first paint; hydrate + select now so
    // the briefing is interactive as soon as this module runs (not only after
    // waitForBriefing, and never after the player has already clicked Load).
    this._selectedQuality = this.prefs.quality || this._selectedQuality;
    this._buildQualityCards();
    this._syncQualityUi();
    this._syncLookUi();

    // Start the briefing bed ASAP so a cold load proves the app has sound.
    if (this.root && !this.root.classList.contains('boot-hidden')) {
      queueMicrotask(() => this._startMenuAudioOnBoot());
    }
  }

  get ready() {
    return this._ready;
  }

  get dismissed() {
    return this._dismissed;
  }

  get inGame() {
    return this._inGame;
  }

  get paused() {
    return this._phase === 'paused';
  }

  get selectedQuality() {
    return this._selectedQuality;
  }

  get lookPrefs() {
    return {
      sensitivity: BASE_SENS * this.prefs.sensMult,
      sensMult: this.prefs.sensMult,
      fov: this.prefs.fov,
      invertY: this.prefs.invertY,
    };
  }

  /**
   * PauseMenu wires this so Resume / Enter / Space unpause the match.
   * @param {null | (() => void)} fn
   */
  setResumeHandler(fn) {
    this._resumeHandler = typeof fn === 'function' ? fn : null;
  }

  /**
   * PauseMenu wires this so Retreat returns to the title shell.
   * @param {null | (() => void)} fn
   */
  setRetreatHandler(fn) {
    this._retreatHandler = typeof fn === 'function' ? fn : null;
  }

  /**
   * Show shell, wait for Load. Returns chosen quality + look prefs.
   * @param {{ recommended?: string, forced?: string|null, gpuLabel?: string }} opts
   */
  waitForBriefing({ recommended = 'medium', forced = null, gpuLabel = '' } = {}) {
    if (this._dismissed || !this.root) {
      return Promise.resolve({
        quality: forced && PRESETS.includes(forced) ? forced : recommended,
        ...this.lookPrefs,
      });
    }

    this._phase = 'idle';
    this._ready = false;
    this._qualityLocked = false;
    this._recommended = PRESETS.includes(recommended) ? recommended : 'medium';
    this._selectedQuality =
      (forced && PRESETS.includes(forced) && forced) ||
      this.prefs.quality ||
      this._recommended;

    this._buildQualityCards();
    this._syncQualityUi();
    this._syncLookUi();
    this._setLiveQuality();
    this._setWarn('');
    this._setActionButton('load');

    if (this.labelEl) this.labelEl.textContent = 'Stand by';
    if (this.pctEl) this.pctEl.textContent = '—';
    if (this.fillEl) this.fillEl.style.width = '0%';
    if (this.qLabel) this.qLabel.textContent = 'Graphics';
    if (this.kickerEl) this.kickerEl.textContent = 'Claude of Duty:';
    if (this.hintEl) {
      const rec = this._recommended.toUpperCase();
      this.hintEl.textContent = gpuLabel
        ? `GPU suggests ${rec} · ${gpuLabel}`
        : `GPU suggests ${rec}`;
    }
    if (this.metaEl) this.metaEl.textContent = '';
    if (this.blurbEl) this.blurbEl.hidden = false;
    this._setPanelMode('graphics');

    this.root.classList.remove('boot-ready', 'boot-hidden', 'boot-gone');
    this.deployBtn?.focus?.({ preventScroll: true });
    this._startMenuAudioOnBoot();

    return new Promise((resolve) => {
      this._loadResolvers.push(() => {
        this.prefs.quality = this._selectedQuality;
        this._persistPrefs();
        resolve({
          quality: this._selectedQuality,
          ...this.lookPrefs,
        });
      });
    });
  }

  /**
   * Lock graphics and flip CTA to Loading…. Same layout — no transition.
   * @param {{ meta?: string }} [opts]
   */
  beginLoading({ meta } = {}) {
    if (this._dismissed || !this.root) return;
    this._phase = 'loading';
    this._ready = false;
    this._qualityLocked = true;
    this._progress = 0;
    this._syncQualityUi();
    this._setLiveQuality();
    this._setWarn('');
    this._setActionButton('loading');
    this._setPanelMode('weapons');

    if (this.fillEl) this.fillEl.style.width = '0%';
    if (this.pctEl) this.pctEl.textContent = '0%';
    if (this.labelEl) this.labelEl.textContent = 'Loading…';
    if (this.hintEl) this.hintEl.textContent = 'Building the AO';
    if (this.kickerEl) this.kickerEl.textContent = 'Claude of Duty:';
    if (meta != null) this.setMeta(meta);
    this.root.classList.remove('boot-ready');
    this._menuAudio.startMusic();
  }

  /**
   * Wire live config once the engine exists. Look sliders write through.
   * @param {object} config
   * @param {import('three').PerspectiveCamera} [camera]
   */
  bindConfig(config, camera = null) {
    this._config = config;
    this._camera = camera;
    if (config) {
      if (Number.isFinite(config.sensitivity)) {
        this.prefs.sensMult = clampNum(config.sensitivity / BASE_SENS, 0.2, 3, this.prefs.sensMult);
      }
      if (Number.isFinite(config.fov)) {
        this.prefs.fov = clampNum(config.fov, 65, 120, this.prefs.fov) | 0;
      }
      if (config.invertY != null) this.prefs.invertY = !!config.invertY;
      if (PRESETS.includes(config.quality)) this._selectedQuality = config.quality;
    }
    this._syncLookUi();
    this._applyLookToConfig();
  }

  /**
   * Wire Input so the Fullscreen checkbox controls keyboard-lock on Deploy.
   * @param {import('./input.js').Input | null} input
   */
  bindInput(input) {
    this._input = input || null;
    this._applyFullscreenToInput();
  }

  /**
   * Canvas used for local run recording (MediaRecorder + captureStream).
   * @param {HTMLCanvasElement | null} canvas
   */
  bindCanvas(canvas) {
    this._recorder.setCanvas(canvas);
    if (this.recordInput && !this._recorder.supported) {
      this.recordInput.disabled = true;
      this.recordInput.checked = false;
      this.prefs.recordRun = false;
      const lab = this.recordInput.closest('label');
      if (lab) {
        lab.title = 'Recording is not supported in this browser';
        lab.classList.add('is-disabled');
      }
    }
  }

  /**
   * Link the game AudioSystem so master volume hits both graphs.
   * @param {import('../audio/index.js').AudioSystem | null} audio
   */
  bindAudio(audio) {
    this._gameAudio = audio || null;
    this._menuAudio.bindGameAudio(audio || null);
    this._menuAudio.setVolume(this.prefs.masterVol);
    // Tap master bus for run capture (lazy — graph may not be up yet).
    this._recorder.setAudioStreamSource(() => this._gameAudio?.getRecordStream?.() ?? null);
  }

  /**
   * @param {number} t  0..1
   * @param {{ stage?: string, label?: string, meta?: string }} [info]
   */
  setProgress(t, info = {}) {
    if (this._dismissed || !this.root) return;
    if (this._phase !== 'loading') return;
    const p = Math.max(this._progress, Math.min(1, Number(t) || 0));
    this._progress = p;
    const pct = Math.round(p * 100);
    if (this.fillEl) this.fillEl.style.width = `${pct}%`;
    if (this.pctEl) this.pctEl.textContent = `${pct}%`;
    if (this.labelEl) this.labelEl.textContent = labelFor(info.stage, info.label);
    if (info.meta != null && this.metaEl) this.metaEl.textContent = info.meta;
  }

  setMeta(text) {
    if (this.metaEl) this.metaEl.textContent = text ?? '';
  }

  /** Switch the shell into Deploy-ready state. */
  enterReady({ meta } = {}) {
    if (this._dismissed || !this.root) return;
    this._ready = true;
    this._progress = 1;
    this._phase = 'ready';
    // Title shell stays windowed — fullscreen only rides the Deploy gesture.
    this._ensureWindowedUntilDeploy();
    this._showShell({ ready: true });
    this._setPanelMode('weapons');
    if (this.fillEl) this.fillEl.style.width = '100%';
    if (this.pctEl) this.pctEl.textContent = '100%';
    if (this.labelEl) this.labelEl.textContent = 'Ready';
    if (this.hintEl) this.hintEl.textContent = 'Enter · Space · Click Deploy';
    if (this.kickerEl) this.kickerEl.textContent = 'Claude of Duty:';
    if (meta != null && this.metaEl) this.metaEl.textContent = meta;
    this._setActionButton('deploy');
    this.deployBtn?.focus?.({ preventScroll: true });
    this._cueDeployReady();
  }

  /**
   * Soft return from an in-progress (or finished) match to the title shell.
   * Assets stay warm — only Deploy is required, not Load / prewarm.
   * @param {{ meta?: string }} [opts]
   */
  returnToTitle({ meta } = {}) {
    if (this._dismissed || !this.root) return;
    // Seal any in-flight capture so the download link is ready on the shell.
    void this.finalizeRecording();
    // Drop any stale Deploy waiters from a previous retreat.
    this._deployResolvers.length = 0;
    this._inGame = false;
    this._ready = true;
    this._progress = 1;
    this._phase = 'ready';
    this._qualityLocked = true;
    this.root.classList.remove('boot-paused');
    this._syncLookFromConfig();
    this._syncLookUi();
    this._syncQualityUi();
    this._setLiveQuality();
    this._setWarn('');
    if (this.blurbEl) this.blurbEl.hidden = false;
    this._setPanelMode?.('weapons');
    if (this.fillEl) this.fillEl.style.width = '100%';
    if (this.pctEl) this.pctEl.textContent = '100%';
    if (this.labelEl) this.labelEl.textContent = 'Ready';
    if (this.hintEl) this.hintEl.textContent = 'Enter · Space · Click Deploy';
    if (this.kickerEl) this.kickerEl.textContent = 'Claude of Duty:';
    if (this.qLabel) this.qLabel.textContent = 'Graphics (locked)';
    if (meta != null) this.setMeta(meta);
    else if (this._selectedQuality) {
      this.setMeta(`${this._selectedQuality.toUpperCase()} · ready`);
    }
    // Soft return also stays windowed until the next Deploy click.
    this._ensureWindowedUntilDeploy();
    this._showShell({ ready: true });
    this._setActionButton('deploy');
    this.deployBtn?.focus?.({ preventScroll: true });
    this._menuAudio.play('open');
    this._menuAudio.startMusic();
    this._cueDeployReady();
  }

  waitForDeploy() {
    if (this._dismissed || !this.root) return Promise.resolve();
    if (this._inGame && this._phase === 'playing') return Promise.resolve();
    return new Promise((resolve) => {
      this._deployResolvers.push(resolve);
    });
  }

  /**
   * Hide the shell and mark match as live. Shell stays alive for pause.
   * Resolves when the shell is fully gone so callers can pointer-lock without
   * hiding the cursor over a still-visible menu.
   * @param {{ immediate?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  enterPlaying({ immediate = false } = {}) {
    this._inGame = true;
    this._ready = true;
    this._phase = 'playing';
    this.root?.classList.remove('boot-paused');
    this._menuAudio.stopMusic();
    this.startRecordingIfEnabled();
    return this._hideShell({ immediate });
  }

  /**
   * Start canvas capture when the Record run checkbox is on.
   * Idempotent while already capturing (Deploy + first restart both call this).
   * @returns {boolean}
   */
  startRecordingIfEnabled() {
    if (this.recordInput) this.prefs.recordRun = !!this.recordInput.checked;
    if (!this.prefs.recordRun) return false;
    if (this._recorder.recording) return true;
    return this._recorder.start({ fps: 30 });
  }

  /**
   * Stop capture (if any) and refresh the download link for the last run.
   * @returns {Promise<object|null>}
   */
  async finalizeRecording() {
    if (!this._recorder.recording) {
      this._syncLastRunUi();
      return this._recorder.last;
    }
    const last = await this._recorder.stop();
    this._syncLastRunUi();
    return last;
  }

  /** @returns {{ url: string, name: string, bytes: number, duration: number, mime: string } | null} */
  getLastRun() {
    return this._recorder?.last ?? null;
  }

  _syncLastRunUi() {
    const last = this._recorder?.last;
    if (!this.lastRunEl) return;
    if (!last) {
      this.lastRunEl.hidden = true;
      if (this.lastRunLink) {
        this.lastRunLink.removeAttribute('href');
        this.lastRunLink.removeAttribute('download');
        this.lastRunLink.onclick = null;
      }
      if (this.lastRunMeta) this.lastRunMeta.textContent = '';
      this._setDownloadProgress(null);
      return;
    }
    this.lastRunEl.hidden = false;
    if (this.lastRunLink) {
      // Click remuxes then downloads (raw MediaRecorder WebM cannot scrub).
      this.lastRunLink.href = '#';
      this.lastRunLink.removeAttribute('download');
      this.lastRunLink.textContent = 'Download last run';
      this.lastRunLink.onclick = (e) => {
        e.preventDefault();
        void this.downloadLastRun();
      };
    }
    if (this.lastRunMeta && !this._dlBusy) {
      const bits = [
        formatDuration(last.duration),
        formatBytes(last.bytes),
        last.hasAudio ? 'sound' : 'silent',
        last.seekable ? 'seekable' : 'remux on save',
        'local',
      ];
      this.lastRunMeta.textContent = bits.join(' · ');
    }
  }

  /**
   * Remux (seekable WebM) + download. Shared by title shell and death card.
   * @param {(p: number, label?: string) => void} [onProgress]
   * @returns {Promise<object|null>} updated last-run meta
   */
  async downloadLastRun(onProgress) {
    if (!this._recorder?.last || this._dlBusy) return this._recorder?.last ?? null;
    this._dlBusy = true;
    const report = (p, label) => {
      this._setDownloadProgress(p, label);
      onProgress?.(p, label);
    };
    report(0.05, 'Preparing…');
    try {
      await this._recorder.download((p, label) => {
        report(p, label || 'Remuxing…');
      });
      report(1, 'Saved');
      this._syncLastRunUi();
      setTimeout(() => {
        if (this._dlBusy) return;
        this._setDownloadProgress(null);
        this._syncLastRunUi();
      }, 1600);
      return this._recorder.last;
    } catch (err) {
      console.warn('[recorder] download failed', err);
      report(1, 'Save failed');
      throw err;
    } finally {
      this._dlBusy = false;
    }
  }

  /**
   * @param {number | null} p  0..1, null clears bar
   * @param {string} [label]
   */
  _setDownloadProgress(p, label) {
    const bar = this.lastRunEl?.querySelector('.boot-last-run-bar');
    const fill = this.lastRunEl?.querySelector('.boot-last-run-fill');
    if (this.lastRunMeta && label) this.lastRunMeta.textContent = label;
    if (!bar || !fill) return;
    if (p == null) {
      bar.hidden = true;
      fill.style.width = '0%';
      return;
    }
    bar.hidden = false;
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  }

  /** Open the shell as the pause / settings menu (Resume CTA). */
  showPause({ meta } = {}) {
    if (!this.root) return;
    this._inGame = true;
    this._ready = true;
    this._phase = 'paused';
    this._qualityLocked = true;
    if (!this._qCards.length) this._buildQualityCards();
    this._syncLookFromConfig();
    this._syncLookUi();
    this._syncQualityUi();
    this._setLiveQuality();
    this._setWarn('');

    if (this.blurbEl) this.blurbEl.hidden = true;
    this._setPanelMode('weapons');
    if (this.fillEl) this.fillEl.style.width = '100%';
    if (this.pctEl) this.pctEl.textContent = '100%';
    if (this.labelEl) this.labelEl.textContent = 'Paused';
    if (this.hintEl) this.hintEl.textContent = 'Esc · Enter · Space · Resume · Retreat → menu';
    if (this.kickerEl) this.kickerEl.textContent = 'Paused';
    if (meta != null) this.setMeta(meta);
    else if (this._selectedQuality) {
      this.setMeta(`${this._selectedQuality.toUpperCase()} · graphics locked`);
    }

    this.root.classList.add('boot-paused');
    this._showShell({ ready: true });
    this._setActionButton('resume');
    this.deployBtn?.focus?.({ preventScroll: true });
    this._menuAudio.play('open');
    this._menuAudio.startMusic();
  }

  /**
   * Hide the pause shell without killing the controller.
   * @param {{ immediate?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  hidePause({ immediate = false } = {}) {
    if (this._phase !== 'paused' && this._phase !== 'ready') {
      if (this._inGame) this._phase = 'playing';
      return Promise.resolve();
    }
    this._phase = 'playing';
    this._inGame = true;
    this.root?.classList.remove('boot-paused');
    this._menuAudio.stopMusic();
    return this._hideShell({ immediate });
  }

  /**
   * Soft hide for capture / autostart — shell can still open as pause later.
   * Does not tear down listeners.
   */
  hideImmediate() {
    this._inGame = true;
    this._ready = true;
    this._phase = 'playing';
    this._qualityLocked = true;
    this._flushLoad();
    this._flushDeploy();
    if (this.root) {
      this.root.classList.add('boot-hidden');
      this.root.classList.remove('boot-gone');
    }
  }

  /** Hard teardown (HMR / dispose). */
  dismiss({ immediate = false } = {}) {
    if (this._dismissed) return;
    this._dismissed = true;
    this._ready = true;
    this._phase = 'playing';
    this._flushLoad();
    this._flushDeploy();
    removeEventListener('keydown', this._onKey);
    if (this.deployBtn) this.deployBtn.removeEventListener('click', this._onCtaClick);
    if (this.retreatBtn) this.retreatBtn.removeEventListener('click', this._onRetreatClick);
    if (this._readyFlashTimer) {
      clearTimeout(this._readyFlashTimer);
      this._readyFlashTimer = 0;
    }
    this.root?.classList.remove('boot-paused');
    this._menuAudio.stopMusic({ immediate: true });
    this._menuAudio.dispose();
    this._hideShell({ immediate });
  }

  // ----------------------------------------------------------------- private

  /**
   * Purpose of the menu bed: audible proof on load that the app has sound.
   * Try to start immediately; if the browser suspends autoplay, arm a one-shot
   * gesture resume so the first key/click unlocks it without a second wait.
   */
  _startMenuAudioOnBoot() {
    if (this._dismissed || this._phase === 'playing') return;
    if (this.root?.classList.contains('boot-hidden')) return;
    this._menuAudio.startMusic();
    this._armMenuMusic();
  }

  _armMenuMusic() {
    if (this._musicArmed || !this.root) return;
    this._musicArmed = true;
    const kick = () => {
      this.root?.removeEventListener('pointerdown', kick);
      removeEventListener('keydown', kick);
      this._menuAudio.ensure().then((ok) => {
        if (ok && this._phase !== 'playing') this._menuAudio.startMusic();
      });
    };
    this.root.addEventListener('pointerdown', kick, { passive: true });
    addEventListener('keydown', kick, { passive: true });
  }

  _sfx(kind, level) {
    this._menuAudio.play(kind, level);
  }

  _setLiveQuality() {
    if (!this.qLive) return;
    const b = QUALITY_BLURBS[this._selectedQuality];
    this.qLive.innerHTML = `Running <strong>${this._selectedQuality.toUpperCase()}</strong>${
      b ? ` — ${b.desc}` : ''
    }`;
  }

  /**
   * Pre-Load: graphics cards. Post-Load + pause: weapons briefing.
   * Both panels stay laid out (stacked) so the shell does not jump on swap.
   * @param {'graphics' | 'weapons'} mode
   */
  _setPanelMode(mode) {
    const weapons = mode === 'weapons';
    if (this.graphicsBlock) {
      this.graphicsBlock.classList.toggle('is-off', weapons);
      this.graphicsBlock.setAttribute('aria-hidden', weapons ? 'true' : 'false');
      if (this.graphicsBlock.hidden) this.graphicsBlock.hidden = false;
    }
    if (this.weaponsBlock) {
      this.weaponsBlock.classList.toggle('is-off', !weapons);
      this.weaponsBlock.setAttribute('aria-hidden', weapons ? 'false' : 'true');
      if (this.weaponsBlock.hidden) this.weaponsBlock.hidden = false;
    }
  }

  /**
   * @param {'load' | 'loading' | 'deploy' | 'resume'} mode
   */
  _setActionButton(mode) {
    const btn = this.deployBtn;
    if (!btn) return;
    const labels = {
      load: 'Load',
      loading: 'Loading',
      deploy: 'Deploy',
      resume: 'Resume',
    };
    const label = labels[mode] ?? 'Load';
    if (this.deployLabel) this.deployLabel.textContent = label;
    else btn.textContent = label;

    btn.classList.toggle('is-loading', mode === 'loading');
    btn.classList.toggle('is-action', mode === 'load' || mode === 'deploy' || mode === 'resume');
    // Clear ready flash when leaving the Deploy CTA (loading / resume / load).
    if (mode !== 'deploy') btn.classList.remove('is-ready-flash');
    btn.disabled = mode === 'loading';
    btn.setAttribute('aria-busy', mode === 'loading' ? 'true' : 'false');
  }

  /**
   * Drop browser fullscreen while the title shell owns the screen.
   * Fullscreen is re-entered only on Deploy / Resume (user gesture).
   */
  _ensureWindowedUntilDeploy() {
    if (!document.fullscreenElement) return;
    // Pause shell may already be fullscreen from the previous match — leave it.
    if (this._phase === 'paused' || this._inGame) return;
    try {
      document.exitFullscreen?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * Deploy just became available: flash the CTA + radio ready cue.
   * Fire once per ready entry (not on pause Resume).
   */
  _cueDeployReady() {
    const btn = this.deployBtn;
    if (btn) {
      btn.classList.remove('is-ready-flash');
      // Force reflow so re-entering ready restarts the animation.
      void btn.offsetWidth;
      btn.classList.add('is-ready-flash');
      if (this._readyFlashTimer) clearTimeout(this._readyFlashTimer);
      this._readyFlashTimer = setTimeout(() => {
        btn.classList.remove('is-ready-flash');
        this._readyFlashTimer = 0;
      }, 2400);
    }
    // Menu: radio squelch + clear tones (works even if game graph is quiet).
    this._sfx('ready', 1);
    // Game: short radio "copy" if the match audio system is already up.
    this._playReadyRadioBark();
  }

  _playReadyRadioBark() {
    const game = this._gameAudio;
    if (!game || typeof game.bark !== 'function') return;
    const fire = () => {
      try {
        game.bark('copy', null, { radio: true, force: true, level: 0.75, send: 0.08 });
      } catch {
        /* optional flavour */
      }
    };
    try {
      const p = typeof game.start === 'function' ? game.start() : null;
      if (p && typeof p.then === 'function') p.then(fire, () => {});
      else fire();
    } catch {
      /* game audio optional */
    }
  }

  _showShell({ ready = false } = {}) {
    if (!this.root) return;
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = 0;
    }
    this.root.classList.remove('boot-hidden', 'boot-gone');
    this.root.classList.toggle('boot-ready', !!ready);
    // Shell is interactive again — never leave the FPS `cursor: none` active.
    this._input?.releasePointerForUi?.();
    if (this._input) this._input._showUiCursor?.();
    else {
      document.body.style.cursor = 'default';
      document.documentElement.style.cursor = 'default';
    }
  }

  /**
   * @param {{ immediate?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  _hideShell({ immediate = false } = {}) {
    if (!this.root) return Promise.resolve();
    if (this._hideTimer) {
      clearTimeout(this._hideTimer);
      this._hideTimer = 0;
    }
    if (immediate) {
      this.root.classList.add('boot-hidden');
      this.root.classList.remove('boot-gone', 'boot-ready');
      return Promise.resolve();
    }
    // Already fully hidden — nothing to wait on.
    if (this.root.classList.contains('boot-hidden')) return Promise.resolve();

    this.root.classList.add('boot-gone');
    const root = this.root;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        root.classList.add('boot-hidden');
        root.classList.remove('boot-gone', 'boot-ready');
        root.removeEventListener('transitionend', onEnd);
        if (this._hideTimer) {
          clearTimeout(this._hideTimer);
          this._hideTimer = 0;
        }
        resolve();
      };
      const onEnd = (e) => {
        // Only the shell opacity transition, not nested element transitions.
        if (e.target !== root || (e.propertyName && e.propertyName !== 'opacity')) return;
        done();
      };
      root.addEventListener('transitionend', onEnd);
      this._hideTimer = setTimeout(done, 700);
    });
  }

  /**
   * Wire the graphics tier cards. Prefers static markup in index.html so the
   * options paint on first frame; falls back to building them if the host is empty.
   */
  _buildQualityCards() {
    const host = this.qualityHost;
    if (!host) return;

    let buttons = [...host.querySelectorAll('.boot-q-card[data-quality]')];
    if (!buttons.length) {
      for (const name of PRESETS) {
        const blurb = QUALITY_BLURBS[name];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'boot-q-card';
        btn.dataset.quality = name;
        btn.setAttribute('role', 'radio');
        btn.innerHTML =
          `<div class="boot-q-name"><span>${name}</span>` +
          `<span class="boot-q-tag">${blurb?.tag ?? ''}</span></div>` +
          `<div class="boot-q-desc">${blurb?.desc ?? ''}</div>` +
          qualityCardMetaHtml(blurb);
        host.appendChild(btn);
      }
      buttons = [...host.querySelectorAll('.boot-q-card[data-quality]')];
    }

    this._qCards.length = 0;
    for (const btn of buttons) {
      const name = btn.dataset.quality;
      if (!PRESETS.includes(name)) continue;
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        // Read lock live from `this._qualityLocked` — never close over a build-time flag.
        btn.addEventListener('click', () => this._onQualityClick(name));
      }
      this._qCards.push(btn);
    }
  }

  _onQualityClick(name) {
    if (this._dismissed) return;
    if (this._qualityLocked) {
      if (name !== this._selectedQuality) {
        this._setWarn('Reload to change graphics');
        this._sfx('click', 0.7);
      } else {
        this._setWarn('');
        this._sfx('tick', 0.5);
      }
      this._syncQualityUi();
      return;
    }
    if (name === this._selectedQuality) {
      this._sfx('tick', 0.5);
      return;
    }
    this._selectedQuality = name;
    this.prefs.quality = name;
    this._persistPrefs();
    this._setWarn('');
    this._syncQualityUi();
    this._setLiveQuality();
    this._sfx('select');
  }

  _syncQualityUi() {
    for (const c of this._qCards) {
      const on = c.dataset.quality === this._selectedQuality;
      c.classList.toggle('is-on', on);
      c.classList.toggle('is-locked', this._qualityLocked && !on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  _setWarn(text) {
    if (this.qWarn) this.qWarn.textContent = text || '';
  }

  _bindFullscreenToggle() {
    if (!this.fullscreenInput) return;
    this.fullscreenInput.checked = !!this.prefs.fullscreen;
    this.fullscreenInput.addEventListener('change', () => {
      this.prefs.fullscreen = !!this.fullscreenInput.checked;
      this._persistPrefs();
      this._applyFullscreenToInput();
      // Leaving fullscreen from the pause shell so the next Resume stays windowed.
      if (!this.prefs.fullscreen && document.fullscreenElement) {
        try {
          document.exitFullscreen?.();
        } catch {
          /* ignore */
        }
      }
      this._sfx('tick', 0.55);
    });
  }

  _bindRecordToggle() {
    if (!this.recordInput) return;
    this.recordInput.checked = !!this.prefs.recordRun;
    if (!this._recorder.supported) {
      this.recordInput.disabled = true;
      this.recordInput.checked = false;
      this.prefs.recordRun = false;
    }
    this.recordInput.addEventListener('change', () => {
      this.prefs.recordRun = !!this.recordInput.checked;
      this._persistPrefs();
      this._sfx('tick', 0.55);
    });
  }

  _applyFullscreenToInput() {
    if (this.fullscreenInput) this.prefs.fullscreen = !!this.fullscreenInput.checked;
    if (this._input) this._input.wantFullscreen = !!this.prefs.fullscreen;
  }

  _bindLookControls() {
    if (this.sensInput) {
      this.sensInput.value = String(this.prefs.sensMult);
      this.sensInput.addEventListener('input', () => {
        this.prefs.sensMult = clampNum(parseFloat(this.sensInput.value), 0.2, 3, 1);
        if (this.sensVal) this.sensVal.textContent = this.prefs.sensMult.toFixed(2);
        this._persistPrefs();
        this._applyLookToConfig();
        this._tickSfx();
      });
    }
    if (this.fovInput) {
      this.fovInput.value = String(this.prefs.fov);
      this.fovInput.addEventListener('input', () => {
        this.prefs.fov = clampNum(parseFloat(this.fovInput.value), 65, 120, 80) | 0;
        if (this.fovVal) this.fovVal.textContent = String(this.prefs.fov);
        this._persistPrefs();
        this._applyLookToConfig();
        this._tickSfx();
      });
    }
    if (this.volInput) {
      this.volInput.value = String(this.prefs.masterVol);
      this.volInput.addEventListener('input', () => {
        this.prefs.masterVol = clampNum(parseFloat(this.volInput.value), 0, 1, 0.95);
        if (this.volVal) this.volVal.textContent = `${Math.round(this.prefs.masterVol * 100)}%`;
        this._menuAudio.setVolume(this.prefs.masterVol);
        this._persistPrefs();
        this._tickSfx();
      });
    }
    if (this.invertHost) {
      this.invertHost.addEventListener('click', (e) => {
        const t = e.target.closest('button[data-inv]');
        if (!t) return;
        const next = t.dataset.inv === '1';
        if (next === !!this.prefs.invertY) {
          this._sfx('tick', 0.5);
          return;
        }
        this.prefs.invertY = next;
        this._persistPrefs();
        this._syncLookUi();
        this._applyLookToConfig();
        this._sfx('select');
      });
    }
    this._syncLookUi();
  }

  /** Rate-limited grain while dragging sliders. */
  _tickSfx() {
    const now = performance.now();
    if (now - this._lastTickAt < 55) return;
    this._lastTickAt = now;
    this._sfx('tick', 0.55);
  }

  _syncLookFromConfig() {
    const cfg = this._config;
    if (!cfg) return;
    if (Number.isFinite(cfg.sensitivity)) {
      this.prefs.sensMult = clampNum(cfg.sensitivity / BASE_SENS, 0.2, 3, this.prefs.sensMult);
    }
    if (Number.isFinite(cfg.fov)) {
      this.prefs.fov = clampNum(cfg.fov, 65, 120, this.prefs.fov) | 0;
    }
    if (cfg.invertY != null) this.prefs.invertY = !!cfg.invertY;
    if (PRESETS.includes(cfg.quality)) this._selectedQuality = cfg.quality;
  }

  _syncLookUi() {
    if (this.sensInput) this.sensInput.value = String(this.prefs.sensMult);
    if (this.sensVal) this.sensVal.textContent = this.prefs.sensMult.toFixed(2);
    if (this.fovInput) this.fovInput.value = String(this.prefs.fov);
    if (this.fovVal) this.fovVal.textContent = String(this.prefs.fov | 0);
    if (this.volInput) this.volInput.value = String(this.prefs.masterVol);
    if (this.volVal) this.volVal.textContent = `${Math.round(this.prefs.masterVol * 100)}%`;
    if (this.fullscreenInput) this.fullscreenInput.checked = !!this.prefs.fullscreen;
    if (this.recordInput && !this.recordInput.disabled) {
      this.recordInput.checked = !!this.prefs.recordRun;
    }
    if (this.invertHost) {
      for (const b of this.invertHost.querySelectorAll('button[data-inv]')) {
        b.classList.toggle('is-on', (b.dataset.inv === '1') === !!this.prefs.invertY);
      }
    }
  }

  _applyLookToConfig() {
    const cfg = this._config;
    if (!cfg) return;
    cfg.sensitivity = BASE_SENS * this.prefs.sensMult;
    cfg.fov = this.prefs.fov;
    cfg.invertY = !!this.prefs.invertY;
    const cam = this._camera;
    if (cam) {
      cam.fov = this.prefs.fov;
      cam.updateProjectionMatrix?.();
    }
  }

  _persistPrefs() {
    writePrefs({
      sensMult: this.prefs.sensMult,
      fov: this.prefs.fov,
      invertY: this.prefs.invertY,
      masterVol: this.prefs.masterVol,
      fullscreen: !!this.prefs.fullscreen,
      recordRun: !!this.prefs.recordRun,
      quality: this.prefs.quality ?? this._selectedQuality,
    });
  }

  _resolveCta() {
    if (this._dismissed) return;
    if (this._phase === 'idle') {
      this._sfx('confirm');
      this._flushLoad();
      return;
    }
    if (this._phase === 'paused') {
      this._applyFullscreenToInput();
      // Fullscreen on the Resume click (user gesture) while the shell still
      // has a visible cursor; pointer-lock waits until the shell is gone.
      void this._input?.prepareGameSurface?.();
      this._sfx('confirm', 0.85);
      if (this._resumeHandler) this._resumeHandler();
      else void this.hidePause();
      return;
    }
    if (this._phase === 'ready' && this._ready) {
      this._applyFullscreenToInput();
      // Fullscreen now if opted in — keep the menu cursor until main finishes
      // hiding the shell, then capturePointerForGame locks aim.
      void this._input?.prepareGameSurface?.();
      this._sfx('confirm');
      this._flushDeploy();
      // enterPlaying is awaited in main before pointer-lock.
    }
  }

  _resolveRetreat() {
    if (this._dismissed) return;
    if (this._phase !== 'paused') return;
    this._sfx('confirm', 0.7);
    if (typeof this._retreatHandler === 'function') {
      this._retreatHandler();
      return;
    }
    // Fallback if no handler (should not happen in normal boots).
    location.reload();
  }

  _flushLoad() {
    const list = this._loadResolvers.splice(0);
    for (const r of list) r();
  }

  _flushDeploy() {
    const list = this._deployResolvers.splice(0);
    for (const r of list) r();
  }
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Singleton helper — safe if #boot was stripped from the document. */
export function createLoadScreen() {
  return new LoadScreen();
}
