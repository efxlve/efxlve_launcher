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

## Deploy (a separate site; nothing on efxlve.com changes)

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

## Or put it on efxlve.com

If the `efxlve.com` site is connected to a Git repository, copy
`netlify/functions/igdb.mjs` into that repository and merge this block into its
`netlify.toml`:

```toml
[functions]
  node_bundler = "esbuild"
```

The endpoint is then `https://efxlve.com/api/igdb`, which is what the launcher
already defaults to — no setting changes needed anywhere.

## Test it

```powershell
curl.exe "https://efxlve-igdb.netlify.app/api/igdb?endpoint=games&q=fields%20name%3B%20limit%201%3B"
```

A working deploy answers with a JSON array holding one game. Errors are JSON
too: `proxy_not_configured` (missing env vars), `unknown_endpoint`,
`bad_query`, `rate_limited`, `igdb_error`.

## Point the launcher at it

**Settings → Integrations → IGDB → Server address.** The default is
`https://efxlve.com/api/igdb`; paste the netlify.app address to use the
separate site instead. Leave the credential fields empty — the proxy needs no
user setup.

## Notes

- Responses are cached at Netlify's edge for a day
  (`netlify-cdn-cache-control`), so repeated game pages never touch IGDB and
  the 4 requests/second limit stays for cache misses.
- A best-effort limiter allows 240 requests per minute per IP per instance.
  Netlify's free tier (125k function calls per month) is far above this
  launcher's traffic, and cached hits do not count.
- The Client Secret never leaves this service: it is not in the launcher, not
  in any repository, and not in any response.
