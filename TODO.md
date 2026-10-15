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

## 3. Startup: what is left

Measured through `<app_data>/perf.log` on the dev machine (before → after):

| mark | before | after |
|---|---|---|
| `paint:shell` | 162 ms | ~150 ms |
| `library:epic-cached` | 2.26 s | ~0.6 s |
| `library:companion` | 4.19 s | ~0.7 s |
| `library:steam` | 5.0 s | ~0.8 s (day-long cache) |
| `library:epic-sync` | ~11 s | ~11 s (network, background) |
| `boot:ready` | 1.6 s | ~0.6 s |

Left: `epicGetNetworkProfile` and the CDN/shortcut prefetch are still awaited on
the boot path (a few IPC round trips, ~50 ms). Not worth another pass unless a
slow start shows up again.

## 4. Bundle size

`main` + `utils` + the shared feature chunk are ~1.1 MB minified (~134 ms of
parse/eval here). Splitting the rare views (tv mode, store, discord) behind
dynamic imports is tracked in ROADMAP 6.3; only worth it for low-end machines,
and it touches the core render switch, so it needs care.

## 5. IGDB proxy deployment (user action)

See `services/igdb-proxy/README.md`: deploy the Netlify function and set
`IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` there. Until it is deployed, the
launcher falls back to per-user Twitch credentials — exactly the setup the
proxy was built to remove.
