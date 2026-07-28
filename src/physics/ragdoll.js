/**
 * Ragdolls — an articulated chain of capsules solved with position-based
 * dynamics (Gauss-Seidel, a handful of iterations per fixed step).
 *
 * Why PBD rather than an impulse-based articulation: with 15 bones, unilateral
 * world contacts and 120 Hz steps, a projected-Gauss-Seidel position solver is
 * unconditionally stable — bones cannot gain energy, so bodies *settle* instead
 * of buzzing or exploding, which is the entire brief. Each bone is a segment of
 * two particles; joints are shared particles, so joint separation is impossible
 * by construction and only the *angular* limits need constraints.
 *
 * Constraints, applied in order every iteration:
 *   1. bone length      (hard distance, stiffness 1)
 *   2. cone limit       (swing of a bone relative to its parent)
 *   3. twist limit      (roll of a bone's reference frame, damped)
 *   4. world contact    (capsule vs static BVH + Coulomb friction)
 *
 * Muscle tone (post-death phases) scales per-bone angular stiffness and cone
 * width so the first quarter-second keeps a hit-reaction pose, then fades to
 * limp — pure limp-from-frame-zero reads as wet spaghetti.
 *
 * `ai` hands over a dead actor with createRagdoll()/adoptSkeleton() and we own
 * the bone transforms from that moment on.
 */

import * as THREE from 'three';
import { MASK, SURFACE_PROPS } from './surfaces.js';
import { closestPtSegSeg, makeClosest } from './math.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Default humanoid rig                                                */
/* ------------------------------------------------------------------ */

/**
 * A 15-capsule humanoid sized from a total height, in the actor's local frame
 * (feet at y = 0, +Z forward). Proportions are the standard 7.5-head figure.
 */
export function humanoidSpec(height = 1.8, scaleMass = 82) {
  const h = height;
  const M = scaleMass;
  const y = (f) => h * f;
  const b = (name, hx, hy, hz, tx, ty, tz, r, m, parent, cone, twist) => ({
    name,
    head: [hx, hy, hz],
    tail: [tx, ty, tz],
    radius: r * h,
    mass: m * M,
    parent,
    cone: cone * DEG,
    twist: twist * DEG,
  });
  const sh = h * 0.105; // half shoulder width
  const hip = h * 0.055;
  return [
    /* 0 */ b('pelvis', 0, y(0.53), 0, 0, y(0.63), 0, 0.085, 0.14, -1, 0, 0),
    /* 1 */ b('spine', 0, y(0.63), 0, 0, y(0.74), 0, 0.082, 0.12, 0, 22, 18),
    /* 2 */ b('chest', 0, y(0.74), 0, 0, y(0.83), 0, 0.088, 0.19, 1, 20, 15),
    /* 3 */ b('neck', 0, y(0.83), 0, 0, y(0.875), 0, 0.042, 0.02, 2, 30, 25),
    /* 4 */ b('head', 0, y(0.875), 0, 0, y(0.97), 0.01, 0.062, 0.07, 3, 42, 30),
    /* 5 */ b('upperArmL', -sh, y(0.815), 0, -sh - h * 0.015, y(0.65), 0, 0.045, 0.027, 2, 85, 60),
    /* 6 */ b('forearmL', -sh - h * 0.015, y(0.65), 0, -sh - h * 0.02, y(0.50), 0, 0.037, 0.018, 5, 80, 45),
    /* 7 */ b('handL', -sh - h * 0.02, y(0.50), 0, -sh - h * 0.02, y(0.44), 0, 0.032, 0.006, 6, 55, 40),
    /* 8 */ b('upperArmR', sh, y(0.815), 0, sh + h * 0.015, y(0.65), 0, 0.045, 0.027, 2, 85, 60),
    /* 9 */ b('forearmR', sh + h * 0.015, y(0.65), 0, sh + h * 0.02, y(0.50), 0, 0.037, 0.018, 8, 80, 45),
    /*10 */ b('handR', sh + h * 0.02, y(0.50), 0, sh + h * 0.02, y(0.44), 0, 0.032, 0.006, 9, 55, 40),
    /*11 */ b('thighL', -hip, y(0.53), 0, -hip * 1.05, y(0.29), 0, 0.062, 0.10, 0, 75, 35),
    /*12 */ b('shinL', -hip * 1.05, y(0.29), 0, -hip * 1.05, y(0.055), 0, 0.048, 0.045, 11, 70, 20),
    /*13 */ b('thighR', hip, y(0.53), 0, hip * 1.05, y(0.29), 0, 0.062, 0.10, 0, 75, 35),
    /*14 */ b('shinR', hip * 1.05, y(0.29), 0, hip * 1.05, y(0.055), 0, 0.048, 0.045, 13, 70, 20),
  ];
}

/* ------------------------------------------------------------------ */

/** Max particle displacement per fixed step (~10 m/s). Lower = less thrash. */
const MAX_PARTICLE_STEP = 0.085;
/**
 * Sleep is in metres-per-step (not m/s). Measured *after* constraints — pre-solve
 * velocity ignores hinge/contact fighting that used to rock corpses forever.
 * At 120 Hz, 0.005 ≈ 0.6 m/s RMS; 0.22 s of that → freeze.
 */
const SLEEP_MOTION = 0.005;
const SLEEP_TIME = 0.22;
/**
 * Safety net: if still only crawling after this age, freeze. Threshold is tight
 * so a mid-flop body is not frozen upright (that failed the collapse selftest).
 */
const FORCE_SLEEP_AGE = 2.4;
const FORCE_SLEEP_MOTION = 0.007;
/**
 * Floor mass used when applying impulses so hands/fingers never take the full
 * kick (invMass of a 0.5 kg hand would launch them through the ceiling).
 */
const IMPULSE_MASS_FLOOR = 3.5;
/** Max Verlet previous-pos kick from one impulse (m) ≈ 6 m/s at 120 Hz. */
const MAX_IMPULSE_KICK = 0.05;

/**
 * Muscle tone timeline (seconds after death):
 *   [0, TONE_HIT)     hit reaction — stiffer angular projection
 *   [TONE_HIT, TONE_LIMP) collapse — fade stiff + open cones
 *   [TONE_LIMP, ∞)    limp (authored stiff, full cones)
 *
 * Cones only *widen* after the hit window (never stay tighter long-term). A
 * standing rest pose with permanently tight cones freezes upright; anti-noodle
 * is mostly clamped shoulder/hip stubs + higher base stiff on limbs.
 */
const TONE_HIT = 0.18;
const TONE_LIMP = 0.5;
const TONE_STIFF_HIT = 1.15;
const TONE_STIFF_LIMP = 1.0;
const TONE_CONE_HIT = 0.9;
const TONE_CONE_LIMP = 1.0;

