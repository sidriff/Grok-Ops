/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  /**
   * Fast iteration tier. Prewarm is lite (forward + existing post only — no
   * multi-pose walk, no world depth/prepass compile wall). Expect possible
   * first-use shader hitches on shadows/prepass; use medium+ or `?prewarm=full`
   * when hunting hitches. Boot with `?q=low`.
   */
  low: {
    renderScale: 0.72,
    /** Cap devicePixelRatio so internal buffers stay sane on Retina/4K. */
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    /** Two cascades: one less full scene walk + depth pass (major GC source). */
    cascades: 2,
    shadowDistance: 48,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
    /** Cap visible practicals — each point light multiplies forward cost. */
    maxPointLights: 8,
  },
  medium: {
    renderScale: 0.85,
    maxPixelRatio: 1.25,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
    maxPointLights: 14,
  },
  high: {
    renderScale: 1.0,
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
    maxPointLights: 20,
  },
  ultra: {
    renderScale: 1.0,
    maxPixelRatio: 1.75,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
    maxPointLights: 24,
  },
};

export const DEFAULTS = {
  /** Boot picks a tier via `detectGraphics()` unless `?q=` or capture mode. */
  quality: 'medium',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}
