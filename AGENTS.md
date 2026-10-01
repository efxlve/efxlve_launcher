# AGENTS.md

OpenCode, Cursor, and Gemini load this file every turn. The table is the task map. Detail that only some tasks need is in `docs/agent/README.md`.

For a code change, open only the matching rows. Leave `docs/CHANGELOG_INTERNAL.md` and `docs/ROADMAP.md` unread.

## Done when

`npm.cmd run build` (PowerShell uses `npm.cmd`). If Rust changed, `cargo test --manifest-path src-tauri/Cargo.toml`.

One task, one folder. Stop when that check passes.

## Open only these files

| Task | Open |
|---|---|
| Epic download progress text | `src-tauri/src/legendary/transfers/parse.rs` |
| Epic install, queue, cancel, pause | `src-tauri/src/legendary/transfers/queue.rs` |
| Epic launch or stop | `src-tauri/src/legendary/transfers/launch.rs` |
| Epic uninstall | `src-tauri/src/legendary/transfers/uninstall.rs`, `guard.rs` |
| New Epic IPC command | `src-tauri/src/legendary/commands/<job>.rs`, the handler list in `src-tauri/src/main.rs`, `src/epic-commands.ts` |
| Epic types or cover helpers | `src/epic-model.ts` |
| Steam library or VDF | `src-tauri/src/steam/library.rs`, `vdf.rs` |
| Steam store page | `src-tauri/src/steam/catalog.rs` |
| Steam achievements | `src-tauri/src/steam/achievements.rs` |
| Steam sign-in | `src-tauri/src/steam_auth/session.rs` |
| Steam token file | `src-tauri/src/steam_auth/vault.rs` |
| Embedded store | `src-tauri/src/store_host.rs`, `store_extension.js` |
| Download progress DOM | `src/features/events/ipc-listeners.ts` (`applyDlDomUpdate`) |
| A screen | `src/features/<name>/` |
| Shared state | `src/core/state.ts`, lookups in `src/core/selectors.ts` |
| Strings | `src/locales/*.json` (15 files, same keys). `npm.cmd run locales` |

Names exported from a folder are listed in that folder's `mod.rs` (`pub use file::{...}`). Command names: `docs/agent/ipc-index.md`.

## Traps

1. JS IPC fields are camelCase (`appName`). Rust fields are snake_case (`app_name`).
2. Legendary progress is on stderr. stdout is JSON.
3. Clicks use one document listener and `data-act`. Leave the event bubbling.
4. Download and IPC progress patch `data-dlbtn`, `data-dlbar`, or `patchLibraryCardDom`.
5. A hot library lookup uses `summaryOf` or `rawOf`.
6. A child webview builder does not call `additional_browser_args`.
7. Icons are `icon("name", size)` or an ISO code (`TR`, `EN`). Covers have no permanent playtime or trophy badge. Color means status: green online, amber updating, red error.
8. Speeds, percents, playtime, and counters use `font-variant-numeric: tabular-nums`.
9. An account vault id passes `vault_id::is_vault_id` before `Path::join`.
10. Code comments are English.
