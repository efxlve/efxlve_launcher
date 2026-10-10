# Agent guide

Always-loaded rules and the task table are in `AGENTS.md`. Open this file when that table does not name the file. Design tokens live in `docs/DESIGN_SYSTEM.md`. Command names live in `docs/agent/ipc-index.md`.

Leave `docs/CHANGELOG_INTERNAL.md` and `docs/ROADMAP.md` unread during a code change.

The app is a Windows desktop launcher (Tauri 2 + Rust + vanilla TypeScript). It wraps Legendary (Epic), gogdl (GOG), and the local Steam client. There is no web framework and no virtual DOM.

## Commands

```powershell
npm.cmd run build    # tsc --noEmit && vite build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Use `npm.cmd`, not `npm`, in PowerShell. Do not commit unless the user asks.

## Where code lives

| You want to change… | Open |
|---|---|
| Boot, view switch, modal close | `src/main.ts` (thin). Real render bus: `src/core/render.ts` |
| Shared state `S`, O(1) maps | `src/core/state.ts`, lookups in `src/core/selectors.ts` |
| Sidebar, download badge | `src/core/nav.ts` |
| Click actions | `src/features/events/click-router.ts` and `src/features/events/handlers/` |
| Download progress DOM | `src/features/events/ipc-listeners.ts` (`applyDlDomUpdate`). Do not call `render()` here |
| A screen | `src/features/<name>/` |
| Epic IPC command | `src-tauri/src/legendary/commands/<file>.rs`, then register it in `src-tauri/src/main.rs`, then wrap it in `src/epic-commands.ts` |
| Epic install / queue / launch | `src-tauri/src/legendary/transfers/` (`queue.rs` owns the state machine) |
| Epic account vault | `src-tauri/src/legendary/accounts.rs` |
| GOG | `src-tauri/src/gogdl/` |
| Steam library, details, achievements | `src-tauri/src/steam/` (`mod.rs` lists each file) |
| Steam sign-in and DPAPI vault | `src-tauri/src/steam_auth/` (`session.rs`, `wire.rs`, `vault.rs`) |
| Embedded store webviews | `src-tauri/src/store_host.rs` and `store_extension.js` |
| Strings | `src/locales/*.json` (15 files, same keys). Rust sends `@t:key` plus `\u{1f}` args. The UI translates them with `localizeMessage`. `npm.cmd run locales` checks that every file has the same keys |

`core/` must not import `features/`. Features import `core/` and call `S.field = ...` (the binding `S` is not reassigned).

## Epic command files

Callers still use `legendary::commands::epic_*`. The folder is split by job:

| File | Owns |
|---|---|
| `commands/support.rs` | Binary lookup, error log, retry / skip loop |
| `commands/session.rs` | Setup, library list, login, account switch |
| `commands/cdn.rs` | CDN probe and preferred host |
| `commands/achievements.rs` | Achievement fetch and the library summary scan |
| `commands/metadata.rs` | HLTB, critic, requirements, EGL detect, third-party launchers |
| `commands/verify.rs` | Verify progress parser and verify command |
| `commands/game_local.rs` | Per-game settings, shortcuts, DLC, install options |
| `commands/ops.rs` | Updates, playtime, preferences, backups, collections, profile, move |

## Rules that break the app if ignored

1. Tauri arguments are camelCase in JS (`appName`) and snake_case in Rust (`app_name`).
2. Legendary progress is on stderr. stdout is JSON.
3. Do not `stopPropagation()` on clicks. The UI uses one document listener and `data-act`.
4. Do not `innerHTML` a whole view on download or IPC progress. Patch `data-dlbtn` / `data-dlbar` or `patchLibraryCardDom`.
5. Do not `.find()` across the library in a hot path. Use `summaryOf` / `rawOf`.
6. Never pass `additional_browser_args` to `WebviewBuilder`. Child webviews go blank.
7. No OS emoji in the UI. Use `icon("name", size)` or `TR` / `EN`.
8. Speeds, percents, playtime, and counters use `font-variant-numeric: tabular-nums`.
9. Account vault ids must go through `vault_id::is_vault_id` before `Path::join`. `join` plus `..` or an absolute path escapes the vault, and remove uses `remove_dir_all`.
10. Comments in code are English.

## Download progress

`download-progress` can fire many times a second. `applyDlDomUpdate` calls `updateBadge("progress")`. That path updates the counter and the bars only. It does not rescan the library or rebuild the sidebar. A full `updateBadge()` runs when the queue, install set, or update list changes.

## One job per file

Callers keep the old paths (`steam::steam_status`, `legendary::transfers::epic_install_game`, `steam_auth::steam_login_begin`). Open the folder's `mod.rs` first. It names the file that owns the job.

| Folder | Files |
|---|---|
| `steam/` | `vdf`, `runtime`, `library`, `protocol`, `cloud`, `playtime`, `users`, `catalog`, `achievements`, `shots` |
| `steam_auth/` | `wire` (protobuf), `vault` (DPAPI), `session` (commands) |
| `legendary/transfers/` | `parse`, `paths`, `guard`, `queue`, `launch`, `uninstall` |
| `legendary/commands/` | Epic IPC, one file per job (table above) |

`store_extension.js` is the script injected into the store webview. `store_host.rs` only places and sizes that webview.

A file past ~1,500 lines should be split on a one-way dependency. Do not cut a state machine in half if the two halves call each other.

## Verify

`cargo test` is the backend check (account-vault path tests, Steam language path tests, store bounds tests). `npm.cmd run build` is the TypeScript check. The window itself is a Tauri app; the Vite bundle is not the product UI.

## Release notes

The workflow pushes a placeholder body (`releaseBody` in `.github/workflows/release.yml`).
Replace it right after the tag publishes, before announcing anything:

```powershell
node scripts/release-notes.mjs 0.1.28 "$env:TEMP\notes.md"
gh release edit v0.1.28 --notes-file "$env:TEMP\notes.md"
```

`scripts/release-notes.mjs <version> <out.md>` reads that version's entry from
`src/features/changelog/changelog-view.ts` (the English `items` and `fixed`) and writes
the `## version` / **New** / **Fixed** body, so the release page and the app's changelog
never drift apart.

## Release tweets

After every release, draft the announcement tweet and hand it to the user; they post it themselves. Rules:

- No emoji except 👇. A link never goes in the main tweet.
- Write it like a short dev update, not marketing copy: say what was fixed and what was added, in plain words. Polished launch phrasing reads as AI-written.
- Shape: the version line, one short paragraph (fixes first, then additions), then `Notes in the reply👇`.
- First reply: `Release notes and download: https://github.com/efxlve/efxlve_launcher/releases/tag/v<version>`
- Use the tag URL, never `/releases/latest`: X caches the link card for an unchanged URL and keeps showing the previous version.
- Highlights come from the newest entry in `src/features/changelog/changelog-view.ts` (the English `items` and `fixed`).
- Keep the main tweet under 280 characters and put the reply up right after posting.

## Open issues

Parked on 2026-10-11 to pick up next session (both seen on the Stores and Spotify pages):

- **Notifications do not open on the Stores and Spotify pages.** There the dropdown is drawn in a child webview (`src-tauri/src/notif_overlay.rs` plus `presentStoreOverlay` in `src/features/notifications/notifications.ts`). Prime suspect is child z-order: a host created *before* the storefront/Spotify children stays below them, and `raise_child_covering` only re-raises a child whose rect matches the requested one within 8 px (DPI-scaled), so a mismatch leaves the panel hidden. The startup prewarm that created the host before the other children was reverted; the next attempt should re-raise the host explicitly (or log which HWND the rect match finds).
- **The Spotify page stays visible on the Stores page.** The `spotify-player` child is not hidden when the view leaves `music`: `hideSpotifyPlayer()` returns early when its local `playerVisible` flag is false, and `spotify_open_in_launcher` (overlay / mini player) shows the child from Rust without the frontend knowing, so the flag drifts. Fix direction: make Rust the source of truth (or emit an event when it shows the player) and hide the child on every view change.
