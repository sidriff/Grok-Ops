/**
 * OAuth popup helpers.
 *
 * X → Convex → SITE_URL often severs `window.opener` (COOP). We never rely on
 * it alone: BroadcastChannel + localStorage handoff notify the game tab even
 * when opener is null. The popup must NOT boot the game.
 */

const MSG_TYPE = 'grok-ops-oauth';
const CHANNEL_NAME = 'grok-ops-oauth';
const HANDOFF_KEY = '__grokOpsOAuthHandoff';

/**
 * If this window is an OAuth return (?code= / ?error=), hand off and stay blank.
 * @returns {boolean} true → do not load the game
 */
export function handleOAuthPopupCallback() {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const error = params.get('error');
    const errorDesc = params.get('error_description');

    if (!code && !error) return false;

    const payload = {
      type: MSG_TYPE,
      code: code || null,
      error: error || null,
      errorDescription: errorDesc || null,
      ts: Date.now(),
    };

    // 1) Same-origin BroadcastChannel — works even when opener is null.
    try {
      const bc = new BroadcastChannel(CHANNEL_NAME);
      bc.postMessage(payload);
      bc.close();
    } catch {
      /* older browsers */
    }

    // 2) localStorage → storage event on the opener tab (same origin).
    try {
      localStorage.setItem(HANDOFF_KEY, JSON.stringify(payload));
      // Nudge listeners that only fire on *change*: write, clear, rewrite.
      localStorage.removeItem(HANDOFF_KEY);
      localStorage.setItem(HANDOFF_KEY, JSON.stringify(payload));
    } catch {
      /* private mode */
    }

    // 3) Classic postMessage if opener still linked.
    if (window.opener && !window.opener.closed) {
      try {
        window.opener.postMessage(payload, location.origin);
      } catch {
        /* ignore */
      }
    }

    // Clean URL + minimal “closing” page (never load game assets).
    try {
      history.replaceState({}, '', location.pathname);
    } catch {
      /* ignore */
    }
    document.title = 'Signed in — closing…';
    document.documentElement.innerHTML = `<head><meta charset="utf-8"><title>Signed in</title></head>
<body style="margin:0;background:#05070a;color:#e8eef2;font:600 14px/1.4 system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;letter-spacing:.08em;text-transform:uppercase">
  <p style="opacity:.85">Signed in — you can close this window</p>
</body>`;

    const tryClose = () => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    };
    tryClose();
    setTimeout(tryClose, 50);
    setTimeout(tryClose, 250);
    setTimeout(tryClose, 800);

    return true;
  } catch (err) {
    console.warn('[social] oauth popup handoff failed', err);
    // Still block game boot if we clearly have OAuth params.
    try {
      const p = new URLSearchParams(location.search);
      if (p.get('code') || p.get('error')) return true;
    } catch {
      /* ignore */
    }
    return false;
  }
}

export { MSG_TYPE as OAUTH_MSG_TYPE, CHANNEL_NAME as OAUTH_CHANNEL, HANDOFF_KEY as OAUTH_HANDOFF_KEY };

/**
 * Open a centered popup for the OAuth provider URL.
 * @param {string} url
 * @returns {Window | null}
 */
export function openOAuthPopup(url) {
  const w = 520;
  const h = 720;
  const left = Math.max(0, (screen.width - w) / 2 + (screen.availLeft || 0));
  const top = Math.max(0, (screen.height - h) / 2 + (screen.availTop || 0));
  const features = [
    `width=${w}`,
    `height=${h}`,
    `left=${left}`,
    `top=${top}`,
    'menubar=no',
    'toolbar=no',
    'location=yes',
    'status=no',
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
  const popup = window.open(url, 'grok_ops_x_login', features);
  if (popup) {
    try {
      popup.focus();
    } catch {
      /* ignore */
    }
  }
  return popup;
}
