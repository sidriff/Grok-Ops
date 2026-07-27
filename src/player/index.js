/**
 * PLAYER — movement state machine, camera feel, health.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT LIVES HERE
 *   movement.js   the state machine: stand/crouch/prone/sprint/tacsprint/slide/
 *                 jump/fall/mantle/vault (+ lean). 120 Hz, fully interruptible.
 *   camera.js     bob, landing dip, step shift, strafe/turn roll, breathing
 *                 sway, recoil + weapon kick channels, trauma shake, FOV.
 *   mantle.js     ledge detection via physics capsule sweeps + the rooted climb.
 *   health.js     health, regen, suppression, damage direction, heartbeat.
 *   lowhealth.js  the low-health screen treatment, registered with `render`.
 *   tuning.js     every number, with the CoD values it was calibrated against.
 *   springs.js    spring/damper + easing maths.
 *
 * Collision is *never* computed here — everything goes through
 * `physics.createCharacter()` capsule sweeps.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * PUBLIC API — `const p = ctx.get('player')`
 * ────────────────────────────────────────────────────────────────────────────
 * TRANSFORM
 *   p.position        Vector3, FEET (bottom of the capsule), interpolated
 *   p.eyePosition     Vector3, the composed camera position
 *   p.velocity        Vector3, m/s
 *   p.forward         Vector3, unit view forward
 *   p.yaw / p.pitch   radians (yaw is the movement basis, camera adds feel)
 *   p.speed / p.horizontalSpeed
 *   p.character       the physics CharacterController (read-only)
 *   p.height          capsule height of the current stance
 *   p.hitbox          physics collider on LAYER.PLAYER — trace against the
 *                     player with `phys.MASK.BULLET | phys.LAYER.PLAYER`
 *
 * STATE
 *   p.state           'stand'|'crouch'|'prone'|'sprint'|'tacsprint'|'slide'|
 *                     'jump'|'fall'|'mantle'|'vault'|'lean'
 *   p.stance          'stand'|'crouch'|'prone'
 *   p.sprinting  p.tacticalSprint  p.sliding  p.grounded  p.airborne
 *   p.mantling   p.leanAmount (-1..1)   p.slideProgress (0..1)
 *
 * AIM
 *   p.adsRequested            true while the aim button is held
 *   p.adsProgress             0..1 blend actually in use
 *   p.setAdsProgress(v)       `weapons` owns the real curve — push it here and
 *                             the camera FOV, sway and move speed follow it
 *
 * CAMERA FEEL (for `weapons`, `fx`, `ai`)
 *   p.addRecoil(pitch, yaw, roll, punch)   camera-owned recoil impulse (radians)
 *   p.addKick(pitch, yaw, roll)            independent weapon kick channel
 *   p.addTrauma(a)                         0..1 noise shake (explosions, hits)
 *   p.viewKick                             { pitch, yaw, roll, punch } this frame
 *   p.cameraRig                            the rig, if you need the raw springs
 *
 * HEALTH
 *   p.health  p.maxHealth  p.healthFraction  p.lowHealth  p.dead
 *   p.suppression  p.damageIndicators
 *   p.applyDamage(amount, fromVector3, opts)   p.heal(a)   p.addSuppression(a)
 *
 * DEATH / RESPAWN
 *   p.deathActive     true while the death cam + countdown are running
 *   p.respawnIn       seconds remaining (0 when alive)
 *   p.killerName      who got the credit for the last death
 *   p.respawn(index)  clear death, teleport to a spawn point, restore control
 *
 * CONTROL
 *   p.setControlEnabled(bool)     shot harness / cutscenes
 *   p.teleport(eyePosition, rotationEulerOrYaw)
 *   p.respawn(index)
 *   p.debugState(name)            'sprint'|'slide'|'crouch'|'hurt'|'critical'|
 *                                 'air'|'reset'|'kill'
 *
 * EVENTS EMITTED
 *   player:state      { stance, sprinting, sliding, ads, state, grounded, ... }
 *   player:land       { velocity, surface, position }
 *   player:footstep   { position, surface, running, left, speed, stance }
 *   damage:taken      { amount, from, health, direction }
 *   player:health     { health, fraction, low, critical, regenerating, ... }  *
 *   player:heartbeat  { strength, fraction }                                  *
 *   player:mantle     { kind, height }                                        *
 *   player:jump       { position }                                            *
 *   player:death      { position, killer, killerName, cause, respawnIn }      *
 *   player:respawn    { position, index }                                     *
 *   (*) not in the canonical table in ARCHITECTURE.md — additive, optional, and
 *   safe to ignore. The canonical `player:state` payload carries `health` too so
 *   a listener that only knows the documented four fields still gets everything.
 */

import * as THREE from 'three';
import { Movement } from './movement.js';
import { CameraRig } from './camera.js';
import { Health } from './health.js';
import { LowHealthPass } from './lowhealth.js';
import { DeathCam } from './death.js';
import { STANCE, MOVE, CAMERA, HEALTH, FOOTSTEP, JUMP_SPEED, DEATH } from './tuning.js';
import { clamp, clamp01, lerp, approach, DEG } from './springs.js';

export class PlayerSystem {
  static id = 'player';
  static deps = ['physics', 'world', 'render'];