let _nextRagdollId = 1;

export class Ragdoll {
  /**
   * @param {StaticWorld} world
   * @param {object} opts
   *   bones      bone spec array (see humanoidSpec)
   *   transform  THREE.Matrix4 placing the spec into world space
   *   gravity    m/s^2 (negative)
   *   iterations Gauss-Seidel iterations per fixed step
   *   damping    per-step linear velocity retain (lower = heavier / stickier)
   *   massScale  multiplies every bone mass (heavier body, softer hits)
   */
  constructor(world, opts = {}) {
    this.id = _nextRagdollId++;
    this.world = world;
    this.gravity = opts.gravity ?? -20.6;
    this.iterations = opts.iterations ?? 8;
    this.mask = opts.mask ?? MASK.DEBRIS;
    // 0.965^120 ≈ 1.4% velocity left after 1 s — bodies settle instead of thrash.
    this.linearDamping = opts.damping ?? 0.965;
    this.friction = opts.friction ?? 0.9;
    this.userData = opts.userData ?? null;
    this.actor = opts.actor ?? null;
    this.alive = true;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.age = 0;
    const massScale = opts.massScale ?? 1.35;

    const spec = opts.bones ?? humanoidSpec(opts.height ?? 1.8, opts.mass ?? 82);
    this.spec = spec;
    const nb = spec.length;
    this.boneCount = nb;

    // --- particle set with shared joints ---
    // Endpoints that land on the same millimetre weld into one particle. That
    // weld is the only thing holding limbs on the torso — without it cone
    // limits only *aim* free chains and the mesh turns to mush.
    const px = [], py = [], pz = [], pm = [];
    const key = (x, y, z) =>
      `${(x * 1000 + (x >= 0 ? 0.5 : -0.5)) | 0},` +
      `${(y * 1000 + (y >= 0 ? 0.5 : -0.5)) | 0},` +
      `${(z * 1000 + (z >= 0 ? 0.5 : -0.5)) | 0}`;
    const map = new Map();
    const mat = opts.transform ?? null;
    const _v = new THREE.Vector3();
    const addPoint = (arr) => {
      _v.set(arr[0], arr[1], arr[2]);
      if (mat) _v.applyMatrix4(mat);
      const k = key(_v.x, _v.y, _v.z);
      let i = map.get(k);
      if (i === undefined) {
        i = px.length;
        // Snap stored position to the key grid so later near-hits weld cleanly.
        const gx = (( _v.x * 1000 + (_v.x >= 0 ? 0.5 : -0.5)) | 0) / 1000;
        const gy = (( _v.y * 1000 + (_v.y >= 0 ? 0.5 : -0.5)) | 0) / 1000;
        const gz = (( _v.z * 1000 + (_v.z >= 0 ? 0.5 : -0.5)) | 0) / 1000;
        px.push(gx); py.push(gy); pz.push(gz); pm.push(0);
        map.set(k, i);
      }
      return i;
    };

    this.boneHead = new Int32Array(nb);
    this.boneTail = new Int32Array(nb);
    this.boneLen = new Float32Array(nb);
    this.boneRadius = new Float32Array(nb);
    this.boneMass = new Float32Array(nb);
    this.boneParent = new Int32Array(nb);
    this.boneCone = new Float32Array(nb);
    this.boneTwist = new Float32Array(nb);
    /** 0 = ball cone from rest, 1 = hinge (knee/elbow). */
    this.boneHinge = new Uint8Array(nb);
    this.boneHingeMin = new Float32Array(nb);
    this.boneHingeMax = new Float32Array(nb);
    /** Child direction in parent bone frame at death pose (rest). */
    this.boneRestLocal = new Float32Array(nb * 3);
    /** Hinge axis in parent bone frame at rest. */
    this.boneHingeLocal = new Float32Array(nb * 3);
    /** Per-bone angular correction stiffness (live; scaled by muscle tone). */
    this.boneStiff = new Float32Array(nb);
    /** Authored stiff / cone before tone scaling. */
    this.boneStiffBase = new Float32Array(nb);
    this.boneConeBase = new Float32Array(nb);
    /** Reference up-vector per bone, parallel-transported for twist. */
    this.boneUp = new Float32Array(nb * 3);

    for (let i = 0; i < nb; i++) {
      const s = spec[i];
      const a = addPoint(s.head);
      const c = addPoint(s.tail);
      this.boneHead[i] = a;
      this.boneTail[i] = c;
      this.boneRadius[i] = s.radius ?? 0.06;
      // Floor extremity mass so light hands don't dominate the thrash budget.
      this.boneMass[i] = Math.max(0.8, (s.mass ?? 4) * massScale);
      this.boneParent[i] = s.parent ?? -1;
      const cone0 = s.cone ?? 70 * DEG;
      this.boneConeBase[i] = cone0;
      this.boneCone[i] = cone0;
      this.boneTwist[i] = s.twist ?? 40 * DEG;
      this.boneHinge[i] = s.hinge ? 1 : 0;
      this.boneHingeMin[i] = s.hingeMin ?? -8 * DEG;
      this.boneHingeMax[i] = s.hingeMax ?? 145 * DEG;
      const stiff0 = s.stiff ?? (s.hinge ? 0.88 : 0.55);
      this.boneStiffBase[i] = stiff0;
      this.boneStiff[i] = stiff0;
      pm[a] += this.boneMass[i] * 0.5;
      pm[c] += this.boneMass[i] * 0.5;
      this.boneUp[i * 3] = 0;
      this.boneUp[i * 3 + 1] = 0;
      this.boneUp[i * 3 + 2] = 1;
    }

    const np = px.length;
    this.particleCount = np;
    this.px = new Float64Array(px);
    this.py = new Float64Array(py);
    this.pz = new Float64Array(pz);
    this.qx = Float64Array.from(px);
    this.qy = Float64Array.from(py);
    this.qz = Float64Array.from(pz);
    this.invMass = new Float64Array(np);
    for (let i = 0; i < np; i++) this.invMass[i] = pm[i] > 0 ? 1 / pm[i] : 0;

    for (let i = 0; i < nb; i++) {
      const a = this.boneHead[i], c = this.boneTail[i];
      this.boneLen[i] = Math.hypot(this.px[c] - this.px[a], this.py[c] - this.py[a], this.pz[c] - this.pz[a]);
      if (this.boneLen[i] < 1e-4) this.boneLen[i] = 1e-4;
      this._initUp(i);
    }
    this._initRestFrames();

    // skeleton binding (filled by adoptSkeleton)
    this.bones3D = null;
    this.boneBind = null;
    this.rootObject = null;
    this._m4 = new THREE.Matrix4();
    this._m4b = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v3 = new THREE.Vector3();
    this._v3b = new THREE.Vector3();
    this._scale = new THREE.Vector3(1, 1, 1);

    this.aabb = { minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0 };
    this._updateAabb();

    this._ss = makeClosest();
    this.selfPairs = this._buildSelfPairs();
  }

