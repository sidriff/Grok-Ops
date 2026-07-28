/**
 * Survival match director — Grok Ops default mode.
 *
 * You + 3 blue allies. Red hostiles wave-spawn for 5 minutes. Difficulty
 * ramps gently at first, then bends hard around the 1-minute mark, and
 * near the end hostiles refill almost as fast as they drop (cap 12).
 *
 * Player death freezes on the death cam and shows a score/retry screen
 * instead of TDM respawn. Surviving the clock is a win.
 */

import * as THREE from 'three';

const DURATION = 300; // 5 minutes
const MAX_ENEMIES = 12;
const ALLY_COUNT = 3;
const START_ENEMIES = 2;

const ALLY_NAMES = ['EAGLE', 'HAWK', 'FALCON', 'OSPREY', 'KITE', 'CONDOR'];

export class GameSystem {
  static id = 'game';
  static deps = ['ai', 'player', 'world'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();

    this.duration = DURATION;
    this.maxEnemies = MAX_ENEMIES;
    this.phase = 'boot'; // boot | playing | won | lost
    this.elapsed = 0;
    this.timeLeft = DURATION;
    this.kills = 0;
    this.headshots = 0;
    /** In-match combat points (headshot kills pay more than body). */
    this.combatPoints = 0;
    this.allyKills = 0;
    this.deaths = 0;
    this.peakAlive = 0;
    this._spawnDebt = 0;
    this._wave = 0;
    this._pendingStart = true;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    const ai = ctx.peek('ai');
    if (ai) {
      ai.autoPopulate = false;
      // Boot may have already dropped a garrison before we registered.
      if (ai.agents?.length) ai.clearAllAgents();
    }

    const player = ctx.peek('player');
    if (player) {
      player.team = 0;
      player.autoRespawn = false;
    }

    this._off = [];
    const on = (t, fn) => this._off.push(ctx.events.on(t, fn));

    on('damage:dealt', (e) => {
      if (this.phase !== 'playing') return;
      if (!e?.killed) return;
      if (!this._isPlayerSource(e.source)) return;
      if (e.target?.team === 0 || e.target?.friendly) return;
      this.kills++;
      // Headshots score higher — not just kill count on the board.
      if (e.headshot) {
        this.headshots++;
        this.combatPoints += 150;
      } else {
        this.combatPoints += 100;
      }
      this._pushHud();
    });

    on('actor:death', (e) => {
      if (this.phase !== 'playing') return;
      const by = e?.by;
      if (!by || by.isPlayer || by === 'player') return;
      if (by.team === 0 && e?.actor?.team !== 0) {
        this.allyKills++;
        this._pushHud();
      }
    });

    on('player:death', () => {
      if (this.phase !== 'playing') return;
      this.deaths++;
      this._endMatch(false);
    });

    // Capture / lockstep runs stay empty — shots own the stage.
    if (ctx.config?.deterministic) {
      this.phase = 'idle';
      this._pendingStart = false;
    }
  }

  /* ================================================================== */
  /* public                                                             */
  /* ================================================================== */

  /** Full match restart (Retry button / boot). */
  restart() {
    this._teardownActors();
    this._resetPlayer();
    this._resetWeapons();
    this.elapsed = 0;
    this.timeLeft = this.duration;
    this.kills = 0;
    this.headshots = 0;
    this.combatPoints = 0;
    this.allyKills = 0;
    this.deaths = 0;
    this.peakAlive = 0;
    this._spawnDebt = START_ENEMIES;
    this._wave = 0;
    this.phase = 'playing';

    const ai = this.ctx.peek('ai');
    if (ai) ai.frozen = false;

    this._spawnAllies();
    // Immediate first hostiles so the street isn't empty for 10s.
    this._spawnDebt = START_ENEMIES;
    this._drainSpawns(true);

    this._pushHud();
    const ui = this.ctx.peek('ui');
    ui?.setEndgame?.(null);
    ui?.banner?.show?.('SURVIVAL', 'HOLD FOR 5:00 · WATCH YOUR SIX', 3.2);
    // Grab aim only when input is live. Boot freezes input under the title shell
    // (Load → Deploy); main captures on Deploy. Calling this earlier would
    // fullscreen mid-load if the Fullscreen checkbox is on.
    if (this.ctx.input?.enabled) {
      this.ctx.input.capturePointerForGame?.({ lock: true });
    }
    console.info('[game] survival restart');
  }

