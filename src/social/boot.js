/**
 * Title-shell social bootstrap.
 *
 * Loaded from index.html as its own module so the leaderboard starts as soon as
 * the briefing paints (same window as menu music) — not after the player hits
 * Load and the game graph downloads.
 */

import { convexUrlFromEnv, fetchLeaderboard } from './board-fetch.js';
import { bindLeaderboard } from './leaderboard.js';

const url = convexUrlFromEnv();

/**
 * Minimal store the leaderboard UI can subscribe to.
 * Full SocialAuth (X login + score submit) is layered on later.
 */
function createBoardStore() {
  /** @type {Set<Function>} */
  const listeners = new Set();
  const state = {
    me: null,
    board: [],
    ready: false,
    boardLoaded: false,
    error: null,
    isAuthenticated: false,
  };

  /** @type {import('./auth.js').SocialAuth | null} */
  let auth = null;

  const emit = () => {
    const snap = { ...state };
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.warn('[social] listener error', err);
      }
    }
  };

  const store = {
    get board() {
      return state.board;
    },
    get me() {
      return state.me;
    },
    get error() {
      return state.error;
    },
    get isAuthenticated() {
      return state.isAuthenticated;
    },
    /** @param {Function} fn */
    subscribe(fn) {
      listeners.add(fn);
      fn({ ...state });
      return () => listeners.delete(fn);
    },
    setBoard(board) {
      state.board = board;
      state.boardLoaded = true;
      state.error = null;
      state.ready = true;
      emit();
    },
    setError(msg) {
      state.error = msg;
      state.boardLoaded = true;
      state.ready = true;
      emit();
    },
    /** @param {import('./auth.js').SocialAuth} next */
    attachAuth(next) {
      auth = next;
      auth.subscribe((s) => {
        state.me = s.me;
        state.isAuthenticated = s.isAuthenticated;
        state.ready = s.ready;
        // Prefer live board when it has rows; keep HTTP snapshot otherwise.
        if (s.boardLoaded) {
          if (s.board?.length) {
            state.board = s.board;
            state.error = null;
          } else if (s.error && !state.board.length) {
            state.error = s.error;
          }
          state.boardLoaded = true;
        }
        emit();
      });
    },
    async signInWithX() {
      if (!auth) throw new Error('Auth still loading — try again in a moment');
      return auth.signInWithX();
    },
    async signInWithHandle(handle) {
      // Free-for-all claim removed — verified X only.
      throw new Error('Use Log in with X — handles must be verified.');
    },
    async signOut() {
      if (!auth) return;
      return auth.signOut();
    },
    async submitScore(payload) {
      if (!auth) return { ok: false, improved: false, reason: 'auth_not_ready' };
      return auth.submitScore(payload);
    },
    dispose() {
      auth?.dispose?.();
      auth = null;
      listeners.clear();
    },
  };

  return store;
}

const store = createBoardStore();
window.__SOCIAL__ = store;

if (!url) {
  console.info('[social] VITE_CONVEX_URL missing — leaderboard offline');
  bindLeaderboard(null);
} else {
  bindLeaderboard(store);
  console.info('[social] fetching leaderboard…', url);

  // 1) Instant public board via HTTP — no Convex client / game code.
  void fetchLeaderboard(url)
    .then((board) => {
      console.info(`[social] board loaded (${board.length} rows)`);
      store.setBoard(board);
    })
    .catch((err) => {
      console.error('[social] board fetch failed', err);
      store.setError(String(err?.message ?? err));
    });

  // 2) Background: full auth client for X login + live updates + score submit.
  void import('./auth.js')
    .then(({ createSocial }) => {
      const next = createSocial();
      if (!next) return null;
      store.attachAuth(next);
      window.__SOCIAL_AUTH__ = next;
      return next.init();
    })
    .then(() => {
      console.info('[social] auth client ready');
    })
    .catch((err) => {
      console.warn('[social] auth client init failed (board still works)', err);
    });
}
