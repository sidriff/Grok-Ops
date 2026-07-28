import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Current player profile for the menu column, or null if signed out.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      handle: v.string(),
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      bestKills: v.optional(v.number()),
      bestTimeSurvived: v.optional(v.number()),
      bestAlliesAlive: v.optional(v.number()),
      bestWon: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const user = await ctx.db.get(userId);
    if (user === null) return null;

    const best = await ctx.db
      .query("scores")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const handle =
      (user.handle && user.handle.trim()) ||
      (user.name && user.name.trim()) ||
      "operator";

    return {
      handle: handle.replace(/^@/, ""),
      name: user.name,
      image: user.image,
      bestKills: best?.kills,
      bestTimeSurvived: best?.timeSurvived,
      bestAlliesAlive: best?.alliesAlive,
      bestWon: best?.won,
    };
  },
});
