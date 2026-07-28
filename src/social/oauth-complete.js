/**
 * Finish OAuth in the callback window (popup).
 *
 * OAuth 1.0a lands with ?x_ticket=… (or error=).
 * Legacy OAuth 2 may still land with ?code=.
 */

import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import { getConvexUrl } from './config.js';
import {
  OAUTH_MSG_TYPE,
  OAUTH_CHANNEL,
  OAUTH_HANDOFF_KEY,
} from './oauth-popup.js';

const JWT_KEY = '__convexAuthJWT';
const REFRESH_KEY = '__convexAuthRefreshToken';
const VERIFIER_KEY = '__convexAuthOAuthVerifier';

function nsFor(url) {
  return url.replace(/[^a-zA-Z0-9]/g, '');
}

function sk(url, key) {
  return `${key}_${nsFor(url)}`;
}

function paint(msg, isError = false) {
  document.title = isError ? 'Sign-in failed' : 'Signed in — closing…';
  const color = isError ? '#ff8a7a' : '#e8eef2';
  document.documentElement.innerHTML = `<head><meta charset="utf-8"><title>${document.title}</title></head>
<body style="margin:0;background:#05070a;color:${color};font:600 14px/1.45 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;letter-spacing:.06em;text-align:center;padding:2rem">
  <div>
    <p style="margin:0 0 .75rem;text-transform:uppercase">${msg}</p>
    <p style="margin:0;font-size:12px;opacity:.55;font-weight:500;letter-spacing:.04em;text-transform:none">You can close this window.</p>
  </div>
</body>`;
}

function broadcast(payload) {
  try {
    const bc = new BroadcastChannel(OAUTH_CHANNEL);
    bc.postMessage(payload);
    bc.close();
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(OAUTH_HANDOFF_KEY, JSON.stringify(payload));
    localStorage.removeItem(OAUTH_HANDOFF_KEY);
    localStorage.setItem(OAUTH_HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
  if (window.opener && !window.opener.closed) {
    try {
      window.opener.postMessage(payload, location.origin);
    } catch {
      /* ignore */
    }
  }
}

function tryClose() {
  const go = () => {
    try {
      window.close();
    } catch {
      /* ignore */
    }
  };
  go();
  setTimeout(go, 50);
  setTimeout(go, 300);
  setTimeout(go, 1000);
}

/**
 * @returns {Promise<boolean>} true if this window handled an OAuth return
 */
export async function completeOAuthIfPresent() {
  let params;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    return false;
  }

  const ticket = params.get('x_ticket');
  const code = params.get('code');
  const error = params.get('error');
  const errorDesc = params.get('error_description');
  const isNamedPopup = window.name === 'grok_ops_x_login';

  if (!ticket && !code && !error) {
    if (isNamedPopup) {
      paint('Sign-in didn’t finish — try again from the game', true);
      broadcast({
        type: OAUTH_MSG_TYPE,
        error: 'oauth_incomplete',
        errorDescription: 'Popup returned without a ticket',
        ts: Date.now(),
      });
      tryClose();
      return true;
    }
    return false;
  }

  try {
    history.replaceState({}, '', location.pathname);
  } catch {
    /* ignore */
  }

  if (error) {
    paint(errorDesc || error || 'Sign-in cancelled', true);
    broadcast({
      type: OAUTH_MSG_TYPE,
      error,
      errorDescription: errorDesc,
      ts: Date.now(),
    });
    tryClose();
    return true;
  }

  const isPopup =
    isNamedPopup || (typeof window.opener === 'object' && window.opener && !window.opener.closed);

  if (isPopup) paint('Signing you in…');

  const convexUrl = getConvexUrl();
  if (!convexUrl) {
    if (isPopup) {
      paint('Missing Convex URL', true);
      broadcast({ type: OAUTH_MSG_TYPE, error: 'no_convex_url', ts: Date.now() });
      tryClose();
      return true;
    }
    return false;
  }

  try {
    const http = new ConvexHttpClient(convexUrl);
    let tokens = null;

    if (ticket) {
      const result = await http.action(api.auth.signIn, {
        provider: 'x-oauth1',
        params: { ticket },
      });
      if (!result?.tokens?.token) throw new Error('No tokens from ticket sign-in');
      tokens = result.tokens;
    } else if (code) {
      let verifier = null;
      try {
        verifier = localStorage.getItem(sk(convexUrl, VERIFIER_KEY));
      } catch {
        /* ignore */
      }
      const result = await http.action(api.auth.signIn, {
        params: { code },
        verifier: verifier ?? undefined,
      });
      if (!result?.tokens?.token) throw new Error('No tokens from code exchange');
      tokens = result.tokens;
      try {
        localStorage.removeItem(sk(convexUrl, VERIFIER_KEY));
      } catch {
        /* ignore */
      }
    }

    if (!tokens?.token) throw new Error('No tokens');

    try {
      localStorage.setItem(sk(convexUrl, JWT_KEY), tokens.token);
      if (tokens.refreshToken) {
        localStorage.setItem(sk(convexUrl, REFRESH_KEY), tokens.refreshToken);
      }
    } catch {
      /* ignore */
    }

    const payload = {
      type: OAUTH_MSG_TYPE,
      tokens: {
        token: tokens.token,
        refreshToken: tokens.refreshToken,
      },
      ts: Date.now(),
    };
    broadcast(payload);

    if (isPopup) {
      paint('Signed in — closing…');
      tryClose();
      return true; // never boot the game in the popup
    }
    // Full-page return: tokens in storage — boot the game as usual.
    return false;
  } catch (err) {
    console.error('[social] OAuth complete failed', err);
    const msg = String(err?.message ?? err).slice(0, 160);
    broadcast({
      type: OAUTH_MSG_TYPE,
      error: 'exchange_failed',
      errorDescription: msg,
      ts: Date.now(),
    });
    if (isPopup) {
      paint(`Sign-in failed: ${msg}`, true);
      tryClose();
      return true;
    }
    return false;
  }
}
