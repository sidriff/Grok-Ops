/** Kill scoring — headshots pay more than body shots. */
export const BODY_KILL_PTS = 100;
export const HEADSHOT_KILL_PTS = 150;

/**
 * Rank key. Higher is better.
 *
 * score = (floor(timeSurvived) + combatPoints) × max(1, alliesAlive)
 *
 * Ally mult never drops below 1 so a wiped squad still posts a score.
 * combatPoints come from in-match awards (kills, headshots, etc.) — not kill count alone.
 */
export function computeScore(
  timeSurvived: number,
  combatPoints: number,
  alliesAlive: number,
): number {
  const t = Math.max(0, Math.floor(timeSurvived));
  const p = Math.max(0, Math.floor(combatPoints));
  const a = Math.max(1, Math.min(3, Math.floor(alliesAlive)));
  return (t + p) * a;
}

/** Points awarded for a single kill. */
export function killPoints(headshot: boolean): number {
  return headshot ? HEADSHOT_KILL_PTS : BODY_KILL_PTS;
}

/** Derive combat points from kill/headshot counts (for seeds / fallbacks). */
export function combatPointsFromKills(kills: number, headshots: number): number {
  const k = Math.max(0, Math.floor(kills));
  const h = Math.max(0, Math.min(k, Math.floor(headshots)));
  return (k - h) * BODY_KILL_PTS + h * HEADSHOT_KILL_PTS;
}
