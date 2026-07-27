import * as THREE from 'three';

/**
 * Shader pre-warm.
 *
 * WHY THIS EXISTS — measured, not guessed. Profiling actual gameplay at Retina
 * DPR showed 86 WebGL programs compiling lazily *during play*, with up to 30
 * landing on a single frame. Each of those frames took 3.1-3.9 SECONDS. That is
 * the "freezing" players report: not a low frame rate, but multi-second stalls
 * whenever geometry with an uncompiled material/light/shadow permutation first
 * enters the frame.
 *
 * Three.js compiles a program the first time a given (material, lights, shadow,
 * skinning, fog, ...) permutation is actually drawn. The fix is to force every
 * permutation to compile up front, while a loading state is on screen, so the
 * steady-state frame loop never compiles anything.
 *
 * This must not change a single rendered pixel. It only moves *when* compilation
 * happens, so it touches no material parameters, no camera, no lighting state.
 * The pixel-diff gate (tools/imagediff.mjs) enforces that.
 *
 * QUALITY-TIERED BUDGET — full warm was measured at ~37 s on a 5070 Ti (render
 * hook ~12 s, world depth/prepass ~12 s, multi-pose compileAsync ~10 s). That is
 * correct for shipping high/ultra. Default `?q=low` now biases toward hitch
 * reduction (street+interior poses, world depth/prepass, light-settled recompile,
 * short combat stage). Use `?prewarm=lite` when you want the old few-second boot
 * and can tolerate first-use compiles. medium is a middle ground; high/ultra keep
 * the exhaustive path.
 *
 * Two mechanisms, because neither alone is sufficient:
 *
 *  1. renderer.compileAsync() — uses KHR_parallel_shader_compile where available,
 *     so it compiles off the main thread and does not block. Covers the forward
 *     lit pass for everything currently in a scene graph.
 *  2. Subsystem `prewarmMaterials()` hooks — reach CSM depth, MRT prepass, post
 *     chain, and skinned character variants that compileAsync alone cannot.
 */

/** Poses chosen to span the level's lighting and material variety, so the
 *  cascades, interiors and exteriors all get their permutations compiled. */
const WARM_POSES = [
  { pos: [12, 1.75, 18], look: [-4, 2.2, -6] }, // main street, long cascades
  { pos: [-8.5, 1.7, 3.2], look: [2, 1.6, -2] }, // interior, short cascades
  { pos: [3.2, 1.35, 5.0], look: [1.4, 1.1, 2.2] }, // close material detail
  { pos: [4, 1.7, 12], look: [-6, 1.7, -4] }, // combat staging
];

/**
 * Subsystems whose `prewarmMaterials()` must NOT be driven from here.
 *
 * `fx` self-schedules its own pre-warm on the second rendered frame, and that is
 * not a workaround it can drop: the program cache key carries the number of
 * VISIBLE lights, and the visible set is only settled inside the renderer's
 * first frame (`render._cullLights`) plus `world._stabiliseLightCount`, both of
 * which run after this function has returned. Calling fx from here would compile
 * a permutation the frame loop never asks for AND latch fx's `_warmed` flag, so
 * the real programs would go back to compiling on the first shot fired. Measured
 * by src/fx: that is 12 programs / 142-159 ms on the frame the trigger is pulled.
 */
const SELF_WARMING = new Set(['fx']);

/**
 * Whether to let `render.prewarmMaterials()` run its CSM-depth + MRT-prepass step.
 *
 * OFF, and it is the one thing in this file that was MEASURED not to be
 * pixel-neutral. World + AI hooks reach those variants via override compile
 * instead. See git history / comments on RENDER_SHADOW_WARM for the bisect.
 */
const RENDER_SHADOW_WARM = false;

/**
 * Prewarm intensity by quality tier (or explicit override).
 *
 * @param {string} quality  engine config quality name
 * @param {'auto'|'lite'|'full'|string|null} [mode]
 *   `auto`  — derive from quality
 *   `lite`  — force minimal budget (fastest boot; more mid-play hitches)
 *   `full`  — force the ultra budget (capture / hitch-free)
 */
