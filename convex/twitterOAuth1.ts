/**
 * Free X login via OAuth 1.0a.
 *
 * The access-token step returns user_id + screen_name in the body — no
 * /2/users/me call, so Free tier works (no $200 Basic).
 *
 * Env (Consumer Keys from the X app Keys page — not OAuth 2 Client ID):
 *   AUTH_TWITTER_CONSUMER_KEY
 *   AUTH_TWITTER_CONSUMER_SECRET
 *
 * Callback to register in X portal (add alongside any others):
 *   https://<deployment>.convex.site/api/auth/callback/twitter-oauth1
 */

import { v } from "convex/values";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { oauth1Request, parseForm } from "./lib/oauth1";
import { takeToken } from "./lib/rateLimit";

const REQUEST_TTL_MS = 15 * 60 * 1000;
const TICKET_TTL_MS = 2 * 60 * 1000;

function consumer() {
  const key = process.env.AUTH_TWITTER_CONSUMER_KEY;
  const secret = process.env.AUTH_TWITTER_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error(
      "Missing AUTH_TWITTER_CONSUMER_KEY / AUTH_TWITTER_CONSUMER_SECRET on Convex. " +
        "Use the API Key + API Secret (Consumer Keys) from the X app Keys page — not OAuth 2 Client ID.",
    );
  }
  return { key, secret };
}

function siteUrl() {
  const u = process.env.SITE_URL?.replace(/\/$/, "");
  if (!u) throw new Error("SITE_URL is not set on Convex");
  return u;
}

function callbackUrl() {
  const site = process.env.CONVEX_SITE_URL?.replace(/\/$/, "");
  if (!site) throw new Error("CONVEX_SITE_URL missing");
  return `${site}/api/auth/callback/twitter-oauth1`;
}

/** Global OAuth start budget — blocks scripted request_token spam on free plan. */
const START_LIMIT = 30;
const START_WINDOW_MS = 60_000;

export const saveRequestToken = internalMutation({
  args: {
    oauthToken: v.string(),
    oauthTokenSecret: v.string(),
  },
  handler: async (ctx, args) => {
    // Clear expired rows cheaply (small table).
    const old = await ctx.db.query("twitterOAuth1").take(50);
    const now = Date.now();
    for (const row of old) {
      if (row.expiresAt < now) await ctx.db.delete(row._id);
    }
    await ctx.db.insert("twitterOAuth1", {
      kind: "request",
      oauthToken: args.oauthToken,
      oauthTokenSecret: args.oauthTokenSecret,
      expiresAt: now + REQUEST_TTL_MS,
    });
  },
});

/** Shared fixed-window gate used by the public `start` action. */
export const checkStartRateLimit = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    return await takeToken(ctx, "oauth1:start", START_LIMIT, START_WINDOW_MS);
  },
});

export const takeRequestToken = internalMutation({
  args: { oauthToken: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("twitterOAuth1")
      .withIndex("by_token", (q) => q.eq("oauthToken", args.oauthToken))
      .unique();
    if (!row || row.kind !== "request" || row.expiresAt < Date.now()) {
      if (row) await ctx.db.delete(row._id);
      return null;
    }
    await ctx.db.delete(row._id);
    return { oauthTokenSecret: row.oauthTokenSecret };
  },
});