  /**
   * Bone pairs worth testing against each other. Bones that share a joint are
   * excluded (they always touch), and so is any pair that already overlaps in
   * the bind pose — pelvis/thigh, chest/upper-arm — otherwise the solver would
   * spend every step fighting the rig itself and the doll would inflate.
   */
  _buildSelfPairs() {
    const pairs = [];
    for (let i = 0; i < this.boneCount; i++) {
      for (let j = i + 1; j < this.boneCount; j++) {
        const ai = this.boneHead[i], bi = this.boneTail[i];
        const aj = this.boneHead[j], bj = this.boneTail[j];
        if (ai === aj || ai === bj || bi === aj || bi === bj) continue;
        const rad = this.boneRadius[i] + this.boneRadius[j];
        closestPtSegSeg(
          this.px[ai], this.py[ai], this.pz[ai], this.px[bi], this.py[bi], this.pz[bi],
          this.px[aj], this.py[aj], this.pz[aj], this.px[bj], this.py[bj], this.pz[bj],
          this._ss ?? (this._ss = makeClosest())
        );
        if (this._ss.d2 < rad * rad * 0.95) continue;
        pairs.push(i, j);
      }
    }
    return Int32Array.from(pairs);
  }

  _initUp(i) {
    const a = this.boneHead[i], c = this.boneTail[i];
    let dx = this.px[c] - this.px[a], dy = this.py[c] - this.py[a], dz = this.pz[c] - this.pz[a];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    // pick any axis not parallel to the bone
    let ux = 0, uy = 0, uz = 1;
    if (Math.abs(dz) > 0.9) { ux = 1; uy = 0; uz = 0; }
    const d = ux * dx + uy * dy + uz * dz;
    ux -= dx * d; uy -= dy * d; uz -= dz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    this.boneUp[i * 3] = ux / ul;
    this.boneUp[i * 3 + 1] = uy / ul;
    this.boneUp[i * 3 + 2] = uz / ul;
  }

