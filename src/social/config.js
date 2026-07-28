/**
 * Public Convex endpoints for the leaderboard / auth client.
 *
 * Prefer Vite env (build-time), then fall back to the known dev deployment so
 * a stale Vite process or missing .env never shows "Leaderboard offline".
 */

const FALLBACK_CONVEX_URL = 'https://abundant-chicken-369.convex.cloud';
const FALLBACK_SITE_URL = 'https://abundant-chicken-369.convex.site';

function pick(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim().replace(/\/$/, '');
  }
  return null;
}

/** @returns {string | null} */
export function getConvexUrl() {
  return pick(
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_CONVEX_URL : null,
    typeof import.meta !== 'undefined' ? import.meta.env?.CONVEX_URL : null,
    FALLBACK_CONVEX_URL,
  );
}

/** @returns {string | null} */
export function getConvexSiteUrl() {
  return pick(
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_CONVEX_SITE_URL : null,
    FALLBACK_SITE_URL,
  );
}
