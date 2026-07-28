/**
 * Lightweight OAuth callback handler for popup windows.
 *
 * When X redirects back to SITE_URL?code=… inside a popup, this module
 * postMessages the code to the opener and closes — the main game never unloads.
 */

const MSG_TYPE = 'grok-ops-oauth';

/**
 * If this window is an OAuth popup landing with ?code=, hand it to the opener.
 * @returns {boolean} true if this page should stay blank / not boot the game
 */
export function handleOAuthPopupCallback() {
  try {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const error = params.get('error');
    const errorDesc = params.get('error_description');

    if (!code && !error) return false;
    if (!window.opener || window.opener.closed) return false;

    const origin = location.origin;
    window.opener.postMessage(
      {
        type: MSG_TYPE,
        code: code || null,
        error: error || null,
        errorDescription: errorDesc || null,
      },
      origin,
    );

    // Clean URL then close — brief "signed in" flash if close is blocked.
    history.replaceState({}, '', location.pathname);
    document.title = 'Signed in — closing…';
    document.body.innerHTML =
      '<p style="font:14px system-ui;color:#ddd;background:#0a0c10;margin:0;padding:2rem;min-height:100vh">Signed in. You can close this window.</p>';
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 120);
    return true;
  } catch (err) {
    console.warn('[social] oauth popup handoff failed', err);
    return false;
  }
}

export { MSG_TYPE as OAUTH_MSG_TYPE };

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
