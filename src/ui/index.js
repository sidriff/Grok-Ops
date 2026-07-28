import * as THREE from 'three';
import { installStyles, removeStyles } from './style.js';
import { el, clamp, clamp01, damp, setStyle } from './util.js';
import { Crosshair } from './crosshair.js';
import { Hitmarkers } from './hitmarkers.js';
import { DamageArcs } from './damage.js';
import { HealthFx } from './health.js';
import { AmmoPanel } from './ammo.js';
import { Killfeed } from './killfeed.js';
import { Compass, MatchBar } from './compass.js';
import { Minimap } from './minimap.js';
import { WorldMarkers } from './markers.js';
import { Prompt, Banner } from './prompts.js';
import { DeathOverlay } from './death.js';
import { PauseMenu } from './menu.js';
import { CombatDemo } from './demo.js';
import { Nameplate } from './nameplate.js';

const MAX_BLIPS = 48;
const MAX_PINGS = 32;
/** How long a lost contact stays as a fading last-known pip (seconds). */
const CONTACT_FADE = 5.5;
/** Beyond this, we never run LOS for minimap contacts (metres). */
const CONTACT_RANGE = 58;
/** Shot-origin radar ring lifetime (seconds). */
const PING_LIFE = 1.35;

/**
 * ===========================================================================
 * HUD / UI subsystem
 * ===========================================================================
 *
 * A DOM+CSS overlay (see style.js for the design system) driven entirely from
 * `lateUpdate`, after the camera has reached its final transform for the frame.
 * Nothing animates on a CSS keyframe or transition: every value is integrated
 * from `dt` here, which is what makes the capture harness deterministic and
 * lets the whole HUD freeze correctly when the game is paused.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API — `const ui = ctx.get('ui')`
 * ---------------------------------------------------------------------------
 *   ui.hitmarker(kind)                  'hit' | 'armour' | 'head' | 'kill'
 *   ui.damageNumber(worldPos, n, kind)  'hit' | 'hs' | 'armour' | 'kill'
 *   ui.hurt(amount, dirX, dirZ)         directional arc + flash + flinch
 *   ui.killfeed.push({attacker,victim,headshot,mine,attackerFriendly})
 *   ui.banner.show(title, sub, life)    kill / objective confirmation
 *   ui.setPrompt({key,text,sub,progress}) / ui.clearPrompt()
 *   ui.setObjectives([{position,label,name}])
 *   ui.setBlips([{x,z,kind:'enemy'|'friend'|'last',heading,alpha}])
 *   ui.spawnGrenade(worldPos, fuse)
 *   ui.setMatch({scoreUs,scoreThem,timeLeft,mode})
 *   ui.setHudVisible(bool)              hide everything (cinematics)
 *   ui.pause() / ui.resume() / ui.menu.toggle()
 *   ui.debugState('combat'|'menu'|'clean')
 *
 * Pause presentation is the boot shell (LoadScreen) once main wires
 * `ui.menu.useBootShell(load)` — same settings panel, Resume instead of Deploy.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUBSYSTEM READS FROM OTHERS (all optional, all duck-typed)
 * ---------------------------------------------------------------------------
 *   weapons.getHudState() -> { name, mode, ammo, reserve, magSize, reloading,
 *                              reloadProgress, ads, spread, lethalCount }
 *   player.getHudState()  -> { health, maxHealth, armour, maxArmour, regen,
 *                              move, sprint, crouch, ads, airborne, position,
 *                              dead, deathActive, killerName, respawnIn }
 *                            (or plain `player.health` / `player.position`)
 *   ai.agents             -> Agent[] (LOS + last-known minimap contacts)
 *   physics.lineOfSight   -> used to gate live enemy blips
 *   audio.playUi(id, gain) | audio.play(id) — hit ticks, heartbeat, warnings
 *
 * Events consumed: weapon:fire (also minimap shot pings), weapon:reload,
 * damage:dealt, damage:taken, actor:death, player:death, player:state,
 * explosion, resize.
 * Events emitted:  ui:pause.
 */
export class UiSystem {
  static id = 'ui';
  static deps = ['render'];

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();
    installStyles();

    const host = document.getElementById('ui') ?? document.body;
    this.root = el('div', 'ow-hud', host);

    // Stacking order: hurt overlays sit under the HUD, the menu over everything.
    this.hurtLayer = el('div', 'ow-layer', this.root);
    this.worldLayer = el('div', 'ow-layer', this.root);
    this.centreLayer = el('div', 'ow-layer', this.root);
    this.chromeLayer = el('div', 'ow-layer', this.root);