  /**
   * Store each bone's rest direction (and hinge axis) in the parent's frame so
   * angular limits track the death pose as the torso tumbles — not "align with
   * parent axis", which turns thighs into free ball joints off a lateral stub.
   */
  _initRestFrames() {
    for (let i = 0; i < this.boneCount; i++) {
      const p = this.boneParent[i];
      // Default: identity rest along +Y in parent frame (unused if no parent).
      this.boneRestLocal[i * 3] = 0;
      this.boneRestLocal[i * 3 + 1] = 1;
      this.boneRestLocal[i * 3 + 2] = 0;
      this.boneHingeLocal[i * 3] = 1;
      this.boneHingeLocal[i * 3 + 1] = 0;
      this.boneHingeLocal[i * 3 + 2] = 0;
      if (p < 0) continue;

      const pa = this.boneHead[p], pc = this.boneTail[p];
      let px = this.px[pc] - this.px[pa];
      let py = this.py[pc] - this.py[pa];
      let pz = this.pz[pc] - this.pz[pa];
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl; py /= pl; pz /= pl;

      const a = this.boneHead[i], c = this.boneTail[i];
      let cx = this.px[c] - this.px[a];
      let cy = this.py[c] - this.py[a];
      let cz = this.pz[c] - this.pz[a];
      const cl = Math.hypot(cx, cy, cz) || 1;
      cx /= cl; cy /= cl; cz /= cl;

      // Parent basis: Y = bone dir, Z ≈ up, X = Y×Z
      let ux = this.boneUp[p * 3], uy = this.boneUp[p * 3 + 1], uz = this.boneUp[p * 3 + 2];
      let d = ux * px + uy * py + uz * pz;
      ux -= px * d; uy -= py * d; uz -= pz * d;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-5) {
        ux = Math.abs(px) < 0.9 ? 1 : 0;
        uy = 0;
        uz = Math.abs(px) < 0.9 ? 0 : 1;
        d = ux * px + uy * py + uz * pz;
        ux -= px * d; uy -= py * d; uz -= pz * d;
        ul = Math.hypot(ux, uy, uz) || 1;
      }
      ux /= ul; uy /= ul; uz /= ul;
      // X = Y × Z
      let xx = py * uz - pz * uy;
      let xy = pz * ux - px * uz;
      let xz = px * uy - py * ux;
      const xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl; xy /= xl; xz /= xl;
      // Re-orthogonalize Z = X × Y
      const zx = xy * pz - xz * py;
      const zy = xz * px - xx * pz;
      const zz = xx * py - xy * px;

      // Child dir in parent local: columns of basis are X,Y,Z
      this.boneRestLocal[i * 3] = cx * xx + cy * xy + cz * xz;
      this.boneRestLocal[i * 3 + 1] = cx * px + cy * py + cz * pz;
      this.boneRestLocal[i * 3 + 2] = cx * zx + cy * zy + cz * zz;

      // Hinge axis = parent × child at rest (flexion plane normal)
      let hx = py * cz - pz * cy;
      let hy = pz * cx - px * cz;
      let hz = px * cy - py * cx;
      let hl = Math.hypot(hx, hy, hz);
      if (hl < 1e-4) {
        hx = ux; hy = uy; hz = uz;
        hl = 1;
      } else {
        hx /= hl; hy /= hl; hz /= hl;
      }
      this.boneHingeLocal[i * 3] = hx * xx + hy * xy + hz * xz;
      this.boneHingeLocal[i * 3 + 1] = hx * px + hy * py + hz * pz;
      this.boneHingeLocal[i * 3 + 2] = hx * zx + hy * zy + hz * zz;
    }
  }

  /** Parent bone world basis → out X,Y,Z unit axes. Returns false if degenerate. */
  _parentBasis(p, out) {
    const pa = this.boneHead[p], pc = this.boneTail[p];
    let px = this.px[pc] - this.px[pa];
    let py = this.py[pc] - this.py[pa];
    let pz = this.pz[pc] - this.pz[pa];
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-9) return false;
    px /= pl; py /= pl; pz /= pl;
    let ux = this.boneUp[p * 3], uy = this.boneUp[p * 3 + 1], uz = this.boneUp[p * 3 + 2];
    let d = ux * px + uy * py + uz * pz;
    ux -= px * d; uy -= py * d; uz -= pz * d;
    let ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-5) {
      this._initUp(p);
      ux = this.boneUp[p * 3]; uy = this.boneUp[p * 3 + 1]; uz = this.boneUp[p * 3 + 2];
      d = ux * px + uy * py + uz * pz;
      ux -= px * d; uy -= py * d; uz -= pz * d;
      ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-5) return false;
    }
    ux /= ul; uy /= ul; uz /= ul;
    let xx = py * uz - pz * uy;
    let xy = pz * ux - px * uz;
    let xz = px * uy - py * ux;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    out.yx = px; out.yy = py; out.yz = pz;
    out.zx = xy * pz - xz * py;
    out.zy = xz * px - xx * pz;
    out.zz = xx * py - xy * px;
    out.xx = xx; out.xy = xy; out.xz = xz;
    return true;
  }

  /** Set a uniform initial velocity (m/s) on every particle. */
  setVelocity(vx, vy, vz, dt = 1 / 120) {
    for (let i = 0; i < this.particleCount; i++) {
      this.qx[i] = this.px[i] - vx * dt;
      this.qy[i] = this.py[i] - vy * dt;
      this.qz[i] = this.pz[i] - vz * dt;
    }
    this.wake();
  }

  /**
   * Kick the doll at a world point — the killing shot, an explosion, a melee.
   * Falloff is 1/(1+d^2) so a headshot snaps the head without teleporting the
   * whole body. Light extremities use a mass floor so they don't whip.
   */
  applyImpulse(x, y, z, ix, iy, iz, radius = 0.45, dt = 1 / 120) {
    const maxKick = MAX_IMPULSE_KICK;
    const imCap = 1 / IMPULSE_MASS_FLOOR;
    for (let i = 0; i < this.particleCount; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const w = 1 / (1 + d2 / (radius * radius));
      // Cap invMass so hands/fingers take a torso-like share of the hit.
      const im = Math.min(this.invMass[i], imCap);
      let kx = ix * im * w * dt;
      let ky = iy * im * w * dt;
      let kz = iz * im * w * dt;
      const kl = Math.hypot(kx, ky, kz);
      if (kl > maxKick) {
        const s = maxKick / kl;
        kx *= s; ky *= s; kz *= s;
      }
      this.qx[i] -= kx;
      this.qy[i] -= ky;
      this.qz[i] -= kz;
    }
    this.wake();
  }

  wake() {
    this.sleeping = false;
    this.sleepTimer = 0;
  }

  /**
   * Hit-reaction → collapse → limp. Updates live boneStiff / boneCone from the
   * authored bases so the death pose holds briefly instead of noodling on frame 0.
   */
  _applyMuscleTone() {
    const age = this.age;
    let stiffScale;
    let coneScale;
    if (age < TONE_HIT) {
      stiffScale = TONE_STIFF_HIT;
      coneScale = TONE_CONE_HIT;
    } else if (age < TONE_LIMP) {
      const t = (age - TONE_HIT) / (TONE_LIMP - TONE_HIT);
      // smoothstep
      const s = t * t * (3 - 2 * t);
      stiffScale = TONE_STIFF_HIT + (TONE_STIFF_LIMP - TONE_STIFF_HIT) * s;
      coneScale = TONE_CONE_HIT + (TONE_CONE_LIMP - TONE_CONE_HIT) * s;
    } else {
      stiffScale = TONE_STIFF_LIMP;
      coneScale = TONE_CONE_LIMP;
    }
    const nb = this.boneCount;
    const maxCone = Math.PI - 1e-3;
    for (let i = 0; i < nb; i++) {
      const st = this.boneStiffBase[i] * stiffScale;
      this.boneStiff[i] = st > 1 ? 1 : st;
      const c = this.boneConeBase[i] * coneScale;
      this.boneCone[i] = c > maxCone ? maxCone : c;
    }
  }

  step(dt) {
    if (!this.alive || this.sleeping) return;
    this.age += dt;
    this._applyMuscleTone();
    const n = this.particleCount;
    const g = this.gravity * dt * dt;
    // Age into stickier damping — leave the first ~0.55s lively for the flop.
    const ageBleed = this.age < 0.55 ? 0 : Math.min(0.1, (this.age - 0.55) * 0.1);
    const damp = Math.max(0.9, this.linearDamping - ageBleed);

    // --- Verlet integration ---
    for (let i = 0; i < n; i++) {
      if (this.invMass[i] === 0) continue;
      let vx = (this.px[i] - this.qx[i]) * damp;
      let vy = (this.py[i] - this.qy[i]) * damp;
      let vz = (this.pz[i] - this.qz[i]) * damp;
      const vl = Math.hypot(vx, vy, vz);
      if (vl > MAX_PARTICLE_STEP) {
        const s = MAX_PARTICLE_STEP / vl;
        vx *= s; vy *= s; vz *= s;
      }
      this.qx[i] = this.px[i];
      this.qy[i] = this.py[i];
      this.qz[i] = this.pz[i];
      this.px[i] += vx;
      this.py[i] += vy + g;
      this.pz[i] += vz;
    }

    // --- Gauss-Seidel constraint solve ---
    for (let it = 0; it < this.iterations; it++) {
      this._solveDistance();
      this._solveCones();
      this._solveHinges();
      this._solveContacts(it === this.iterations - 1);
    }
    // Extra length pass after angles so knees don't stretch when hinges yank.
    this._solveDistance();
    // One self-collision pass per step: enough to stop an arm sinking through
    // the chest, cheap enough to run on every corpse on screen.
    this._solveSelf();

    // Bleed residual velocity *after* constraints. PBD contact/hinge fighting
    // writes position corrections that become next-step velocity; without this
    // the sleep timer resets forever on a twitching pile.
    // Bleed residual velocity *after* constraints. Light during the flop so
    // gravity can fold a standing death pose; ramp after ~0.5s.
    const settle =
      this.age < 0.5 ? 0.03 : Math.min(0.32, 0.06 + (this.age - 0.5) * 0.2);
    let motion = 0;
    for (let i = 0; i < n; i++) {
      if (this.invMass[i] === 0) continue;
      const dx = this.px[i] - this.qx[i];
      const dy = this.py[i] - this.qy[i];
      const dz = this.pz[i] - this.qz[i];
      motion += dx * dx + dy * dy + dz * dz;
      // Move previous pos toward current → kills fraction `settle` of velocity.
      this.qx[i] += dx * settle;
      this.qy[i] += dy * settle;
      this.qz[i] += dz * settle;
    }

    this._transportUp();
    this._updateAabb();

    // --- sleep (post-constraint motion) ---
    const avg = motion / Math.max(1, n);
    const still = avg < SLEEP_MOTION * SLEEP_MOTION;
    const crawling =
      this.age >= FORCE_SLEEP_AGE && avg < FORCE_SLEEP_MOTION * FORCE_SLEEP_MOTION;
    if (still || crawling) {
      this.sleepTimer += dt;
      const need = crawling && !still ? 0.1 : SLEEP_TIME;
      if (this.sleepTimer > need) {
        this.sleeping = true;
        for (let i = 0; i < n; i++) {
          this.qx[i] = this.px[i];
          this.qy[i] = this.py[i];
          this.qz[i] = this.pz[i];
        }
      }
    } else {
      this.sleepTimer = 0;
    }
  }

  _solveDistance() {
    for (let i = 0; i < this.boneCount; i++) {
      const a = this.boneHead[i], c = this.boneTail[i];
      const wa = this.invMass[a], wc = this.invMass[c];
      const w = wa + wc;
      if (w === 0) continue;
      const dx = this.px[c] - this.px[a];
      const dy = this.py[c] - this.py[a];
      const dz = this.pz[c] - this.pz[a];
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) continue;
      const diff = (d - this.boneLen[i]) / d / w;
      this.px[a] += dx * diff * wa;
      this.py[a] += dy * diff * wa;
      this.pz[a] += dz * diff * wa;
      this.px[c] -= dx * diff * wc;
      this.py[c] -= dy * diff * wc;
      this.pz[c] -= dz * diff * wc;
    }
  }

  /**
   * Ball-joint swing: child may not deviate more than `cone` from its *rest*
   * direction in the parent frame (death pose). Hinge bones skip this — they
   * use `_solveHinges` so knees can't splay sideways like rope.
   */
  _solveCones() {
    const basis = this._basisTmp || (this._basisTmp = {
      xx: 0, xy: 0, xz: 0, yx: 0, yy: 0, yz: 0, zx: 0, zy: 0, zz: 0,
    });
    for (let i = 0; i < this.boneCount; i++) {
      if (this.boneHinge[i]) continue;
      const p = this.boneParent[i];
      if (p < 0) continue;
      const cone = this.boneCone[i];
      if (cone >= Math.PI - 1e-3) continue;
      if (!this._parentBasis(p, basis)) continue;

      // Preferred = parentBasis * restLocal
      const rx = this.boneRestLocal[i * 3];
      const ry = this.boneRestLocal[i * 3 + 1];
      const rz = this.boneRestLocal[i * 3 + 2];
      let ax = basis.xx * rx + basis.yx * ry + basis.zx * rz;
      let ay = basis.xy * rx + basis.yy * ry + basis.zy * rz;
      let az = basis.xz * rx + basis.yz * ry + basis.zz * rz;
      const al = Math.hypot(ax, ay, az);
      if (al < 1e-9) continue;
      ax /= al; ay /= al; az /= al;

      const a = this.boneHead[i], c = this.boneTail[i];
      let bx = this.px[c] - this.px[a];
      let by = this.py[c] - this.py[a];
      let bz = this.pz[c] - this.pz[a];
      const bl = Math.hypot(bx, by, bz);
      if (bl < 1e-9) continue;
      bx /= bl; by /= bl; bz /= bl;

      let dot = ax * bx + ay * by + az * bz;
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      const angle = Math.acos(dot);
      if (angle <= cone) continue;

      let kx = ay * bz - az * by;
      let ky = az * bx - ax * bz;
      let kz = ax * by - ay * bx;
      let kl = Math.hypot(kx, ky, kz);
      if (kl < 1e-7) {
        kx = -ay; ky = ax; kz = 0;
        kl = Math.hypot(kx, ky, kz);
        if (kl < 1e-7) { kx = 1; ky = 0; kz = 0; kl = 1; }
      }
      kx /= kl; ky /= kl; kz /= kl;

      // Rotate preferred by `cone` toward current → target on cone surface
      const ca = Math.cos(cone), sa = Math.sin(cone);
      const cross_x = ky * az - kz * ay;
      const cross_y = kz * ax - kx * az;
      const cross_z = kx * ay - ky * ax;
      const kdot = kx * ax + ky * ay + kz * az;
      const tx = ax * ca + cross_x * sa + kx * kdot * (1 - ca);
      const ty = ay * ca + cross_y * sa + ky * kdot * (1 - ca);
      const tz = az * ca + cross_z * sa + kz * kdot * (1 - ca);

      this._pullBoneTail(i, a, c, tx, ty, tz, bl, this.boneStiff[i]);
    }
  }

  /**
   * Knee/elbow hinge: kill side-splay, clamp flexion. Prevents the classic
   * "legs as wet spaghetti" look where shins flop out of the sagittal plane.
   */
  _solveHinges() {
    const basis = this._basisTmp || (this._basisTmp = {
      xx: 0, xy: 0, xz: 0, yx: 0, yy: 0, yz: 0, zx: 0, zy: 0, zz: 0,
    });
    for (let i = 0; i < this.boneCount; i++) {
      if (!this.boneHinge[i]) continue;
      const p = this.boneParent[i];
      if (p < 0) continue;
      if (!this._parentBasis(p, basis)) continue;

      // World hinge axis from parent frame
      const lx = this.boneHingeLocal[i * 3];
      const ly = this.boneHingeLocal[i * 3 + 1];
      const lz = this.boneHingeLocal[i * 3 + 2];
      let hx = basis.xx * lx + basis.yx * ly + basis.zx * lz;
      let hy = basis.xy * lx + basis.yy * ly + basis.zy * lz;
      let hz = basis.xz * lx + basis.yz * ly + basis.zz * lz;
      let hl = Math.hypot(hx, hy, hz);
      if (hl < 1e-7) continue;
      hx /= hl; hy /= hl; hz /= hl;

      // Parent distal direction
      let px = basis.yx, py = basis.yy, pz = basis.yz;

      const a = this.boneHead[i], c = this.boneTail[i];
      let bx = this.px[c] - this.px[a];
      let by = this.py[c] - this.py[a];
      let bz = this.pz[c] - this.pz[a];
      const bl = Math.hypot(bx, by, bz);
      if (bl < 1e-9) continue;
      bx /= bl; by /= bl; bz /= bl;

      // 1) Project child into the hinge plane (remove lateral splay)
      const hd = bx * hx + by * hy + bz * hz;
      let fx = bx - hx * hd;
      let fy = by - hy * hd;
      let fz = bz - hz * hd;
      let fl = Math.hypot(fx, fy, fz);
      if (fl < 1e-7) {
        // Degenerate: rebuild from rest flex in plane
        const rx = this.boneRestLocal[i * 3];
        const ry = this.boneRestLocal[i * 3 + 1];
        const rz = this.boneRestLocal[i * 3 + 2];
        fx = basis.xx * rx + basis.yx * ry + basis.zx * rz;
        fy = basis.xy * rx + basis.yy * ry + basis.zy * rz;
        fz = basis.xz * rx + basis.yz * ry + basis.zz * rz;
        const rd = fx * hx + fy * hy + fz * hz;
        fx -= hx * rd; fy -= hy * rd; fz -= hz * rd;
        fl = Math.hypot(fx, fy, fz);
        if (fl < 1e-7) continue;
      }
      fx /= fl; fy /= fl; fz /= fl;

      // 2) Clamp angle between parent and flexed dir
      let dot = px * fx + py * fy + pz * fz;
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      let ang = Math.acos(dot);
      // Signed flexion via hinge axis (right-hand)
      const cx = py * fz - pz * fy;
      const cy = pz * fx - px * fz;
      const cz = px * fy - py * fx;
      if (cx * hx + cy * hy + cz * hz < 0) ang = -ang;

      const amin = this.boneHingeMin[i];
      const amax = this.boneHingeMax[i];
      let target = ang;
      if (ang < amin) target = amin;
      else if (ang > amax) target = amax;

      // Also clamp residual lateral cone (cone field = max |hd| as angle-ish)
      // Rebuild target dir by rotating parent around hinge by `target`.
      const ca = Math.cos(target), sa = Math.sin(target);
      const cross_x = hy * pz - hz * py;
      const cross_y = hz * px - hx * pz;
      const cross_z = hx * py - hy * px;
      const kdot = hx * px + hy * py + hz * pz;
      let tx = px * ca + cross_x * sa + hx * kdot * (1 - ca);
      let ty = py * ca + cross_y * sa + hy * kdot * (1 - ca);
      let tz = pz * ca + cross_z * sa + hz * kdot * (1 - ca);
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;

      // If already near target and little splay, skip
      const splay = Math.abs(hd);
      const err = Math.abs(ang - target);
      if (splay < 0.02 && err < 0.02) continue;

      this._pullBoneTail(i, a, c, tx, ty, tz, bl, this.boneStiff[i]);
    }
  }

  /** Pull bone tail toward a unit direction with inverse-mass weighting. */
  _pullBoneTail(i, a, c, tx, ty, tz, bl, stiff) {
    const gx = this.px[a] + tx * bl;
    const gy = this.py[a] + ty * bl;
    const gz = this.pz[a] + tz * bl;
    const wa = this.invMass[a], wc = this.invMass[c];
    const w = wa + wc;
    if (w === 0) return;
    const k = stiff ?? 0.55;
    const ex = (gx - this.px[c]) * k;
    const ey = (gy - this.py[c]) * k;
    const ez = (gz - this.pz[c]) * k;
    this.px[c] += ex * (wc / w);
    this.py[c] += ey * (wc / w);
    this.pz[c] += ez * (wc / w);
    this.px[a] -= ex * (wa / w);
    this.py[a] -= ey * (wa / w);
    this.pz[a] -= ez * (wa / w);
  }

  /** Capsule bones vs the static world, with friction against the previous position. */
  _solveContacts(applyFriction) {
    const w = this.world;
    if (!w || w.triCount === 0) return;
    for (let i = 0; i < this.boneCount; i++) {
      const a = this.boneHead[i], c = this.boneTail[i];
      const r = this.boneRadius[i];
      const n = w.overlapCapsule(
        this.px[a], this.py[a], this.pz[a],
        this.px[c], this.py[c], this.pz[c],
        r, this.mask, 0
      );
      if (n === 0) continue;
      const cts = w.contacts;
      let pushx = 0, pushy = 0, pushz = 0;
      let fric = 0.7;
      let param = 0;
      let wsum = 0;
      for (let k = 0; k < n; k++) {
        const d = cts.depth[k];
        if (d <= 1e-5) continue;
        const nx = cts.nx[k], ny = cts.ny[k], nz = cts.nz[k];
        // Accumulate the *maximum* push along each normal instead of the sum:
        // a tessellated floor would otherwise eject the bone into orbit.
        const already = pushx * nx + pushy * ny + pushz * nz;
        const extra = d - already;
        if (extra > 0) {
          pushx += nx * extra;
          pushy += ny * extra;
          pushz += nz * extra;
        }
        param += cts.s[k] * d;
        wsum += d;
        const sp = SURFACE_PROPS[w.surface[cts.tri[k]]];
        if (sp) fric = sp.friction;
      }
      const pl = Math.hypot(pushx, pushy, pushz);
      if (pl < 1e-6) continue;
      // Soft contact push — hard depenetration launches limbs when a capsule
      // starts slightly buried (death pose / floor).
      const cap = 0.1;
      if (pl > cap) {
        const s = cap / pl;
        pushx *= s; pushy *= s; pushz *= s;
      }
      // Distribute along the capsule so the *contact point* clears the surface
      // rather than the midpoint: classic PBD segment weighting.
      const sPar = wsum > 0 ? param / wsum : 0.5;
      const w0 = 1 - sPar, w1 = sPar;
      const wa = this.invMass[a], wc = this.invMass[c];
      const denom = w0 * w0 * wa + w1 * w1 * wc;
      if (denom < 1e-12) continue;
      const k0 = (w0 * wa) / denom;
      const k1 = (w1 * wc) / denom;
      this.px[a] += pushx * k0; this.py[a] += pushy * k0; this.pz[a] += pushz * k0;
      this.px[c] += pushx * k1; this.py[c] += pushy * k1; this.pz[c] += pushz * k1;

      if (applyFriction) {
        const mu = Math.min(1, this.friction * fric);
        this._frictionAt(a, pushx, pushy, pushz, mu);
        this._frictionAt(c, pushx, pushy, pushz, mu);
      }
    }
  }

  /** Capsule-vs-capsule pushout between non-adjacent bones. */
  _solveSelf() {
    const pairs = this.selfPairs;
    const cl = this._ss;
    for (let k = 0; k < pairs.length; k += 2) {
      const i = pairs[k], j = pairs[k + 1];
      const a0 = this.boneHead[i], a1 = this.boneTail[i];
      const b0 = this.boneHead[j], b1 = this.boneTail[j];
      const rad = (this.boneRadius[i] + this.boneRadius[j]) * 0.92;
      const d2 = closestPtSegSeg(
        this.px[a0], this.py[a0], this.pz[a0], this.px[a1], this.py[a1], this.pz[a1],
        this.px[b0], this.py[b0], this.pz[b0], this.px[b1], this.py[b1], this.pz[b1],
        cl
      );
      if (d2 >= rad * rad) continue;
      const d = Math.sqrt(d2);
      let nx, ny, nz;
      if (d > 1e-6) {
        nx = (cl.ax - cl.bx) / d; ny = (cl.ay - cl.by) / d; nz = (cl.az - cl.bz) / d;
      } else {
        nx = 0; ny = 1; nz = 0;
      }
      const push = (rad - d) * 0.32;
      const s = cl.s, t = cl.t;
      const wa0 = this.invMass[a0] * (1 - s), wa1 = this.invMass[a1] * s;
      const wb0 = this.invMass[b0] * (1 - t), wb1 = this.invMass[b1] * t;
      const wsum = wa0 + wa1 + wb0 + wb1;
      if (wsum < 1e-12) continue;
      const k1 = push / wsum;
      this.px[a0] += nx * wa0 * k1; this.py[a0] += ny * wa0 * k1; this.pz[a0] += nz * wa0 * k1;
      this.px[a1] += nx * wa1 * k1; this.py[a1] += ny * wa1 * k1; this.pz[a1] += nz * wa1 * k1;
      this.px[b0] -= nx * wb0 * k1; this.py[b0] -= ny * wb0 * k1; this.pz[b0] -= nz * wb0 * k1;
      this.px[b1] -= nx * wb1 * k1; this.py[b1] -= ny * wb1 * k1; this.pz[b1] -= nz * wb1 * k1;
    }
  }

  _frictionAt(i, nx, ny, nz, mu) {
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) return;
    nx /= nl; ny /= nl; nz /= nl;
    let vx = this.px[i] - this.qx[i];
    let vy = this.py[i] - this.qy[i];
    let vz = this.pz[i] - this.qz[i];
    const vn = vx * nx + vy * ny + vz * nz;
    let tx = vx - nx * vn, ty = vy - ny * vn, tz = vz - nz * vn;
    // Kill the tangential component; PBD friction is applied by moving the
    // previous position towards the current one.
    this.qx[i] += tx * mu;
    this.qy[i] += ty * mu;
    this.qz[i] += tz * mu;
  }

  /**
   * Parallel-transport each bone's reference up-vector so the rendered roll is
   * continuous, then clamp the twist relative to the parent.
   */
  _transportUp() {
    for (let i = 0; i < this.boneCount; i++) {
      const a = this.boneHead[i], c = this.boneTail[i];
      let dx = this.px[c] - this.px[a];
      let dy = this.py[c] - this.py[a];
      let dz = this.pz[c] - this.pz[a];
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) continue;
      dx /= l; dy /= l; dz /= l;
      let ux = this.boneUp[i * 3], uy = this.boneUp[i * 3 + 1], uz = this.boneUp[i * 3 + 2];
      const d = ux * dx + uy * dy + uz * dz;
      ux -= dx * d; uy -= dy * d; uz -= dz * d;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-5) {
        this._initUp(i);
        continue;
      }
      ux /= ul; uy /= ul; uz /= ul;

      // twist limit against the parent's frame
      const p = this.boneParent[i];
      const lim = this.boneTwist[i];
      if (p >= 0 && lim < Math.PI - 1e-3) {
        let rx = this.boneUp[p * 3], ry = this.boneUp[p * 3 + 1], rz = this.boneUp[p * 3 + 2];
        const rd = rx * dx + ry * dy + rz * dz;
        rx -= dx * rd; ry -= dy * rd; rz -= dz * rd;
        const rl = Math.hypot(rx, ry, rz);
        if (rl > 1e-5) {
          rx /= rl; ry /= rl; rz /= rl;
          let cs = ux * rx + uy * ry + uz * rz;
          if (cs > 1) cs = 1; else if (cs < -1) cs = -1;
          const ang = Math.acos(cs);
          if (ang > lim) {
            // rotate u back towards r by (ang - lim)
            const t = (ang - lim) / ang;
            ux += (rx - ux) * t; uy += (ry - uy) * t; uz += (rz - uz) * t;
            const nl2 = Math.hypot(ux, uy, uz) || 1;
            ux /= nl2; uy /= nl2; uz /= nl2;
          }
        }
      }
      this.boneUp[i * 3] = ux;
      this.boneUp[i * 3 + 1] = uy;
      this.boneUp[i * 3 + 2] = uz;
    }
  }

  _updateAabb() {
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < this.particleCount; i++) {
      if (this.px[i] < minx) minx = this.px[i];
      if (this.py[i] < miny) miny = this.py[i];
      if (this.pz[i] < minz) minz = this.pz[i];
      if (this.px[i] > maxx) maxx = this.px[i];
      if (this.py[i] > maxy) maxy = this.py[i];
      if (this.pz[i] > maxz) maxz = this.pz[i];
    }
    const a = this.aabb;
    a.minx = minx; a.miny = miny; a.minz = minz;
    a.maxx = maxx; a.maxy = maxy; a.maxz = maxz;
  }

  /* ---------------------------------------------------------------- */
  /* Read-back                                                         */
  /* ---------------------------------------------------------------- */

  /** World-space capsule of bone i: writes head/tail/radius into `out`. */
  getBoneCapsule(i, out) {
    const a = this.boneHead[i], c = this.boneTail[i];
    out.ax = this.px[a]; out.ay = this.py[a]; out.az = this.pz[a];
    out.bx = this.px[c]; out.by = this.py[c]; out.bz = this.pz[c];
    out.r = this.boneRadius[i];
    return out;
  }

  /**
   * World transform of bone i. `upAxis` names which local axis runs down the
   * bone — THREE bones conventionally point along +Y.
   */
  getBoneTransform(i, outPos, outQuat) {
    const a = this.boneHead[i], c = this.boneTail[i];
    outPos.set(this.px[a], this.py[a], this.pz[a]);
    let dx = this.px[c] - this.px[a];
    let dy = this.py[c] - this.py[a];
    let dz = this.pz[c] - this.pz[a];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const ux = this.boneUp[i * 3], uy = this.boneUp[i * 3 + 1], uz = this.boneUp[i * 3 + 2];
    // basis: Y = bone dir, Z = up-ish, X = Y x Z
    let xx = dy * uz - dz * uy;
    let xy = dz * ux - dx * uz;
    let xz = dx * uy - dy * ux;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const zx = xy * dz - xz * dy;
    const zy = xz * dx - xx * dz;
    const zz = xx * dy - xy * dx;
    this._m4.set(
      xx, dx, zx, 0,
      xy, dy, zy, 0,
      xz, dz, zz, 0,
      0, 0, 0, 1
    );
    outQuat.setFromRotationMatrix(this._m4);
    return outPos;
  }

  /**
   * Take ownership of a THREE.Skeleton. `boneMap` maps our bone index to a
   * THREE.Bone (or a name). After this, writeToSkeleton() drives the mesh.
   */
  adoptSkeleton(skeleton, boneMap) {
    const bones = new Array(this.boneCount).fill(null);
    for (let i = 0; i < this.boneCount; i++) {
      const entry = boneMap?.[i] ?? boneMap?.[this.spec[i].name] ?? null;
      if (!entry) continue;
      bones[i] = typeof entry === 'string' ? skeleton.getBoneByName(entry) : entry;
    }
    this.bones3D = bones;
    this.skeleton = skeleton;
    return this;
  }

  /** Push the simulated transforms into the adopted skeleton. */
  writeToSkeleton() {
    if (!this.bones3D) return;
    // A settled corpse re-derives bone transforms per frame from particle
    // positions that `step()` has already stopped touching (it early-returns on
    // `sleeping`), so every one of those writes is the same value it wrote last
    // frame. Skip them — but only AFTER one write has landed while asleep: the
    // frame the ragdoll falls asleep, `step()` has already moved the particles
    // one last time before setting the flag, and dropping that write would leave
    // the skeleton one step stale forever. `sleeping` going false re-arms this on
    // the next call, so a re-woken ragdoll writes again immediately.
    if (this.sleeping && this._sleepWritten) return;
    this._sleepWritten = this.sleeping;
    const pos = this._v3;
    const quat = this._q;
    for (let i = 0; i < this.boneCount; i++) {
      const bone = this.bones3D[i];
      if (!bone) continue;
      this.getBoneTransform(i, pos, quat);
      this._m4b.compose(pos, quat, this._scale);
      if (bone.parent) {
        // Parent scale must stay unit or inv(parent)*world injects stretch into
        // every child (classic Slender Man). Clamp before reading world matrix.
        if (
          bone.parent.scale.x !== 1 ||
          bone.parent.scale.y !== 1 ||
          bone.parent.scale.z !== 1
        ) {
          bone.parent.scale.set(1, 1, 1);
          bone.parent.updateMatrix();
        }
        bone.parent.updateWorldMatrix(true, false);
        this._m4.copy(bone.parent.matrixWorld).invert().multiply(this._m4b);
      } else {
        this._m4.copy(this._m4b);
      }
      this._m4.decompose(bone.position, bone.quaternion, this._v3b);
      // Never keep decomposed scale — float error + non-uniform parents accumulate
      // into limb stretch within a second of death.
      bone.scale.set(1, 1, 1);
      bone.updateMatrix();
    }
    // Prefer the pelvis / first mapped bone so the full hierarchy refreshes.
    const root =
      this.bones3D.find((b) => b && !b.parent?.isBone) ?? this.bones3D.find(Boolean);
    root?.updateMatrixWorld(true);
  }

  dispose() {
    this.alive = false;
    this.bones3D = null;
    this.skeleton = null;
  }
}

