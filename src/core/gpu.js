/**
 * GPU probe + quality auto-select for Grok Ops.
 *
 * Upstream defaulted to `ultra` (4K shadows, full post stack) for screenshot
 * capture. That is the wrong default for a sustained firefight: most machines
 * hitch, audio underruns, and the fight feels broken before design even starts.
 *
 * This module reads WebGL renderer strings (and a few capability signals) and
 * returns a quality tier that should stay playable. Override anytime with `?q=`.
 */

/** @typedef {'low'|'medium'|'high'|'ultra'} QualityTier */

/**
 * @typedef {object} GpuInfo
 * @property {string} vendor
 * @property {string} renderer
 * @property {boolean} webgl2
 * @property {number} maxTextureSize
 * @property {number|null} deviceMemory   GB, Chrome-ish only
 * @property {number} cores
 * @property {number} dpr
 * @property {boolean} software
 * @property {QualityTier} quality
 * @property {number} score              0..100 rough confidence band
 * @property {string} reason             short why for console / HUD
 */

const SOFTWARE_RE =
  /swiftshader|llvmpipe|softpipe|microsoft basic render|gdi generic|virtualbox|vmware|angle \(microsoft/i;

const MOBILE_RE = /adreno|mali|powervr|xclipse|apple gpu.*iphone|apple gpu.*ipad|tegra/i;

/**
 * Probe a throwaway WebGL context. Safe to call once at boot; returns a
 * best-effort report even when WebGL is missing (quality → low).
 * @returns {Omit<GpuInfo, 'quality'|'score'|'reason'> & { raw: string }}
 */
export function probeGpu() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  const deviceMemory =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory)
      ? navigator.deviceMemory
      : null;
  const dpr = (typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1;

  const blank = {
    vendor: 'unknown',
    renderer: 'unknown',
    webgl2: false,
    maxTextureSize: 0,
    deviceMemory,
    cores,
    dpr,
    software: true,
    raw: '',
  };

  if (typeof document === 'undefined') return blank;

  let canvas;
  try {
    canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) ||
      canvas.getContext('webgl', { failIfMajorPerformanceCaveat: false });
    if (!gl) return blank;

    const webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    let vendor = gl.getParameter(gl.VENDOR) || '';
    let renderer = gl.getParameter(gl.RENDERER) || '';

    // Unmasked strings are the useful ones on ANGLE (Windows).
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || vendor;
      renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || renderer;
    }

    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    const raw = `${vendor} | ${renderer}`.trim();
    const software = SOFTWARE_RE.test(raw);

    // Drop the context so we do not hold a GPU process slot through boot.
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();

    return {
      vendor: String(vendor),
      renderer: String(renderer),
      webgl2,
      maxTextureSize,
      deviceMemory,
      cores,
      dpr,
      software,
      raw,
    };
  } catch {
    return blank;
  } finally {
    canvas = null;
  }
}

/**
 * Map probe data → quality tier. Conservative by design: Grok Ops would rather
 * look a bit softer and run than look ultra and hitch every second.
 *
 * @param {ReturnType<typeof probeGpu>} info
 * @returns {{ quality: QualityTier, score: number, reason: string }}
 */
