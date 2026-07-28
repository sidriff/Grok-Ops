import { el, svg, setStyle, clamp, clamp01, damp, ease } from './util.js';

/** Reload ring geometry (viewBox units). */
const RING_R = 14;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Dynamic four-blade reticle.
 *
 * Spread model (all in HUD pixels at k=1):
 *   gap = base + move*MOVE + fire kick + flinch
 * The kick is a spring so a burst punches the blades out and they settle back
 * with a little overshoot instead of linearly interpolating — that overshoot is
 * most of what makes firing feel mechanical rather than animated.
 *
 * ADS hides the whole reticle over 70ms (the optic reticle is the weapon's job).
 * Reload swaps blades/dot for a filling ring driven by `reloadProgress` (0..1).
 */
export class Crosshair {
  constructor(parent) {
    this.root = el('div', 'ow-cross', parent);
    this.blades = new Array(4);
    for (let i = 0; i < 4; i++) this.blades[i] = el('div', 'ow-blade', this.root);
    this.dot = el('div', 'ow-dot', this.root);

    // Filling circle for reload — SVG stroke-dashoffset so the arc is sharp
    // at any scale (CSS conic-gradient blurs under the HUD scale factor).
    this.ringWrap = el('div', 'ow-reload-ring', this.root);
    const ringSvg = svg(
      'svg',
      { viewBox: '0 0 40 40', width: '100%', height: '100%' },
      this.ringWrap
    );
    svg(
      'circle',
      {
        class: 'ow-reload-track',
        cx: 20,
        cy: 20,
        r: RING_R,
        fill: 'none',
      },
      ringSvg
    );
    this.ringFill = svg(
      'circle',
      {
        class: 'ow-reload-fill',
        cx: 20,
        cy: 20,
        r: RING_R,
        fill: 'none',
        // Start empty; dashoffset walks 0..C as progress fills.
        'stroke-dasharray': `${RING_C.toFixed(3)} ${RING_C.toFixed(3)}`,
        'stroke-dashoffset': RING_C.toFixed(3),
        // 12 o'clock start, clockwise fill.
        transform: 'rotate(-90 20 20)',
      },
      ringSvg
    );

    this.k = 1;
    this.gap = 6;
    this.kick = 0;
    this.kickVel = 0;
    this.moveSpread = 0;
    this.adsBlend = 0;
    this.reloadBlend = 0;
    this.reloadFill = 0;
    this.hitPulse = 0;
    this.visible = 1;

    // preallocated transform scratch — string concat only, no objects
    this._rot = [0, 90, 180, 270];
  }

  /** Called on every shot. `amount` scales with weapon recoil. */
  onFire(amount = 1) {
    this.kickVel += 78 * amount;
    this.kick = Math.min(this.kick + 1.2 * amount, 16);
  }

  /** Taking damage nudges the reticle — reads as flinch. */
  onFlinch(amount = 1) {
    this.kickVel += 30 * amount;
  }

  onHit() {
    this.hitPulse = 1;
  }

  /**
   * @param {object} s { move:0..1, sprint:bool, ads:bool, crouch:bool,
   *                     baseSpread:px, hidden:bool, reloading:bool,
   *                     reloadProgress:0..1 }
   */
  update(dt, s) {
    // --- spring kick -------------------------------------------------------
    const stiff = 150;
    const dampC = 15;
    this.kickVel += (0 - this.kick) * stiff * dt - this.kickVel * dampC * dt;
    this.kick += this.kickVel * dt;
    if (this.kick < 0) {
      this.kick = 0;
      if (this.kickVel < 0) this.kickVel *= 0.4;
    }

    // --- movement / stance bloom ------------------------------------------
    const target =
      (s.move ?? 0) * 7 + (s.sprint ? 6 : 0) - (s.crouch ? 1.6 : 0) + (s.airborne ? 5 : 0);
    this.moveSpread = damp(this.moveSpread, target, 9, dt);

    this.adsBlend = damp(this.adsBlend, s.ads ? 1 : 0, 16, dt);
    this.hitPulse = Math.max(0, this.hitPulse - dt * 5.5);

    // Reload state: hide blades/dot, show filling ring. Progress tracks the
    // clip so the arc finishes with the bolt slap rather than a linear timer.
    const reloading = !!s.reloading;
    this.reloadBlend = damp(this.reloadBlend, reloading ? 1 : 0, 18, dt);
    const reloadP = clamp01(s.reloadProgress ?? 0);
    // Snap progress while active; ease out of the full ring when reload ends
    // so the circle doesn't pop empty mid-fade.
    this.reloadFill = reloading
      ? reloadP
      : damp(this.reloadFill, this.reloadBlend > 0.05 ? 1 : 0, 14, dt);

    const base = (s.baseSpread ?? 5.5) - this.adsBlend * 2;
    const gap = (base + this.moveSpread + this.kick) * this.k;
    // blades grow a touch as they spread — keeps the mass of the reticle even
    const len = clamp(1 + this.moveSpread * 0.035 + this.kick * 0.05, 1, 1.7);

    // ADS fades the hip reticle; reload zeros blades and drives the ring instead.
    // (Keep the ring readable even if ads was still blending out mid-swap.)
    const hipFade = clamp01(1 - this.adsBlend * 1.25) * (s.hidden ? 0 : 1);
    const bladeTarget = hipFade * (1 - this.reloadBlend);
    this.visible = damp(this.visible, bladeTarget, 22, dt);
    const vis = this.visible;

    const bright = 1 - 0.25 * this.adsBlend + 0.5 * ease.outQuad(this.hitPulse);
    for (let i = 0; i < 4; i++) {
      const b = this.blades[i];
      setStyle(
        b,
        'transform',
        `rotate(${this._rot[i]}deg) translateY(${-gap.toFixed(2)}px) scaleY(${len.toFixed(3)})`
      );
      setStyle(b, 'opacity', (vis * Math.min(1, bright)).toFixed(3));
    }
    const dotScale = 1 + this.hitPulse * 1.1;
    setStyle(this.dot, 'transform', `scale(${dotScale.toFixed(3)})`);
    setStyle(this.dot, 'opacity', (vis * (0.85 + 0.15 * this.hitPulse)).toFixed(3));

    // --- reload ring ------------------------------------------------------
    const ringOp = this.reloadBlend * (s.hidden ? 0 : 1);
    setStyle(this.ringWrap, 'opacity', ringOp.toFixed(3));
    setStyle(this.ringWrap, 'display', ringOp < 0.004 ? 'none' : '');
    // dashoffset: full C = empty, 0 = full. Rotate origin is already -90°.
    const offset = RING_C * (1 - clamp01(this.reloadFill));
    this.ringFill.setAttribute('stroke-dashoffset', offset.toFixed(3));

    setStyle(this.root, 'display', vis < 0.004 && ringOp < 0.004 ? 'none' : '');
  }

  setScale(k) {
    this.k = k;
  }

  dispose() {
    this.root.remove();
  }
}
