/**
 * Vanilla (non-React) Convex Auth client for OAuth + session storage.
 * Mirrors the flow in @convex-dev/auth/react without pulling React in.
 */

import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import { getConvexUrl } from './config.js';

const JWT_KEY = '__convexAuthJWT';
const REFRESH_KEY = '__convexAuthRefreshToken';
const VERIFIER_KEY = '__convexAuthOAuthVerifier';

/**
 * @typedef {object} SocialUser
 * @property {string} handle
 * @property {string} [name]
 * @property {string} [image]
 * @property {number} [bestKills]
 * @property {number} [bestTimeSurvived]
 * @property {number} [bestAlliesAlive]
 * @property {boolean} [bestWon]
 */

/**
 * @typedef {object} BoardEntry
 * @property {number} rank
 * @property {string} handle
 * @property {string} [name]
 * @property {string} [image]
 * @property {number} kills
 * @property {number} timeSurvived
 * @property {number} alliesAlive
 * @property {boolean} won
 * @property {boolean} isYou
 */

export class SocialAuth {
  /**
   * @param {string} convexUrl
   */
  constructor(convexUrl) {
    this.url = convexUrl;
    this.client = new ConvexClient(convexUrl);
    this.http = new ConvexHttpClient(convexUrl);
    this._ns = convexUrl.replace(/[^a-zA-Z0-9]/g, '');
    this._token = null;
    this._ready = false;
    this._boardLoaded = false;
    this._listeners = new Set();
    /** @type {SocialUser | null} */
    this.me = null;
    /** @type {BoardEntry[]} */
    this.board = [];
    /** @type {string | null} */
    this.error = null;
    this._unsubBoard = null;
    this._unsubMe = null;
    this._authWired = false;
  }

  get ready() {
    return this._ready;
  }

  get isAuthenticated() {
    return this._token !== null;
  }

  /**
   * @param {(state: {
   *   me: SocialUser | null,
   *   board: BoardEntry[],
   *   ready: boolean,
   *   boardLoaded: boolean,
   *   error: string | null,
   *   isAuthenticated: boolean,
   * }) => void} fn
   * @returns {() => void}
   */
  subscribe(fn) {
    this._listeners.add(fn);
    fn(this._snapshot());
    return () => this._listeners.delete(fn);
  }

  _snapshot() {
    return {
      me: this.me,
      board: this.board,
      ready: this._ready,
      boardLoaded: this._boardLoaded,
      error: this.error,
      isAuthenticated: this.isAuthenticated,
    };
  }

  _emit() {
    const snap = this._snapshot();
    for (const fn of this._listeners) {
      try {
        fn(snap);
      } catch (err) {
        console.warn('[social] listener error', err);
      }
    }
  }

  _sk(key) {
    return `${key}_${this._ns}`;
  }

  _get(key) {
    try {
      return localStorage.getItem(this._sk(key));
    } catch {
      return null;
    }
  }

  _set(key, value) {
    try {
      localStorage.setItem(this._sk(key), value);
    } catch {
      /* private mode */
    }
  }

  _remove(key) {
    try {
      localStorage.removeItem(this._sk(key));
    } catch {
      /* private mode */
    }
  }

  async _setTokens(tokens) {
    if (!tokens) {
      this._token = null;
      this._remove(JWT_KEY);
      this._remove(REFRESH_KEY);
    } else {
      this._token = tokens.token;
      this._set(JWT_KEY, tokens.token);
      if (tokens.refreshToken) this._set(REFRESH_KEY, tokens.refreshToken);
    }
    this._wireAuth();
    this._emit();
  }

  _wireAuth() {
    if (this._authWired) return;
    this._authWired = true;
    this.client.setAuth(async ({ forceRefreshToken }) => {
      if (forceRefreshToken) {
        const refreshToken = this._get(REFRESH_KEY);
        if (refreshToken) {
          try {
            const result = await this.http.action(api.auth.signIn, { refreshToken });
            if (result?.tokens) {
              await this._setTokens(result.tokens);
            } else {
              await this._setTokens(null);
            }
          } catch (err) {
            console.warn('[social] token refresh failed', err);
            await this._setTokens(null);
          }
        } else {
          return null;
        }
      }
      return this._token;
    });
  }

