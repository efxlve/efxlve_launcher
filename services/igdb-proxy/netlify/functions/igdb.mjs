/**
 * IGDB proxy — the launcher's default IGDB transport.
 *
 * Why a proxy: the IGDB API needs a Twitch Client ID and Secret, and shipping
 * the secret inside a desktop app would leak it (Twitch's rules require it to
 * stay confidential). Users should not have to register a Twitch app either,
 * so the credentials live here, as Netlify environment variables, and the
 * launcher talks to this endpoint instead:
 *
 *   GET /api/igdb?endpoint=games&q=<apicalypse%20query>
 *
 * Responses are cached at Netlify's edge for a day — IGDB asks for caching and
 * it keeps the API's 4 requests/second budget for cache misses only, so a game
 * is fetched from IGDB once and then served from the CDN to everyone.
 *
 * Environment variables (Site configuration → Environment variables):
 *   IGDB_CLIENT_ID      Twitch app client id      (required)
 *   IGDB_CLIENT_SECRET  Twitch app client secret  (required)
 *
 * The launcher still supports "bring your own credentials" in Settings, for
 * power users and as a fallback if this endpoint ever goes away.
 */

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

/** The endpoints the launcher asks for; everything else is refused. */
const ALLOWED_ENDPOINTS = new Set([
  "games",
  "covers",
  "artworks",
  "screenshots",
  "external_games",
  "age_ratings",
  "age_rating_categories",
  "age_rating_organizations",
]);

/** Apicalypse bodies are short; anything bigger is not a real query. */
const MAX_QUERY_LENGTH = 4000;
/** Edge cache: IGDB metadata barely changes, so a day is safe. */
const EDGE_TTL_SECONDS = 60 * 60 * 24;
/** A shorter cache for anything that sits in front of the edge. */
const BROWSER_TTL_SECONDS = 60 * 60;
/** Best-effort limiter: 240 requests per minute per IP, per instance. */
const RATE_LIMIT = 240;
const RATE_WINDOW_MS = 60_000;

/** The app access token, reused until it is close to expiring. */
let token = { value: "", expiresAt: 0 };
/** ip → { count, resetAt } for the in-memory limiter. */
const hits = new Map();

function env(name) {
  const fromNetlify = globalThis.Netlify?.env?.get?.(name);
  return fromNetlify ?? process.env[name] ?? "";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${BROWSER_TTL_SECONDS}`,
      "netlify-cdn-cache-control": `public, s-maxage=${EDGE_TTL_SECONDS}, stale-while-revalidate=604800`,
    },
  });
}

async function appToken(clientId, clientSecret) {
  const now = Date.now();
  if (token.value && token.expiresAt > now + 60_000) return token.value;
  const url =
    `${TOKEN_URL}?client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) throw new Error(`token request failed (${response.status})`);
  const body = await response.json();
  token = {
    value: body.access_token,
    expiresAt: now + Math.max(body.expires_in ?? 3600, 120) * 1000,
  };
  return token.value;
}

/** One IGDB call; a stale token is replaced and the call retried once. */
async function queryIgdb(clientId, clientSecret, endpoint, query) {
  const send = async () =>
    fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${await appToken(clientId, clientSecret)}`,
        Accept: "application/json",
      },
      body: query,
    });
  let response = await send();
  if (response.status === 401) {
    token = { value: "", expiresAt: 0 };
    response = await send();
  }
  return response;
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt <= now) {
    // The map only exists to stop bursts; it never needs to grow forever.
    if (hits.size > 5000) hits.clear();
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

export default async function handler(request, context) {
  const clientId = env("IGDB_CLIENT_ID");
  const clientSecret = env("IGDB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return json({ error: "proxy_not_configured" }, 503);
  }

  const url = new URL(request.url);
  const endpoint = url.searchParams.get("endpoint") ?? "";
  const query = url.searchParams.get("q") ?? "";
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return json({ error: "unknown_endpoint" }, 400);
  }
  if (!query.trim() || query.length > MAX_QUERY_LENGTH) {
    return json({ error: "bad_query" }, 400);
  }

  const ip = context?.ip ?? request.headers.get("x-nf-client-connection-ip") ?? "unknown";
  if (rateLimited(ip)) {
    return json({ error: "rate_limited" }, 429);
  }

  try {
    const response = await queryIgdb(clientId, clientSecret, endpoint, query);
    if (response.status === 429) return json({ error: "rate_limited" }, 429);
    if (!response.ok) return json({ error: "igdb_error", status: response.status }, 502);
    return json(await response.json());
  } catch (error) {
    return json({ error: "proxy_failure", message: String(error) }, 502);
  }
}

/** Functions 2.0: the endpoint is the path, no redirect rule needed. */
export const config = { path: "/api/igdb" };
