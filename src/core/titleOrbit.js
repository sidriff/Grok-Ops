/**
 * Title-shell scenic camera — show the already-warm street view under Deploy.
 *
 * THE HITCH THIS AVOIDS
 *   Prewarm compiles a handful of street / interior poses, then restores the
 *   spawn camera and the load shell fades to transparent. That view is stable.
 *   Snapping to a *new* elevated "hero" cam (or orbiting) forces Three to build
 *   fresh programs for different light counts, LODs, and CSM coverage — the
 *   multi-second lockup + X3595 Program Info Log spam.
 *
 * RULE
 *   Do not change the camera pose on start. The frame the player already sees
 *   after Load is the payoff. We only:
 *     - mark `active` so weapons hides the FP viewmodel
 *     - re-hold the *current* camera each frame so nothing steals it
 *   On soft retreat (player may be mid-street or death-cam), snap to the same
 *   world-space street pose prewarm already compiled (WARM_POSES[0]), never
 *   a high overlook.
 */

import * as THREE from 'three';

/**
 * World-space street pose — MUST match `WARM_POSES[0]` in `src/core/prewarm.js`
 * so every program key was already compiled during boot.
 */
const STREET_POSE = {
  pos: [12, 1.75, 18],
  look: [-4, 2.2, -6],
};

export class TitleOrbitSystem {
  static id = 'titleOrbit';
  static deps = ['world'];

  async init(ctx) {
    this.ctx = ctx;
    this.active = false;
    /** When true, lateUpdate re-applies STREET_POSE (retreat path only). */
    this._lockStreet = false;
    this._look = new THREE.Vector3();
    ctx.engine.titleOrbit = this;
  }

  /**
   * @param {{ lockStreet?: boolean }} [opts]
   *   `lockStreet` — snap to the prewarmed street pose (use after retreat).
   *   Default keeps the camera exactly where boot left it (zero hitch).
   */
  start({ lockStreet = false } = {}) {
    if (this.active) {
      if (lockStreet) {
        this._lockStreet = true;
        this._applyStreet(this.ctx);
      }
      return;
    }
    if (!this.ctx?.camera) return;

    this.active = true;
    this._lockStreet = !!lockStreet;
    if (this._lockStreet) this._applyStreet(this.ctx);
    // else: leave camera where prewarm / spawn already put it — already stable.
  }

  stop() {
    this.active = false;
    this._lockStreet = false;
  }

  lateUpdate(_dt, ctx) {
    if (!this.active) return;
    // Only re-write the camera when we intentionally own a fixed street pose.
    // On first Deploy-wait we leave the warm boot camera alone.
    if (this._lockStreet) this._applyStreet(ctx);
  }

  _applyStreet(ctx = this.ctx) {
    const cam = ctx?.camera;
    if (!cam) return;
    const [px, py, pz] = STREET_POSE.pos;
    const [lx, ly, lz] = STREET_POSE.look;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    this._look.set(lx, ly, lz);
    cam.lookAt(this._look);
    cam.updateMatrixWorld(true);
  }

  dispose() {
    this.stop();
    if (this.ctx?.engine?.titleOrbit === this) this.ctx.engine.titleOrbit = null;
  }
}