  getHudSnapshot() {
    return {
      mode: 'SURVIVE',
      timeLeft: Math.max(0, this.timeLeft),
      scoreUs: this.kills,
      scoreThem: this._countAlive(1),
      phase: this.phase,
      kills: this.kills,
      allyKills: this.allyKills,
      elapsed: this.elapsed,
      alliesAlive: this._countAlive(0),
      intensity: this._intensity(this.elapsed),
    };
  }

  /* ================================================================== */
  /* frame                                                              */
  /* ================================================================== */

  update(dt, ctx) {
    if (this._pendingStart) {
      const ai = ctx.peek('ai');
      if (ai && !ai._navPending && ai.grid) {
        this._pendingStart = false;
        this.restart();
      }
      return;
    }

    if (this.phase !== 'playing') return;
    if ((ctx.time?.scale ?? 1) <= 0 || dt <= 0) return;

    this.elapsed += dt;
    this.timeLeft = Math.max(0, this.duration - this.elapsed);

    // Difficulty → accuracy on every living hostile.
    const inten = this._intensity(this.elapsed);
    this._applyDifficulty(inten);

    // Spawn meter: interval shrinks hard after ~60s and approaches instant refill.
    const interval = this._spawnInterval(inten);
    this._spawnDebt += dt / Math.max(0.05, interval);
    this._drainSpawns(false);

    const enemies = this._countAlive(1);
    if (enemies > this.peakAlive) this.peakAlive = enemies;

    this._pushHud();

    if (this.timeLeft <= 0) {
      this._endMatch(true);
    }
  }

  dispose() {
    for (const off of this._off ?? []) off();
    this._off = [];
  }

  /* ================================================================== */
  /* difficulty                                                         */
  /* ================================================================== */

  /**
   * 0..1 intensity. Soft for the first minute, sharp bend ~60s, then ramps
   * toward full chaos by the end of five minutes.
   */
  _intensity(tSec) {
    const t = Math.max(0, tSec);
    if (t < 60) {
      // 0.06 → ~0.28 over the first minute (still readable).
      const u = t / 60;
      return 0.06 + 0.22 * u * u;
    }
    const u = Math.min(1, (t - 60) / (this.duration - 60));
    // After the bend: climb hard (ease-in power).
    return 0.28 + 0.72 * Math.pow(u, 1.25);
  }

  /** Seconds between spawn attempts at this intensity. */
  _spawnInterval(inten) {
    // Start ~7s, mid ~1.4s, end ~0.12s (near-instant refill under the cap).
    const a = 7.2;
    const b = 0.12;
    return a * Math.pow(b / a, Math.min(1, Math.max(0, inten)));
  }

  _applyDifficulty(inten) {
    // Early: spray (mul ~3.4). Late: tighter than default (mul ~0.85).
    const mul = 3.4 - 2.55 * inten;
    const dmgScale = 0.7 + 0.55 * inten;
    for (const a of this.ctx.peek('ai')?.agents ?? []) {
      if (!a.alive || a.team === 0 || a.isPlayerCorpse) continue;
      a.accuracyMul = mul;
      a.weaponDamage = 14 * dmgScale;
    }
  }

  /* ================================================================== */
  /* spawning                                                           */
  /* ================================================================== */

  _drainSpawns(force) {
    const ai = this.ctx.peek('ai');
    if (!ai?.grid) return;
    let living = this._countAlive(1);
    // Spend fractional debt as whole bodies under the cap.
    while ((this._spawnDebt >= 1 || force) && living < this.maxEnemies) {
      if (!force && this._spawnDebt < 1) break;
      if (this._spawnOneEnemy()) {
        living++;
        this._spawnDebt = Math.max(0, this._spawnDebt - 1);
        force = false;
      } else {
        // No valid spawn point this frame — wait.
        this._spawnDebt = Math.min(this._spawnDebt, 1.5);
        break;
      }
    }
    // Never bank more than a small queue or the end of the match dumps a stack.
    this._spawnDebt = Math.min(this._spawnDebt, 3);
  }

