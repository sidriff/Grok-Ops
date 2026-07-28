/**
 * Death cam + respawn countdown.
 *
 * On lethal damage the player system freezes input, drops a third-person
 * corpse, and hands the world camera to this controller. The orbit parks at
 * the death pose (not the thrashing ragdoll) and *continuously* tracks the
 * killer until the countdown expires and the player respawns.
 */

import * as THREE from 'three';
import { DEATH } from './tuning.js';
import { clamp01, lerp } from './springs.js';

export class DeathCam {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.timer = 0;
    this.delay = DEATH.respawnDelay;
    this.blend = 0;
    this.killerName = 'ENEMY';
    this.cause = 'bullet';

    this.body = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.cam = new THREE.Vector3();
    this.eyeStart = new THREE.Vector3();
    this.lookStart = new THREE.Vector3();
    this._desiredCam = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    /** Live killer aim point, refreshed every frame while a killer is known. */
    this._killerPos = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._fwd = new THREE.Vector3();

    this.killer = null;
    this._hasKiller = false;
    this.corpse = null;
    this._baseFov = 75;
  }

  /**
   * @param {object} opts
   *   position   Vector3 feet (or body)
   *   eye        Vector3 camera at the moment of death
   *   forward    Vector3 view forward
   *   killer     agent-like { position, eye, name, alive? } or null
   *   killerName string
   *   cause      'bullet' | 'explosion' | 'fall' | ...
   *   corpse     optional agent returned by ai.spawnPlayerCorpse
   */
  begin(opts = {}) {
    const cam = this.ctx.camera;
    this.active = true;
    this.delay = DEATH.respawnDelay;
    this.timer = this.delay;
    this.blend = 0;
    this.killer = opts.killer ?? null;
    this.killerName = opts.killerName ?? this._nameOf(this.killer) ?? this._causeName(opts.cause);
    this.cause = opts.cause ?? 'bullet';
    this.corpse = opts.corpse ?? null;
    // Prefer the configured hip FOV so a mid-ADS death does not restore zoomed.
    this._baseFov = this.ctx.config?.fov ?? cam.fov;

    if (opts.position) this.body.copy(opts.position);
    else this.body.copy(cam.position);
    this.body.y += 0.9;

    this.eyeStart.copy(opts.eye ?? cam.position);
    if (opts.forward) {
      this.lookStart.copy(this.eyeStart).addScaledVector(opts.forward, 8);
    } else {
      this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
      this.lookStart.copy(this.eyeStart).addScaledVector(this._fwd, 8);
    }

    // Seed killer track immediately so the first frame already faces them.
    this._hasKiller = this._sampleKiller(this._killerPos);
    if (this._hasKiller) this.lookStart.copy(this._killerPos);

    this.cam.copy(this.eyeStart);
    this.look.copy(this.lookStart);
    this._desiredLook.copy(this.look);
  }

  end() {
    this.active = false;
    this.timer = 0;
    this.blend = 0;
    this.killer = null;
    this._hasKiller = false;
    this.corpse = null;
    if (this.ctx?.camera && this._baseFov > 0) {
      this.ctx.camera.fov = this._baseFov;
      this.ctx.camera.updateProjectionMatrix();
    }
  }

  get respawnIn() {
    return Math.max(0, this.timer);
  }

  get fraction() {
    return this.delay > 0 ? clamp01(1 - this.timer / this.delay) : 1;
  }

  /**
   * Drive the world camera. Returns true when the countdown has finished and
   * the player should respawn.
   */
  update(dt) {
    if (!this.active) return false;

    this.timer = Math.max(0, this.timer - dt);
    this.blend = Math.min(1, this.blend + dt / Math.max(1e-3, DEATH.camBlend));

    // Always re-sample the killer — they keep moving during the death cam.
    // Body stays parked at the death pose from begin() so ragdoll thrash
    // does not drag the orbit root around.
    this._hasKiller = this._sampleKiller(this._killerPos) || this._hasKiller;
    this._desiredLook.copy(this._hasKiller ? this._killerPos : this.look);

    // Overhead stand-off, biased toward the *live* killer so orbit keeps up
    // as they strafe around the death pose.
    this._tmp.copy(this._desiredLook).sub(this.body);
    this._tmp.y = 0;
    if (this._tmp.lengthSq() < 1e-4) this._tmp.set(0, 0, -1);
    else this._tmp.normalize();

    this._desiredCam
      .copy(this.body)
      .addScaledVector(this._tmp, DEATH.camPull)
      .y = this.body.y + DEATH.camHeight;

    const t = this.blend * this.blend * (3 - 2 * this.blend); // smoothstep
    // Ease only the *position* off the death eye. Look-at tracks the killer
    // every frame so the camera keeps following them through the blend.
    this.cam.lerpVectors(this.eyeStart, this._desiredCam, t);

    const bs = 1 - Math.exp(-DEATH.bodySmooth * dt);
    const ls = 1 - Math.exp(-DEATH.lookSmooth * dt);
    // During blend, ramp look-follow stiffness so we lock on the killer fast
    // without a hard snap on the first frame.
    const lookRate = this._hasKiller ? lerp(ls, Math.min(1, ls * 2.4), t) : ls;
    this.look.lerp(this._desiredLook, lookRate);
    if (this.blend >= 1) this.cam.lerp(this._desiredCam, bs);

    const cam = this.ctx.camera;
    cam.position.copy(this.cam);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look);
    const fov = lerp(this._baseFov, DEATH.camFov, t);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    return this.timer <= 0;
  }

  /**
   * Write the killer's current aim point into `out`. Prefers eye / chest height
   * so we track a moving shooter rather than their feet. Returns false when no
   * live sample is available (keeps the last good `_killerPos`).
   */
  _sampleKiller(out) {
    const k = this.killer;
    if (!k || typeof k !== 'object') return false;

    // Prefer live eye (Agent.eye is a getter onto current position).
    const eye = k.eye;
    if (eye && Number.isFinite(eye.x)) {
      out.copy(eye);
      return true;
    }
    if (k.position && Number.isFinite(k.position.x)) {
      out.copy(k.position);
      // Chest/head height for a standing humanoid when only feet are known.
      const h = k.eyeHeight ?? k.height ?? 1.78;
      out.y += h * 0.82;
      return true;
    }
    if (k.group?.position && Number.isFinite(k.group.position.x)) {
      out.copy(k.group.position);
      out.y += 1.45;
      return true;
    }
    return false;
  }

  _nameOf(k) {
    if (!k) return null;
    if (typeof k === 'string') return k;
    return k.name ?? k.callsign ?? k.variantName ?? null;
  }

  _causeName(cause) {
    if (cause === 'fall') return 'FALL DAMAGE';
    if (cause === 'explosion') return 'EXPLOSION';
    return 'ENEMY';
  }
}