export function classifyGpu(info) {
  const r = `${info.renderer} ${info.vendor}`.toLowerCase();
  let score = 50;
  const notes = [];

  if (info.software || !info.webgl2) {
    return { quality: 'low', score: 5, reason: info.software ? 'software rasterizer' : 'no WebGL2' };
  }

  if (info.maxTextureSize > 0 && info.maxTextureSize < 8192) {
    score -= 20;
    notes.push('small max texture');
  }
  if (info.deviceMemory != null) {
    if (info.deviceMemory <= 4) {
      score -= 18;
      notes.push(`${info.deviceMemory} GB RAM`);
    } else if (info.deviceMemory >= 16) {
      score += 8;
    }
  }
  if (info.cores <= 4) score -= 8;
  else if (info.cores >= 12) score += 5;

  if (MOBILE_RE.test(r)) {
    score -= 15;
    notes.push('mobile GPU');
  }

  // --- NVIDIA ---
  if (/nvidia|geforce|quadro|rtx|gtx/.test(r)) {
    const m = r.match(/\b(rtx|gtx)\s*(\d{3,4})\b/) || r.match(/\b(rtx|gtx)(\d{3,4})\b/);
    if (m) {
      const series = m[1];
      const num = parseInt(m[2], 10);
      const tier = num >= 1000 ? Math.floor(num / 100) : Math.floor(num / 10); // 4090 → 40, 980 → 98
      if (series === 'rtx') {
        if (num >= 4080 || tier >= 50) {
          score += 40;
          notes.push(`NVIDIA ${m[0]}`);
        } else if (num >= 3070 || tier >= 40) {
          score += 32;
          notes.push(`NVIDIA ${m[0]}`);
        } else if (num >= 2060 || tier >= 30) {
          score += 22;
          notes.push(`NVIDIA ${m[0]}`);
        } else {
          score += 12;
          notes.push(`NVIDIA ${m[0]}`);
        }
      } else {
        // GTX
        if (num >= 1660) score += 12;
        else if (num >= 1060) score += 4;
        else score -= 5;
        notes.push(`NVIDIA ${m[0]}`);
      }
    } else if (/rtx/.test(r)) {
      score += 28;
      notes.push('NVIDIA RTX');
    } else {
      score += 10;
      notes.push('NVIDIA');
    }
  }

  // --- AMD discrete ---
  else if (/radeon\s*rx|amd radeon\(tm\)\s*rx|graphics.*rx\s*\d/.test(r)) {
    const m = r.match(/rx\s*(\d{3,4})/);
    const num = m ? parseInt(m[1], 10) : 0;
    if (num >= 7800 || num >= 7900) score += 36;
    else if (num >= 6700 || num >= 6800 || num >= 7600) score += 28;
    else if (num >= 5700 || num >= 6600) score += 18;
    else score += 10;
    notes.push(m ? `AMD ${m[0]}` : 'AMD RX');
  }

  // --- Apple Silicon / metal ---
  else if (/apple/.test(r) || /metal/i.test(info.vendor)) {
    if (/m4\s*(max|ultra)/i.test(r) || /m3\s*(max|ultra)/i.test(r) || /m2\s*ultra/i.test(r)) {
      score += 38;
      notes.push('Apple high-end');
    } else if (/m4|m3\s*pro|m2\s*(pro|max)|m1\s*(pro|max|ultra)/i.test(r)) {
      score += 30;
      notes.push('Apple Pro/Max');
    } else if (/m[1-4]/i.test(r)) {
      score += 20;
      notes.push('Apple Silicon');
    } else {
      score += 8;
      notes.push('Apple GPU');
    }
    // Retina + browser already expensive; do not auto-pick ultra on laptops.
    if (info.dpr >= 2) {
      score -= 6;
      notes.push('Retina DPR');
    }
  }

  // --- Intel integrated ---
  else if (/intel/.test(r)) {
    if (/arc\s*(a|b)?\d|arc graphics/i.test(r)) {
      score += 14;
      notes.push('Intel Arc');
    } else if (/iris\s*xe|uhd\s*7[7-9]|uhd\s*6[3-9]/i.test(r)) {
      score -= 5;
      notes.push('Intel iGPU');
    } else {
      score -= 15;
      notes.push('Intel integrated');
    }
  }

  // --- AMD integrated / vague ---
  else if (/amd|radeon/.test(r)) {
    if (/graphics|vega|rdna|780m|890m|760m/.test(r)) {
      score -= 2;
      notes.push('AMD iGPU / APU');
    } else {
      score += 6;
      notes.push('AMD');
    }
  }

  // Clamp and bucket. Thresholds bias toward medium — our north star is a
  // playable five-minute fight, not maxed post.
  score = Math.max(0, Math.min(100, score));
  /** @type {QualityTier} */
  let quality = 'medium';
  if (score < 28) quality = 'low';
  else if (score < 52) quality = 'medium';
  else if (score < 78) quality = 'high';
  else quality = 'ultra';

  // Never auto-ultra on very high DPR without discrete-class score; 3MP+
  // internal buffers are what made upstream unplayable on laptops.
  if (quality === 'ultra' && info.dpr >= 2 && score < 88) {
    quality = 'high';
    notes.push('capped ultra→high at high DPR');
  }

  const reason = notes.length ? notes.join(', ') : `score ${score}`;
  return { quality, score, reason };
}

/**
 * Full boot-time detection. Call once before `createConfig`.
 * @returns {GpuInfo}
 */
export function detectGraphics() {
  const probe = probeGpu();
  const tier = classifyGpu(probe);
  return {
    vendor: probe.vendor,
    renderer: probe.renderer,
    webgl2: probe.webgl2,
    maxTextureSize: probe.maxTextureSize,
    deviceMemory: probe.deviceMemory,
    cores: probe.cores,
    dpr: probe.dpr,
    software: probe.software,
    quality: tier.quality,
    score: tier.score,
    reason: tier.reason,
  };
}
