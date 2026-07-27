#!/usr/bin/env node
/**
 * Cold-load benchmark: wall-clock time from navigation to window.__READY__.
 *
 * Playwright sets navigator.webdriver, so the title/deploy gate is skipped
 * (see src/main.js skipMenu) — this measures full init + prewarm + 3 boot frames.
 *
 *   bun tools/bench-load.mjs
 *   bun tools/bench-load.mjs --port=5173 --runs=5 --query=q=high --channel=chrome
 *   bun tools/bench-load.mjs --cdp=http://127.0.0.1:9222
 */
import { chromium } from 'playwright';
import { platform } from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const PORT = Number(args.port ?? 5173);
const RUNS = Math.max(1, Number(args.runs ?? 5));
const W = Number(args.w ?? 1512);
const H = Number(args.h ?? 982);
const DPR = Number(args.dpr ?? 1);
const CHANNEL = args.channel === true ? 'chrome' : args.channel || 'chrome';
const HEADED = args.headed === true || args.headed === '1';
const CDP = args.cdp === true ? 'http://127.0.0.1:9222' : args.cdp || null;
const OUT = args.out ? resolve(args.out) : resolve('tmp/bench-load.json');
const QUERY = args.query ? String(args.query) : '';

const angle =
  args.angle ||
  (platform() === 'darwin' ? 'metal' : platform() === 'win32' ? 'd3d11' : 'gl');

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const sum = s.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)))];
  return {
    n,
    min: +s[0].toFixed(1),
    max: +s[n - 1].toFixed(1),
    mean: +(sum / n).toFixed(1),
    median: +pct(50).toFixed(1),
    p90: +pct(90).toFixed(1),
  };
}

const browser = CDP
  ? await chromium.connectOverCDP(CDP)
  : await chromium.launch({
      headless: !HEADED,
      channel: CHANNEL,
      timeout: 60_000,
      args: [
        `--use-angle=${angle}`,
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        '--enable-zero-copy',
        '--mute-audio',
        '--disable-frame-rate-limit',
        '--disable-gpu-vsync',
      ],
    });

const runs = [];
const qs = QUERY ? (QUERY.startsWith('?') ? QUERY : `?${QUERY}`) : '';

console.log(
  `bench-load: ${RUNS} run(s) → http://127.0.0.1:${PORT}/${qs || ''}  ` +
    `(${W}x${H}@${DPR} ${CHANNEL}${HEADED ? ' headed' : ' headless'}${CDP ? ' cdp' : ''})`
);

for (let i = 0; i < RUNS; i++) {
  const context = browser.contexts()[0] && CDP
    ? browser.contexts()[0]
    : await browser.newContext({
        viewport: { width: W, height: H },
        deviceScaleFactor: DPR,
      });

  const page = await (CDP && browser.contexts()[0]
    ? context.newPage()
    : context.newPage());

  if (!CDP) await page.setViewportSize({ width: W, height: H });

  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  const tNav = performance.now();
  await page.goto(`http://127.0.0.1:${PORT}/${qs}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  const dclMs = performance.now() - tNav;

  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180_000 });
  const readyMs = performance.now() - tNav;

  const detail = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const marks = performance
      .getEntriesByType('measure')
      .map((m) => ({ name: m.name, ms: +m.duration.toFixed(1) }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 20);
    const paint = performance.getEntriesByType('paint').map((p) => ({
      name: p.name,
      ms: +p.startTime.toFixed(1),
    }));
    const resources = performance.getEntriesByType('resource');
    const transfer = resources.reduce((s, r) => s + (r.transferSize || 0), 0);
    const encoded = resources.reduce((s, r) => s + (r.encodedBodySize || 0), 0);
    const gpu = window.__GPU__ || null;
    const prewarm = window.__PREWARM__ || null;
    const quality = window.__ENGINE__?.config?.quality ?? null;
    return {
      nav: nav
        ? {
            domContentLoaded: +nav.domContentLoadedEventEnd.toFixed(1),
            loadEvent: +nav.loadEventEnd.toFixed(1),
            responseStart: +nav.responseStart.toFixed(1),
            responseEnd: +nav.responseEnd.toFixed(1),
            domInteractive: +nav.domInteractive.toFixed(1),
            transferSize: nav.transferSize,
          }
        : null,
      paint,
      marks,
      resourceCount: resources.length,
      transferKB: +(transfer / 1024).toFixed(1),
      encodedKB: +(encoded / 1024).toFixed(1),
      quality,
      gpu: gpu
        ? {
            renderer: gpu.renderer,
            quality: gpu.quality,
            score: gpu.score,
            reason: gpu.reason,
          }
        : null,
      prewarm: prewarm
        ? {
            ok: prewarm.ok,
            ms: prewarm.ms ?? prewarm.duration ?? null,
            programs: prewarm.programs ?? null,
            reason: prewarm.reason ?? null,
          }
        : null,
    };
  });

  const row = {
    run: i + 1,
    dclMs: +dclMs.toFixed(1),
    readyMs: +readyMs.toFixed(1),
    errors: errs,
    ...detail,
  };
  runs.push(row);
  console.log(
    `  run ${i + 1}/${RUNS}: DCL ${row.dclMs} ms  →  __READY__ ${row.readyMs} ms` +
      (detail.quality ? `  [${detail.quality}]` : '') +
      (detail.prewarm?.ms != null ? `  prewarm~${detail.prewarm.ms}ms` : '') +
      (errs.length ? `  ⚠ ${errs.length} page error(s)` : '')
  );

  await page.close();
  if (!CDP) await context.close();
}

if (!CDP) await browser.close();
else {
  // Leave CDP browser running; only close pages we opened.
}

const ready = runs.map((r) => r.readyMs);
const dcl = runs.map((r) => r.dclMs);
const report = {
  at: new Date().toISOString(),
  url: `http://127.0.0.1:${PORT}/${qs}`,
  viewport: `${W}x${H}@${DPR}`,
  channel: CHANNEL,
  headed: HEADED,
  cdp: !!CDP,
  angle,
  runs,
  summary: {
    readyMs: stats(ready),
    dclMs: stats(dcl),
  },
  sample: runs[0]
    ? {
        quality: runs[0].quality,
        gpu: runs[0].gpu,
        prewarm: runs[0].prewarm,
        transferKB: runs[0].transferKB,
        resourceCount: runs[0].resourceCount,
        paint: runs[0].paint,
      }
    : null,
};

mkdirSync(resolve(OUT, '..'), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log('\n=== Load time summary (ms) ===');
console.log('__READY__:', JSON.stringify(report.summary.readyMs));
console.log('DCL:     ', JSON.stringify(report.summary.dclMs));
if (report.sample) {
  console.log(
    'sample:  ',
    `quality=${report.sample.quality}`,
    report.sample.gpu
      ? `gpu=${report.sample.gpu.renderer} score=${report.sample.gpu.score}`
      : '',
    report.sample.prewarm
      ? `prewarm=${JSON.stringify(report.sample.prewarm)}`
      : ''
  );
}
console.log(`wrote ${OUT}`);
