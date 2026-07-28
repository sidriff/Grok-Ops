import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  combatPointsFromKills,
  computeScore,
} from "./lib/score";
import { takeToken } from "./lib/rateLimit";

/** Rows shown in the menu column. */
const BOARD_DISPLAY = 25;
/** Hard cap — prune anything below the 100th score. */
const BOARD_KEEP = 100;
/** ~5 min match, absurd headshot farm — still client-trusted, just not infinite. */
const MAX_COMBAT_POINTS = 50_000;
/** Submit spam per signed-in user (mutations still cost free-plan calls). */
const SUBMIT_LIMIT = 20;
const SUBMIT_WINDOW_MS = 60_000;

export { computeScore, combatPointsFromKills };

const entryValidator = v.object({
  rank: v.number(),
  handle: v.string(),
  name: v.optional(v.string()),
  image: v.optional(v.string()),
  kills: v.number(),
  combatPoints: v.number(),
  timeSurvived: v.number(),
  alliesAlive: v.number(),
  score: v.number(),
  won: v.boolean(),
  isYou: v.boolean(),
});

/**
 * Public top board, sorted by score desc. Always available without login.
 */
export const list = query({
  args: {},
  returns: v.array(entryValidator),
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    const rows = await ctx.db
      .query("scores")
      .withIndex("by_score")
      .order("desc")
      .take(BOARD_DISPLAY);

    return rows.map((row, i) => {
      const alliesAlive = row.alliesAlive ?? 0;
      const combatPoints =
        row.combatPoints ??
        combatPointsFromKills(row.kills ?? 0, Math.floor((row.kills ?? 0) * 0.3));
      const score =
        row.score ??
        computeScore(row.timeSurvived ?? 0, combatPoints, alliesAlive);
      return {
        rank: i + 1,
        handle: row.handle,
        name: row.name,
        image: row.image,
        kills: row.kills ?? 0,
        combatPoints,
        timeSurvived: row.timeSurvived ?? 0,
        alliesAlive,
        score,
        won: row.won,
        isYou: me !== null && row.userId === me,
      };
    });
  },
});

/** Drop ranks worse than the 100th score so the table stays bounded. */
async function pruneToTop(ctx: { db: any }) {
  const kept = await ctx.db
    .query("scores")
    .withIndex("by_score")
    .order("desc")
    .take(BOARD_KEEP);

  if (kept.length < BOARD_KEEP) return;

  const cutoff = kept[kept.length - 1].score;
  const tail = await ctx.db
    .query("scores")
    .withIndex("by_score")
    .order("asc")
    .take(200);

  for (const row of tail) {
    if (row.score < cutoff) {
      await ctx.db.delete(row._id);
    }
  }
}

/**
 * Upsert personal best for the signed-in player.
 */
export const submit = mutation({
  args: {
    kills: v.number(),
    combatPoints: v.number(),
    timeSurvived: v.number(),
    alliesAlive: v.number(),
    won: v.boolean(),
  },
  returns: v.object({
    ok: v.boolean(),
    improved: v.boolean(),
    score: v.number(),
    reason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, improved: false, score: 0, reason: "not_authenticated" };
    }

    const allowed = await takeToken(
      ctx,
      `submit:${userId}`,
      SUBMIT_LIMIT,
      SUBMIT_WINDOW_MS,
    );
    if (!allowed) {
      return { ok: false, improved: false, score: 0, reason: "rate_limited" };
    }

    const user = await ctx.db.get(userId);
    if (user === null) {
      return { ok: false, improved: false, score: 0, reason: "no_user" };
    }

    const kills = Math.max(0, Math.min(500, Math.floor(args.kills)));
    const combatPoints = Math.max(
      0,
      Math.min(MAX_COMBAT_POINTS, Math.floor(args.combatPoints)),
    );
    const timeSurvived = Math.max(0, Math.min(600, args.timeSurvived));
    const alliesAlive = Math.max(0, Math.min(3, Math.floor(args.alliesAlive)));
    const won = !!args.won;
    const score = computeScore(timeSurvived, combatPoints, alliesAlive);

    const handle =
      (user.handle && user.handle.trim()) ||
      (user.name && user.name.trim()) ||
      "operator";

    const existing = await ctx.db
      .query("scores")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const payload = {
      userId,
      handle: handle.replace(/^@/, "").slice(0, 32),
      name: user.name,
      image: user.image,
      score,
      kills,
      combatPoints,
      timeSurvived,
      alliesAlive,
      won,
    };

    if (existing === null) {
      await ctx.db.insert("scores", payload);
      await pruneToTop(ctx);
      return { ok: true, improved: true, score };
    }

    if (score > existing.score) {
      await ctx.db.patch(existing._id, payload);
      await pruneToTop(ctx);
      return { ok: true, improved: true, score };
    }

    if (
      existing.handle !== payload.handle ||
      existing.name !== payload.name ||
      existing.image !== payload.image
    ) {
      await ctx.db.patch(existing._id, {
        handle: payload.handle,
        name: payload.name,
        image: payload.image,
      });
    }

    return { ok: true, improved: false, score: existing.score };
  },
});