    this.health = new HealthFx(this.hurtLayer, this.chromeLayer);
    this.markers = new WorldMarkers(this.worldLayer, this.rng.fork());
    this.arcs = new DamageArcs(this.centreLayer);
    this.crosshair = new Crosshair(this.centreLayer);
    this.hit = new Hitmarkers(this.centreLayer);
    this.minimap = new Minimap(this.chromeLayer, this.rng.fork());
    this.compass = new Compass(this.chromeLayer);
    this.matchBar = new MatchBar(this.chromeLayer);
    this.killfeed = new Killfeed(this.chromeLayer);
    this.ammo = new AmmoPanel(this.chromeLayer);
    this.prompt = new Prompt(this.chromeLayer);
    this.banner = new Banner(this.chromeLayer);
    this.death = new DeathOverlay(this.root);
    this.nameplate = new Nameplate(this.centreLayer);
    this.menu = new PauseMenu(this.root, ctx);

    this.death.onRetry = () => {
      const game = this.ctx.peek('game');
      if (typeof game?.restart === 'function') game.restart();
      else location.reload();
    };
    // Full page reload returns to the title shell (boot is one-shot).
    const retreatToMenu = () => {
      location.reload();
    };
    this.death.onRetreat = retreatToMenu;
    this.menu.onRetreat = retreatToMenu;

    this.health.onBeat = (i) => this.sfx('heartbeat', 0.35 + i * 0.5);

    /** Single source of truth for everything the HUD draws. */
    this.state = {
      health: 100,
      maxHealth: 100,
      armour: 0,
      maxArmour: 150,
      regen: false,
      ammo: 30,
      reserve: 210,
      magSize: 30,
      reloading: false,
      reloadProgress: 0,
      weaponName: 'M4A1',
      fireMode: 'AUTO',
      lethalCount: 2,
      move: 0,
      sprint: false,
      crouch: false,
      ads: false,
      airborne: false,
      baseSpread: 5.5,
      scoreUs: 0,
      scoreThem: 0,
      timeLeft: 300,
      mode: 'SURVIVE',
      dead: false,
      deathActive: false,
      killerName: '',
      respawnIn: 0,
      noRespawn: true,
      endgame: false,
      won: false,
      timeSurvived: 0,
      kills: 0,
      allyKills: 0,
      alliesAlive: 0,
      /** true when no player/weapons subsystem is driving us (stub-safe demo) */
      simulate: false,
      time: 0,
    };

    this.k = 1;
    this.vw = 1920;
    this.vh = 1080;
    this.hudVisible = 1;
    this.hudTarget = 1;
    this._lastRaw = ctx.time.raw;
    this._lastKillAt = -10;
    this._regenTimer = 0;
    this._hadPointerLock = false;
    this._bakeFrame = 0;

    this._pos = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._objectives = [];
    this._compassObjs = [];
    this._blips = new Array(MAX_BLIPS);
    for (let i = 0; i < MAX_BLIPS; i++) {
      this._blips[i] = { x: 0, z: 0, kind: 'enemy', heading: 0, alpha: 1 };
    }
    this._blipCount = 0;
    this._blipView = [];
    /** @type {Map<number, {x:number,z:number,heading:number,age:number,live:boolean,kind:string}>} */
    this._contacts = new Map();
    this._pings = new Array(MAX_PINGS);
    for (let i = 0; i < MAX_PINGS; i++) this._pings[i] = { x: 0, z: 0, age: 0, life: 0 };
    this._pingCount = 0;
    this._pingView = [];
    this._eye = new THREE.Vector3();
    this._tgtEye = new THREE.Vector3();

    this.demo = null;

    this._unsubs = [];
    const on = (type, fn) => this._unsubs.push(ctx.events.on(type, fn));

    on('weapon:fire', (e) => {
      // Only the *local* weapon kicks the reticle / spends HUD ammo.
      // AI also emits weapon:fire for muzzle FX — that used to punch the
      // crosshair on every hostile burst, which felt like "my gun is firing
      // without me" and masked a dry mag as a broken trigger.
      const local = e?.local === true || e?.firstPerson === true;
      if (local) this.crosshair.onFire(e?.recoil ?? 1);
      // Any muzzle — yours or theirs — pings the minimap at the origin.
      const o = e?.origin;
      if (o && Number.isFinite(o.x) && Number.isFinite(o.z)) this._pushPing(o.x, o.z);
      if (this.state.simulate || !local) return;
      const w = this._weaponState();
      if (!w) this.state.ammo = Math.max(0, this.state.ammo - 1);
    });

