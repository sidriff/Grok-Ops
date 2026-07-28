/**
 * Set Convex Auth JWT keys (matching pair) without shell flag-parsing PEM.
 *
 *   bun tools/set-auth-env.mjs
 *
 * Also prints the X Developer Portal checklist. You must set AUTH_TWITTER_ID
 * and AUTH_TWITTER_SECRET yourself (secrets) — dashboard or:
 *   bunx convex env set AUTH_TWITTER_ID '…'
 *   bunx convex env set AUTH_TWITTER_SECRET '…'
 */

import { generateKeyPair, exportPKCS8, exportJWK } from 'jose';
import { spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';

const k = await generateKeyPair('RS256', { extractable: true });
const JWT_PRIVATE_KEY = (await exportPKCS8(k.privateKey)).trimEnd().replace(/\n/g, ' ');
const pub = await exportJWK(k.publicKey);
const JWKS = JSON.stringify({ keys: [{ use: 'sig', ...pub }] });

writeFileSync('.jwt-key.txt', JWT_PRIVATE_KEY);
writeFileSync('.jwks.txt', JWKS);

function setFromFile(name, file) {
  const r = spawnSync(
    'bunx',
    ['convex', 'env', 'set', name, '--from-file', file],
    { encoding: 'utf8', shell: true },
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    console.error(`FAILED ${name}:`, out);
    process.exitCode = 1;
    return false;
  }
  console.log(`OK ${name}`);
  return true;
}

const okJ = setFromFile('JWKS', '.jwks.txt');
const okK = setFromFile('JWT_PRIVATE_KEY', '.jwt-key.txt');

try {
  unlinkSync('.jwt-key.txt');
  unlinkSync('.jwks.txt');
} catch {
  /* ignore */
}

console.log(`
SITE_URL should be your game origin, e.g.:
  bunx convex env set SITE_URL http://127.0.0.1:5173

X Developer Portal app:
  Callback URL:
    https://abundant-chicken-369.convex.site/api/auth/callback/twitter
  Then set:
    bunx convex env set AUTH_TWITTER_ID '<client id>'
    bunx convex env set AUTH_TWITTER_SECRET '<client secret>'

Website URL / app origin: http://127.0.0.1:5173
`);

if (okJ && okK) console.log('JWT pair installed.');
