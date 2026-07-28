import Twitter from "@auth/core/providers/twitter";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * X (Twitter) OAuth 2.0 via Auth.js provider.
 *
 * Env on the Convex deployment:
 *   AUTH_TWITTER_ID, AUTH_TWITTER_SECRET  — X Developer Portal app
 *   SITE_URL                             — game origin (e.g. http://127.0.0.1:5173)
 *   JWT_PRIVATE_KEY, JWKS                — generated for Convex Auth
 *
 * Callback URL to register in the X app:
 *   https://<deployment>.convex.site/api/auth/callback/twitter
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Twitter({
      // Ensure we get the @handle for the board.
      userinfo: "https://api.x.com/2/users/me?user.fields=profile_image_url,username",
      profile({ data }) {
        return {
          id: data.id,
          name: data.name,
          email: data.email ?? null,
          image: data.profile_image_url,
          handle: data.username,
        };
      },
    }),
  ],
});