/**
 * Build a bone spec from an existing THREE.Skeleton.
 *
 * One capsule per parent→child edge, with endpoints at the joint world
 * positions. That way every joint is a *shared particle* (same world point at
 * construction → same Verlet particle), so limbs cannot float off the torso.
 * Branch points (hips, shoulders) get free cones — a spine-up parent direction
 * is ~90° from a thigh and would otherwise fight the bind pose every step.
 *
 * Returns { spec, boneMap } ready for `new Ragdoll(...).adoptSkeleton(...)`.
 */
export function specFromSkeleton(skeleton, opts = {}) {
  const bones = skeleton.bones;
  const spec = [];
  const boneMap = [];
  const totalMass = opts.mass ?? 82;
  const defaultCone = (opts.cone ?? 70) * DEG;
  const defaultTwist = (opts.twist ?? 35) * DEG;
  const freeCone = Math.PI - 1e-3;

  const worldPos = new Map();
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    bone.updateWorldMatrix(true, false);
    const e = bone.matrixWorld.elements;
    worldPos.set(bone, [e[12], e[13], e[14]]);
  }

  // First structural child of a bone (prefer spine/neck over limbs at branches).
  const primaryChild = (bone) => {
    const kids = bone.children.filter((c) => c.isBone);
    if (!kids.length) return null;
    const structural = kids.find((c) => !/clavicle|upleg|upperarm|shoulder|thigh/i.test(c.name));
    return structural ?? kids[0];
  };

  /** Spec index of the capsule whose *tail* is this joint (drives this bone). */
  const specAtJoint = new Map();

  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i];
    const parent = bone.parent?.isBone ? bone.parent : null;
    let head;
    let tail;
    let parentSpec = -1;
    let cone = defaultCone;

    if (!parent) {
      // Root: capsule from root joint to primary child (or short stub).
      head = worldPos.get(bone);
      const child = primaryChild(bone);
      if (child) {
        tail = worldPos.get(child);
      } else {
        const q = new THREE.Quaternion();
        bone.getWorldQuaternion(q);
        const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const stub = opts.stubLength ?? 0.08;
        tail = [head[0] + dir.x * stub, head[1] + dir.y * stub, head[2] + dir.z * stub];
      }
    } else {
      head = worldPos.get(parent);
      tail = worldPos.get(bone);
      parentSpec = specAtJoint.has(parent) ? specAtJoint.get(parent) : -1;
      // Branch off a chain (leg from hips, arm from spine): free cone so the
      // solver doesn't yank the limb toward the parent's long axis.
      const siblings = parent.children.filter((c) => c.isBone);
      if (siblings.length > 1 && primaryChild(parent) !== bone) {
        cone = freeCone;
      }
    }

    const dx = tail[0] - head[0];
    const dy = tail[1] - head[1];
    const dz = tail[2] - head[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) continue;

    const si = spec.length;
    // Tail joint is this bone's origin (or primary child for the root capsule).
    if (!parent) {
      specAtJoint.set(bone, si);
    } else {
      specAtJoint.set(bone, si);
    }

    spec.push({
      name: bone.name || `bone${i}`,
      head: [head[0], head[1], head[2]],
      tail: [tail[0], tail[1], tail[2]],
      radius: Math.max(0.025, len * (opts.radiusRatio ?? 0.32)),
      mass: 1,
      parent: parentSpec,
      cone,
      twist: defaultTwist,
    });
    boneMap[si] = bone;
  }

  // distribute mass by bone volume
  let vol = 0;
  for (const s of spec) {
    const l = Math.hypot(s.tail[0] - s.head[0], s.tail[1] - s.head[1], s.tail[2] - s.head[2]);
    s.mass = Math.PI * s.radius * s.radius * l;
    vol += s.mass;
  }
  if (vol > 0) for (const s of spec) s.mass = Math.max(0.4, (s.mass / vol) * totalMass);

  return { spec, boneMap };
}
