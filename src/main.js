/**
 * Boot entry.
 *
 * The title shell (graphics pick, look prefs, Load) must paint and stay
 * interactive without waiting on the full game graph. Only light modules are
 * static imports; the engine + systems load after the player clicks Load.
 */

import { createConfig, QUALITY_PRESETS } from './core/config.js';
import { detectGraphics } from './core/gpu.js';
import { createLoadScreen } from './core/loadscreen.js';

const params = new URLSearchParams(location.search);

// Leaderboard + X login boot from src/social/boot.js (separate script in
// index.html) so the board fills while menu music plays — not after Load.
const social = () => window.__SOCIAL__ ?? null;
const capture = params.get('capture') === '1';
// Deterministic shutter for the pixel gate: the engine does not schedule its own
// frames, the driver advances exactly N of them through window.__PUMP__. Opt-in,
// because tools that measure real frame pacing (tools/perf.mjs) need the loop to
// free-run. See the long comment in src/dev/shots.js.
const lockstep = capture && params.get('lockstep') === '1';
// Title / deploy gate. Capture, tooling, and explicit opt-outs skip it so the
// harness never waits on a human click and screenshots never include the shell.
// Playwright sets navigator.webdriver — that covers playtest/probe/profile even
// when they forget ?capture=1.
const skipMenu =
  capture ||
  params.get('menu') === '0' ||
  params.get('autostart') === '1' ||
  params.get('demo') === '1' ||
  (typeof navigator !== 'undefined' && !!navigator.webdriver);

const load = createLoadScreen();
if (skipMenu) load.hideImmediate();

// GPU probe is cheap and informs the briefing recommendation + capture defaults.
const forcedQ = params.get('q');
const gpu = detectGraphics();
window.__GPU__ = gpu;

let quality;
let lookPrefs = { sensitivity: 0.0022, fov: 80, invertY: false };

if (skipMenu) {
  quality =
    forcedQ && QUALITY_PRESETS[forcedQ]
      ? forcedQ
      : capture
        ? 'ultra'
        : gpu.quality;
} else {
  // Phase 1 — briefing: project pitch + graphics pick, then Load.
  // Quality must be chosen before Engine init (bakes, shadows, prewarm budget).
  // Graphics cards are already in the HTML / LoadScreen constructor — this only
  // waits on the human click, not on the game bundle.
  const choice = await load.waitForBriefing({
    recommended: gpu.quality,
    forced: forcedQ && QUALITY_PRESETS[forcedQ] ? forcedQ : null,
    gpuLabel: gpu.renderer || '',
  });
  quality = choice.quality;
  lookPrefs = {
    sensitivity: choice.sensitivity,
    fov: choice.fov,
    invertY: choice.invertY,
  };
  // Same shell — lock graphics + flip CTA to Loading, then fetch the game graph.
  load.beginLoading({
    meta: `${quality.toUpperCase()} · ${gpu.renderer || 'GPU'}`,
  });
  load.setProgress(0.04, { stage: 'gpu', label: 'Preparing systems…' });
}

const config = createConfig({
  quality,
  deterministic: capture,
  sensitivity: lookPrefs.sensitivity,
  fov: lookPrefs.fov,
  invertY: lookPrefs.invertY,
});
config.gpu = gpu;
console.info(
  `[grok-ops] quality=${quality}` +
    (forcedQ ? ' (forced)' : skipMenu ? (capture ? ' (capture)' : ' (auto)') : ' (briefing)') +
    ` — ${gpu.renderer || 'unknown GPU'} | score ${gpu.score} | ${gpu.reason}`
);

// Phase 2 — pull the game. Dynamic so the briefing is not blocked by three.js /
// world / weapons / AI module evaluation on cold boot.
if (!skipMenu) {
  load.setProgress(0.05, { stage: 'systems', label: 'Loading systems…' });
}

const [
  { Engine },
  { RenderSystem },
  { MaterialSystem },
  { SkySystem },
  { WorldSystem },
  { PhysicsSystem },
  { PlayerSystem },
  { WeaponSystem },
  { FxSystem },
  { AiSystem },
  { UiSystem },
  { AudioSystem },
  { GameSystem },
  { TitleOrbitSystem },
  { installShotApi },
  { prewarm },
] = await Promise.all([
  import('./core/engine.js'),
  import('./render/index.js'),
  import('./materials/index.js'),
  import('./sky/index.js'),
  import('./world/index.js'),
  import('./physics/index.js'),
  import('./player/index.js'),
  import('./weapons/index.js'),
  import('./fx/index.js'),
  import('./ai/index.js'),
  import('./ui/index.js'),
  import('./audio/index.js'),
  import('./game/index.js'),
  import('./core/titleOrbit.js'),
  import('./dev/shots.js'),
  import('./core/prewarm.js'),
]);

if (!skipMenu) {
  load.setProgress(0.08, { stage: 'systems', label: 'Systems ready…' });
}

