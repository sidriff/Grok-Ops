/**
 * Boot / title shell controller.
 *
 * Markup + CSS live in index.html for first paint. Phases:
 *   1. briefing  — what this is, pick graphics, press Load
 *   2. loading   — progress + controls + sens/FOV/invert (graphics locked)
 *   3. ready     — Deploy to enter the match
 *
 * Graphics quality is chosen before engine init (it drives shaders, bake sizes,
 * prewarm). Changing it after Load only shows "Reload to change". Look prefs
 * (sens / FOV / invert) apply live once `bindConfig` is called.
 *
 * Capture / tooling paths call hideImmediate() so the overlay never appears.
 */

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

/** Attractive one-liners for the quality cards. */
export const QUALITY_BLURBS = {
  low: {
    tag: 'Fast boot',
    desc: 'Lower res, basic post. Boots quick so you can play and iterate — expect fewer fancy lights and reflections.',
  },
  medium: {
    tag: 'Balanced',
    desc: 'TAA, ambient occlusion, volumetrics. Solid default for a real GPU without melting the fans.',
  },
  high: {
    tag: 'Full stack',
    desc: 'SSR, sharper scales, heavier particles. Needs a modern card for a smooth firefight.',
  },
  ultra: {
    tag: 'Max fidelity',
    desc: 'Biggest shadows, densest FX, capture baselines. Opt-in only — not the everyday boot.',
  },
};

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
    this.briefingEl = root?.querySelector('#boot-briefing') ?? null;
    this.loadingEl = root?.querySelector('#boot-loading') ?? null;
    this.qualityHost = root?.querySelector('#boot-quality') ?? null;
    this.qualityLockedHost = root?.querySelector('#boot-quality-locked') ?? null;
    this.qWarnBrief = root?.querySelector('#boot-q-warn') ?? null;
    this.qWarnLoad = root?.querySelector('#boot-q-warn-load') ?? null;
    this.qLive = root?.querySelector('#boot-q-live') ?? null;
    this.briefHint = root?.querySelector('#boot-brief-hint') ?? null;
    this.loadBtn = root?.querySelector('#boot-load') ?? null;
    this.labelEl = root?.querySelector('#boot-label') ?? null;
    this.pctEl = root?.querySelector('#boot-pct') ?? null;
    this.fillEl = root?.querySelector('#boot-fill') ?? null;
    this.metaEl = root?.querySelector('#boot-meta') ?? null;
    this.hintEl = root?.querySelector('#boot-hint') ?? null;
    this.deployBtn = root?.querySelector('#boot-deploy') ?? null;
    this.sensInput = root?.querySelector('#boot-sens') ?? null;
    this.sensVal = root?.querySelector('#boot-sens-val') ?? null;
    this.fovInput = root?.querySelector('#boot-fov') ?? null;
    this.fovVal = root?.querySelector('#boot-fov-val') ?? null;
    this.invertHost = root?.querySelector('#boot-invert') ?? null;

    this._phase = 'briefing'; // briefing | loading | ready | gone
    this._progress = 0;
    this._ready = false;
    this._dismissed = false;
    this._qualityLocked = false;
    this._selectedQuality = 'medium';
    this._recommended = 'medium';
    this._loadResolvers = [];
    this._deployResolvers = [];
    this._config = null;
    this._camera = null;
    this._qCards = [];
    this._qCardsLocked = [];

    const saved = readPrefs() || {};
    this.prefs = {
      sensMult: clampNum(saved.sensMult, 0.2, 3, 1),
      fov: clampNum(saved.fov, 65, 120, 80),
      invertY: !!saved.invertY,
      quality: PRESETS.includes(saved.quality) ? saved.quality : null,
    };

    this._onDeployClick = () => this._resolveDeploy();
    this._onLoadClick = () => this._resolveLoad();
    this._onKey = (e) => {
      if (this._dismissed) return;
      if (this._phase === 'briefing' && (e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        this._resolveLoad();
        return;
      }
      if (this._phase === 'ready' && this._ready && (e.code === 'Enter' || e.code === 'Space')) {
        e.preventDefault();
        this._resolveDeploy();
      }
    };

    if (this.deployBtn) this.deployBtn.addEventListener('click', this._onDeployClick);
    if (this.loadBtn) this.loadBtn.addEventListener('click', this._onLoadClick);
    addEventListener('keydown', this._onKey);

    this._bindLookControls();
    this._setPhase('briefing');
  }

  get ready() {
    return this._ready;
  }

  get dismissed() {
    return this._dismissed;
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
   * Show briefing, wait for Load. Returns chosen quality + look prefs.
   * @param {{ recommended?: string, forced?: string|null, gpuLabel?: string }} opts
   */
  waitForBriefing({ recommended = 'medium', forced = null, gpuLabel = '' } = {}) {
    if (this._dismissed || !this.root) {
      return Promise.resolve({
        quality: forced && PRESETS.includes(forced) ? forced : recommended,
        ...this.lookPrefs,
      });
    }

    this._recommended = PRESETS.includes(recommended) ? recommended : 'medium';
    this._selectedQuality =
      (forced && PRESETS.includes(forced) && forced) ||
      this.prefs.quality ||
      this._recommended;

    this._buildQualityCards(this.qualityHost, this._qCards, { locked: false });
    this._syncQualityUi();
    this._syncLookUi();

    if (this.briefHint) {
      const rec = this._recommended.toUpperCase();
      this.briefHint.textContent = gpuLabel
        ? `GPU suggests ${rec} · ${gpuLabel}`
        : `GPU suggests ${rec}`;
    }
    if (this.loadBtn) this.loadBtn.focus?.({ preventScroll: true });

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

  /** Enter the loading phase (progress bar + controls). Locks graphics. */
  beginLoading({ meta } = {}) {
    if (this._dismissed || !this.root) return;
    this._qualityLocked = true;
    this._setPhase('loading');
    this._buildQualityCards(this.qualityLockedHost, this._qCardsLocked, { locked: true });
    this._syncQualityUi();
    this._syncLookUi();
    this._progress = 0;
    if (this.fillEl) this.fillEl.style.width = '0%';
    if (this.pctEl) this.pctEl.textContent = '0%';
    if (this.labelEl) this.labelEl.textContent = 'Loading…';
    if (this.hintEl) this.hintEl.textContent = 'Building the AO';
    if (meta != null) this.setMeta(meta);
    if (this.qLive) {
      const b = QUALITY_BLURBS[this._selectedQuality];
      this.qLive.innerHTML = `Running <strong>${this._selectedQuality.toUpperCase()}</strong>${
        b ? ` — ${b.desc}` : ''
      }`;
    }
    this._setWarn('');
  }

  /**
   * Wire live config once the engine exists. Look sliders write through.
   * @param {object} config
   * @param {import('three').PerspectiveCamera} [camera]
   */
  bindConfig(config, camera = null) {
    this._config = config;
    this._camera = camera;
    this._applyLookToConfig();
  }

  /**
   * @param {number} t  0..1
   * @param {{ stage?: string, label?: string, meta?: string }} [info]
   */
  setProgress(t, info = {}) {
    if (this._dismissed || !this.root) return;
    if (this._phase === 'briefing') return;
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
    this._setPhase('ready');
    if (this.fillEl) this.fillEl.style.width = '100%';
    if (this.pctEl) this.pctEl.textContent = '100%';
    if (this.labelEl) this.labelEl.textContent = 'Ready';
    if (this.hintEl) this.hintEl.textContent = 'Enter · Space · Click Deploy';
    if (meta != null && this.metaEl) this.metaEl.textContent = meta;
    this.root.classList.add('boot-ready');
    if (this.deployBtn) {
      this.deployBtn.disabled = false;
      this.deployBtn.focus?.({ preventScroll: true });
    }
  }

  waitForDeploy() {
    if (this._dismissed || !this.root) return Promise.resolve();
    return new Promise((resolve) => {
      this._deployResolvers.push(resolve);
    });
  }

  dismiss({ immediate = false } = {}) {
    if (this._dismissed) return;
    this._dismissed = true;
    this._ready = true;
    this._phase = 'gone';
    this._flushLoad();
    this._flushDeploy();
    removeEventListener('keydown', this._onKey);
    if (this.deployBtn) this.deployBtn.removeEventListener('click', this._onDeployClick);
    if (this.loadBtn) this.loadBtn.removeEventListener('click', this._onLoadClick);

    if (!this.root) return;
    if (immediate) {
      this.root.classList.add('boot-hidden');
      return;
    }
    this.root.classList.add('boot-gone');
    const root = this.root;
    const done = () => {
      root.classList.add('boot-hidden');
      root.removeEventListener('transitionend', done);
    };
    root.addEventListener('transitionend', done);
    setTimeout(done, 700);
  }

  hideImmediate() {
    this.dismiss({ immediate: true });
  }

  // ----------------------------------------------------------------- private

  _setPhase(phase) {
    this._phase = phase;
    if (!this.root) return;
    this.root.classList.remove('boot-phase-briefing', 'boot-phase-loading', 'boot-phase-ready');
    this.root.classList.add(`boot-phase-${phase === 'gone' ? 'ready' : phase}`);
    if (this.briefingEl) this.briefingEl.hidden = phase !== 'briefing';
    if (this.loadingEl) this.loadingEl.hidden = phase === 'briefing' || phase === 'gone';
  }

  _buildQualityCards(host, bucket, { locked }) {
    if (!host) return;
    host.replaceChildren();
    bucket.length = 0;
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
        `<div class="boot-q-desc">${blurb?.desc ?? ''}</div>`;
      btn.addEventListener('click', () => this._onQualityClick(name, locked));
      host.appendChild(btn);
      bucket.push(btn);
    }
  }

  _onQualityClick(name, locked) {
    if (this._dismissed) return;
    if (locked || this._qualityLocked) {
      if (name !== this._selectedQuality) {
        this._setWarn('Reload to change graphics');
      } else {
        this._setWarn('');
      }
      this._syncQualityUi();
      return;
    }
    this._selectedQuality = name;
    this.prefs.quality = name;
    this._persistPrefs();
    this._setWarn('');
    this._syncQualityUi();
  }

  _syncQualityUi() {
    const paint = (cards) => {
      for (const c of cards) {
        const on = c.dataset.quality === this._selectedQuality;
        c.classList.toggle('is-on', on);
        c.classList.toggle('is-locked', this._qualityLocked && !on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    paint(this._qCards);
    paint(this._qCardsLocked);
  }

  _setWarn(text) {
    for (const el of [this.qWarnBrief, this.qWarnLoad]) {
      if (el) el.textContent = text || '';
    }
  }

  _bindLookControls() {
    if (this.sensInput) {
      this.sensInput.value = String(this.prefs.sensMult);
      this.sensInput.addEventListener('input', () => {
        this.prefs.sensMult = clampNum(parseFloat(this.sensInput.value), 0.2, 3, 1);
        if (this.sensVal) this.sensVal.textContent = this.prefs.sensMult.toFixed(2);
        this._persistPrefs();
        this._applyLookToConfig();
      });
    }
    if (this.fovInput) {
      this.fovInput.value = String(this.prefs.fov);
      this.fovInput.addEventListener('input', () => {
        this.prefs.fov = clampNum(parseFloat(this.fovInput.value), 65, 120, 80) | 0;
        if (this.fovVal) this.fovVal.textContent = String(this.prefs.fov);
        this._persistPrefs();
        this._applyLookToConfig();
      });
    }
    if (this.invertHost) {
      this.invertHost.addEventListener('click', (e) => {
        const t = e.target.closest('button[data-inv]');
        if (!t) return;
        this.prefs.invertY = t.dataset.inv === '1';
        this._persistPrefs();
        this._syncLookUi();
        this._applyLookToConfig();
      });
    }
    this._syncLookUi();
  }

  _syncLookUi() {
    if (this.sensInput) this.sensInput.value = String(this.prefs.sensMult);
    if (this.sensVal) this.sensVal.textContent = this.prefs.sensMult.toFixed(2);
    if (this.fovInput) this.fovInput.value = String(this.prefs.fov);
    if (this.fovVal) this.fovVal.textContent = String(this.prefs.fov | 0);
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
      quality: this.prefs.quality ?? this._selectedQuality,
    });
  }

  _resolveLoad() {
    if (this._dismissed) return;
    if (this._phase !== 'briefing') return;
    this._flushLoad();
  }

  _resolveDeploy() {
    if (this._dismissed) return;
    if (!this._ready) return;
    this.dismiss({ immediate: false });
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
