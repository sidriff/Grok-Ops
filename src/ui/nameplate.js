/**
 * Hover nameplate — shows an actor's callsign when the reticle is over them.
 * Blue for friendlies / team 0, red for hostiles.
 */

import { el, setText, setStyle, setClass, damp } from './util.js';

export class Nameplate {
  constructor(parent) {
    this.root = el('div', 'ow-nameplate', parent);
    this.tag = el('div', 'ow-nameplate-tag', this.root, '');
    this.sub = el('div', 'ow-nameplate-sub', this.root, '');
    this.shown = 0;
    this._name = '';
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {object|null} info  { name, friendly, dist } or null to hide
   * @param {number} dt
   */
  update(dt, info) {
    const want = !!(info && info.name);
    this.shown = damp(this.shown, want ? 1 : 0, 16, dt);
    const vis = this.shown;
    setStyle(this.root, 'display', vis < 0.02 ? 'none' : '');
    if (vis < 0.02) return;

    setStyle(this.root, 'opacity', vis.toFixed(3));
    if (info?.name && info.name !== this._name) {
      this._name = info.name;
      setText(this.tag, String(info.name).toUpperCase());
    }
    if (info) {
      setClass(this.root, 'friend', !!info.friendly);
      setClass(this.root, 'enemy', !info.friendly);
      if (info.dist != null) {
        setText(this.sub, `${Math.round(info.dist)} M`);
      } else {
        setText(this.sub, info.friendly ? 'FRIENDLY' : 'HOSTILE');
      }
    }
  }

  dispose() {
    this.root.remove();
  }
}