    on('weapon:reload', (e) => {
      // Enemies emit reload start for VO/foley — never own the player HUD.
      if (e?.actor && e.actor !== this.ctx.peek('player') && e.local !== true) return;
      if (e?.local === false) return;
      const s = this.state;
      if (e?.phase === 'start') {
        s.reloading = true;
        s.reloadProgress = 0;
      } else if (e?.phase === 'end') {
        s.reloading = false;
        if (!this._weaponState()) {
          const take = Math.min(s.magSize - s.ammo, s.reserve);
          s.ammo += take;
          s.reserve -= take;
        }
      }
    });

    on('damage:dealt', (e) => {
      if (!e) return;
      // The payload means "damage dealt TO e.target". Enemy rounds into the
      // player must not draw a hitmarker — that arrives as `damage:taken`.
      if (this._isPlayerTarget(e.target)) return;
      // Only the *local player's* rounds credit hitmarkers / score / YOU rows.
      // AI-on-AI used to arrive with no source and looked like free kills.
      if (!this._isPlayerSource(e.source)) return;
      // Don't celebrate teamkilling a blue.
      if (e.target?.team === 0 || e.target?.friendly === true) return;
      const kind = e.killed ? 'kill' : e.headshot ? 'head' : e.armour ? 'armour' : 'hit';
      this.hitmarker(kind);
      if (e.point) {
        this.damageNumber(
          e.point,
          e.amount ?? 0,
          e.killed ? 'kill' : e.headshot ? 'hs' : e.armour ? 'armour' : 'hit'
        );
      }
      if (e.killed) {
        this._lastKillAt = ctx.time.elapsed;
        this.killfeed.push({
          attacker: 'YOU',
          victim: e.target?.name ?? e.name ?? 'ENEMY',
          headshot: !!e.headshot,
          mine: true,
        });
        this.banner.show('Enemy Eliminated', e.headshot ? '+150 XP · HEADSHOT' : '+100 XP');
        // scoreUs is owned by the survival director; bump only as fallback.
        if (!this.ctx.peek('game')) this.state.scoreUs++;
      }
    });

    on('damage:taken', (e) => {
      const amount = e?.amount ?? 10;
      if (e?.health !== undefined) this.state.health = e.health;
      else this.state.health = Math.max(0, this.state.health - amount);
      let dx = 0;
      let dz = 1;
      if (e?.from) {
        this._tmp.copy(e.from).sub(this._playerPos());
        dx = this._tmp.x;
        dz = this._tmp.z;
      }
      this.hurt(amount, dx, dz);
    });

    on('actor:death', (e) => {
      if (e?.actor?.isPlayerCorpse) return; // player body is not a combat kill
      if (ctx.time.elapsed - this._lastKillAt < 0.3) return; // already credited as YOU
      const by = e?.by;
      const attackerIsPlayer = this._isPlayerSource(by);
      if (attackerIsPlayer) return; // handled by damage:dealt kill row
      const ally = by && typeof by === 'object' && (by.team === 0 || by.friendly);
      this.killfeed.push({
        attacker: by?.name ?? (ally ? 'ALLY' : 'ENEMY'),
        victim: e?.actor?.name ?? 'OPERATOR',
        // false → red attacker / blue victim (hostile kill). Ally kill flips.
        attackerFriendly: ally ? true : false,
      });
    });

    on('player:death', (e) => {
      this.killfeed.push({
        attacker: e?.killerName ?? e?.killer?.name ?? 'ENEMY',
        victim: 'YOU',
        attackerFriendly: false,
      });
      this.sfx('player_hurt', 1);
    });

    on('explosion', (e) => {
      if (!e?.position) return;
      this._tmp.copy(e.position).sub(this._playerPos());
      const d = this._tmp.length();
      if (d < (e.radius ?? 6) * 2.5) this.crosshair.onFlinch(0.6);
    });

    on('player:state', (e) => {
      if (!e) return;
      const s = this.state;
      if (e.ads !== undefined) s.ads = !!e.ads;
      if (e.sprinting !== undefined) s.sprint = !!e.sprinting;
      if (e.stance !== undefined) s.crouch = e.stance === 'crouch' || e.stance === 'prone';
    });

