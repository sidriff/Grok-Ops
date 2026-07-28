import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";

/**
 * Verified X login via OAuth 1.0a ticket (see twitterOAuth1.ts).
 *
 * Free tier: access_token + v1.1 verify_credentials → real @handle + display name.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials({
      id: "x-oauth1",
      authorize: async (credentials, ctx) => {
        const ticket = credentials.ticket;
        if (typeof ticket !== "string" || !ticket) {
          throw new Error("Missing login ticket");
        }

        const claimed = await ctx.runMutation(
          internal.twitterOAuth1.consumeLoginTicket,
          { ticket },
        );
        if (!claimed) {
          throw new Error("Login ticket expired — try Log in with X again");
        }

        const handle = claimed.handle.replace(/^@/, "");
        const name = (claimed.name || handle).trim() || handle;
        const image =
          claimed.image ||
          `https://unavatar.io/twitter/${handle.toLowerCase()}`;

        const { user } = await createAccount(ctx, {
          provider: "x-oauth1",
          account: { id: claimed.twitterUserId },
          profile: {
            name,
            handle,
            image,
          },
        });

        // createAccount won't refresh profile on re-login — always sync.
        await ctx.runMutation(internal.twitterOAuth1.syncUserProfile, {
          userId: user._id,
          handle,
          name,
          image,
        });

        return { userId: user._id };
      },
    }),
  ],
});