export const saveLoginTicket = internalMutation({
  args: {
    ticket: v.string(),
    twitterUserId: v.string(),
    handle: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("twitterOAuth1", {
      kind: "ticket",
      oauthToken: args.ticket,
      oauthTokenSecret: "",
      twitterUserId: args.twitterUserId,
      handle: args.handle,
      name: args.name,
      image: args.image,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
  },
});

export const consumeLoginTicket = internalMutation({
  args: { ticket: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("twitterOAuth1")
      .withIndex("by_token", (q) => q.eq("oauthToken", args.ticket))
      .unique();
    if (!row || row.kind !== "ticket" || row.expiresAt < Date.now()) {
      if (row) await ctx.db.delete(row._id);
      return null;
    }
    await ctx.db.delete(row._id);
    return {
      twitterUserId: row.twitterUserId!,
      handle: row.handle!,
      name: row.name,
      image: row.image,
    };
  },
});

/** Keep profile + any score row in sync with latest X display name / avatar. */
export const syncUserProfile = internalMutation({
  args: {
    userId: v.id("users"),
    handle: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const handle = args.handle.replace(/^@/, "");
    await ctx.db.patch(args.userId, {
      handle,
      name: args.name,
      ...(args.image ? { image: args.image } : {}),
    });
    const score = await ctx.db
      .query("scores")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (score) {
      await ctx.db.patch(score._id, {
        handle,
        name: args.name,
        ...(args.image ? { image: args.image } : {}),
      });
    }
  },
});

/** Peek ticket without consuming — for debugging only. */
export const getTicket = internalQuery({
  args: { ticket: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("twitterOAuth1")
      .withIndex("by_token", (q) => q.eq("oauthToken", args.ticket))
      .unique();
  },
});

/**
 * Start OAuth 1.0a — returns X authorize URL for a popup.
 */
export const start = action({
  args: {},
  returns: v.object({ url: v.string() }),
  handler: async (ctx) => {
    const allowed = await ctx.runMutation(
      internal.twitterOAuth1.checkStartRateLimit,
      {},
    );
    if (!allowed) {
      throw new Error("Too many login attempts — wait a minute and try again");
    }

    const c = consumer();
    const cb = callbackUrl();
    const body = await oauth1Request({
      method: "POST",
      url: "https://api.twitter.com/oauth/request_token",
      consumer: c,
      oauthParams: { oauth_callback: cb },
    });
    const parsed = parseForm(body);
    const oauthToken = parsed.oauth_token;
    const oauthTokenSecret = parsed.oauth_token_secret;
    if (!oauthToken || !oauthTokenSecret) {
      throw new Error("X request_token missing oauth_token");
    }
    if (parsed.oauth_callback_confirmed !== "true") {
      throw new Error("X did not confirm oauth_callback — check callback URL in portal");
    }
    await ctx.runMutation(internal.twitterOAuth1.saveRequestToken, {
      oauthToken,
      oauthTokenSecret,
    });
    const url =
      "https://api.twitter.com/oauth/authenticate?oauth_token=" +
      encodeURIComponent(oauthToken);
    return { url };
  },
});

/**
 * HTTP callback from X after user approves.
 * Redirects to SITE_URL?x_ticket=… for the game tab to finish sign-in.
 */
export const httpCallback = httpAction(async (ctx, request) => {
  const site = siteUrl();
  try {
    const url = new URL(request.url);
    const oauthToken = url.searchParams.get("oauth_token");
    const oauthVerifier = url.searchParams.get("oauth_verifier");
    const denied = url.searchParams.get("denied");

    if (denied || !oauthToken || !oauthVerifier) {
      const dest = new URL(site);
      dest.searchParams.set("error", "oauth_denied");
      dest.searchParams.set(
        "error_description",
        denied ? "X login cancelled" : "Missing oauth_token/verifier",
      );
      return Response.redirect(dest.toString(), 302);
    }

    const stored = await ctx.runMutation(internal.twitterOAuth1.takeRequestToken, {
      oauthToken,
    });
    if (!stored) {
      const dest = new URL(site);
      dest.searchParams.set("error", "oauth_expired");
      dest.searchParams.set(
        "error_description",
        "Login session expired — try again",
      );
      return Response.redirect(dest.toString(), 302);
    }

    const c = consumer();
    const body = await oauth1Request({
      method: "POST",
      url: "https://api.twitter.com/oauth/access_token",
      consumer: c,
      token: { key: oauthToken, secret: stored.oauthTokenSecret },
      oauthParams: { oauth_verifier: oauthVerifier },
    });
    const parsed = parseForm(body);
    const userId = parsed.user_id;
    const handle = parsed.screen_name;
    if (!userId || !handle) {
      throw new Error("X access_token missing user_id/screen_name: " + body.slice(0, 120));
    }

    // Free v1.1: display name + avatar (OAuth 1.0a user context — no paid v2).
    let displayName = handle;
    let image: string | undefined;
    try {
      const accessToken = {
        key: parsed.oauth_token ?? oauthToken,
        secret: parsed.oauth_token_secret ?? stored.oauthTokenSecret,
      };
      const profileJson = await oauth1Request({
        method: "GET",
        url: "https://api.twitter.com/1.1/account/verify_credentials.json",
        consumer: c,
        token: accessToken,
        data: { include_entities: "false", skip_status: "true" },
      });
      const profile = JSON.parse(profileJson) as {
        name?: string;
        screen_name?: string;
        profile_image_url_https?: string;
      };
      if (profile.name?.trim()) displayName = profile.name.trim();
      if (profile.screen_name?.trim()) {
        // Prefer live screen_name if it changed.
      }
      const avatar = profile.profile_image_url_https;
      if (avatar) {
        image = avatar.replace("_normal.", "_bigger.");
      }
    } catch (profileErr) {
      console.warn(
        "[twitter-oauth1] verify_credentials failed, using @handle only",
        profileErr,
      );
      image = `https://unavatar.io/twitter/${handle.toLowerCase()}`;
    }

    const ticketBytes = new Uint8Array(24);
    crypto.getRandomValues(ticketBytes);
    const ticket = Array.from(ticketBytes, (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

    await ctx.runMutation(internal.twitterOAuth1.saveLoginTicket, {
      ticket,
      twitterUserId: userId,
      handle,
      name: displayName,
      image,
    });

    const dest = new URL(site);
    dest.searchParams.set("x_ticket", ticket);
    return Response.redirect(dest.toString(), 302);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[twitter-oauth1] callback failed", msg);
    const dest = new URL(site);
    dest.searchParams.set("error", "oauth_callback");
    dest.searchParams.set("error_description", msg.slice(0, 280));
    return Response.redirect(dest.toString(), 302);
  }
});
