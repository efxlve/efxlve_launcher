# TODO

Open work, in the order it should be picked up. Each item is sized so it can
land as one commit with `npm run build` (plus `cargo test` when Rust changed).

## 1. TV mode modernization (needs a screen)

The mode works — timers are cleaned up, reduced motion is respected, gamepad
navigation and fullscreen are wired — but it is the oldest surface in the app:
`tv-mode.css` (43 kB) predates the current design tokens, and `tv-mode.ts`
(41 kB) + `tv-hub.ts` + `tv-panels.ts` + `tv-profile.ts` carry their own layout
language.

This needs a visual pass with screenshots; it cannot be done blind.

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

## 3. Startup: the remaining seconds

Measured on the dev machine through `<app_data>/perf.log`:

| mark | time |
|---|---|
| `paint:shell` | ~150 ms |
| `library:epic-cached` | ~0.4 s (was 2.3 s) |
| `library:companion` | ~1.5 s (was 4.2 s) |
| `library:steam` | ~5 s (network; installed games paint earlier) |
| `library:epic-sync` | ~11 s (background) |
| `boot:ready` | ~1.5 s |

- `epicGetPlaytimes` and `epicGetOfflineMode` are awaited on the boot path;
  both could move behind the first paint.
- The Steam mark is the owned-games call (Steam Web API). Installed games are
  already painted before it; only the badge waits.

## 4. Bundle size

`main` + `utils` + the shared feature chunk are ~1.1 MB minified (~134 ms of
parse/eval here). Splitting the rare views (tv mode, store, discord) behind
dynamic imports is tracked in ROADMAP 6.3; only worth it for low-end machines.

## 5. IGDB proxy deployment (user action)

See `services/igdb-proxy/README.md`: deploy the Netlify function and set
`IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` there. Until it is deployed, the
launcher falls back to per-user Twitch credentials — exactly the setup the
proxy was built to remove.