  _applyBoard(board) {
    this.board = Array.isArray(board) ? board : [];
    this._boardLoaded = true;
    this.error = null;
    this._emit();
  }

  /**
   * Boot session: HTTP fetch board first (reliable), then live WS subscription.
   * Consume OAuth `?code=` if present, else restore JWT from storage.
   */
  async init() {
    this._wireAuth();

    // 1) Immediate HTTP pull so the menu isn't empty while WS connects.
    try {
      const board = await this.http.query(api.scores.list, {});
      this._applyBoard(board);
    } catch (err) {
      console.error('[social] board fetch failed', err);
      this.error = String(err?.message ?? err);
      this._boardLoaded = true;
      this._emit();
    }

    // 2) Live updates over WebSocket.
    this._unsubBoard = this.client.onUpdate(
      api.scores.list,
      {},
      (board) => this._applyBoard(board),
      (err) => {
        console.error('[social] board subscription error', err);
        this.error = String(err?.message ?? err);
        this._emit();
      },
    );

    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      history.replaceState({}, '', url.pathname + url.search + url.hash);

      const verifier = this._get(VERIFIER_KEY) ?? undefined;
      this._remove(VERIFIER_KEY);
      try {
        const result = await this.http.action(api.auth.signIn, {
          params: { code },
          verifier,
        });
        if (result?.tokens) await this._setTokens(result.tokens);
      } catch (err) {
        console.error('[social] OAuth code exchange failed', err);
      }
    } else {
      const token = this._get(JWT_KEY);
      if (token) {
        this._token = token;
        this._wireAuth();
      }
    }

    this._unsubMe = this.client.onUpdate(
      api.users.me,
      {},
      (me) => {
        this.me = me ?? null;
        this._ready = true;
        this._emit();
      },
      (err) => {
        console.warn('[social] me subscription error', err);
        this._ready = true;
        this._emit();
      },
    );

    if (!this._token) {
      this._ready = true;
      this._emit();
    }
  }

  /** Start X OAuth redirect. */
  async signInWithX() {
    try {
      const result = await this.client.action(api.auth.signIn, {
        provider: 'twitter',
        params: {},
      });
      if (result?.redirect) {
        if (result.verifier) this._set(VERIFIER_KEY, result.verifier);
        location.href = result.redirect;
        return;
      }
      if (result?.tokens) {
        await this._setTokens(result.tokens);
      }
    } catch (err) {
      console.error('[social] signIn failed', err);
      throw err;
    }
  }

  async signOut() {
    try {
      await this.client.action(api.auth.signOut, {});
    } catch {
      /* already signed out */
    }
    await this._setTokens(null);
    this.me = null;
    this._emit();
  }

  /**
   * Post personal best after a match. No-op if signed out.
   * @param {{ kills: number, combatPoints?: number, timeSurvived: number, alliesAlive?: number, won: boolean }} payload
   */
  async submitScore(payload) {
    if (!this._token) {
      return { ok: false, improved: false, reason: 'not_authenticated' };
    }
    try {
      return await this.client.mutation(api.scores.submit, {
        kills: payload.kills ?? 0,
        combatPoints: payload.combatPoints ?? 0,
        timeSurvived: payload.timeSurvived ?? 0,
        alliesAlive: payload.alliesAlive ?? 0,
        won: !!payload.won,
      });
    } catch (err) {
      console.error('[social] submitScore failed', err);
      return { ok: false, improved: false, reason: String(err?.message ?? err) };
    }
  }

  dispose() {
    this._unsubBoard?.();
    this._unsubMe?.();
    this._unsubBoard = null;
    this._unsubMe = null;
    this.client.close?.();
    this._listeners.clear();
  }
}

/**
 * Create social auth if VITE_CONVEX_URL is configured; otherwise null.
 * @returns {SocialAuth | null}
 */
export function createSocial() {
  const url = getConvexUrl();
  if (!url) {
    console.info('[social] no Convex URL — leaderboard offline');
    return null;
  }
  return new SocialAuth(url);
}