    this.resize(ctx.canvas.clientWidth || innerWidth, ctx.canvas.clientHeight || innerHeight, ctx);
    this._prevPos.copy(this._playerPos());
  }

  /* ------------------------------------------------------------- helpers -- */

  _weaponState() {
    const w = this.ctx.peek('weapons');
    if (!w) return null;
    const s = typeof w.getHudState === 'function' ? w.getHudState() : w.hudState ?? null;
    return s && typeof s === 'object' ? s : null;
  }

  /** True when a `damage:dealt` payload is aimed at the local player. */
  _isPlayerTarget(t) {
    if (!t) return false;
    return t === 'player' || t === this.ctx.peek('player') || t.isPlayer === true;
  }

  /** True when the local player dealt this damage. */
  _isPlayerSource(src) {
    if (!src) return false;
    if (src === 'player' || src?.isPlayer === true) return true;
    return src === this.ctx.peek('player');
  }

  /**
   * Reticle hover: name + friend/foe colour for the actor under the crosshair.
   */
  _updateNameplate(dt, ctx, s) {
    if (!this.nameplate) return;
    if (s.deathActive || s.endgame || this.menu?.open) {
      this.nameplate.update(dt, null);
      return;
    }
    const phys = ctx.peek('physics');
    const cam = ctx.camera;
    if (!phys?.raycast || !cam) {
      this.nameplate.update(dt, null);
      return;
    }
    // Camera look ray.
    this._tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const hit = phys.raycast(cam.position, this._tmp, 48, phys.MASK?.BULLET);
    const actor = hit?.actor ?? hit?.hit?.actor ?? null;
    if (!actor || actor.isPlayerCorpse || actor.alive === false) {
      this.nameplate.update(dt, null);
      return;
    }
    // Prefer the Agent on the collider owner.
    const a = actor.userData?.agent ?? actor;
    if (!a?.name && !a?.callsign) {
      this.nameplate.update(dt, null);
      return;
    }
    const friendly = a.friendly === true || a.team === 0;
    const dist = a.position
      ? Math.hypot(
          a.position.x - cam.position.x,
          a.position.y - cam.position.y,
          a.position.z - cam.position.z
        )
      : null;
    this.nameplate.update(dt, {
      name: a.name ?? a.callsign,
      friendly,
      dist,
    });
  }

  _playerState() {
    const p = this.ctx.peek('player');
    if (!p) return null;
    const s = typeof p.getHudState === 'function' ? p.getHudState() : p.hudState ?? null;
    return s && typeof s === 'object' ? s : null;
  }

  _playerPos() {
    const p = this.ctx.peek('player');
    const pos = p?.position ?? p?.getPosition?.();
    if (pos && pos.isVector3) return this._pos.copy(pos);
    return this._pos.copy(this.ctx.camera.position);
  }

  /** Fire-and-forget audio; the audio subsystem may not exist yet. */
  sfx(id, gain = 1) {
    const a = this.ctx.peek('audio');
    if (!a) return;
    try {
      if (typeof a.playUi === 'function') a.playUi(id, gain);
      else if (typeof a.play === 'function') a.play(id, { gain });
      else if (typeof a.sfx === 'function') a.sfx(id, gain);
    } catch {
      /* audio is optional feedback — never let it break the HUD */
    }
  }

  /* ---------------------------------------------------------------- api --- */

  hitmarker(kind = 'hit') {
    this.hit.spawn(kind);
    this.crosshair.onHit();
    this.sfx(
      kind === 'kill' ? 'hit_kill' : kind === 'head' ? 'hit_head' : kind === 'armour' ? 'hit_armour' : 'hit_flesh',
      kind === 'kill' ? 1 : 0.7
    );
  }

  damageNumber(worldPos, amount, kind = 'hit') {
    this.markers.spawnDamage(worldPos, amount, kind);
  }

  /** Incoming damage: arc toward the source, screen flash, reticle flinch. */
  hurt(amount = 10, dirX = 0, dirZ = 1) {
    const i = clamp01(amount / 40);
    this.arcs.spawn(dirX, dirZ, 0.45 + i * 0.55);
    this.health.onDamage(i);
    this.crosshair.onFlinch(0.5 + i);
    this._regenTimer = 0;
    this.state.regen = false;
    this.sfx('player_hurt', 0.6 + i * 0.4);
  }

  setPrompt(p) {
    this.prompt.set(p);
  }

  clearPrompt() {
    this.prompt.clear();
  }

  setObjectives(list) {
    this._objectives = list ?? [];
  }

  addObjective(o) {
    this._objectives.push(o);
  }

  removeObjective(id) {
    const i = this._objectives.findIndex((o) => o.id === id);
    if (i >= 0) this._objectives.splice(i, 1);
  }

  /** Copies into a preallocated array — the caller's array is not retained. */
  setBlips(list) {
    const n = Math.min(list?.length ?? 0, MAX_BLIPS);
    for (let i = 0; i < n; i++) {
      const src = list[i];
      const dst = this._blips[i];
      dst.x = src.x ?? src.position?.x ?? 0;
      dst.z = src.z ?? src.position?.z ?? 0;
      dst.kind = src.kind ?? (src.friendly ? 'friend' : 'enemy');
      dst.heading = src.heading ?? 0;
      dst.alpha = src.alpha ?? 1;
    }
    this._blipCount = n;
  }

  /** Radar ring at a world XZ (shot origin, scripted pulse, etc.). */
  _pushPing(x, z, life = PING_LIFE) {
    let slot;
    if (this._pingCount < MAX_PINGS) {
      slot = this._pingCount++;
    } else {
      // Pool full — overwrite the oldest ring.
      let best = 0;
      let bestAge = -1;
      for (let i = 0; i < MAX_PINGS; i++) {
        const p = this._pings[i];
        if (p.age > bestAge) {
          bestAge = p.age;
          best = i;
        }
      }
      slot = best;
    }
    const p = this._pings[slot];
    p.x = x;
    p.z = z;
    p.age = 0;
    p.life = life;
  }

  spawnGrenade(worldPos, fuse = 2.4) {
    this.markers.spawnGrenade(worldPos, fuse);
    this.sfx('grenade_warn', 0.6);
  }

  setMatch(m) {
    Object.assign(this.state, m);
  }

  /**
   * Survival score screen. Pass null to clear (Retry / new match).
   * @param {object|null} payload
   */
  setEndgame(payload) {
    const s = this.state;
    if (!payload) {
      s.endgame = false;
      s.won = false;
      s.deathActive = false;
      s.dead = false;
      s.killerName = '';
      s.timeSurvived = 0;
      s.kills = 0;
      s.allyKills = 0;
      s.alliesAlive = 0;
      return;
    }
    s.endgame = true;
    s.won = !!payload.won;
    s.killerName = payload.killerName ?? s.killerName ?? 'ENEMY';
    s.timeSurvived = payload.timeSurvived ?? 0;
    s.kills = payload.kills ?? 0;
    s.allyKills = payload.allyKills ?? 0;
    s.alliesAlive = payload.alliesAlive ?? 0;
    s.deathActive = true;
    s.dead = true;
    s.noRespawn = true;
    // Belt-and-suspenders with game._endMatch: show a real cursor for Retry.
    this.ctx.input?.releasePointerForUi?.();
  }

  setHudVisible(v) {
    this.hudTarget = v ? 1 : 0;
  }

  pause() {
    this.menu.show();
  }

  resume() {
    this.menu.close();
  }

  /* --------------------------------------------------------------- debug -- */

  /**
   * Populate a representative state for screenshots / critics.
   * 'combat' runs the scripted firefight timeline in demo.js.
   */
  debugState(name = 'combat') {
    if (name === 'clean') {
      this.demo?.stop(this);
      this.demo = null;
      this.state.simulate = false;
      this.killfeed.clear();
      this.arcs.clear();
      this.hit.clear();
      this.markers.clear();
      this.clearPrompt();
      return { state: 'clean' };
    }
    if (name === 'menu') {
      this.debugState('combat');
      this.menu.show();
      return { state: 'menu' };
    }
    if (!this.demo) this.demo = new CombatDemo();
    this.demo.start(this);
    return { state: 'combat', frames: 'timeline keyed to frame 90' };
  }

  /* -------------------------------------------------------------- frame --- */

  lateUpdate(dt, ctx) {
    const t = ctx.time;
    const rawDt = clamp(t.raw - this._lastRaw, 0, 0.1);
    this._lastRaw = t.raw;
    const s = this.state;
    s.time = t.elapsed;

    // ---- pause -----------------------------------------------------------
    if (ctx.input.enabled && !ctx.input.frozen) {
      if (ctx.input.actionPressed('pause') && !s.endgame) this.menu.toggle();
      // Losing pointer lock mid-match is the same intent as pressing Escape.
      // Score screen intentionally releases lock for Retry — don't treat that
      // as "pause".
      if (s.endgame) {
        this._hadPointerLock = false;
      } else if (ctx.input.pointerLocked) {
        this._hadPointerLock = true;
      } else if (this._hadPointerLock && !this.menu.open) {
        this._hadPointerLock = false;
        this.menu.show();
      }
    }
    this.menu.update(rawDt);

    // ---- external state --------------------------------------------------
    // `simulate` means a scripted debug timeline owns the HUD numbers; letting
    // the live weapon/player state through would fight it every frame.
    const ws = s.simulate ? null : this._weaponState();
    if (ws) {
      if (ws.name) s.weaponName = ws.name;
      if (ws.mode) s.fireMode = ws.mode;
      if (ws.ammo !== undefined) s.ammo = ws.ammo;
      if (ws.reserve !== undefined) s.reserve = ws.reserve;
      if (ws.magSize !== undefined) s.magSize = ws.magSize;
      if (ws.reloading !== undefined) s.reloading = !!ws.reloading;
      if (ws.reloadProgress !== undefined) s.reloadProgress = ws.reloadProgress;
      if (ws.ads !== undefined) s.ads = !!ws.ads;
      if (ws.spread !== undefined) s.baseSpread = 4 + ws.spread * 40;
      if (ws.lethalCount !== undefined) s.lethalCount = ws.lethalCount;
    }

    const ps = s.simulate ? null : this._playerState();
    const player = ctx.peek('player');
    if (ps) {
      if (ps.health !== undefined) s.health = ps.health;
      if (ps.maxHealth !== undefined) s.maxHealth = ps.maxHealth;
      if (ps.armour !== undefined) s.armour = ps.armour;
      else if (ps.armor !== undefined) s.armour = ps.armor;
      if (ps.regen !== undefined) s.regen = !!ps.regen;
      if (ps.move !== undefined) s.move = ps.move;
      if (ps.sprint !== undefined) s.sprint = !!ps.sprint;
      if (ps.crouch !== undefined) s.crouch = !!ps.crouch;
      if (ps.ads !== undefined) s.ads = !!ps.ads;
      if (ps.airborne !== undefined) s.airborne = !!ps.airborne;
      s.dead = !!ps.dead;
      s.deathActive = !!ps.deathActive;
      s.killerName = ps.killerName ?? '';
      s.respawnIn = ps.respawnIn ?? 0;
    } else if (player && typeof player.health === 'number') {
      s.health = player.health;
    } else {
      s.deathActive = false;
      s.killerName = '';
      s.respawnIn = 0;
    }

    // ---- movement-derived reticle bloom (works with any player system) ----
    const pos = this._playerPos();
    if (!ps && !s.simulate) {
      this._dir.copy(pos).sub(this._prevPos);
      this._dir.y = 0;
      const speed = dt > 0 ? this._dir.length() / dt : 0;
      s.move = damp(s.move, clamp01(speed / 6.2), 12, Math.max(rawDt, 1e-3));
      if (!this._weaponState()) s.ads = ctx.input.ads && ctx.input.enabled;
    }
    this._prevPos.copy(pos);

    // ---- health regeneration when nobody else owns health ----------------
    if (!ps && !s.simulate && s.health < s.maxHealth) {
      this._regenTimer += dt;
      if (this._regenTimer > 4.5) {
        if (!s.regen) {
          s.regen = true;
          this.health.onRegenStart();
          this.sfx('regen', 0.4);
        }
        s.health = Math.min(s.maxHealth, s.health + dt * 24);
      }
    }

    // ---- demo timeline ---------------------------------------------------
    if (this.demo?.active) this.demo.update(this, dt);

    // ---- camera basis ----------------------------------------------------
    const m = ctx.camera.matrixWorld.elements;
    let rx = m[0];
    let rz = m[2];
    let fx = -m[8];
    let fz = -m[10];
    const rl = Math.hypot(rx, rz) || 1;
    const fl = Math.hypot(fx, fz) || 1;
    rx /= rl;
    rz /= rl;
    fx /= fl;
    fz /= fl;
    const heading = (Math.atan2(fx, -fz) * 180) / Math.PI;

    // ---- ai blips + shot pings (needs camera forward / eye) --------------
    this._collectBlips(dt, pos, fx, fz, ctx.camera);

    // ---- widgets ---------------------------------------------------------
    const deadHud = s.deathActive ? 0.12 : 1;
    const hudGoal = this.hudTarget * (this.menu.open ? 0.15 : 1) * deadHud;
    this.hudVisible = damp(this.hudVisible, hudGoal, 10, rawDt);
    // One toFixed per frame for all three layers (was three string allocs).
    const hudOp =
      this.hudVisible < 0.001 ? '0' : this.hudVisible > 0.999 ? '1' : this.hudVisible.toFixed(3);
    setStyle(this.chromeLayer, 'opacity', hudOp);
    setStyle(this.worldLayer, 'opacity', hudOp);
    setStyle(this.centreLayer, 'opacity', hudOp);

    this.crosshair.update(dt, s);
    this.hit.update(dt);
    this.arcs.update(dt, rx, rz, fx, fz);
    this.health.update(dt, s);
    this.ammo.update(dt, s);
    this.killfeed.update(dt);
    this.matchBar.update(s);
    this.prompt.update(dt);
    this.banner.update(dt);
    this.death.update(rawDt, s);
    this._updateNameplate(dt, ctx, s);

    this._buildCompassObjectives(pos);
    this.compass.update(heading, this._compassObjs);

    this.markers.updateObjectives(this._objectives, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateGrenades(dt, ctx.camera, this.vw, this.vh, this.k);
    this.markers.updateDamage(dt, ctx.camera, this.vw, this.vh, this.k);

    // ---- minimap ---------------------------------------------------------
    if (!this.minimap.bakeDone && ++this._bakeFrame > 6 && this._bakeFrame % 20 === 0) {
      this.minimap.tryBake(ctx);
    }
    this._blipView.length = this._blipCount;
    for (let i = 0; i < this._blipCount; i++) this._blipView[i] = this._blips[i];
    this._pingView.length = 0;
    for (let i = 0; i < this._pingCount; i++) {
      const p = this._pings[i];
      if (p.life > 0) this._pingView.push(p);
    }
    this._mmState = this._mmState ?? {
      x: 0,
      z: 0,
      heading: 0,
      fov: 80,
      blips: null,
      pings: null,
      objectives: null,
    };
    this._mmState.x = pos.x;
    this._mmState.z = pos.z;
    this._mmState.heading = heading;
    this._mmState.fov = ctx.camera.fov;
    this._mmState.blips = this._blipView;
    this._mmState.pings = this._pingView;
    this._mmState.objectives = this._mmObjs ?? (this._mmObjs = []);
    this._mmObjs.length = 0;
    for (const o of this._objectives) {
      if (!o.position) continue;
      this._mmObjs.push(o._mm ?? (o._mm = { x: 0, z: 0, label: o.label }));
      const last = this._mmObjs[this._mmObjs.length - 1];
      last.x = o.position.x;
      last.z = o.position.z;
      last.label = o.label;
    }
    this.minimap.draw(this._mmState);
  }

  /**
   * Live contacts: enemies (and friendlies) the player has clear LOS to.
   * Lost LOS freezes the pip at the last known XZ and fades it out.
   * Shot pings age here so the minimap can draw expanding rings.
   */
  _collectBlips(dt, playerPos, fx, fz, camera) {
    // ---- age / compact shot pings ----------------------------------------
    let write = 0;
    for (let i = 0; i < this._pingCount; i++) {
      const p = this._pings[i];
      p.age += dt;
      if (p.age < p.life) {
        if (write !== i) {
          const d = this._pings[write];
          d.x = p.x;
          d.z = p.z;
          d.age = p.age;
          d.life = p.life;
        }
        write++;
      }
    }
    this._pingCount = write;

    if (this.demo?.active) return; // demo drives its own contacts

    const ai = this.ctx.peek('ai');
    const agents = ai?.agents;
    const phys = this.ctx.peek('physics');
    const contacts = this._contacts;

    // Mark every stored contact as not refreshed this frame.
    for (const c of contacts.values()) c.live = false;

    if (Array.isArray(agents) && agents.length) {
      const eye = this._eye;
      if (camera?.position) eye.copy(camera.position);
      else eye.set(playerPos.x, (playerPos.y ?? 0) + 1.6, playerPos.z);

      // Slightly wider than the optical half-FOV so edge-of-screen contacts count.
      const halfFov = (((camera?.fov ?? 80) * 0.55) * Math.PI) / 180;
      const cosHalf = Math.cos(halfFov);
      const range = CONTACT_RANGE;
      const rangeSq = range * range;
      const mask = phys?.MASK?.SIGHT;

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a || a.isPlayerCorpse) continue;
        if (a.alive === false) {
          // Dead: leave any existing last-known to fade, don't refresh.
          continue;
        }

        const p = a.position;
        if (!p) continue;
        const friendly = a.friendly === true || a.team === 0;
        // Map heading matches the player arrow: atan2(fwdX, -fwdZ) so 0° = north (-Z).
        // Agent yaw is different — body forward is (sin yaw, cos yaw), i.e. 0 = +Z.
        let heading = 0;
        if (a.heading != null && Number.isFinite(a.heading)) {
          heading = a.heading;
        } else if (a.yaw !== undefined) {
          const fx = Math.sin(a.yaw);
          const fz = Math.cos(a.yaw);
          heading = (Math.atan2(fx, -fz) * 180) / Math.PI;
        }

        // Friendlies always plot; enemies need range + facing + clear LOS.
        let spotted = friendly;
        if (!friendly) {
          const dx = p.x - eye.x;
          const dz = p.z - eye.z;
          const distSq = dx * dx + dz * dz;
          if (distSq > rangeSq) continue;

          const dist = Math.sqrt(distSq) || 1e-4;
          const inv = 1 / dist;
          // Horizontal facing into the camera look cone.
          const facing = fx * dx * inv + fz * dz * inv;
          if (facing < cosHalf) {
            // Still age an existing contact if we had one.
            continue;
          }

          // Chest/eye probe — standing eye height if the agent has no eye getter.
          if (a.eye && Number.isFinite(a.eye.x)) this._tgtEye.copy(a.eye);
          else this._tgtEye.set(p.x, p.y + (a.eyeHeight ?? 1.6), p.z);

          const clear = phys?.lineOfSight
            ? phys.lineOfSight(eye, this._tgtEye, mask)
            : true;
          spotted = clear;
        }

        if (!spotted) continue;

        let c = contacts.get(a.id);
        if (!c) {
          c = { x: 0, z: 0, heading: 0, age: 0, live: true, kind: 'enemy' };
          contacts.set(a.id, c);
        }
        c.x = p.x;
        c.z = p.z;
        c.heading = heading;
        c.age = 0;
        c.live = true;
        c.kind = friendly ? 'friend' : 'enemy';
      }
    }

    // Age lost contacts; drop fully faded ones.
    for (const [id, c] of contacts) {
      if (!c.live) c.age += dt;
      if (c.age >= CONTACT_FADE) contacts.delete(id);
    }

    // Flatten into the blip pool for the minimap.
    let n = 0;
    for (const c of contacts.values()) {
      if (n >= MAX_BLIPS) break;
      const b = this._blips[n++];
      b.x = c.x;
      b.z = c.z;
      b.heading = c.heading;
      if (c.live) {
        b.kind = c.kind;
        b.alpha = 1;
      } else {
        // Fading last-known pip — no chevron heading.
        b.kind = 'last';
        b.alpha = clamp01(1 - c.age / CONTACT_FADE);
        b.heading = 0;
      }
    }
    this._blipCount = n;
  }

  _buildCompassObjectives(pos) {
    const out = this._compassObjs;
    out.length = 0;
    for (const o of this._objectives) {
      if (!o.position) continue;
      const dx = o.position.x - pos.x;
      const dz = o.position.z - pos.z;
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      out.push(o._cmp ?? (o._cmp = { bearing: 0, label: o.label, color: o.color }));
      const last = out[out.length - 1];
      last.bearing = bearing;
      last.label = o.label;
      last.color = o.color;
    }
    return out;
  }

  resize(w, h, ctx) {
    this.vw = w;
    this.vh = h;
    this.k = clamp(h / 1080, 0.62, 2.4);
    this.root.style.setProperty('--k', this.k.toFixed(4));
    this.crosshair.setScale(this.k);
    this.compass.setScale(this.k);
    this.minimap.resize(this.k);
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
    this.crosshair.dispose();
    this.hit.dispose();
    this.arcs.dispose();
    this.health.dispose();
    this.ammo.dispose();
    this.killfeed.dispose();
    this.compass.dispose();
    this.matchBar.dispose();
    this.minimap.dispose();
    this.markers.dispose();
    this.prompt.dispose();
    this.banner.dispose();
    this.death.dispose();
    this.nameplate?.dispose?.();
    this.menu.dispose();
    this.root.remove();
    removeStyles();
  }
}