  _spawnAllies() {
    const ai = this.ctx.peek('ai');
    const player = this.ctx.peek('player');
    if (!ai?.grid || !player?.position) return;

    const origin = player.position;
    const squad = ai.createSquad();
    const yaw = player.movement?.yaw ?? 0;

    for (let i = 0; i < ALLY_COUNT; i++) {
      const ang = yaw + Math.PI + (i - 1) * 0.55 + this.rng.signed() * 0.15;
      const r = 2.2 + i * 0.45;
      this._v.set(
        origin.x + Math.sin(ang) * r,
        origin.y,
        origin.z + Math.cos(ang) * r
      );
      const p = this._snapNav(ai, this._v, origin.y);
      if (!p) continue;
      const name = `${ALLY_NAMES[i % ALLY_NAMES.length]}-${String(i + 1).padStart(2, '0')}`;
      const a = ai.spawn('breacher', p, yaw + this.rng.signed() * 0.4, {
        team: 0,
        friendly: true,
        name,
        accuracyMul: 0.9,
        escort: true,
        escortSlot: i, // left / centre / right wedge behind the player
      });
      a.patrolPoints = null;
      squad.add(a);
    }
    console.info(`[game] allies: ${squad.members?.length ?? ALLY_COUNT}`);
  }

  _spawnOneEnemy() {
    const ai = this.ctx.peek('ai');
    const world = this.ctx.peek('world');
    const player = this.ctx.peek('player');
    if (!ai?.grid || !world?.spawnPoints?.length || !player?.position) return false;

    const origin = player.position;
    const spawns = world.spawnPoints;
    // Prefer points 18–55 m out, not on top of the player, with a little random.
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[i];
      const d = s.position.distanceTo(origin);
      if (d < 16 || d > 62) continue;
      // Light random so we don't always pick the same two rooftops.
      const score = d * 0.15 + this.rng.float() * 8 - (d > 48 ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) {
      // Fallback: farthest point.
      let far = spawns[0];
      let farD = -1;
      for (const s of spawns) {
        const d = s.position.distanceTo(origin);
        if (d > farD) {
          farD = d;
          far = s;
        }
      }
      best = far;
    }
    if (!best) return false;

    const jitterA = this.rng.range(0, Math.PI * 2);
    const jitterR = this.rng.range(0.6, 2.8);
    this._v.set(
      best.position.x + Math.cos(jitterA) * jitterR,
      best.position.y,
      best.position.z + Math.sin(jitterA) * jitterR
    );
    const p = this._snapNav(ai, this._v, best.position.y);
    if (!p) return false;

    // Don't spawn on top of an ally / the player.
    if (p.distanceTo(origin) < 12) return false;
    for (const a of ai.agents) {
      if (a.alive && a.position.distanceTo(p) < 1.6) return false;
    }

    // Warm OPFOR only — never spawn hostiles as urban `breacher` (that's blue team).
    const variants = ['vanguard', 'irregular'];
    const v = variants[this.rng.int(0, variants.length - 1)];
    const inten = this._intensity(this.elapsed);
    const a = ai.spawn(v, p, best.yaw + this.rng.signed() * 0.8, {
      team: 1,
      accuracyMul: 3.4 - 2.55 * inten,
    });
    // Seed last-known toward the fight so they don't idle forever far away.
    a.lastKnown.copy(origin);
    a.lastKnown.y += 1.35;
    a.lastKnownAge = 0.5;
    a.alertness = 0.4 + inten * 0.5;
    if (inten > 0.35) {
      a._setState?.('alert');
      a._seekLastKnown?.(true);
    } else {
      a.patrolPoints = [p.clone()];
      a.patrolIndex = 0;
    }
    this._wave++;
    return true;
  }

  _snapNav(ai, pos, yHint) {
    const ci = ai.grid.nearest(pos.x, pos.z, yHint ?? pos.y, 8, 1.4);
    if (ci < 0) {
      const y = ai.groundAt(pos.x, pos.z, (yHint ?? pos.y) + 4);
      if (!Number.isFinite(y)) return null;
      return new THREE.Vector3(pos.x, y, pos.z);
    }
    return new THREE.Vector3(
      ai.grid.worldX(ci % ai.grid.nx),
      ai.grid.floor[ci],
      ai.grid.worldZ((ci / ai.grid.nx) | 0)
    );
  }

  _countAlive(team) {
    let n = 0;
    for (const a of this.ctx.peek('ai')?.agents ?? []) {
      if (a.alive && !a.isPlayerCorpse && a.team === team) n++;
    }
    return n;
  }

