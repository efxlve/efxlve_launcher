# IGDB proxy

The launcher's default IGDB transport. Users do **not** need a Twitch app: the
Client ID and Secret live in this service's environment variables, and the
launcher calls `GET /api/igdb?endpoint=…&q=…` instead of the IGDB API.

The launcher also keeps a "bring your own credentials" option in
**Settings → Integrations → IGDB**, for power users and as a fallback if this
endpoint ever goes away.

## What you need

- A Twitch application: <https://dev.twitch.tv/console/apps/create>
  - **Client Type:** Confidential
  - **OAuth Redirect URL:** any HTTPS URL, e.g. `https://localhost` (unused here)
  - Copy the **Client ID**, then generate and copy a **Client secret**
    (shown once).
- A Netlify account — the same one `efxlve.com` already uses.

## Deploy on efxlve.com (what the launcher actually ships with)

The website is connected to a Git repository, so the function lives there, at
`netlify/functions/igdb.mjs`. Two details matter when copying it over:

- **Drop the `export const config = { path: "/api/igdb" }` line.** A function
  that declares a custom path is not served at `/.netlify/functions/<name>`, and
  that is exactly what the redirect below points at.
- **Keep the redirect above the SPA rule.** Redirects match top-down and the
  first match wins, so `/api/igdb` has to come before `/* → /index.html`;
  `force = true` stops the fallback from shadowing it.

```toml
[[redirects]]
  from = "/api/igdb"
  to = "/.netlify/functions/igdb"
  status = 200
  force = true

[functions]
  node_bundler = "esbuild"
```

Set `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` under **Site configuration →
Environment variables** (leave the scopes at their default) and push: Netlify
builds and the endpoint is live. It is then `https://efxlve.com/api/igdb`, which
is what the launcher already defaults to — no setting changes needed anywhere,
for this install or any other.

## Alternative: a separate site

Nothing on `efxlve.com` changes, but the launcher then has to be pointed at the
new address (see "Point the launcher at it" below), and shipping that default
for everyone becomes a launcher change.

```powershell
cd services/igdb-proxy
npx netlify-cli login
npx netlify-cli sites:create --name efxlve-igdb
npx netlify-cli env:set IGDB_CLIENT_ID "<client id>"
npx netlify-cli env:set IGDB_CLIENT_SECRET "<client secret>"
npx netlify-cli deploy --prod
```

The endpoint is then `https://efxlve-igdb.netlify.app/api/igdb`.

Prefer the UI? Create a site at <https://app.netlify.com>, add the two
environment variables under **Site configuration → Environment variables**, and
deploy this folder with `npx netlify-cli deploy --prod`.

## Test it

```powershell
curl.exe "https://efxlve.com/api/igdb?endpoint=games&q=fields%20name%3B%20limit%201%3B"
```

On the separate-site route, use `https://efxlve-igdb.netlify.app/api/igdb`
instead.

A working deploy answers with a JSON array holding one game. Errors are JSON
too: `proxy_not_configured` (missing env vars), `unknown_endpoint`,
`bad_query`, `rate_limited`, `igdb_error`. The site's own HTML coming back means
the redirect is missing or the deploy did not happen.

## Point the launcher at it

Only needed for the separate-site route: **Settings → Integrations → IGDB →
Server address.** The default is `https://efxlve.com/api/igdb`; paste the
netlify.app address to use that site instead. Leave the credential fields empty
— the proxy needs no user setup.

## Notes

- Responses are cached at Netlify's edge for a day
  (`netlify-cdn-cache-control`), so repeated game pages never touch IGDB and
  the 4 requests/second limit stays for cache misses.
- A best-effort limiter allows 240 requests per minute per IP per instance.
  Netlify's free tier (125k function calls per month) is far above this
  launcher's traffic, and cached hits do not count.
- The Client Secret never leaves this service: it is not in the launcher, not
  in any repository, and not in any response.
