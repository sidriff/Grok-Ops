import { P } from './atlas.js';
import { resetSpawn, PF } from './particles.js';

/**
 * Tracers.
 *
 * A tracer is a burning pellet in the base of the round, so what you see is a
 * short, very bright streak that *travels* — the fact that it takes time to
 * cross the street is most of the read. Real muzzle velocity (~900 m/s)
 * crosses a 30 m street in 33 ms, i.e. two frames, so like every shipped
 * shooter we clamp the visual speed into a range that reads on screen while
 * keeping the departure and arrival times honest.
 *
 * Rendering model (PF.TRAIL): a camera-facing *world-space* ribbon from the
 * particle (tip) back along -velocity by a fixed length in metres. Not a
 * view-plane speed smear — that put a flat sticker at one depth and looked
 * sideways on anything with a real depth component (death cam, crossing fire).
 *
 * Three sprites: hot head (billboard spark), core streak, longer dim afterglow.
 */

const MIN_SPEED = 55;
const MAX_SPEED = 340;

/** Core ribbon length (metres). */
const CORE_LEN = 1.15;
/** Afterglow ribbon length (metres). */
const GLOW_LEN = 2.1;

export function spawnTracer(fx, from, to, speed, opts) {
  const rng = fx.rng;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  let dz = to.z - from.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.35) return;
  dx /= dist;
  dy /= dist;
  dz /= dist;
  const v = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed || 260));
  const life = dist / v;
  const warm = opts?.warm ?? 1;
  // Start a little out of the bore so the tracer is not born inside the flash.
  const ox = from.x + dx * 0.25;
  const oy = from.y + dy * 0.25;
  const oz = from.z + dz * 0.25;

  // core streak — short world-space ribbon aft of the tip
  let s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.STREAK;
  s.size0 = 0.045; // ribbon width (m)
  s.size1 = 0.032;
  s.stretch = CORE_LEN; // ribbon length (m) under PF.TRAIL
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.52 * warm; s.b0 = 0.18 * warm; s.i0 = 26;
  s.r1 = 1; s.g1 = 0.4 * warm; s.b1 = 0.12 * warm; s.i1 = 16;
  s.alphaCurve = 0.25;
  s.soft = 0.1;
  s.seed = rng.float();
  s.flags = PF.TRAIL;
  fx.emitAdd(s);

  // afterglow: longer, dimmer, same world-space model
  s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.STREAK;
  s.size0 = 0.07;
  s.size1 = 0.05;
  s.stretch = GLOW_LEN;
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.33 * warm; s.b0 = 0.1 * warm; s.i0 = 5.5;
  s.r1 = 1; s.g1 = 0.24 * warm; s.b1 = 0.06 * warm; s.i1 = 2.5;
  s.alphaCurve = 0.3;
  s.soft = 0.14;
  s.seed = rng.float();
  s.flags = PF.TRAIL;
  fx.emitAdd(s);

  // incandescent head — billboard spark at the tip the ribbons hang off
  s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.SPARK;
  s.size0 = 0.05;
  s.size1 = 0.042;
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.85; s.b0 = 0.6; s.i0 = 30;
  s.r1 = 1; s.g1 = 0.6; s.b1 = 0.3; s.i1 = 18;
  s.alphaCurve = 0.2;
  s.soft = 0.08;
  s.seed = rng.float();
  fx.emitAdd(s);
}