export function resolvePrewarmPolicy(quality, mode = 'auto') {
  const tier =
    mode === 'lite' || mode === '0' || mode === 'minimal'
      ? 'minimal'
      : mode === 'full' || mode === '1' || mode === 'max'
        ? 'ultra'
        : quality || 'medium';

  switch (tier) {
    case 'minimal':
      // Fastest boot for agent loops / `?prewarm=lite`. Expect first-use hitches.
      return {
        tier: 'minimal',
        poses: 0,
        render: { post: true, shadow: false },
        world: { forward: true, overrides: ['depth', 'prepass'] },
        ai: false,
        settle: false,
        stageCombat: false,
      };
    case 'low':
      // Hitch-reduced iteration default for `?q=low`. Covers the permutations
      // that used to compile mid-street (cascade depth, interiors, skinned
      // shadows, settled light count). Boot is longer than minimal; console
      // Program Info Log spam moves into load instead of gameplay.
      return {
        tier: 'low',
        poses: 2, // street + interior
        render: { post: true, shadow: false },
        world: { forward: true, overrides: ['depth', 'prepass'] },
        ai: true, // skinned CSM-depth (init may have run; hook is idempotent)
        settle: true,
        stageCombat: true,
      };
    case 'medium':
      return {
        tier: 'medium',
        poses: 2,
        render: { post: true, shadow: false },
        world: { forward: true, overrides: ['depth', 'prepass'] },
        ai: true,
        settle: true,
        stageCombat: true,
      };
    case 'high':
      return {
        tier: 'high',
        poses: 2,
        render: { post: true, shadow: false },
        world: { forward: true, overrides: ['depth', 'prepass'] },
        ai: true,
        settle: true,
        stageCombat: true,
      };
    default:
      return {
        tier: 'ultra',
        poses: WARM_POSES.length,
        render: { post: true, shadow: RENDER_SHADOW_WARM },
        world: { forward: true, overrides: ['depth', 'prepass'] },
        ai: true,
        settle: true,
        stageCombat: true,
      };
  }
}

/**
 * Force shader permutations to compile before gameplay starts.
 * Resolves once warm. Never throws — a failed pre-warm must not block boot,
 * it just means the old stutter comes back.
 *
 * @param opts.transients  Stage each subsystem's spawned objects (enemies, impact
 *   bursts, muzzle flash) so their programs compile too. MEASURED TO BE UNSAFE and
 *   therefore off by default: the pixel-diff gate showed up-to-254/255 channel
 *   deltas afterwards.
 * @param opts.mode  'auto' | 'lite' | 'full' — see resolvePrewarmPolicy
 * @param opts.policy  explicit policy object; wins over mode/quality when set
 */
