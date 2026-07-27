/**
 * Death overlay — "Killed by <name>" plus a respawn countdown.
 *
 * Driven entirely from `update(dt, state)` so it freezes correctly when the
 * game is paused and stays deterministic under the capture harness.
 */

import { el, setText, setStyle, setClass, ease, clamp01, damp } from './util.js';

export class DeathOverlay {
  constructor(parent) {
    this.root = el('div', 'ow-death', parent);
    this.scrim = el('div', 'ow-death-scrim', this.root);
    this.panel = el('div', 'ow-death-panel', this.root);
    this.lbl = el('div', 'ow-death-lbl', this.panel, 'KILLED BY');
    this.name = el('div', 'ow-death-name', this.panel, 'ENEMY');
    this.rule = el('div', 'ow-death-rule', this.panel);
    this.sub = el('div', 'ow-death-sub', this.panel, 'RESPAWNING');
    this.timer = el('div', 'ow-death-timer', this.panel, '5');

    this.shown = 0;
    this.active = false;
    this._lastName = '';
    this._lastSec = -1;
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {object} s  player HUD state (or any object with deathActive /
   *                    killerName / respawnIn)
   */
  update(dt, s) {
    const want = !!(s?.deathActive || (s?.dead && (s?.respawnIn ?? 0) > 0));
    this.active = want;
    this.shown = damp(this.shown, want ? 1 : 0, 14, dt);
    const vis = this.shown;
    setStyle(this.root, 'display', vis < 0.01 ? 'none' : '');
    if (vis < 0.01) return;

    setStyle(this.root, 'opacity', vis.toFixed(3));
    const y = (1 - ease.outCubic(vis)) * 10;
    setStyle(this.panel, 'transform', `translate(-50%, calc(-50% + ${y.toFixed(2)}px))`);

    const name = (s?.killerName || 'ENEMY').toString().toUpperCase();
    if (name !== this._lastName) {
      this._lastName = name;
      setText(this.name, name);
    }

    const sec = Math.max(0, Math.ceil(s?.respawnIn ?? 0));
    if (sec !== this._lastSec) {
      this._lastSec = sec;
      setText(this.timer, String(sec));
      setClass(this.timer, 'tick', sec <= 2);
    }

    // Subtle countdown pulse on the digit itself.
    const frac = clamp01((s?.respawnIn ?? 0) % 1);
    const pulse = 1 + (1 - frac) * 0.06;
    setStyle(this.timer, 'transform', `scale(${pulse.toFixed(3)})`);
  }

  dispose() {
    this.root.remove();
  }
}
