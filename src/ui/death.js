/**
 * Death / endgame overlay.
 *
 * Mid-match death cam still shows "KILLED BY" while the overhead cam runs.
 * Survival endgame swaps the countdown for a score panel + Retry button.
 */

import { el, setText, setStyle, setClass, ease, clamp01, damp } from './util.js';

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

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

    // Endgame score block (hidden during normal death-cam countdown).
    this.stats = el('div', 'ow-death-stats', this.panel);
    this.statTime = el('div', 'ow-death-stat', this.stats);
    this.statKills = el('div', 'ow-death-stat', this.stats);
    this.statAllies = el('div', 'ow-death-stat', this.stats);

    this.actions = el('div', 'ow-death-actions', this.panel);
    this.retry = el('button', 'ow-death-retry', this.actions, 'RETRY');
    this.retry.type = 'button';
    this.retry.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.onRetry?.();
    });
    this.retreat = el('button', 'ow-death-retreat', this.actions, 'RETREAT');
    this.retreat.type = 'button';
    this.retreat.title = 'Back to menu';
    this.retreat.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.onRetreat?.();
    });

    this.shown = 0;
    this.active = false;
    this._lastName = '';
    this._lastSec = -1;
    this._endgame = false;
    this.onRetry = null;
    this.onRetreat = null;
    setStyle(this.root, 'display', 'none');
    setStyle(this.stats, 'display', 'none');
    setStyle(this.actions, 'display', 'none');
  }

  /**
   * @param {object} s  player HUD state + optional endgame fields
   */
  update(dt, s) {
    const endgame = !!(s?.endgame);
    const want =
      endgame ||
      !!(s?.deathActive || (s?.dead && (s?.respawnIn ?? 0) > 0));
    this.active = want;
    this.shown = damp(this.shown, want ? 1 : 0, 14, dt);
    const vis = this.shown;
    setStyle(this.root, 'display', vis < 0.01 ? 'none' : '');
    if (vis < 0.01) return;

    // Endgame needs pointer events + a visible cursor for the Retry button.
    setStyle(this.root, 'pointer-events', endgame ? 'auto' : 'none');
    setStyle(this.root, 'cursor', endgame ? 'default' : '');
    setStyle(this.root, 'opacity', vis.toFixed(3));
    const y = (1 - ease.outCubic(vis)) * 10;
    setStyle(this.panel, 'transform', `translate(-50%, calc(-50% + ${y.toFixed(2)}px))`);

    if (endgame !== this._endgame) {
      this._endgame = endgame;
      setClass(this.root, 'endgame', endgame);
      setStyle(this.stats, 'display', endgame ? '' : 'none');
      setStyle(this.actions, 'display', endgame ? '' : 'none');
      setStyle(this.timer, 'display', endgame ? 'none' : '');
    }

    if (endgame) {
      const won = !!s.won;
      setText(this.lbl, won ? 'MISSION COMPLETE' : 'KILLED BY');
      const name = won
        ? 'SURVIVED'
        : (s?.killerName || 'ENEMY').toString().toUpperCase();
      if (name !== this._lastName) {
        this._lastName = name;
        setText(this.name, name);
      }
      setClass(this.name, 'win', won);
      setText(this.sub, won ? 'FIVE MINUTES HELD' : 'SQUAD WIPED');
      setText(this.statTime, `TIME  ${mmss(s.timeSurvived ?? 0)}`);
      setText(
        this.statKills,
        `KILLS  ${s.kills ?? 0}` + (s.allyKills ? `  ·  ALLY ${s.allyKills}` : '')
      );
      setText(this.statAllies, `ALLIES UP  ${s.alliesAlive ?? 0}/3`);
      return;
    }

    setClass(this.name, 'win', false);
    setText(this.lbl, 'KILLED BY');
    setText(this.sub, 'KIA');
    const name = (s?.killerName || 'ENEMY').toString().toUpperCase();
    if (name !== this._lastName) {
      this._lastName = name;
      setText(this.name, name);
    }

    // Survival: no respawn countdown — hold the cam and wait for endgame
    // payload (player death ends the match immediately after).
    if (s?.noRespawn) {
      setStyle(this.timer, 'display', 'none');
      setText(this.sub, 'MISSION FAILED');
      return;
    }

    setStyle(this.timer, 'display', '');
    const sec = Math.max(0, Math.ceil(s?.respawnIn ?? 0));
    if (sec !== this._lastSec) {
      this._lastSec = sec;
      setText(this.timer, String(sec));
      setClass(this.timer, 'tick', sec <= 2);
    }

    const frac = clamp01((s?.respawnIn ?? 0) % 1);
    const pulse = 1 + (1 - frac) * 0.06;
    setStyle(this.timer, 'transform', `scale(${pulse.toFixed(3)})`);
  }

  dispose() {
    this.root.remove();
  }
}