  constructor() {
    /** Lets `ai` / `physics` recognise the local player from an owner pointer. */
    this.isPlayer = true;
    this.movement = null;
    this.rig = null;
    this.health = null;
    this.lowHealthPass = null;
    this.hitbox = null;

    this.controlEnabled = true;
    this.adsAmount = 0;
    this._adsExternal = false;
    this._adsExternalAge = 0;
    this.adsRequested = false;

    this._lookFrame = -1;
    this._prevYaw = 0;

    /** Death cam controller; created in init. */
    this.deathCam = null;
    this._spawnIndex = 0;
    this._lastKiller = null;
    this._lastKillerName = null;
    this._lastDamageCause = 'bullet';
    this._lastHitPoint = new THREE.Vector3();
    this._lastHitDir = new THREE.Vector3(0, 0, 1);
    this._deathPayload = {
      position: new THREE.Vector3(),
      killer: null,
      killerName: 'ENEMY',
      cause: 'bullet',
      respawnIn: DEATH.respawnDelay,
    };
    this._respawnPayload = { position: new THREE.Vector3(), index: 0 };

    // preallocated event payloads
    this._statePayload = {
      stance: 'stand', sprinting: false, sliding: false, ads: false,
      state: 'stand', grounded: true, airborne: false, mantling: false,
      lean: 0, speed: 0, health: HEALTH.max, healthFraction: 1, crouched: false,
    };
    this._landPayload = { velocity: 0, surface: 'concrete', position: new THREE.Vector3() };
    this._stepPayload = {
      position: new THREE.Vector3(), surface: 'concrete', running: false,
      left: false, speed: 0, stance: 'stand',
    };
    this._mantlePayload = { kind: 'none', height: 0 };
    this._jumpPayload = { position: new THREE.Vector3() };
    // Preallocated HUD snapshot polled by `ui` (see getHudState).
    this._hudState = {
      health: HEALTH.max, maxHealth: HEALTH.max, regen: false, dead: false,
      move: 0, sprint: false, crouch: false, ads: false, airborne: false,
      suppression: 0, position: null,
      killerName: '', respawnIn: 0, deathActive: false,
    };

    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._spawnEye = new THREE.Vector3();
    this._enemyEye = new THREE.Vector3();
    this._toSpawn = new THREE.Vector3();
    this._desireDir = new THREE.Vector3();
    /** Last emitted discrete state, compared field-wise so no string is built. */
    this._prev = {
      state: '', stance: '', sprinting: false, tacticalSprint: false,
      sliding: false, grounded: true, ads: false, mantling: false,
    };
    this._offEvents = [];
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx;
    this.physics = ctx.get('physics');
    this.rng = ctx.rng.fork();

    this.movement = new Movement(ctx, this);
    this.rig = new CameraRig(ctx);
    this.health = new Health(ctx, this.rig);
    this.deathCam = new DeathCam(ctx);

    // ---- spawn -----------------------------------------------------------
    const spawn = this._resolveSpawn(0);
    this.movement.init(this.physics, spawn.feet);
    this.movement.yaw = spawn.yaw;
    this.movement.pitch = 0;
    this._prevYaw = spawn.yaw;
    this.rig.reset(STANCE.stand.eye);
    this.rig.update(1 / 60, this.movement, this.health);
    this.rig.applyTo(ctx.camera);

    // ---- hitbox ----------------------------------------------------------
    // A capsule on the PLAYER layer so `ai` has something to shoot at. PLAYER is
    // deliberately absent from MASK.BULLET and MASK.CHARACTER, so it can never
    // be hit by the player's own muzzle ray and never blocks the player's own
    // movement sweeps: an AI that wants to hit us traces with
    //   phys.MASK.BULLET | phys.LAYER.PLAYER
    this.hitbox = this.physics.addCollider({
      shape: 'capsule',
      layer: this.physics.LAYER.PLAYER,
      surface: 'flesh',
      owner: this,
      part: 'torso',
      radius: 0.3,
    });
    this._syncHitbox();

    // ---- low-health treatment -------------------------------------------
    const render = ctx.peek('render');
    if (render?.registerPass) {
      this.lowHealthPass = new LowHealthPass();
      this._unregisterPass = render.registerPass(this.lowHealthPass);
    }

    // ---- incoming damage / suppression ----------------------------------
    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn));
    on('damage:dealt', (e) => this._onDamageDealt(e));
    on('explosion', (e) => this._onExplosion(e));
    on('bullet:impact', (e) => this._onBulletImpact(e));

    console.info(
      `[player] spawn ${spawn.feet.x.toFixed(1)}, ${spawn.feet.y.toFixed(2)}, ` +
      `${spawn.feet.z.toFixed(1)} · walk ${STANCE.stand.speed} sprint ${MOVE.sprintSpeed} ` +
      `tac ${MOVE.tacSprintSpeed} m/s · jump ${JUMP_SPEED.toFixed(2)} m/s (apex 0.60 m)`
    );
  }

  _resolveSpawn(index = 0) {
    const world = this.ctx.peek('world');
    const out = { feet: new THREE.Vector3(0, 0.2, 0), yaw: 0, index: 0 };
    const n = world?.spawnPoints?.length ?? 0;
    const i = n > 0 ? ((index % n) + n) % n : 0;
    out.index = i;
    const sp = world?.spawn?.(i);
    if (sp?.position) {
      out.feet.copy(sp.position);
      out.yaw = sp.yaw ?? 0;
    }
    // Physics owns the exact floor; drop onto it so we never start embedded.
    const gy = this.physics.groundHeight(out.feet.x, out.feet.z, out.feet.y + 6);
    out.feet.y = Number.isFinite(gy) ? gy + 0.03 : out.feet.y + 0.2;
    return out;
  }

  /**
   * Pick a spawn that living enemies cannot already see. Prefer points that
   * are clear of LOS/facing cones, outside the hard proximity ring, and away
   * from the death position. Falls back to the least-bad option if every
   * point is contested (small maps / full surround).
   *
   * Always re-aims yaw after the point is chosen so the player faces open
   * space toward threats rather than the authored corner angle.
   *
   * @param {number|null|undefined} forced   force this index (debug / harness)
   * @param {THREE.Vector3|null}    deathPos bias away from the kill site
   */
  _pickSpawn(forced, deathPos = null) {
    const world = this.ctx.peek('world');
    const points = world?.spawnPoints;
    const n = points?.length ?? 0;
    if (n <= 0) {
      const s = this._resolveSpawn(0);
      this._orientSpawn(s, deathPos);
      return s;
    }
    if (forced !== undefined && forced !== null) {
      const s = this._resolveSpawn(forced);
      this._orientSpawn(s, deathPos);
      return s;
    }

    let bestI = (this._spawnIndex + 1) % n;
    let bestScore = -Infinity;
    const death = deathPos ?? this.deathCam?.body ?? this.movement?.position ?? null;

    for (let i = 0; i < n; i++) {
      const spawn = this._resolveSpawn(i);
      const score = this._scoreSpawn(spawn, death);
      // Tiny rng jitter so two equal candidates do not always pick the same.
      const jitter = this.rng.float() * 0.15;
      if (score + jitter > bestScore) {
        bestScore = score + jitter;
        bestI = i;
      }
    }
    this._spawnIndex = bestI;
    const picked = this._resolveSpawn(bestI);
    this._orientSpawn(picked, death);
    return picked;
  }

  /**
   * Higher is safer. Visible to any living enemy → large penalty. Close to any
   * enemy → hard penalty. Open sightlines preferred over alley corners.
   * Distance from death is a soft preference.
   */
  _scoreSpawn(spawn, deathPos) {
    const D = DEATH;
    const eyeH = STANCE.stand.eye;
    this._spawnEye.set(spawn.feet.x, spawn.feet.y + eyeH, spawn.feet.z);

    let score = 0;
    let visibleHits = 0;
    let tooClose = 0;
    let nearest = Infinity;

    const ai = this.ctx.peek('ai');
    const agents = ai?.agents;
    if (agents?.length) {
      const cosHalf = Math.cos(D.spawnViewHalfAngle);
      const viewR = D.spawnViewRange;
      const minD = D.spawnMinEnemyDist;
      const phys = this.physics;
      const mask = phys?.MASK?.SIGHT;

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.alive === false || a.isPlayerCorpse) continue;

        // Enemy eye: live eye getter, else feet + eye height.
        if (a.eye && Number.isFinite(a.eye.x)) this._enemyEye.copy(a.eye);
        else if (a.position) {
          this._enemyEye.copy(a.position);
          this._enemyEye.y += a.eyeHeight ?? eyeH;
        } else continue;

        const dx = this._spawnEye.x - this._enemyEye.x;
        const dy = this._spawnEye.y - this._enemyEye.y;
        const dz = this._spawnEye.z - this._enemyEye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < nearest) nearest = dist;

        if (dist < minD) {
          tooClose++;
          score -= (minD - dist) * 8;
          continue;
        }
        if (dist > viewR) continue;

        // Facing cone: only "in view" if they are roughly looking this way.
        const inv = 1 / (dist || 1e-4);
        this._toSpawn.set(dx * inv, dy * inv, dz * inv);
        let fx; let fz;
        if (a.yaw !== undefined) {
          // AI forward is (-sin yaw, 0, -cos yaw) — same basis as player.
          fx = -Math.sin(a.yaw);
          fz = -Math.cos(a.yaw);
        } else {
          fx = this._toSpawn.x;
          fz = this._toSpawn.z;
        }
        // Horizontal facing only — pitch is loose for spawn safety.
        const fl = Math.hypot(fx, fz) || 1;
        const facing = (fx / fl) * this._toSpawn.x + (fz / fl) * this._toSpawn.z;
        if (facing < cosHalf) continue;

        // Clear world LOS from their eye to the spawn eye → they can see us.
        const clear = phys?.lineOfSight
          ? phys.lineOfSight(this._enemyEye, this._spawnEye, mask)
          : true;
        if (clear) {
          visibleHits++;
          // Closer visible enemies are much worse.
          score -= 120 + (viewR - dist) * 2.5;
        }
      }
    }

    // Hard reject tier: anything with visibility or proximity loses to clear points.
    if (visibleHits > 0) score -= 500 * visibleHits;
    if (tooClose > 0) score -= 200 * tooClose;

    // Prefer farther from nearest enemy and from the death body.
    if (Number.isFinite(nearest)) score += Math.min(nearest, 80) * 0.35;
    if (deathPos) {
      const ddx = spawn.feet.x - deathPos.x;
      const ddz = spawn.feet.z - deathPos.z;
      score += Math.hypot(ddx, ddz) * D.spawnDeathBias;
    }

    // Corners lose: max open ray in any direction. Keeps alley dead-ends from
    // winning just because nobody can see them.
    score += this._spawnOpenness(spawn) * 0.55;
    return score;
  }

  /**
   * Best free-space distance from a spawn eye across the compass (metres).
   * Used both to prefer open spawns and to re-aim yaw after the pick.
   */
  _spawnOpenness(spawn) {
    const D = DEATH;
    const eyeH = STANCE.stand.eye;
    const ox = spawn.feet.x;
    const oy = spawn.feet.y + eyeH;
    const oz = spawn.feet.z;
    const phys = this.physics;
    if (!phys?.raycast) return 8;
    const mask = phys.MASK?.WORLD ?? phys.MASK?.SIGHT;
    const range = D.spawnLookRange;
    const n = 8;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const yaw = (i / n) * Math.PI * 2;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const hit = phys.raycast(ox, oy, oz, fx, 0, fz, range, mask);
      const d = hit?.hit ? hit.distance : range;
      if (d > best) best = d;
    }
    return best;
  }

  /**
   * Replace authored spawn yaw with one that faces open space and, when
   * possible, toward living threats (or the death site as a fallback).
   * Mutates `spawn.yaw`.
   */
  _orientSpawn(spawn, deathPos = null) {
    const D = DEATH;
    const eyeH = STANCE.stand.eye;
    const ox = spawn.feet.x;
    const oy = spawn.feet.y + eyeH;
    const oz = spawn.feet.z;
    const phys = this.physics;
    const range = D.spawnLookRange;
    const wall = D.spawnWallClear;
    const samples = D.spawnYawSamples | 0 || 16;

    // --- desire direction: nearest living threat, else death, else authored --
    let desireX = -Math.sin(spawn.yaw);
    let desireZ = -Math.cos(spawn.yaw);
    let threatW = 0;
    let nearestThreat = Infinity;

    const ai = this.ctx.peek('ai');
    const agents = ai?.agents;
    if (agents?.length) {
      let sx = 0;
      let sz = 0;
      let count = 0;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.alive === false || a.isPlayerCorpse || !a.position) continue;
        const dx = a.position.x - ox;
        const dz = a.position.z - oz;
        const d = Math.hypot(dx, dz);
        if (d < 1 || d > D.spawnViewRange * 1.35) continue;
        // Weight nearer threats more so one flanker does not lose to a crowd far away.
        const w = 1 / (d * d);
        sx += dx * w;
        sz += dz * w;
        count += w;
        if (d < nearestThreat) nearestThreat = d;
      }
      if (count > 0) {
        const l = Math.hypot(sx, sz) || 1;
        desireX = sx / l;
        desireZ = sz / l;
        threatW = D.spawnThreatAlign;
      }
    }

    if (threatW <= 0 && deathPos) {
      const dx = deathPos.x - ox;
      const dz = deathPos.z - oz;
      const d = Math.hypot(dx, dz);
      if (d > 2) {
        desireX = dx / d;
        desireZ = dz / d;
        threatW = D.spawnDeathAlign;
      }
    }

    this._desireDir.set(desireX, 0, desireZ);

    let bestYaw = spawn.yaw;
    let bestScore = -Infinity;
    const mask = phys?.MASK?.WORLD ?? phys?.MASK?.SIGHT;

    for (let i = 0; i < samples; i++) {
      const yaw = (i / samples) * Math.PI * 2;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);

      // Forward clearance — the main "don't face a wall" signal.
      let open = range;
      if (phys?.raycast) {
        const hit = phys.raycast(ox, oy, oz, fx, 0, fz, range, mask);
        open = hit?.hit ? hit.distance : range;
      }

      let s = open;
      // Wall in your face is the whole bug; crush those samples.
      if (open < wall) s -= (wall - open) * 18;
      // Prefer the open corridor (also probe slightly off-axis so a doorway wins).
      if (phys?.raycast) {
        const yawL = yaw + 0.35;
        const yawR = yaw - 0.35;
        const hL = phys.raycast(ox, oy, oz, -Math.sin(yawL), 0, -Math.cos(yawL), range * 0.7, mask);
        const hR = phys.raycast(ox, oy, oz, -Math.sin(yawR), 0, -Math.cos(yawR), range * 0.7, mask);
        const oL = hL?.hit ? hL.distance : range * 0.7;
        const oR = hR?.hit ? hR.distance : range * 0.7;
        s += (oL + oR) * 0.2;
      }

      // Face threats / death when the lane is open enough.
      const align = fx * desireX + fz * desireZ; // -1..1
      if (open >= wall * 0.85) s += align * threatW;
      // Mild preference to keep something like the authored facing when tied.
      const authored = -Math.sin(spawn.yaw) * fx + -Math.cos(spawn.yaw) * fz;
      s += authored * 0.6;

      if (s > bestScore) {
        bestScore = s;
        bestYaw = yaw;
      }
    }

    spawn.yaw = bestYaw;
    spawn.pitch = 0;
    return spawn;
  }

  /* ==================================================================== */
  /* look                                                                 */
  /* ==================================================================== */

  /**
   * Mouse/stick look is consumed once per rendered frame. It happens in the
   * first fixed step when there is one (so movement uses this frame's yaw with
   * zero latency) and in update() otherwise — above 120 fps a frame can contain
   * no fixed step at all and dropping the delta there would feel like a hitch.
   */
  _consumeLook(dt) {
    const frame = this.ctx.time.frame;
    if (frame === this._lookFrame) return;
    this._lookFrame = frame;
    const m = this.movement;
    if (!this.controlEnabled) {
      m.yawRate = 0;
      return;
    }
    const input = this.ctx.input;
    const cfg = this.ctx.config;
    const sens = lerp(1, cfg.adsSensScale, clamp01(this.adsAmount));

    let dYaw = -input.look.x * sens;
    let dPitch = -input.look.y * sens;

    // Gamepad: rate-based, already curved by Input.
    const stick = input.stick;
    if (stick.lookX || stick.lookY) {
      const rate = 3.1 * sens; // rad/s at full deflection
      dYaw -= stick.lookX * rate * dt;
      dPitch -= stick.lookY * rate * dt;
    }
    // Mantles are rooted: you keep your head, but the shoulders are committed.
    if (m.mantleMotion.active) {
      dYaw *= 0.55;
      dPitch *= 0.55;
    }

    m.yaw += dYaw;
    m.pitch = clamp(m.pitch + dPitch, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    // Keep yaw bounded so long sessions never lose float precision.
    if (m.yaw > Math.PI) m.yaw -= Math.PI * 2;
    else if (m.yaw < -Math.PI) m.yaw += Math.PI * 2;

    m.yawRate = dt > 1e-5 ? dYaw / dt : 0;
    this._prevYaw = m.yaw;
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.movement) return;
    // Death cam owns the camera — do not advance look / movement under it.
    if (this.deathCam?.active) return;
    this._consumeLook(ctx.time.dt > 1e-5 ? ctx.time.dt : h);
    this.movement.latchInput(ctx.time.frame);
    if (!this.controlEnabled) return;
    this.movement.adsAmount = this.adsAmount;
    this.movement.step(h);
  }

  update(dt, ctx) {
    if (!this.movement) return;

    if (this.deathCam?.active) {
      this.health.update(dt);
      this.lowHealthPass?.sync(this.health);
      this._syncHitbox();
      if (this.deathCam.update(dt)) this.respawn();
      this._publishState();
      return;
    }

    this._consumeLook(dt);
    this.movement.latchInput(ctx.time.frame);

    this._updateAds(dt);
    this._drainMovementEvents();
    this.health.update(dt);

    this.rig.update(dt, this.movement, this.health);
    if (this.controlEnabled) this.rig.applyTo(ctx.camera);
    else this.rig.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);

    this.lowHealthPass?.sync(this.health);
    this._syncHitbox();
    this._publishState();
  }

  /** Keep the AI-facing hitbox on the interpolated capsule. */
  _syncHitbox() {
    if (!this.hitbox) return;
    const m = this.movement;
    const p = m.renderPosition;
    const r = 0.3;
    const h = STANCE[m.stance].height;
    this.hitbox.setSegment(p.x, p.y + r, p.z, p.x, p.y + Math.max(r, h - r), p.z, r);
    this.hitbox.enabled = !this.health.dead;
  }

  _updateAds(dt) {
    const input = this.ctx.input;
    const m = this.movement;
    this.adsRequested =
      this.controlEnabled && input.ads && !m.mantleMotion.active && !m.sliding && !this.health.dead;

    if (this._adsExternal) {
      // `weapons` is driving the blend; stop trusting it if it goes quiet.
      this._adsExternalAge += dt;
      if (this._adsExternalAge > 0.6) this._adsExternal = false;
    }
    if (!this._adsExternal) {
      this.adsAmount = approach(this.adsAmount, this.adsRequested ? 1 : 0, 0.075, dt);
    }
    m.adsAmount = this.adsAmount;
  }

  /** Turn the movement machine's one-shot flags into events + camera impulses. */
  _drainMovementEvents() {
    const m = this.movement;

    if (m.landEvent.pending) {
      m.landEvent.pending = false;
      const speed = m.landEvent.speed;
      const mag = this.rig.onLand(speed);
      this._landPayload.velocity = speed;
      this._landPayload.surface = m.landEvent.surface;
      this._landPayload.position.copy(m.position);
      this.ctx.events.emit('player:land', this._landPayload);
      // Fall damage — CoD only hurts you past a real drop.
      const L = CAMERA.land;
      if (speed > L.damageSpeed) {
        this._lastDamageCause = 'fall';
        this._lastKiller = null;
        this._lastKillerName = 'FALL DAMAGE';
        this.health.damage((speed - L.damageSpeed) * L.damagePerSpeed, null, { type: 'fall' });
        this._checkDeath();
      }
      if (mag > 0.35) this.movement._footHold = FOOTSTEP.landHold;
    }

    if (m.stepEvent.pending) {
      m.stepEvent.pending = false;
      const e = this._stepPayload;
      e.position.set(m.stepEvent.x, m.stepEvent.y, m.stepEvent.z);
      e.surface = m.stepEvent.surface;
      e.running = m.stepEvent.running;
      e.left = m.stepEvent.left;
      e.speed = m.horizontalSpeed;
      e.stance = m.stance;
      this.rig.onFootstep(e.running, m.stance);
      this.ctx.events.emit('player:footstep', e);
    }

    if (m.jumped) {
      m.jumped = false;
      this.rig.addRecoil(-0.35 * DEG, 0, 0, 0.004);
      this._jumpPayload.position.copy(m.position);
      this.ctx.events.emit('player:jump', this._jumpPayload);
    }

    if (m.slideStarted) {
      m.slideStarted = false;
      this.rig.onSlideStart(m._slideSide);
    }
    if (m.slideEnded) m.slideEnded = false;

    if (m.mantleEvent.pending) {
      m.mantleEvent.pending = false;
      this._mantlePayload.kind = m.mantleEvent.kind;
      this._mantlePayload.height = m.mantleEvent.height;
      this.rig.addTrauma(m.mantleEvent.kind === 'vault' ? 0.08 : 0.14);
      this.ctx.events.emit('player:mantle', this._mantlePayload);
    }
  }

  _publishState() {
    const m = this.movement;
    const s = this._statePayload;
    const leaning = Math.abs(m.leanAmount) > 0.35;
    const state = leaning && (m.state === 'stand' || m.state === 'crouch') ? 'lean' : m.state;
    s.state = state;
    s.stance = m.stance;
    s.crouched = m.stance !== 'stand';
    s.sprinting = m.sprinting;
    s.tacticalSprint = m.tacticalSprint;
    s.sliding = m.sliding;
    s.ads = this.adsAmount > 0.5;
    s.adsProgress = this.adsAmount;
    s.grounded = m.grounded;
    s.airborne = !m.grounded;
    s.mantling = m.mantleMotion.active;
    s.lean = m.leanAmount;
    s.speed = m.horizontalSpeed;
    s.health = this.health.value;
    s.healthFraction = this.health.fraction;
    // Emit only when something discrete actually changed. Field-wise compare,
    // because building a key string every frame would be a per-frame allocation.
    const q = this._prev;
    if (
      q.state !== s.state || q.stance !== s.stance || q.sprinting !== s.sprinting ||
      q.tacticalSprint !== s.tacticalSprint || q.sliding !== s.sliding ||
      q.grounded !== s.grounded || q.ads !== s.ads || q.mantling !== s.mantling
    ) {
      q.state = s.state; q.stance = s.stance; q.sprinting = s.sprinting;
      q.tacticalSprint = s.tacticalSprint; q.sliding = s.sliding;
      q.grounded = s.grounded; q.ads = s.ads; q.mantling = s.mantling;
      this.ctx.events.emit('player:state', s);
    }
  }

  /* ==================================================================== */
  /* incoming damage                                                      */
  /* ==================================================================== */

  _onDamageDealt(e) {
    if (!e) return;
    const t = e.target;
    if (t !== this && t !== 'player' && t?.isPlayer !== true) return;
    // Direction indicators need the *shooter*, not the impact point: `ai` sets
    // `point` to where the round landed (which is the player), and `from` to the
    // muzzle. Using `point` pinned every arc to dead ahead.
    const from = e.from ?? e.source?.position ?? e.point ?? null;
    this._rememberAttacker(e.source ?? null, from, 'bullet', e.point ?? null);
    this.applyDamage(e.amount ?? 0, from, { type: 'bullet' });
  }

  _onExplosion(e) {
    if (!e?.position) return;
    const eye = this.ctx.camera.position;
    const r = e.radius ?? 5;
    const d = this._tmp.copy(e.position).distanceTo(eye);
    if (d > r * 1.6) return;
    // Occluded blasts still shake you, they just do not wound you.
    const clear = this.physics.lineOfSight(e.position, eye, this.physics.MASK.EXPLOSION);
    const falloff = Math.pow(clamp01(1 - d / r), 1.6);
    this.rig.addTrauma(clamp01(falloff * 1.4));
    this.health.addSuppression(HEALTH.suppression.perExplosion * falloff);
    if (clear && falloff > 0.02) {
      this._rememberAttacker(e.source ?? e.owner ?? null, e.position, 'explosion', e.position);
      this.applyDamage((e.damage ?? 90) * falloff, e.position, { type: 'explosion' });
    }
  }

  _rememberAttacker(source, from, cause, point) {
    this._lastDamageCause = cause;
    this._lastKiller = source && typeof source === 'object' ? source : null;
    this._lastKillerName = this._killerLabel(source, cause);
    if (point) this._lastHitPoint.copy(point);
    else if (from) this._lastHitPoint.copy(from);
    else this._lastHitPoint.copy(this.ctx.camera.position);
    if (from) {
      this._lastHitDir.copy(this.ctx.camera.position).sub(from);
      if (this._lastHitDir.lengthSq() < 1e-6) this._lastHitDir.set(0, 0, 1);
      else this._lastHitDir.normalize();
    }
  }

  _killerLabel(source, cause) {
    if (source && typeof source === 'object') {
      return source.name ?? source.callsign ?? source.variantName?.toUpperCase?.() ?? 'ENEMY';
    }
    if (typeof source === 'string') return source;
    if (cause === 'fall') return 'FALL DAMAGE';
    if (cause === 'explosion') return 'EXPLOSION';
    return 'ENEMY';
  }

  /**
   * If health just hit zero, freeze the player, drop a corpse, and start the
   * overhead death cam + respawn countdown.
   */
  _checkDeath() {
    if (!this.health.dead || this.deathCam?.active) return;
    this._beginDeath();
  }

  _beginDeath() {
    const feet = this.movement.position;
    const yaw = this.movement.yaw;
    const eye = this.ctx.camera.position;
    const fwd = this.rig.forward;

    // Impulse along the last hit direction so the body reacts to the kill shot.
    this._tmp2.copy(this._lastHitDir).multiplyScalar(3.2);
    this._tmp2.y = Math.max(0.4, this._tmp2.y);

    const ai = this.ctx.peek('ai');
    let corpse = null;
    if (typeof ai?.spawnPlayerCorpse === 'function') {
      corpse = ai.spawnPlayerCorpse({
        position: feet,
        yaw,
        impulse: this._tmp2,
        point: this._lastHitPoint,
      });
    }

    this.setControlEnabled(false);
    this.adsAmount = 0;
    this._adsExternal = false;

    this.deathCam.begin({
      position: feet,
      eye,
      forward: fwd,
      killer: this._lastKiller,
      killerName: this._lastKillerName,
      cause: this._lastDamageCause,
      corpse,
    });

    const p = this._deathPayload;
    p.position.copy(feet);
    p.killer = this._lastKiller;
    p.killerName = this.deathCam.killerName;
    p.cause = this._lastDamageCause;
    p.respawnIn = this.deathCam.respawnIn;
    this.ctx.events.emit('player:death', p);
  }

  _onBulletImpact(e) {
    if (!e?.point || this.health.dead) return;
    const eye = this.ctx.camera.position;
    const dx = e.point.x - eye.x, dy = e.point.y - eye.y, dz = e.point.z - eye.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const R = HEALTH.suppression.radius;
    if (d2 > R * R) return;
    // Heuristic: rounds we fired land where we are looking. Anything cracking in
    // beside or behind us is somebody shooting at us.
    const d = Math.sqrt(d2) || 1e-4;
    const f = this.rig.forward;
    if ((dx * f.x + dy * f.y + dz * f.z) / d > 0.55) return;
    this.health.addSuppression(HEALTH.suppression.perNearMiss * (1 - d / R));
  }

  /* ==================================================================== */
  /* public API                                                           */
  /* ==================================================================== */

  /**
   * HUD adapter polled by `ui` every lateUpdate. Shape is fixed by the contract
   * documented at the top of src/ui/index.js. Preallocated and mutated in place.
   */
  getHudState() {
    const h = this._hudState;
    const m = this.movement;
    const hp = this.health;
    const dc = this.deathCam;
    h.health = hp.value;
    h.maxHealth = hp.max;
    h.regen = hp.regenerating;
    h.dead = hp.dead || !!dc?.active;
    h.suppression = hp.suppression;
    // 0..1 against tactical sprint, which is the fastest the player can move —
    // `ui` uses this directly as the reticle-bloom weight.
    h.move = Math.min(1, m.horizontalSpeed / MOVE.tacSprintSpeed);
    h.sprint = m.sprinting || m.tacticalSprint;
    h.crouch = m.stance === 'crouch' || m.stance === 'prone';
    h.ads = this.adsAmount > 0.5;
    h.airborne = !m.grounded;
    h.position = this.position;
    h.deathActive = !!dc?.active;
    h.killerName = dc?.active ? dc.killerName : '';
    h.respawnIn = dc?.active ? dc.respawnIn : 0;
    return h;
  }

  get deathActive() {
    return !!this.deathCam?.active;
  }
  get respawnIn() {
    return this.deathCam?.active ? this.deathCam.respawnIn : 0;
  }
  get killerName() {
    return this.deathCam?.active ? this.deathCam.killerName : '';
  }

  get position() {
    return this.movement.renderPosition;
  }
  get feetPosition() {
    return this.movement.position;
  }
  get eyePosition() {
    return this.rig.eyePosition;
  }
  get velocity() {
    return this.movement.velocity;
  }
  get forward() {
    return this.rig.forward;
  }
  get yaw() {
    return this.movement.yaw;
  }
  get pitch() {
    return this.movement.pitch;
  }
  get speed() {
    return this.movement.speed;
  }
  get horizontalSpeed() {
    return this.movement.horizontalSpeed;
  }
  get character() {
    return this.movement.character;
  }
  get state() {
    return this._statePayload.state;
  }
  get stance() {
    return this.movement.stance;
  }
  get sprinting() {
    return this.movement.sprinting;
  }
  get tacticalSprint() {
    return this.movement.tacticalSprint;
  }
  get sliding() {
    return this.movement.sliding;
  }
  get slideProgress() {
    return this.movement.slideProgress;
  }
  get grounded() {
    return this.movement.grounded;
  }
  get airborne() {
    return !this.movement.grounded;
  }
  get mantling() {
    return this.movement.mantleMotion.active;
  }
  get leanAmount() {
    return this.movement.leanAmount;
  }
  get eyeHeight() {
    return this.rig.eye;
  }
  get adsProgress() {
    return this.adsAmount;
  }
  get viewKick() {
    return this.rig.viewKick;
  }
  get cameraRig() {
    return this.rig;
  }
  get height() {
    return STANCE[this.movement.stance].height;
  }
  get maxHealth() {
    return this.health.max;
  }
  get healthFraction() {
    return this.health.fraction;
  }
  get lowHealth() {
    return this.health.low;
  }
  get dead() {
    return this.health.dead;
  }
  get suppression() {
    return this.health.suppression;
  }
  get damageIndicators() {
    return this.health.indicators;
  }
  get heartbeatPulse() {
    return this.health.pulse;
  }
  get bobPhase() {
    return this.rig.bobPhase;
  }

  /** `weapons` owns the ADS curve; hand it over and everything else follows. */
  setAdsProgress(v) {
    this.adsAmount = clamp01(v);
    this._adsExternal = true;
    this._adsExternalAge = 0;
    this.movement.adsAmount = this.adsAmount;
  }

  addRecoil(pitch, yaw, roll, punch) {
    this.rig.addRecoil(pitch, yaw, roll, punch);
  }
  addKick(pitch, yaw, roll) {
    this.rig.addKick(pitch, yaw, roll);
  }
  addTrauma(a) {
    this.rig.addTrauma(a);
  }
  /** Alias some subsystems may reach for. */
  addCameraShake(a) {
    this.rig.addTrauma(a);
  }

  applyDamage(amount, from, opts) {
    if (opts?.type) this._lastDamageCause = opts.type;
    const dealt = this.health.damage(amount, from ?? null, { yaw: this.movement.yaw, ...opts });
    this._checkDeath();
    return dealt;
  }
  heal(a) {
    this.health.heal(a);
  }
  addSuppression(a) {
    this.health.addSuppression(a);
  }

  setControlEnabled(on) {
    this.controlEnabled = !!on;
    this.movement.controlEnabled = this.controlEnabled;
    if (!on) {
      this.movement.latchInput(-2); // flush held keys
      this.movement.velocity.set(0, 0, 0);
      this.movement.sprinting = false;
      this.movement.tacticalSprint = false;
      this.movement.sliding = false;
      this.movement.cancelMantle();
      this.adsAmount = 0;
      this._adsExternal = false;
    } else {
      this.movement._cmdFrame = -1;
    }
  }

  /**
   * Move the player. `eyeOrPos` is the EYE position (that is what the shot
   * harness hands us — it passes the camera transform); `rot` may be a
   * THREE.Euler, an object with `.y`, or a yaw in radians.
   */
  teleport(eyeOrPos, rot) {
    if (!eyeOrPos) return;
    const eyeH = STANCE.stand.eye;
    const feetY = eyeOrPos.y - eyeH;
    if (typeof rot === 'number') {
      this.movement.yaw = rot;
    } else if (rot) {
      this.movement.yaw = rot.y ?? this.movement.yaw;
      this.movement.pitch = clamp(rot.x ?? 0, -CAMERA.pitchLimit, CAMERA.pitchLimit);
    }
    this.movement.teleport(eyeOrPos.x, feetY, eyeOrPos.z);
    this.rig.reset(eyeH);
    this.rig.eyePosition.set(eyeOrPos.x, eyeOrPos.y, eyeOrPos.z);
    this.rig.fov = this.ctx.config.fov;
    this._lookFrame = this.ctx.time.frame;
    this._prev.state = '';
  }

  /**
   * Clear death state, remove the corpse, and place the player on a spawn
   * point. With no `index`, picks the safest point enemies cannot already see.
   * An explicit index (debug / harness) still forces that slot.
   */
  respawn(index) {
    const ai = this.ctx.peek('ai');
    const corpse = this.deathCam?.corpse;
    // Snapshot kill site before teardown — bias spawn selection away from it.
    if (this.deathCam?.body) this._tmp2.copy(this.deathCam.body);
    else if (this.movement?.position) this._tmp2.copy(this.movement.position);
    else this._tmp2.set(0, 0, 0);

    if (corpse && typeof ai?.removeCorpse === 'function') ai.removeCorpse(corpse);
    else if (corpse?.dispose) {
      const list = ai?.agents;
      if (Array.isArray(list)) {
        const i = list.indexOf(corpse);
        if (i >= 0) list.splice(i, 1);
      }
      corpse.dispose();
    }
    this.deathCam?.end();

    this.health.reset(true);
    this.health.effect = 0;
    this.health.hitFlash = 0;
    this._lastKiller = null;
    this._lastKillerName = null;
    this._lastDamageCause = 'bullet';

    // Safe pick before control returns — skip any point living enemies can see.
    const spawn = this._pickSpawn(index, this._tmp2);
    this._spawnIndex = spawn.index;
    this.movement.yaw = spawn.yaw;
    this.movement.pitch = 0;
    this.movement.velocity.set(0, 0, 0);
    this.movement.teleport(spawn.feet.x, spawn.feet.y, spawn.feet.z);
    this.movement.cancelMantle?.();
    this.movement.sprinting = false;
    this.movement.tacticalSprint = false;
    this.movement.sliding = false;
    this.rig.reset(STANCE.stand.eye);
    this.rig.update(1 / 60, this.movement, this.health);
    this.rig.applyTo(this.ctx.camera);
    this._syncHitbox();
    this._lookFrame = -1;
    this._prev.state = '';

    this.setControlEnabled(true);

    const p = this._respawnPayload;
    p.position.copy(spawn.feet);
    p.index = spawn.index;
    this.ctx.events.emit('player:respawn', p);
  }

  /** Named states for dev overlays and future shots. */
  debugState(name) {
    const m = this.movement;
    switch (name) {
      case 'sprint':
        m.stanceWant = 'stand';
        m.sprinting = true;
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed);
        break;
      case 'tacsprint':
        m.sprinting = true;
        m.tacticalSprint = true;
        break;
      case 'crouch':
        m.stanceWant = 'crouch';
        break;
      case 'prone':
        m.stanceWant = 'prone';
        break;
      case 'slide':
        m.sprinting = true;
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed);
        m._beginSlide(m.cmd, m._wish.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)), 1, MOVE.sprintSpeed);
        m.slideStarted = false;
        this.rig.onSlideStart(1);
        break;
      case 'air':
        m.velocity.y = JUMP_SPEED;
        m.grounded = false;
        break;
      case 'hurt':
        this.health.value = this.health.max * 0.28;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = clamp01((HEALTH.lowThreshold - 0.28) / HEALTH.lowThreshold);
        break;
      case 'critical':
        this.health.value = this.health.max * 0.11;
        this.health.lastDamageTime = this.ctx.time.elapsed;
        this.health.effect = 1;
        this.health.hitFlash = 0.6;
        break;
      case 'reset':
        if (this.deathCam?.active) this.respawn(this._spawnIndex);
        else {
          this.health.reset(true);
          this.health.effect = 0;
        }
        break;
      case 'kill':
        this._lastDamageCause = 'bullet';
        this._lastKillerName = 'DEBUG';
        this._lastKiller = null;
        this.health.damage(this.health.max + 10, null, { type: 'bullet' });
        this._checkDeath();
        break;
      default:
        break;
    }
    return {
      state: this.state, stance: m.stance, speed: m.horizontalSpeed,
      health: this.health.value, ads: this.adsAmount,
    };
  }

  /** Snapshot for the dev HUD / debugging. */
  get stats() {
    const m = this.movement;
    return {
      state: this.state,
      stance: m.stance,
      speed: m.horizontalSpeed,
      vertical: m.velocity.y,
      grounded: m.grounded,
      lean: m.leanAmount,
      fov: this.rig.fov,
      health: this.health.value,
      suppression: this.health.suppression,
    };
  }

  dispose() {
    for (const off of this._offEvents) off?.();
    this._offEvents.length = 0;
    if (this.hitbox) {
      this.physics?.removeCollider(this.hitbox);
      this.hitbox = null;
    }
    this._unregisterPass?.();
    this.lowHealthPass?.dispose();
    this.lowHealthPass = null;
    this.movement?.dispose();
  }
}
