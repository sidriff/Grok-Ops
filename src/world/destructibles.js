import * as THREE from 'three';

/**
 * WORLD — prop destruction.
 *
 * Instanced set dressing is frozen at bake time. This module re-opens the
 * flimsy ones (crates, cardboard, bottles, planks) and the pressurised ones
 * (fuel barrels, gas bottles, jerry cans) so a bullet or a blast can take
 * them out:
 *
 *   break   — scale the instance to zero + a surface-appropriate particle poof
 *   explode — same, then fire the shared `explosion` event (chains to neighbours)
 *
 * Collision is per-instance (a cheap box proxy registered with physics) so a
 * destroyed prop stops blocking the capsule and stops eating bullets. Ghost
 * boxes from older merged `A.box()` calls may still linger under stacked
 * set-pieces; individual scatter props are clean.
 */

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _zero = new THREE.Vector3(0, 0, 0);
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

/** Shared unit box — each collider just reuses it with a different matrix. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * @param {object} opts
 * @param {import('./index.js').WorldSystem} opts.world
 * @param {*} opts.physics
 * @param {*} opts.events
 * @param {() => *} opts.getFx  lazy fx lookup (fx inits after world)
 */
export class Destructibles {
  constructor({ world, physics, events, getFx }) {
    this.world = world;
    this.physics = physics;
    this.events = events;
    this.getFx = getFx;
    this.items = [];
    this._off = [];
    this._root = null;
    this._grid = new Map();
    this._cell = 2.5;
  }

  /**
   * Scan finalized world meshes for InstancedMeshes tagged with a destruction
   * recipe and register each instance.
   */
  build(meshes) {
    if (!this.physics) return;
    this._root = new THREE.Group();
    this._root.name = 'destructible_collision';
    this._root.visible = false;
    this.world.root.add(this._root);

    for (const mesh of meshes) {
      if (!mesh?.isInstancedMesh) continue;
      const recipe = mesh.userData?.destructible;
      if (!recipe) continue;
      const n = mesh.count;
      for (let i = 0; i < n; i++) {
        mesh.getMatrixAt(i, _m);
        _m.decompose(_p, _q, _s);
        // Skip degenerate / already-culled instances.
        if (_s.x * _s.y * _s.z < 1e-6) continue;
        const scale = Math.max(_s.x, _s.y, _s.z);
        const hx = recipe.hx * scale;
        const hy = recipe.hy * scale;
        const hz = recipe.hz * scale;
        const oy = recipe.oy * scale;
        const cx = _p.x;
        const cy = _p.y + oy;
        const cz = _p.z;
        // Hit radius: a little fat so glancing shots still count.
        const r = Math.max(hx, hy, hz) + 0.12;

        const col = new THREE.Mesh(UNIT_BOX, INVISIBLE);
        col.name = `destruct_${mesh.userData.protoId ?? 'prop'}_${i}`;
        col.position.set(cx, cy, cz);
        col.scale.set(hx * 2, hy * 2, hz * 2);
        col.updateMatrix();
        col.matrixAutoUpdate = false;
        col.userData.surface = recipe.surface;
        this._root.add(col);
        const handle = this.physics.addStatic(col, recipe.surface);

        const item = {
          mesh,
          index: i,
          x: cx,
          y: cy,
          z: cz,
          r,
          r2: r * r,
          hp: recipe.hp,
          maxHp: recipe.hp,
          kind: recipe.kind,
          surface: recipe.surface,
          boomR: recipe.radius ?? 5,
          boomDmg: recipe.damage ?? 140,
          handle,
          alive: true,
        };
        this.items.push(item);
        this._insert(item);
      }
    }

    // BVH rebuild is deferred to the next physics fixedUpdate (dirty flag).
    this._off.push(
      this.events.on('bullet:impact', (e) => this._onImpact(e)),
      this.events.on('explosion', (e) => this._onExplosion(e))
    );

    console.info(`[world] destructibles: ${this.items.length} props armed`);
  }

  _cellKey(x, z) {
    const c = this._cell;
    return ((Math.floor(x / c) * 73856093) ^ (Math.floor(z / c) * 19349663)) | 0;
  }

  _insert(item) {
    const k = this._cellKey(item.x, item.z);
    let bucket = this._grid.get(k);
    if (!bucket) this._grid.set(k, (bucket = []));
    bucket.push(item);
  }