export async function prewarm(
  engine,
  { onProgress = () => {}, transients = false, drawFrames = false, mode = 'auto', policy: policyIn } = {}
) {
  const t0 = performance.now();
  const render = engine.ctx.peek('render');
  const renderer = render?.renderer;
  if (!renderer) return { ok: false, reason: 'no renderer' };

  const quality = engine.config?.quality ?? engine.ctx?.config?.quality ?? 'medium';
  const policy = policyIn ?? resolvePrewarmPolicy(quality, mode);
  const poses = WARM_POSES.slice(0, Math.max(0, policy.poses | 0));

  const programsBefore = renderer.info.programs?.length ?? 0;
  const cam = engine.camera;
  const saved = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };

  // Pre-warm has to be *simulation-transparent*, not just visually transparent.
  // It steps the engine, which advances the clock and the RNG stream; if that
  // residue survived, every downstream capture would drift and the pixel-diff
  // gate would report phantom regressions. Snapshot and restore both.
  const t = engine.time;
  const savedTime = { elapsed: t.elapsed, raw: t.raw, dt: t.dt, alpha: t.alpha, frame: t.frame };
  const r = engine.rng;
  const savedRng = { s0: r.s0, s1: r.s1, s2: r.s2, s3: r.s3, spare: r._spare };
  const savedAccum = engine._accum;

  const transientStages = [
    () => engine.ctx.peek('ai')?.debugStage?.('firefight'),
    () => engine.ctx.peek('fx')?.debugBurst?.('wall'),
    () => engine.ctx.peek('fx')?.debugBurst?.('explosion'),
    () => engine.ctx.peek('fx')?.debugBurst?.('muzzle'),
    () => engine.ctx.peek('fx')?.debugBurst?.('combat'),
    () => engine.ctx.peek('weapons')?.debugPose?.('fire'),
    () => engine.ctx.peek('weapons')?.debugPose?.('ads'),
    () => engine.ctx.peek('ui')?.debugState?.('combat'),
  ];

  // A RENDER TARGET MUST BE BOUND WHILE COMPILING. three folds `outputColorSpace`
  // and `toneMapping` into the program cache key and reads BOTH off the currently
  // bound target. With the canvas bound (the default here) every program compiled
  // is the `srgb` + tone-mapped variant — but the world and the viewmodel are both
  // drawn into HDR targets, which need `srgb-linear` + NoToneMapping. A 1x1 target
  // is enough to get the right key; nothing is ever rendered into it.
  const scratchRt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  const prevRt = renderer.getRenderTarget();
  const prevFace = renderer.getActiveCubeFace?.() ?? 0;
  const prevMip = renderer.getActiveMipmapLevel?.() ?? 0;

  const compile = async () => {
    renderer.setRenderTarget(scratchRt);
    try {
      await renderer.compileAsync(engine.scene, engine.camera);
      await renderer.compileAsync(engine.viewScene, engine.viewCamera);
    } catch {
      try {
        renderer.compile(engine.scene, engine.camera);
        renderer.compile(engine.viewScene, engine.viewCamera);
      } catch {
        /* nothing more we can do; boot must still proceed */
      }
    } finally {
      renderer.setRenderTarget(prevRt, prevFace, prevMip);
    }
  };

  const yieldFrame = () => new Promise((res) => requestAnimationFrame(res));

  try {
    let step = 0;
    const hookBudget = 6;
    const settleBudget = policy.settle ? 2 : 0;
    const combatBudget = policy.stageCombat ? 2 : 0;
    const totalSteps =
      Math.max(1, poses.length * 2) +
      hookBudget +
      settleBudget +
      combatBudget +
      (transients ? transientStages.length : 0) +
      1;
    const tick = () => onProgress(Math.min(1, ++step / totalSteps));

    // Pass 1: multi-pose forward compile (street + interior on hitch-reduced low).
    if (poses.length === 0) {
      // Still warm the real spawn pose once so post/HDR keys exist.
      await compile();
      tick();
    } else {
      for (const p of poses) {
        cam.position.set(...p.pos);
        cam.lookAt(...p.look);
        cam.updateMatrixWorld(true);
        try {
          engine.ctx.peek('world')?._stabiliseLightCount?.(engine.ctx);
        } catch {
          /* optional */
        }
        await compile();
        tick();
        if (drawFrames || policy.drawFrames) {
          engine.step();
          await yieldFrame();
          engine.step();
          await yieldFrame();
        }
        tick();
      }
    }

    // Pass 1b: subsystem hooks, filtered by policy.
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const hooks = [];
    const renderSys = engine.registry.peek?.('render');
    if (policy.render && renderSys && typeof renderSys.prewarmMaterials === 'function') {
      hooks.push({ sys: renderSys, kind: 'render' });
    }
    for (const sys of engine.registry.ordered ?? []) {
      if (sys === renderSys) continue;
      const id = sys.constructor?.id;
      if (SELF_WARMING.has(id)) continue;
      if (typeof sys.prewarmMaterials !== 'function') continue;
      if (id === 'world' && !policy.world) continue;
      if (id === 'ai' && !policy.ai) continue;
      // Unknown subsystems with the hook still run on high/ultra only.
      if (id !== 'world' && id !== 'ai' && (policy.tier === 'low' || policy.tier === 'minimal'))
        continue;
      hooks.push({ sys, kind: id });
    }

    const hookResults = {};
    for (const { sys, kind } of hooks) {
      const id = sys.constructor?.id ?? kind ?? '?';
      try {
        let arg;
        if (id === 'render') {
          arg = {
            post: policy.render?.post !== false,
            shadow: !!(policy.render?.shadow ?? RENDER_SHADOW_WARM),
          };
        } else if (id === 'world' && policy.world && typeof policy.world === 'object') {
          arg = { ...policy.world, ctx: engine.ctx };
        } else if (id === 'ai') {
          // Always request skinned CSM-depth when the AI hook runs — that is the
          // first-enemy-in-shadows hitch on low.
          arg = { depth: true };
        } else {
          arg = engine.ctx;
        }
        hookResults[id] = (await sys.prewarmMaterials(arg)) ?? { ok: true };
      } catch (err) {
        hookResults[id] = { ok: false, reason: String(err?.message ?? err) };
      }
      tick();
      await yieldFrame();
    }
    for (let i = hooks.length; i < hookBudget; i++) tick();
    engine.__prewarmHooks = hookResults;

    // Pass 1c: re-compile at the *settled* punctual-light count. Without this,
    // ballast + distance cull only lock in after the first real frames, and the
    // real numPointLights key still compiles mid-play (Program Info Log spam).
    if (policy.settle) {
      cam.position.copy(saved.pos);
      cam.quaternion.copy(saved.quat);
      cam.updateMatrixWorld(true);
      try {
        engine.ctx.peek('world')?._stabiliseLightCount?.(engine.ctx);
        const rSys = engine.ctx.peek('render');
        const camPos = rSys?._camPos;
        if (camPos && rSys?._cullLights) {
          camPos.setFromMatrixPosition(cam.matrixWorld);
          rSys._cullLights(camPos);
        }
      } catch {
        /* optional */
      }
      await compile();
      tick();
      await compile();
      tick();
    } else {
      for (let i = 0; i < settleBudget; i++) tick();
    }

    // Pass 1d: stage combat meshes so skinned + weapon viewmodel programs
    // exist under the live light set, then tear down. Simulation clock is
    // restored in finally — this is compile-only residue control.
    if (policy.stageCombat) {
      try {
        engine.ctx.peek('ai')?.debugStage?.('firefight');
        engine.ctx.peek('weapons')?.debugPose?.('fire');
      } catch {
        /* optional */
      }
      try {
        engine.ctx.peek('world')?._stabiliseLightCount?.(engine.ctx);
      } catch {
        /* optional */
      }
      await compile();
      tick();
      await compile();
      tick();
      try {
        engine.ctx.peek('ai')?.debugStage?.('none');
        engine.ctx.peek('weapons')?.debugPose?.('idle');
      } catch {
        /* optional */
      }
    } else {
      for (let i = 0; i < combatBudget; i++) tick();
    }

    // Pass 2: transients (off by default — not pixel-transparent).
    for (const spawn of transients ? transientStages : []) {
      try {
        spawn();
      } catch {
        /* optional */
      }
      engine.step();
      await yieldFrame();
      await compile();
      engine.step();
      await yieldFrame();
      tick();
    }
    tick();
  } finally {
    for (const reset of [
      ...(transients
        ? [
            () => engine.ctx.peek('fx')?.debugBurst?.('none'),
            () => engine.ctx.peek('weapons')?.debugPose?.('idle'),
            () => engine.ctx.peek('ui')?.debugState?.('clean'),
            () => engine.ctx.peek('ai')?.debugStage?.('none'),
          ]
        : []),
      // Always clear combat stage residue from hitch-reduction warm.
      () => engine.ctx.peek('ai')?.debugStage?.('none'),
      () => engine.ctx.peek('weapons')?.debugPose?.('idle'),
    ]) {
      try {
        reset();
      } catch {
        /* optional */
      }
    }
    cam.position.copy(saved.pos);
    cam.quaternion.copy(saved.quat);
    cam.fov = saved.fov;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    Object.assign(engine.time, savedTime);
    r.s0 = savedRng.s0;
    r.s1 = savedRng.s1;
    r.s2 = savedRng.s2;
    r.s3 = savedRng.s3;
    r._spare = savedRng.spare;
    engine._accum = savedAccum;
    engine._last = performance.now();
    renderer.setRenderTarget(prevRt, prevFace, prevMip);
    scratchRt.dispose();
  }

  const programsAfter = renderer.info.programs?.length ?? 0;
  return {
    ok: true,
    policy,
    hooks: engine.__prewarmHooks,
    ms: Math.round(performance.now() - t0),
    programsBefore,
    programsAfter,
    compiled: programsAfter - programsBefore,
    parallel: !!renderer.getContext().getExtension('KHR_parallel_shader_compile'),
  };
}
