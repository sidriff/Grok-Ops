import { el, setStyle, damp, ease } from './util.js';

/**
 * Pause controller.
 *
 * Presentation is the boot shell (`LoadScreen`) — same graphics / look /
 * controls panel as the title load screen, with Resume instead of Deploy.
 * This class owns sim freeze, pointer lock, and `ui:pause` events.
 *
 * Events emitted: `ui:pause` {paused}
 */
export class PauseMenu {
  constructor(parent, ctx) {
    this.ctx = ctx;
    // Fallback root kept for opacity bookkeeping when no boot shell is wired
    // (should not happen in normal boots — main always attaches LoadScreen).
    this.root = el('div', 'ow-menu', parent);
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'pointer-events', 'none');

    this.boot = null;
    this.open = false;
    this.shown = 0;
    this._prevScale = 1;
    /** @type {null | (() => void)} */
    this.onRetreat = null;
  }

  /**
   * Use the title shell as the pause / settings UI.
   * @param {import('../core/loadscreen.js').LoadScreen} boot
   */
  useBootShell(boot) {
    this.boot = boot || null;
    if (this.boot) {
      this.boot.setResumeHandler(() => this.close());
      this.boot.setRetreatHandler(() => this.retreat());
    }
  }

  /** Back to title menu (soft retreat — no full reload when UiSystem is wired). */
  retreat() {
    if (typeof this.onRetreat === 'function') {
      this.onRetreat();
      return;
    }
    // Fallback when boot shell isn't available.
    location.reload();
  }

  /** No-op — look prefs live on the boot shell; kept for API compatibility. */
  syncFromConfig() {
    /* boot shell syncs on showPause */
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    if (this.open) return;
    this.open = true;

    // Free the OS cursor and stop auto pointer-lock so buttons are clickable.
    this.ctx.input?.releasePointerForUi?.();
    const t = this.ctx.time;
    if (t) {
      this._prevScale = t.scale;
      t.scale = 0;
    }
    this.ctx.peek('player')?.setControlEnabled?.(false);
    this.ctx.events.emit('ui:pause', { paused: true });

    if (this.boot) {
      this.boot.showPause();
      return;
    }

    // Bare fallback if boot was never attached (tooling edge case).
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', 'auto');
    setStyle(this.root, 'cursor', 'default');
    this.root.replaceChildren();
    const inner = el('div', 'ow-menu-inner', this.root);
    el('h1', null, inner).textContent = 'PAUSED';
    const btns = el('div', 'ow-btns', inner);
    const resume = el('button', 'ow-btn primary', btns, 'Resume');
    resume.type = 'button';
    resume.addEventListener('click', () => this.close());
    const retreat = el('button', 'ow-btn', btns, 'Retreat');
    retreat.type = 'button';
    retreat.title = 'Back to menu';
    retreat.addEventListener('click', () => this.retreat());
    el('div', 'hint', inner, 'ESC RESUME');
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const t = this.ctx.time;
    if (t) t.scale = this._prevScale ?? 1;
    this.ctx.peek('player')?.setControlEnabled?.(true);
    this.ctx.events.emit('ui:pause', { paused: false });

    // Hide the shell first, then pointer-lock. Locking while the pause UI is
    // still fading kills the cursor over the menu (same as Deploy).
    const lockAim = () => this.ctx.input?.capturePointerForGame?.({ lock: true });
    if (this.boot) {
      void Promise.resolve(this.boot.hidePause({ immediate: false })).then(lockAim);
      return;
    }
    lockAim();
  }

  /** Driven with unscaled time so the fade still runs while the game is frozen. */
  update(rawDt) {
    if (this.boot) {
      // Boot shell owns its own CSS opacity transition.
      this.shown = this.open ? 1 : 0;
      return;
    }
    this.shown = damp(this.shown, this.open ? 1 : 0, 14, rawDt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      setStyle(this.root, 'pointer-events', 'none');
      return;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', this.open ? 'auto' : 'none');
    setStyle(this.root, 'opacity', ease.outQuad(this.shown).toFixed(3));
  }

  dispose() {
    if (this.open) this.ctx.input?.capturePointerForGame?.({ lock: false });
    if (this.boot) {
      this.boot.setResumeHandler(null);
      this.boot.setRetreatHandler(null);
    }
    this.root.remove();
  }
}
