/**
 * Set Convex Auth JWT keys without shell flag-parsing the PEM dashes.
 *
 * Usage (from repo root, after `bunx convex dev` has a deployment):
 *   bun tools/set-auth-env.mjs
 *
 * Regenerates JWT_PRIVATE_KEY + JWKS and pushes them to the current
 * deployment. You still set AUTH_TWITTER_ID / AUTH_TWITTER_SECRET yourself
 * (X Developer Portal) — paste them in the Convex dashboard if the CLI hangs:
 *   https://dashboard.convex.dev → Project → Settings → Environment Variables
 */

import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const k = await generateKeyPair('RS256', { extractable: true });
const JWT_PRIVATE_KEY = (await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, ' ');
const pub = await exportJWK(k.publicKey);
const JWKS = JSON.stringify({ keys: [{ use: 'sig', ...pub }] });

function setEnv(name, value) {
  // Pass value as its own argv so -----BEGIN is never a CLI flag.
  const r = spawnSync(
    'bunx',
    ['convex', 'env', 'set', name, value],
    { encoding: 'utf8', shell: true, maxBuffer: 10 * 1024 * 1024 },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    console.error(`FAILED ${name}:`, out || `exit ${r.status}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK ${name}`);
  return true;
}

const okJ = setEnv('JWKS', JWKS);
const okK = setEnv('JWT_PRIVATE_KEY', JWT_PRIVATE_KEY);

// Local backup for debugging — delete after you're happy.
writeFileSync('.auth-keys.json', JSON.stringify({ JWT_PRIVATE_KEY, JWKS }, null, 0));
console.log('Wrote .auth-keys.json (delete after keys are on the deployment).');

if (okJ && okK) {
  console.log('\nAlso set on the deployment (dashboard is fine if CLI hangs):');
  console.log('  SITE_URL=http://127.0.0.1:5173');
  console.log('  AUTH_TWITTER_ID=<from X Developer Portal>');
  console.log('  AUTH_TWITTER_SECRET=<from X Developer Portal>');
  console.log('Callback URL:');
  console.log('  https://abundant-chicken-369.convex.site/api/auth/callback/twitter');
}

try {
  // Don't leave PEM on disk if both set succeeded — user can re-run.
  if (okJ && okK) unlinkSync('.auth-keys.json');
} catch {
  /* keep file on partial failure */
}