  /* ================================================================== */
  /* end / reset                                                        */
  /* ================================================================== */

  _endMatch(won) {
    if (this.phase !== 'playing') return;
    this.phase = won ? 'won' : 'lost';
    this.timeLeft = won ? 0 : this.timeLeft;

    const player = this.ctx.peek('player');
    if (player) {
      player.autoRespawn = false;
      // Win: drop control so the score card is the only interaction.
      if (won) player.setControlEnabled?.(false);
    }

    const ai = this.ctx.peek('ai');
    if (ai) ai.frozen = true;
    for (const a of ai?.agents ?? []) {
      if (!a.alive) continue;
      a.wantFire = false;
      a.awareness = 0;
      a.hasTarget = false;
      a.targetRef = null;
    }

    // Same path as the pause menu: free the OS cursor and stop auto-lock so
    // RETRY is actually clickable (canvas is cursor:none under pointer lock).
    this.ctx.input?.releasePointerForUi?.();

    const survived = Math.min(this.duration, this.elapsed);
    const alliesAlive = this._countAlive(0);
    const allyMult = Math.max(1, Math.min(3, alliesAlive));
    const combatPoints = this.combatPoints | 0;
    // (survival seconds + combat points) × allies still standing (min 1×)
    const score = (Math.floor(survived) + combatPoints) * allyMult;
    const payload = {
      endgame: true,
      won,
      killerName: player?.deathCam?.killerName || player?._lastKillerName || 'ENEMY',
      timeSurvived: survived,
      kills: this.kills,
      headshots: this.headshots,
      combatPoints,
      score,
      allyKills: this.allyKills,
      alliesAlive,
      enemiesKilled: this.kills + this.allyKills,
      peakAlive: this.peakAlive,
    };
    this._pushHud();
    this.ctx.peek('ui')?.setEndgame?.(payload);
    this.ctx.events.emit('game:end', payload);
    console.info(
      `[game] ${won ? 'WIN' : 'LOSS'} t=${survived.toFixed(1)}s kills=${this.kills}` +
        ` hs=${this.headshots} pts=${combatPoints} allies=${alliesAlive} score=${score}`
    );
  }

  _teardownActors() {
    const ai = this.ctx.peek('ai');
    ai?.clearAllAgents?.();
    // Clear AI grenades left mid-air.
    if (ai?._grenades) {
      for (const g of ai._grenades) {
        ai.phys?.removeRigidBody?.(g.body);
        g.mesh?.removeFromParent?.();
      }
      ai._grenades.length = 0;
    }
  }

  _resetPlayer() {
    const player = this.ctx.peek('player');
    if (!player) return;
    player.autoRespawn = false;
    player.team = 0;

    // If we died mid-run, tear down death cam + corpse via respawn, then
    // re-disable auto-respawn for the next death.
    if (player.deathCam?.active) {
      player.respawn?.();
    } else {
      player.health?.reset?.(true);
      if (player.health) {
        player.health.effect = 0;
        player.health.hitFlash = 0;
      }
      player.setControlEnabled?.(true);
    }
    player.autoRespawn = false;
    player._lastKiller = null;
    player._lastKillerName = null;
  }

  _resetWeapons() {
    const wp = this.ctx.peek('weapons');
    if (!wp) return;
    try {
      if (wp.states instanceof Map) {
        for (const s of wp.states.values()) {
          const def = s.def;
          if (!def) continue;
          s.mag = def.magSize ?? 30;
          s.reserve = def.reserve ?? 210;
          s.chambered = true;
        }
      }
      wp.grenadeCount = 2;
      // Clear in-flight rounds so a retry doesn't eat a ghost tracer.
      wp.sim?.clear?.();
    } catch {
      /* best-effort */
    }
  }

  _pushHud() {
    const ui = this.ctx.peek('ui');
    if (!ui?.setMatch) return;
    ui.setMatch({
      mode: 'SURVIVE',
      timeLeft: Math.max(0, this.timeLeft),
      scoreUs: this.kills,
      scoreThem: this._countAlive(1),
    });
  }

  _isPlayerSource(src) {
    if (!src) return false;
    if (src === 'player' || src?.isPlayer === true) return true;
    return src === this.ctx.peek('player');
  }
}
