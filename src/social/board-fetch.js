/**
 * Public leaderboard pull — plain fetch, no Convex client / WebSocket.
 * Safe to run from the title shell before any game code loads.
 */

import { getConvexUrl } from './config.js';

/**
 * @param {string} convexUrl  e.g. https://xxx.convex.cloud
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchLeaderboard(convexUrl, opts = {}) {
  const url = convexUrl.replace(/\/$/, '');
  const ctrl = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? ctrl.signal;
  const timer =
    ctrl &&
    setTimeout(() => {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }, 10000);

  try {
    const res = await fetch(`${url}/api/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Convex-Client': 'grok-ops-boot',
      },
      body: JSON.stringify({
        path: 'scores:list',
        args: {},
        format: 'json',
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`leaderboard HTTP ${res.status}`);
    }

    const body = await res.json();
    if (body.status === 'error') {
      throw new Error(body.errorMessage || 'leaderboard query failed');
    }
    if (body.status !== 'success') {
      throw new Error(`leaderboard bad status: ${body.status}`);
    }
    return Array.isArray(body.value) ? body.value : [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** @returns {string | null} */
export function convexUrlFromEnv() {
  return getConvexUrl();
}
