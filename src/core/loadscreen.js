/**
 * Boot / title shell controller.
 *
 * The markup and CSS live in index.html so first paint is immediate (no module
 * wait, no black void). This module only binds to that DOM and drives progress
 * → ready → deploy → dismiss.
 *
 * Capture / tooling paths call hideImmediate() so the overlay never appears in
 * screenshots or blocks __READY__.
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

function labelFor(stage, fallback) {
  if (fallback) return fallback;
  if (!stage) return 'Loading…';
  return STAGE_LABELS[stage] ?? String(stage);
}

export class LoadScreen {
  constructor(root = document.getElementById('boot')) {
    this.root = root;
    this.labelEl = root?.querySelector('#boot-label') ?? null;
    this.pctEl = root?.querySelector('#boot-pct') ?? null;
    this.fillEl = root?.querySelector('#boot-fill') ?? null;
    this.metaEl = root?.querySelector('#boot-meta') ?? null;
    this.hintEl = root?.querySelector('#boot-hint') ?? null;
    this.deployBtn = root?.querySelector('#boot-deploy') ?? null;

    this._progress = 0;
    this._ready = false;
    this._dismissed = false;
    this._deployResolvers = [];
    this._onDeployClick = () => this._resolveDeploy();

    if (this.deployBtn) {
      this.deployBtn.addEventListener('click', this._onDeployClick);
    }

    // Enter / Space once ready — standard title-screen deploy.
    this._onKey = (e) => {
      if (!this._ready || this._dismissed) return;
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this._resolveDeploy();
      }
    };
    addEventListener('keydown', this._onKey);
  }

  get ready() {
    return this._ready;
  }

  get dismissed() {
    return this._dismissed;
  }

  /**
   * @param {number} t  0..1
   * @param {{ stage?: string, label?: string, meta?: string }} [info]
   */
  setProgress(t, info = {}) {
    if (this._dismissed || !this.root) return;
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

  /** Switch the shell into the main-menu / title state. */
  enterReady({ meta } = {}) {
    if (this._dismissed || !this.root) return;
    this._ready = true;
    this._progress = 1;
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

  /** Resolves when the player deploys (or hideImmediate/dismiss was called). */
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
    this._flushDeploy();
    removeEventListener('keydown', this._onKey);
    if (this.deployBtn) this.deployBtn.removeEventListener('click', this._onDeployClick);

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
    // Fallback if transitionend never fires (display:none mid-flight, etc.)
    setTimeout(done, 700);
  }

  /** Capture / autostart: never show a blocking title gate. */
  hideImmediate() {
    this.dismiss({ immediate: true });
  }

  _resolveDeploy() {
    if (this._dismissed) return;
    if (!this._ready) return;
    this.dismiss({ immediate: false });
  }

  _flushDeploy() {
    const list = this._deployResolvers.splice(0);
    for (const r of list) r();
  }
}

/** Singleton helper — safe if #boot was stripped from the document. */
export function createLoadScreen() {
  return new LoadScreen();
}
