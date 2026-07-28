import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Auth tables from @convex-dev/auth, plus app tables.
 * users is extended with X handle for leaderboard display.
 */
export default defineSchema({
  ...authTables,

  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    /** X / Twitter @handle (no @ prefix). */
    handle: v.optional(v.string()),
    /** Seed / demo rows — not real OAuth users. */
    isSeed: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("handle", ["handle"]),

  /**
   * One personal-best row per user. Board keeps top 100 by score.
   *
   * score = (floor(time) + combatPoints) × max(1, alliesAlive)
   */
  scores: defineTable({
    userId: v.id("users"),
    handle: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    score: v.number(),
    kills: v.number(),
    /** In-match points (headshots pay more than body kills). */
    combatPoints: v.optional(v.number()),
    timeSurvived: v.number(),
    alliesAlive: v.number(),
    won: v.boolean(),
    isSeed: v.optional(v.boolean()),
  })
    .index("by_score", ["score"])
    .index("by_user", ["userId"]),

  /**
   * Short-lived OAuth 1.0a request tokens + one-time login tickets.
   * oauthToken doubles as ticket id for kind "ticket".
   */
  twitterOAuth1: defineTable({
    kind: v.union(v.literal("request"), v.literal("ticket")),
    oauthToken: v.string(),
    oauthTokenSecret: v.string(),
    twitterUserId: v.optional(v.string()),
    handle: v.optional(v.string()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    expiresAt: v.number(),
  }).index("by_token", ["oauthToken"]),

  /** Fixed-window counters for public/auth spam protection. */
  rateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
});
