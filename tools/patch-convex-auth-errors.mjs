/**
 * Patch @convex-dev/auth so OAuth callback failures redirect to SITE_URL with
 * ?error=&error_description= instead of a silent bounce (no query params).
 *
 * Run: node tools/patch-convex-auth-errors.mjs
 * Safe to re-run (idempotent).
 */
import fs from "node:fs";
import path from "node:path";

const file = path.join(
  process.cwd(),
  "node_modules/@convex-dev/auth/dist/server/implementation/index.js",
);

if (!fs.existsSync(file)) {
  console.error("convex-auth not installed:", file);
  process.exit(1);
}

let src = fs.readFileSync(file, "utf8");
const MARKER = "oauth4webapi ResponseBodyError puts fields on the error itself";

if (src.includes(MARKER)) {
  console.log("already patched (v2)");
  process.exit(0);
}

// Replace either the original silent catch or our earlier patch variants.
const catchRe =
  /catch \(error\) \{\s*logError\(error\);\s*(?:\/\/[^\n]*\n\s*)*(?:try \{[\s\S]*?return Response\.redirect\(destinationUrl\);\s*\}\s*catch \{[\s\S]*?\}\s*|return Response\.redirect\(destinationUrl\);\s*)\}/;

const neu = `catch (error) {
                        logError(error);
                        // Surface the failure to SITE_URL so the client can show it
                        // (default Convex Auth silently redirects with no query params).
                        try {
                            const parts = [];
                            if (error instanceof Error) {
                                parts.push(error.message);
                                // oauth4webapi ResponseBodyError puts fields on the error itself
                                const e = error;
                                if (e.error)
                                    parts.push(String(e.error));
                                if (e.error_description)
                                    parts.push(String(e.error_description));
                                const c = error.cause;
                                if (c && typeof c === "object") {
                                    const o = c;
                                    if (o.error && o.error !== e.error)
                                        parts.push(String(o.error));
                                    if (o.error_description && o.error_description !== e.error_description)
                                        parts.push(String(o.error_description));
                                }
                                else if (c && !e.error) {
                                    parts.push(String(c));
                                }
                            }
                            else {
                                parts.push(String(error));
                            }
                            const msg = [...new Set(parts.filter(Boolean))].join(" — ").slice(0, 280);
                            const dest = setURLSearchParam(destinationUrl, "error", "oauth_callback");
                            return Response.redirect(setURLSearchParam(dest, "error_description", msg || "oauth_callback_failed"));
                        }
                        catch {
                            return Response.redirect(destinationUrl);
                        }
                    }`;

if (!catchRe.test(src)) {
  // Fallback: simple silent redirect only
  const old = `catch (error) {
                        logError(error);
                        return Response.redirect(destinationUrl);
                    }`;
  if (!src.includes(old)) {
    console.error("pattern not found — convex-auth version may have changed");
    process.exit(1);
  }
  src = src.replace(old, neu);
} else {
  src = src.replace(catchRe, neu);
}

fs.writeFileSync(file, src);
console.log("patched", file);
