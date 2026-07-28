/**
 * Vanilla (non-React) Convex Auth client for OAuth + session storage.
 * Mirrors the flow in @convex-dev/auth/react without pulling React in.
 */

import { ConvexClient, ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import { getConvexUrl } from './config.js';
import {
  OAUTH_MSG_TYPE,
  OAUTH_CHANNEL,
  OAUTH_HANDOFF_KEY,
  openOAuthPopup,
} from './oauth-popup.js';

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
    this._oauthBusy = false;
    this._oauthWaiters = [];
    this._bc = null;
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
      /* ignore */
    }
  }

  /**
   * Persist tokens and re-auth the WebSocket (must re-call setAuth — Convex
   * only picks up a new identity when setConfig runs again).
   * @param {{ token: string, refreshToken?: string } | null} tokens
   */
  async _setTokens(tokens) {
    if (!tokens) {
      this._token = null;
      this._remove(JWT_KEY);
      this._remove(REFRESH_KEY);
      this.http.clearAuth?.();
      this.me = null;
    } else {
      this._token = tokens.token;
      this._set(JWT_KEY, tokens.token);
      if (tokens.refreshToken) this._set(REFRESH_KEY, tokens.refreshToken);
      try {
        this.http.setAuth(tokens.token);
      } catch {
        /* ignore */
      }
    }
    this._wireAuth();
    this._emit();
    // Pull profile immediately so the UI can show name/avatar without waiting
    // for the first authenticated WS transition.
    if (this._token) {
      await this._refreshMe();
    }
  }

  _wireAuth() {
    // Always re-register — setAuth/setConfig re-auths the socket with current token.
    this.client.setAuth(async ({ forceRefreshToken }) => {
      if (forceRefreshToken) {
        const refreshToken = this._get(REFRESH_KEY);
        if (refreshToken) {
          try {
            const result = await this.http.action(api.auth.signIn, { refreshToken });
            if (result?.tokens) {
              this._token = result.tokens.token;
              this._set(JWT_KEY, result.tokens.token);
              if (result.tokens.refreshToken) {
                this._set(REFRESH_KEY, result.tokens.refreshToken);
              }
              try {
                this.http.setAuth(result.tokens.token);
              } catch {
                /* ignore */
              }
              return result.tokens.token;
            }
            await this._setTokens(null);
            return null;
          } catch (err) {
            console.warn('[social] token refresh failed', err);
            await this._setTokens(null);
            return null;
          }
        }
        return null;
      }
      return this._token;
    });
  }

  async _refreshMe() {
    if (!this._token) {
      this.me = null;
      this._ready = true;
      this._emit();
      return;
    }
    try {
      this.http.setAuth(this._token);
      const me = await this.http.query(api.users.me, {});
      this.me = me ?? null;
      this._ready = true;
      this.error = null;
      this._emit();
    } catch (err) {
      console.warn('[social] me fetch failed', err);
      this._ready = true;
      this._emit();
    }
  }

  _applyBoard(board) {
    this.board = Array.isArray(board) ? board : [];
    this._boardLoaded = true;
    this.error = null;
    this._emit();
  }

  /**
   * Boot session: HTTP fetch board first, then live WS + OAuth listeners.
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

    // Full-page OAuth return (fallback if popup blocked / handoff failed).
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) {
      const url = new URL(location.href);
      url.searchParams.delete('code');
      history.replaceState({}, '', url.pathname + url.search + url.hash);
      try {
        await this._exchangeCode(code);
      } catch (err) {
        console.error('[social] OAuth code exchange failed', err);
        this.error = String(err?.message ?? err);
        this._emit();
      }
    } else {
      const token = this._get(JWT_KEY);
      if (token) {
        this._token = token;
        try {
          this.http.setAuth(token);
        } catch {
          /* ignore */
        }
        this._wireAuth();
        await this._refreshMe();
      }
    }

    // Popup OAuth: postMessage + BroadcastChannel + localStorage handoff.
    this._onOAuthMessage = (ev) => {
      if (ev.origin && ev.origin !== location.origin) return;
      const data = ev.data;
      if (!data || data.type !== OAUTH_MSG_TYPE) return;
      void this._onPopupOAuthMessage(data);
    };
    window.addEventListener('message', this._onOAuthMessage);

    try {
      this._bc = new BroadcastChannel(OAUTH_CHANNEL);
      this._bc.onmessage = (ev) => {
        const data = ev.data;
        if (!data || data.type !== OAUTH_MSG_TYPE) return;
        void this._onPopupOAuthMessage(data);
      };
    } catch {
      this._bc = null;
    }

    this._onStorage = (ev) => {
      if (ev.key === OAUTH_HANDOFF_KEY && ev.newValue) {
        try {
          const data = JSON.parse(ev.newValue);
          if (data?.type === OAUTH_MSG_TYPE) {
            void this._onPopupOAuthMessage(data);
          }
        } catch {
          /* ignore */
        }
        try {
          localStorage.removeItem(OAUTH_HANDOFF_KEY);
        } catch {
          /* ignore */
        }
        return;
      }
      // Sibling window wrote JWT (e.g. exchange ran in popup).
      if (ev.key === this._sk(JWT_KEY) && ev.newValue && ev.newValue !== this._token) {
        this._token = ev.newValue;
        try {
          this.http.setAuth(ev.newValue);
        } catch {
          /* ignore */
        }
        this._wireAuth();
        void this._refreshMe();
      }
    };
    window.addEventListener('storage', this._onStorage);

    // Drain a handoff left if we missed the storage event (race).
    try {
      const raw = localStorage.getItem(OAUTH_HANDOFF_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        localStorage.removeItem(OAUTH_HANDOFF_KEY);
        if (data?.type === OAUTH_MSG_TYPE) {
          void this._onPopupOAuthMessage(data);
        }
      }
    } catch {
      /* ignore */
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

  async _exchangeCode(code) {
    const verifier = this._get(VERIFIER_KEY) ?? undefined;
    this._remove(VERIFIER_KEY);
    const result = await this.http.action(api.auth.signIn, {
      params: { code },
      verifier,
    });
    if (result?.tokens) {
      await this._setTokens(result.tokens);
      return true;
    }
    throw new Error('No tokens returned from sign-in');
  }

  async _onPopupOAuthMessage(data) {
    if (this._oauthBusy) return;
    const dedupeKey =
      data.tokens?.token || data.ticket || data.code || data.error || data.ts;
    if (dedupeKey && dedupeKey === this._lastOAuthKey) return;
    if (dedupeKey) this._lastOAuthKey = dedupeKey;

    this._oauthBusy = true;
    try {
      if (data.error) {
        const msg = data.errorDescription || data.error || 'X login cancelled';
        console.warn('[social] OAuth error', msg);
        this.error = msg;
        this._emit();
        return;
      }
      if (data.tokens?.token) {
        await this._setTokens(data.tokens);
        console.info('[social] signed in via popup tokens');
        return;
      }
      // OAuth 1.0a one-time ticket (preferred free path).
      if (data.ticket) {
        await this.signInWithTicket(data.ticket);
        return;
      }
      if (data.code) {
        await this._exchangeCode(data.code);
        console.info('[social] signed in via popup code');
        return;
      }
      const token = this._get(JWT_KEY);
      if (token && token !== this._token) {
        this._token = token;
        try {
          this.http.setAuth(token);
        } catch {
          /* ignore */
        }
        this._wireAuth();
        await this._refreshMe();
      }
    } catch (err) {
      console.error('[social] popup OAuth complete failed', err);
      this.error = String(err?.message ?? err);
      this._emit();
    } finally {
      this._oauthBusy = false;
      for (const w of this._oauthWaiters.splice(0)) {
        try {
          w();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Finish OAuth 1.0a after popup returns with x_ticket (or handoff).
   * @param {string} ticket
   */
  async signInWithTicket(ticket) {
    if (!ticket) throw new Error('Missing login ticket');
    const result = await this.http.action(api.auth.signIn, {
      provider: 'x-oauth1',
      params: { ticket },
    });
    if (result?.tokens) {
      await this._setTokens(result.tokens);
      console.info('[social] signed in via X OAuth 1.0a');
      return;
    }
    throw new Error('Sign-in did not return a session');
  }

  /**
   * Real X login (OAuth 1.0a popup) — free tier, verified @handle.
   * Uses Consumer API Key/Secret, not OAuth 2 Client ID.
   */
  async signInWithX() {
    try {
      const { url } = await this.client.action(api.twitterOAuth1.start, {});
      const popup = openOAuthPopup(url);
      if (!popup) {
        console.warn('[social] popup blocked; full-page redirect');
        location.href = url;
        return;
      }

      await new Promise((resolve) => {
        this._oauthWaiters.push(resolve);
        const poll = setInterval(() => {
          if (popup.closed) {
            clearInterval(poll);
            resolve();
          }
        }, 400);
        setTimeout(() => {
          clearInterval(poll);
          resolve();
        }, 180000);
      });

      if (!this._token) {
        const token = this._get(JWT_KEY);
        if (token) {
          this._token = token;
          this._wireAuth();
          await this._refreshMe();
        }
      }
    } catch (err) {
      console.error('[social] X OAuth 1.0a failed', err);
      const msg = String(err?.message ?? err);
      if (/CONSUMER|Missing AUTH_TWITTER/i.test(msg)) {
        throw new Error(
          'Set AUTH_TWITTER_CONSUMER_KEY + AUTH_TWITTER_CONSUMER_SECRET on Convex (API Key + Secret from X Keys page).',
        );
      }
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
    if (this._onOAuthMessage) {
      window.removeEventListener('message', this._onOAuthMessage);
      this._onOAuthMessage = null;
    }
    if (this._onStorage) {
      window.removeEventListener('storage', this._onStorage);
      this._onStorage = null;
    }
    try {
      this._bc?.close?.();
    } catch {
      /* ignore */
    }
    this._bc = null;
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
