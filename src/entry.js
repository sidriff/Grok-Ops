/**
 * App entry — real file (not inline html-proxy).
 *
 * OAuth popup returns here with ?code=… — finish sign-in in this window and
 * close; never boot the game. Otherwise load leaderboard + game.
 */
import { completeOAuthIfPresent } from './social/oauth-complete.js';

const handled = await completeOAuthIfPresent();
if (!handled) {
  import('./social/boot.js');
  import('./main.js');
}
