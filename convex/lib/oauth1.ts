/**
 * Minimal OAuth 1.0a client (HMAC-SHA1) for X request/access token steps.
 * Access-token response includes screen_name + user_id — no paid v2 API.
 */

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function randomNonce(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Base64(key: string, base: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(base));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export type OAuth1Token = { key: string; secret: string };

/**
 * Signed OAuth 1.0a request. Returns response text (form-encoded body).
 */
export async function oauth1Request(opts: {
  method: "GET" | "POST";
  url: string;
  consumer: OAuth1Token;
  token?: OAuth1Token;
  /** Extra oauth_* params (e.g. oauth_callback, oauth_verifier) */
  oauthParams?: Record<string, string>;
  /** Extra body/query params included in the signature */
  data?: Record<string, string>;
}): Promise<string> {
  const method = opts.method.toUpperCase();
  const oauth: Record<string, string> = {
    oauth_consumer_key: opts.consumer.key,
    oauth_nonce: randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...opts.oauthParams,
  };
  if (opts.token?.key) oauth.oauth_token = opts.token.key;

  const all: Record<string, string> = { ...oauth, ...(opts.data ?? {}) };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k]!)}`)
    .join("&");

  const base = [
    method,
    percentEncode(opts.url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(opts.consumer.secret)}&${percentEncode(
    opts.token?.secret ?? "",
  )}`;
  oauth.oauth_signature = await hmacSha1Base64(signingKey, base);

  const authHeader =
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k]!)}"`)
      .join(", ");

  const init: RequestInit = {
    method,
    headers: { Authorization: authHeader },
  };

  let url = opts.url;
  if (method === "POST" && opts.data && Object.keys(opts.data).length) {
    init.headers = {
      ...init.headers,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    init.body = Object.keys(opts.data)
      .map(
        (k) =>
          `${percentEncode(k)}=${percentEncode(opts.data![k]!)}`,
      )
      .join("&");
  } else if (method === "GET" && opts.data && Object.keys(opts.data).length) {
    const q = Object.keys(opts.data)
      .map(
        (k) =>
          `${percentEncode(k)}=${percentEncode(opts.data![k]!)}`,
      )
      .join("&");
    url += (url.includes("?") ? "&" : "?") + q;
  }

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth1 ${method} ${opts.url} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return text;
}

export function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, " "));
    const v = decodeURIComponent((i < 0 ? "" : part.slice(i + 1)).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}
