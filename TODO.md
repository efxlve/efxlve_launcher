# TODO

Open work, in the order it should be picked up. Each item is sized so it can
land as one commit with `npm run build` (plus `cargo test` when Rust changed).

## 1. TV mode modernization (needs a screen)

The mode works — timers are cleaned up, reduced motion is respected, gamepad
navigation and fullscreen are wired — but it is the oldest surface in the app:
`tv-mode.css` (43 kB) predates the current design tokens, and `tv-mode.ts`
(41 kB) + `tv-hub.ts` + `tv-panels.ts` + `tv-profile.ts` carry their own layout
language. A visual pass needs screenshots; it cannot be done blind.

- Rebuild the home screen on the current tokens: type scale, spacing, focus ring.
- Reuse the library card visuals (`pcard`) for the shelf instead of the bespoke
  TV cards.
- Keep what works: gamepad navigation, boot animation, clock, battery, panels.

## 2. Window transparency cost

`tauri.conf.json` uses a frameless `transparent: true` window, so the compositor
pays for alpha on every frame. Idle CPU is ~11% of one core after the Discord
prewarm fix (launcher 2.5%, GPU 2.7%, renderer 5.6%).

- Disable transparency while the window is unfocused, or
- offer a "solid background" switch in Settings → Appearance for low-end PCs.

## 3. Screenshots workstream — shipped, with room to grow

Done: opt-in sidebar page (filters, favorites, multi-select, batch), canvas
editor (crop, rotate, flip, pen, arrow, rectangle, mosaic, text, undo/redo,
save a copy or overwrite a PNG), one-click sharing (Discord webhook, X and
Reddit via clipboard + compose window), and the F9 MJPEG-AVI clip recorder.

Left, in rough priority:
- Trim/join clips in the launcher (the AVI writer is already a plain container;
  a simple cut list would be a small extension).
- Upload a clip to the Discord webhook as well (the multipart path exists, the
  8 MB webhook limit means a shorter cap or a compressed re-encode first).
- Screenshot `SteamGridDB` upload? Not planned; the picker already covers covers.

## 4. Startup: what is left

Measured through `<app_data>/perf.log` on the dev machine (before → after):

| mark | before | after |
|---|---|---|
| `paint:shell` | 162 ms | ~150 ms |
| `library:epic-cached` | 2.26 s | ~0.6 s |
| `library:companion` | 4.19 s | ~0.7 s |
| `library:steam` | 5.0 s | ~0.8 s (day-long cache) |
| `boot:ready` | 1.6 s | ~0.7 s |

Left: `epicGetNetworkProfile` and the CDN/shortcut prefetch are still awaited on
the boot path (a few IPC round trips, ~50 ms). Not worth another pass unless a
slow start shows up again.

## 5. Bundle size

`main` + `utils` + the shared feature chunk are ~1.1 MB minified (~134 ms of
parse/eval here). Splitting the rare views (tv mode, store, discord) behind
dynamic imports is tracked in ROADMAP 6.3; only worth it for low-end machines,
and it touches the core render switch, so it needs care.

## 6. IGDB — live

The proxy runs on `efxlve.com/api/igdb` (the website repo's
`netlify/functions/igdb.mjs` plus the redirect above the SPA rule), with
`IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` set in Netlify. Verified 2026-10-15:
the endpoint answers with JSON for a real query, and the launcher's default
server address already points at it, so no user setup is involved.

Two bugs surfaced only once the transport was real, both fixed:

- `igdb_enrich` bailed out when the credential store was empty, which is always
  the case in proxy mode — game pages never asked IGDB at all. The guard now
  asks the transport.
- `S.igdbConfigured` was only ever set by the Settings loader, so a game page
  opened before Settings enriched nothing. The game page now loads the status
  once by itself.

Remaining ideas: IGDB `dlcs`/`expansions` merged into the DLC tab, and a
"power user" way back to own credentials now that the row is always visible.