// Seeds die early — none past 2:00 so real players can own the board.
const FAKE_OPS = [
  // Don't use real handles (e.g. sidriff) — collisions with live OAuth users.
  { handle: "si_seed", name: "Si", kills: 14, headshots: 6, time: 118, allies: 2, won: false },
  { handle: "ghostwire", name: "Ghost", kills: 11, headshots: 3, time: 97, allies: 1, won: false },
  { handle: "rattlecan", name: "Rattle", kills: 9, headshots: 2, time: 84, allies: 1, won: false },
  { handle: "lowpoly_dave", name: "Dave", kills: 16, headshots: 7, time: 112, allies: 2, won: false },
  { handle: "bytebarrel", name: "Byte", kills: 7, headshots: 1, time: 51, allies: 0, won: false },
  { handle: "haze_runner", name: "Haze", kills: 13, headshots: 5, time: 105, allies: 2, won: false },
  { handle: "clip_eater", name: "Clip", kills: 5, headshots: 1, time: 38, allies: 0, won: false },
  { handle: "nullref", name: "Null", kills: 10, headshots: 3, time: 73, allies: 1, won: false },
  { handle: "ashtrail", name: "Ash", kills: 4, headshots: 0, time: 27, allies: 0, won: false },
  { handle: "v0x_ops", name: "Vox", kills: 12, headshots: 4, time: 91, allies: 1, won: false },
] as const;

/**
 * Idempotent seed — inserts 10 demo operators if the board is empty.
 * INTERNAL ONLY (not callable from the browser). Run from CLI:
 *   npx convex run scores:seedDemo '{"force":true}'
 */
export const seedDemo = internalMutation({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({
    inserted: v.number(),
    skipped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (!args.force) {
      const any = await ctx.db.query("scores").take(1);
      if (any.length > 0) {
        return { inserted: 0, skipped: true };
      }
    } else {
      const all = await ctx.db.query("scores").take(500);
      for (const row of all) {
        if (row.isSeed) await ctx.db.delete(row._id);
      }
      const users = await ctx.db.query("users").take(500);
      for (const u of users) {
        if (u.isSeed) await ctx.db.delete(u._id);
      }
    }

    let inserted = 0;
    for (const op of FAKE_OPS) {
      const userId = await ctx.db.insert("users", {
        name: op.name,
        handle: op.handle,
        isSeed: true,
      });
      const combatPoints = combatPointsFromKills(op.kills, op.headshots);
      const score = computeScore(op.time, combatPoints, op.allies);
      await ctx.db.insert("scores", {
        userId,
        handle: op.handle,
        name: op.name,
        score,
        kills: op.kills,
        combatPoints,
        timeSurvived: op.time,
        alliesAlive: op.allies,
        won: op.won,
        isSeed: true,
      });
      inserted++;
    }
    await pruneToTop(ctx);
    return { inserted, skipped: false };
  },
});

export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await pruneToTop(ctx);
    return null;
  },
});
