/**
 * Tiny fixed-window rate limiter (no extra package).
 * One doc per key; windows roll every `windowMs`.
 */

import type { MutationCtx } from "../_generated/server";

type RateCtx = Pick<MutationCtx, "db">;

/**
 * Returns true if the call is allowed; false if over limit.
 * Call from mutations only (DB writes).
 */
export async function takeToken(
  ctx: RateCtx,
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = Date.now();
  const existing = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

  if (!existing || existing.windowStart + windowMs <= now) {
    if (existing) {
      await ctx.db.patch(existing._id, { windowStart: now, count: 1 });
    } else {
      await ctx.db.insert("rateLimits", {
        key,
        windowStart: now,
        count: 1,
      });
    }
    return true;
  }

  if (existing.count >= limit) {
    return false;
  }

  await ctx.db.patch(existing._id, { count: existing.count + 1 });
  return true;
}
