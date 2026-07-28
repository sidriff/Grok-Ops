/**
 * App entry — kept as a real file (not an inline index.html script) so Vite
 * never invents a fragile `?html-proxy&index=0.js` virtual module. That proxy
 * tends to break after HTML edits / dual-server restarts with the overlay:
 *   "No matching HTML proxy module found"
 *
 * If this window is the X OAuth popup callback (?code=…), hand the code to the
 * opener and exit — never load the game. Otherwise boot the leaderboard (title
 * shell) and the deferred game entry.
 */
import { handleOAuthPopupCallback } from './social/oauth-popup.js';

if (!handleOAuthPopupCallback()) {
  import('./social/boot.js');
  import('./main.js');
}