const canvas = document.getElementById('game');
const engine = new Engine({ canvas, config });
// Always wire look prefs — shell is also the pause menu (incl. skipMenu path).
load.bindConfig(config, engine.camera);
load.bindInput(engine.input);
// Local run capture (opt-in Record run checkbox on the title shell).
load.bindCanvas(canvas);

// Registration order is irrelevant — Registry topo-sorts on static deps.
engine
  .add(RenderSystem)
  .add(MaterialSystem)
  .add(SkySystem)
  .add(WorldSystem)
  .add(PhysicsSystem)
  .add(PlayerSystem)
  .add(WeaponSystem)
  .add(FxSystem)
  .add(AiSystem)
  .add(UiSystem)
  .add(AudioSystem)
  .add(GameSystem)
  .add(TitleOrbitSystem);

// Init covers ~8–72% of the bar; prewarm takes the rest. Labels come from stage ids.
const INIT_LO = 0.08;
const INIT_HI = 0.72;
const WARM_LO = 0.72;
const WARM_HI = 0.98;

try {
  await engine.init(
    skipMenu
      ? undefined
      : {
          onProgress: (t, info) => {
            const p = INIT_LO + (INIT_HI - INIT_LO) * Math.min(1, Math.max(0, t));
            load.setProgress(p, {
              stage: info?.stage,
              label: info?.label ? `Building ${info.label}…` : undefined,
            });
          },
        }
  );
} catch (err) {
  console.error('[boot] init failed', err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:0;padding:2rem;color:#f66;background:#000;
       font:12px/1.5 ui-monospace,monospace;overflow:auto;z-index:9999;white-space:pre-wrap">
BOOT FAILURE\n\n${err.stack ?? err.message}</pre>`
  );
  throw err;
}

const shotApi = installShotApi(engine, { capture, lockstep });

// Menu master volume drives the game mixer too (shell owns the slider).
load.bindAudio(engine.ctx.peek('audio'));

// Compile every shader permutation before the frame loop starts. Measured: without
// this, 86 programs compile lazily during play, up to 30 on one frame, producing
// 3.1-3.9 SECOND stalls. See src/core/prewarm.js.
//
// ON BY DEFAULT since the capture path was made frame-deterministic; opt out with
// `?prewarm=0`. It is now PROVEN pixel-neutral: `tools/baseline.mjs` with
// `--query=prewarm=0` vs `--query=prewarm=1` reports identical:true on all 11
// shots (0 changed pixels, maxDelta 0). The two things that previously made the
// ~1.4 s pre-warm spend look like a visual change were both boot-duration
// couplings OUTSIDE the subsystems: (1) the shutter frame index was latency-bound
// because the engine kept stepping through the driver's round trips — fixed by
// lockstep in src/dev/shots.js; (2) `will-change: transform` on the compass strip
// cached a composited-layer raster taken at a wall-clock-dependent moment — fixed
// in src/ui/style.js.
if (!skipMenu) load.setProgress(WARM_LO, { stage: 'prewarm', label: 'Compiling shaders…' });
// Prewarm intensity:
//   ?prewarm=0       off (expect mid-play hitches)
//   ?prewarm=lite    minimal budget (fastest boot; more mid-play hitches)
//   ?prewarm=full    force the ultra budget (hitch-free, slow)
//   omitted          derive from quality — low is hitch-reduced, ultra is full
const prewarmParam = params.get('prewarm');
let warmup = { ok: false, reason: 'disabled by ?prewarm=0' };
if (prewarmParam !== '0') {
  try {
    warmup = await prewarm(engine, {
      mode:
        prewarmParam === 'lite' || prewarmParam === 'minimal'
          ? 'lite'
          : prewarmParam === 'full' || prewarmParam === '1' || prewarmParam === 'max'
            ? 'full'
            : 'auto',
      onProgress: (t) => {
        if (skipMenu) return;
        const p = WARM_LO + (WARM_HI - WARM_LO) * Math.min(1, Math.max(0, t));
        load.setProgress(p, { stage: 'prewarm', label: 'Compiling shaders…' });
      },
    });
  } catch (err) {
    // A failed prewarm must not trap the player on a dead Deploy button.
    console.error('[boot] prewarm failed', err);
    warmup = { ok: false, reason: String(err?.message ?? err) };
  }
}
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;
// agent-browser / CDP evals often hang while the GPU is compiling, so expose a
// lightweight signal in the document title for load benches (`?bench=1`).
if (params.get('bench') != null) {
  const tier = warmup?.policy?.tier ?? (warmup?.ok === false ? 'off' : '?');
  const ms = warmup?.ms ?? 0;
  const n = warmup?.compiled ?? 0;
  document.title = `bench prewarm=${ms}ms tier=${tier} compiled=${n} q=${quality}`;
}

// Hold the match frozen under the title shell until Deploy. Capture / autostart
// skip the gate and run as before.
const player = engine.ctx.peek('player');
const ui = engine.ctx.peek('ui');
if (!skipMenu) {
  // Freeze the sim and park input so ESC/click don't open pause or grab the
  // pointer under the title shell. Re-enabled on Deploy.
  engine.time.scale = 0;
  engine.input.enabled = false;
  // Critical: without this, #game's cursor:none + wantPointerLock make the
  // title shell feel broken (invisible cursor, clicks fighting the canvas).
  engine.input.releasePointerForUi();
  player?.setControlEnabled?.(false);
  ui?.setHudVisible?.(false);
}

engine.start();

// Capture harness handshake: only flag ready once a frame has actually landed.
//
// BOOT_FRAMES is deliberately a frame COUNT, not a rAF race. In lockstep mode the
// engine has no loop of its own, so we hand-pump exactly this many frames and only
// then raise __READY__; the shot is therefore always applied at engine frame 3, no
// matter how long boot (or pre-warm) took in wall-clock terms.
//
// Interactive boots (especially low) need more settle frames: compileAsync does
// not cover every first-draw permutation, and without these the first second
// after Deploy is the classic black-world + HUD flash while programs compile.
const BOOT_FRAMES = lockstep
  ? 3
  : quality === 'low'
    ? 36
    : quality === 'medium'
      ? 12
      : 6;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
} else {
  if (!skipMenu) {
    load.setProgress(0.99, { stage: 'prewarm', label: 'Warming first frames…' });
  }
  await new Promise((resolve) => {
    let warm = 0;
    const readyProbe = () => {
      if (++warm >= BOOT_FRAMES) {
        resolve();
        return;
      }
      if (!skipMenu && warm % 6 === 0) {
        const t = 0.99 + 0.01 * (warm / BOOT_FRAMES);
        load.setProgress(t, { stage: 'prewarm', label: 'Warming first frames…' });
      }
      requestAnimationFrame(readyProbe);
    };
    requestAnimationFrame(readyProbe);
  });
}

// Boot shell doubles as the in-game pause / settings menu (Resume CTA).
// skipMenu already called hideImmediate() at boot — shell stays re-openable.
ui?.menu?.useBootShell?.(load);

if (!skipMenu) {
  load.setProgress(1, { stage: 'ready', label: 'Ready' });
  load.enterReady({
    meta: `${quality.toUpperCase()} · ${gpu.renderer || 'GPU'}`,
  });
  // Prewarm stages a firefight + freezes the viewmodel for shader compile.
  // Both must be fully cleared before Deploy or the player spawns into an
  // ambush they cannot shoot (debugMode === 'idle' blocks live fire).
  engine.ctx.peek('ai')?.clearStage?.();
  engine.ctx.peek('weapons')?.clearDebugPose?.();
  // Payoff: keep the already-warm street camera under the title panel.
  // Do NOT snap to a new overlook — that recompiles and hitch-locks the menu.
  engine.titleOrbit?.start?.({ lockStreet: false });
  await load.waitForDeploy();
  engine.titleOrbit?.stop?.();
  engine.ctx.peek('ai')?.clearStage?.();
  engine.ctx.peek('weapons')?.clearDebugPose?.();
  engine.time.scale = 1;
  engine.input.enabled = true;
  player?.setControlEnabled?.(true);
  ui?.setHudVisible?.(true);
  // Fade the shell out with a normal cursor (fullscreen may already be on from
  // the Deploy click). Only then pointer-lock — locking earlier hides the cursor
  // over the still-visible load menu.
  await load.enterPlaying({ immediate: false });
  engine.input.capturePointerForGame({ lock: true });
}

// Seal local canvas capture when the match ends, then surface download on the
// death / score card (and the title shell when they retreat).
engine.ctx.events.on('game:end', () => {
  void load.finalizeRecording().then((last) => {
    engine.ctx.peek('ui')?.setLastRun?.(last);
  });
});
// Retry mid-session (no title shell) — start a fresh capture if Record is on.
// No-op if Deploy already started one for this run.
engine.ctx.events.on('game:begin', () => {
  load.startRecordingIfEnabled();
});

// Auto-post personal best when a survival match ends (logged-in only).
engine.ctx.events.on('game:end', (payload) => {
  if (!payload || payload.endgame !== true) return;
  const s = social();
  if (!s?.submitScore) return;
  void s
    .submitScore({
      kills: payload.kills ?? 0,
      combatPoints: payload.combatPoints ?? 0,
      timeSurvived: payload.timeSurvived ?? 0,
      alliesAlive: payload.alliesAlive ?? 0,
      won: !!payload.won,
    })
    .then((res) => {
      if (res?.ok && res.improved) {
        console.info('[social] new personal best posted', res.score);
      }
    });
});

window.__READY__ = true;
window.__ENGINE__ = engine;
window.__LOAD__ = load;

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    engine.dispose();
  });
}
