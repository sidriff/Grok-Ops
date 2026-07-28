import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { httpCallback as twitterOAuth1Callback } from "./twitterOAuth1";

const http = httpRouter();
auth.addHttpRoutes(http);

// Free X login (OAuth 1.0a) — separate from Auth.js OAuth 2 callback.
http.route({
  path: "/api/auth/callback/twitter-oauth1",
  method: "GET",
  handler: twitterOAuth1Callback,
});

export default http;
