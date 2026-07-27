import { Engine } from './core/engine.js';
import { createConfig, QUALITY_PRESETS } from './core/config.js';
import { detectGraphics } from './core/gpu.js';
import { createLoadScreen } from './core/loadscreen.js';

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { AudioSystem } from './audio/index.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
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
else load.setProgress(0.02, { stage: 'boot', label: 'Booting…' });

// Quality: explicit `?q=` wins. Capture tools default to ultra for stable
// baselines. Everyone else gets GPU auto-detect so we stop shipping hitch-city.
load.setProgress(0.04, { stage: 'gpu', label: 'Detecting GPU…' });
const forcedQ = params.get('q');
const gpu = detectGraphics();
const quality =
  forcedQ && QUALITY_PRESETS[forcedQ]
    ? forcedQ
    : capture
      ? 'ultra'
      : gpu.quality;

const config = createConfig({
  quality,
  deterministic: capture,
});
config.gpu = gpu;
console.info(
  `[grok-ops] quality=${quality}` +
    (forcedQ ? ' (forced)' : capture ? ' (capture)' : ' (auto)') +
    ` — ${gpu.renderer || 'unknown GPU'} | score ${gpu.score} | ${gpu.reason}`
);
window.__GPU__ = gpu;
if (!skipMenu) {
  load.setMeta(
    `${quality.toUpperCase()} · ${gpu.renderer || 'GPU'}`
  );
  load.setProgress(0.06, { stage: 'systems', label: 'Loading systems…' });
}

const canvas = document.getElementById('game');

const engine = new Engine({ canvas, config });

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
  .add(AudioSystem);

// Init covers ~6–72% of the bar; prewarm takes the rest. Labels come from stage ids.
const INIT_LO = 0.06;
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
const warmup =
  params.get('prewarm') === '0'
    ? { ok: false, reason: 'disabled by ?prewarm=0' }
    : await prewarm(engine, {
        onProgress: (t) => {
          if (skipMenu) return;
          const p = WARM_LO + (WARM_HI - WARM_LO) * Math.min(1, Math.max(0, t));
          load.setProgress(p, { stage: 'prewarm', label: 'Compiling shaders…' });
        },
      });
console.info('[boot] prewarm', warmup);
window.__PREWARM__ = warmup;

// Hold the match frozen under the title shell until Deploy. Capture / autostart
// skip the gate and run as before.
const player = engine.ctx.peek('player');
const ui = engine.ctx.peek('ui');
if (!skipMenu) {
  // Freeze the sim and park input so ESC/click don't open pause or grab the
  // pointer under the title shell. Re-enabled on Deploy.
  engine.time.scale = 0;
  engine.input.enabled = false;
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
const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
} else {
  await new Promise((resolve) => {
    let warm = 0;
    const readyProbe = () => {
      if (++warm >= BOOT_FRAMES) {
        resolve();
        return;
      }
      requestAnimationFrame(readyProbe);
    };
    requestAnimationFrame(readyProbe);
  });
}

if (!skipMenu) {
  load.setProgress(1, { stage: 'ready', label: 'Ready' });
  load.enterReady({
    meta: `${quality.toUpperCase()} · ${gpu.renderer || 'GPU'}`,
  });
  await load.waitForDeploy();
  engine.time.scale = 1;
  engine.input.enabled = true;
  player?.setControlEnabled?.(true);
  ui?.setHudVisible?.(true);
  engine.input.requestPointerLock?.();
}

window.__READY__ = true;
window.__ENGINE__ = engine;
window.__LOAD__ = load;

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.dispose());
}