  /** Collect alive items near a world point into `out`. */
  _query(x, y, z, radius, out) {
    out.length = 0;
    const c = this._cell;
    const r = radius;
    // Expand grid walk by one cell so large props straddling cell edges still hit.
    const pad = 1.2;
    const x0 = Math.floor((x - r - pad) / c);
    const x1 = Math.floor((x + r + pad) / c);
    const z0 = Math.floor((z - r - pad) / c);
    const z1 = Math.floor((z + r + pad) / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const bucket = this._grid.get(((ix * 73856093) ^ (iz * 19349663)) | 0);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const it = bucket[i];
          if (!it.alive) continue;
          const dx = it.x - x;
          const dy = it.y - y;
          const dz = it.z - z;
          const maxR = r + it.r;
          if (dx * dx + dy * dy + dz * dz <= maxR * maxR) out.push(it);
        }
      }
    }
    return out;
  }

  _scratch = [];

  _onImpact(e) {
    if (!e?.point || e.exit === true) return;
    // Only entry hits — exits would double-tap thin props.
    const p = e.point;
    const dmg = Math.max(1, e.damage ?? 25);
    this._query(p.x, p.y, p.z, 0.55, this._scratch);
    for (let i = 0; i < this._scratch.length; i++) {
      const it = this._scratch[i];
      const dx = it.x - p.x;
      const dy = it.y - p.y;
      const dz = it.z - p.z;
      if (dx * dx + dy * dy + dz * dz > it.r2) continue;
      this._damage(it, dmg, p);
      // One prop per bullet is enough — stops a single round vaporising a pile.
      break;
    }
  }

  _onExplosion(e) {
    if (!e?.position) return;
    // Skip the synthetic blast we just emitted for this prop (chain uses the
    // real explosion event; self is already dead so it would no-op anyway).
    const p = e.position;
    const R = Math.max(0.5, e.radius ?? 5);
    const base = e.damage ?? 120;
    this._query(p.x, p.y, p.z, R + 0.4, this._scratch);
    for (let i = 0; i < this._scratch.length; i++) {
      const it = this._scratch[i];
      const dx = it.x - p.x;
      const dy = it.y - p.y;
      const dz = it.z - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > R + it.r * 0.5) continue;
      // Falloff matches AI/player grenade feel: full at centre, nothing at edge.
      const t = 1 - dist / (R + 0.001);
      const dmg = base * t * t;
      if (dmg < 8) continue;
      this._damage(it, dmg, p);
    }
  }

  _damage(it, amount, hitPoint) {
    if (!it.alive) return;
    it.hp -= amount;
    if (it.hp > 0) return;
    this._destroy(it, hitPoint);
  }

  _destroy(it, hitPoint) {
    if (!it.alive) return;
    it.alive = false;

    // Hide the instance (zero scale keeps the slot; no re-pack of the buffer).
    it.mesh.getMatrixAt(it.index, _m);
    _m.decompose(_p, _q, _s);
    _m.compose(_p, _q, _zero);
    it.mesh.setMatrixAt(it.index, _m);
    it.mesh.instanceMatrix.needsUpdate = true;

    // Drop collision so the player can walk through the wreck.
    if (it.handle >= 0) this.physics.removeStatic(it.handle);
    it.handle = -1;

    const px = hitPoint?.x ?? it.x;
    const py = hitPoint?.y ?? it.y;
    const pz = hitPoint?.z ?? it.z;

    if (it.kind === 'explode') {
      this.events.emit('explosion', {
        position: { x: it.x, y: it.y, z: it.z },
        radius: it.boomR,
        damage: it.boomDmg,
        source: 'destructible',
      });
    } else {
      const fx = this.getFx?.();
      fx?.propBreak?.({
        x: px,
        y: py,
        z: pz,
        surface: it.surface,
        scale: Math.max(0.4, it.r),
      });
    }
  }

  dispose() {
    for (const off of this._off) off?.();
    this._off.length = 0;
    if (this.physics) {
      for (const it of this.items) {
        if (it.alive && it.handle >= 0) this.physics.removeStatic(it.handle);
      }
    }
    this.items.length = 0;
    this._grid.clear();
    this._root?.parent?.remove(this._root);
    this._root = null;
  }
}
