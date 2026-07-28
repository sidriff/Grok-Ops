/**
 * Online social layer — X login + Convex leaderboard.
 * Boot entry is src/social/boot.js (loaded from index.html before the game).
 */

export { createSocial, SocialAuth } from './auth.js';
export { bindLeaderboard } from './leaderboard.js';
export { fetchLeaderboard, convexUrlFromEnv } from './board-fetch.js';
