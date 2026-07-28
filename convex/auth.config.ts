export default {
  providers: [
    {
      // Convex Auth issues JWTs from this deployment's HTTP actions host.
      // domain must be the .site URL (HTTP actions), not .cloud.
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
