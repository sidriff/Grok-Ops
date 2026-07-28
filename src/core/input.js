/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 *
 * Crouch is Ctrl. Chrome reserves Ctrl+W / Ctrl+T / Ctrl+N for the browser and
 * ignores preventDefault on them. Keyboard Lock only works in fullscreen; the
 * boot "Fullscreen" checkbox sets `wantFullscreen` so Deploy can opt into that.
 */

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

/** Codes that conflict with browser chrome when Ctrl/Meta is held (crouch). */
const KEYBOARD_LOCK_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyR',
  'KeyT',
  'KeyQ',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyC',
  'KeyV',
  'KeyZ',
  'KeyN',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Tab',
  'Space',
  'Escape',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
];

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;
    /**
     * When false (pause / title menus), never auto-grab pointer lock and leave
     * the system cursor free so DOM buttons remain clickable.
     */
    this.wantPointerLock = true;
    /**
     * When true, Deploy/resume requests fullscreen so keyboard.lock can stop
     * Ctrl+W from closing the tab. Driven by the boot Fullscreen checkbox.
     */
    this.wantFullscreen = true;
    /** True after a successful navigator.keyboard.lock while in play. */
    this._keysLocked = false;
    this._claimGen = 0;

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      fullscreen: this._onFullscreenChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    // Capture phase so we can preventDefault before other handlers; still not
    // enough alone for Chrome's reserved Ctrl+W — see _claimExclusiveInput.
    addEventListener('keydown', this._bound.keydown, true);
    addEventListener('keyup', this._bound.keyup, true);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    document.addEventListener('fullscreenchange', this._bound.fullscreen);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    this._releaseExclusiveInput({ exitFullscreen: true });
    removeEventListener('keydown', this._bound.keydown, true);
    removeEventListener('keyup', this._bound.keyup, true);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    document.removeEventListener('fullscreenchange', this._bound.fullscreen);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  requestPointerLock() {
    if (!this.wantPointerLock) return;
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  /** Force a visible OS cursor (boot / pause / endgame). */
  _showUiCursor() {
    // #game CSS is `cursor: none` for FPS aim — override while menus own the mouse.
    if (this.canvas) this.canvas.style.cursor = 'default';
    document.body.style.cursor = 'default';
    document.documentElement.style.cursor = 'default';
  }

  /** Drop UI cursor overrides so #game can hide the cursor under pointer lock. */
  _hideUiCursor() {
    if (this.canvas) this.canvas.style.cursor = '';
    document.body.style.cursor = '';
    document.documentElement.style.cursor = '';
  }

  /** Release lock and restore a normal OS cursor for DOM menus. */
  releasePointerForUi() {
    this.wantPointerLock = false;
    // Keep browser fullscreen if the user opted in; only free keyboard lock + pointer.
    this._releaseExclusiveInput({ exitFullscreen: false });
    try {
      document.exitPointerLock?.();
    } catch {
      /* already free */
    }
    this._showUiCursor();
  }

  /**
   * Enter fullscreen (if the Fullscreen checkbox is on) without pointer-lock
   * or hiding the cursor. Call from a user gesture (Deploy / Resume click) so
   * the load menu can stay interactive while the page goes fullscreen.
   */
  async prepareGameSurface() {
    const gen = ++this._claimGen;
    if (!this.wantFullscreen) return;
    try {
      if (!document.fullscreenElement) {
        const root = document.documentElement;
        const req =
          root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.requestFullscreen?.();
        if (req && typeof req.then === 'function') await req;
      }
    } catch {
      /* denied / unsupported */
    }
    // Cursor stays visible — caller still has the menu up.
    if (gen === this._claimGen && !this.wantPointerLock) this._showUiCursor();
  }

  /**
   * Return to FPS aim: keyboard-lock (if fullscreen), hide cursor, pointer-lock.
   * Call only after the load/pause shell is gone — pointer lock hides the OS
   * cursor even when the menu is still fading out.
   */
  capturePointerForGame({ lock = true } = {}) {
    this.wantPointerLock = true;
    // Fullscreen + keyboard.lock must ride a user gesture (Deploy / Resume /
    // click-to-recapture). Without it, Ctrl+crouch + W closes the tab.
    void this._claimExclusiveInput().then(() => {
      if (!this.wantPointerLock) return;
      if (lock) {
        this._hideUiCursor();
        this.requestPointerLock();
      }
    });
  }

  /**
   * Optionally enter fullscreen, then keyboard-lock action keys so Ctrl+WASD
   * is delivered to the page instead of the browser. Fullscreen is gated by
   * `wantFullscreen` (boot checkbox). Safe to call often.
   */
  async _claimExclusiveInput() {
    if (!this.wantPointerLock) return;
    const gen = ++this._claimGen;

    if (this.wantFullscreen) {
      try {
        if (!document.fullscreenElement) {
          const root = document.documentElement;
          const req =
            root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.requestFullscreen?.();
          if (req && typeof req.then === 'function') await req;
        }
      } catch {
        /* denied / unsupported — keyboard.lock will likely fail too */
      }
    }
    if (gen !== this._claimGen || !this.wantPointerLock) return;

    // Chromium only honors lock for reserved shortcuts while fullscreen.
    if (!document.fullscreenElement) return;

    try {
      const kb = navigator.keyboard;
      if (kb && typeof kb.lock === 'function') {
        await kb.lock(KEYBOARD_LOCK_CODES);
        if (gen === this._claimGen && this.wantPointerLock) this._keysLocked = true;
      }
    } catch {
      this._keysLocked = false;
    }
  }

  _releaseExclusiveInput({ exitFullscreen = false } = {}) {
    this._claimGen++;
    if (this._keysLocked) {
      try {
        navigator.keyboard?.unlock?.();
      } catch {
        /* ignore */
      }
      this._keysLocked = false;
    }
    if (exitFullscreen && document.fullscreenElement) {
      try {
        document.exitFullscreen?.();
      } catch {
        /* ignore */
      }
    }
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    // Always try to swallow game keys while we own input. Chrome still ignores
    // this for reserved combos (Ctrl+W) unless keyboard.lock is active.
    if (this.wantPointerLock || this.pointerLocked || (!e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
    }
    if (e.repeat) return;
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    if (this.wantPointerLock || this.pointerLocked) e.preventDefault();
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    // Menus own the mouse — don't re-lock mid-click or swallow button presses.
    if (!this.wantPointerLock) return;
    if (!this.pointerLocked && e.button === 0) {
      // Click-to-recapture is a fresh user gesture — re-claim + lock aim.
      this.capturePointerForGame({ lock: true });
    }
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) {
      this._onBlur();
      // Esc released pointer lock but menu may still want a visible cursor.
      if (!this.wantPointerLock) this._showUiCursor();
    } else if (this.wantPointerLock && !this._keysLocked) {
      void this._claimExclusiveInput();
    }
  }

  _onFullscreenChange() {
    if (document.fullscreenElement && this.wantPointerLock && !this._keysLocked) {
      void this._claimExclusiveInput();
    }
    if (!document.fullscreenElement && this._keysLocked) {
      // User left fullscreen (Esc hold / F11) — reserved shortcuts work again.
      this._releaseExclusiveInput({ exitFullscreen: false });
    }
    // Fullscreening the page while the title shell is up must keep the cursor.
    if (!this.wantPointerLock) this._showUiCursor();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._rawLook.x = 0;
    this._rawLook.y = 0;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    this.look.x = this.frozen ? 0 : this._rawLook.x * s;
    this.look.y = this.frozen ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  get fire() {
    return this.down.has('Mouse0');
  }

  get firePressed() {
    return this._pressed.has('Mouse0');
  }

  get ads() {
    return this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
