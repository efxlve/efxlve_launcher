# AGENTS.md

OpenCode, Cursor, and Gemini load this file every turn. The table is the task map. Detail that only some tasks need is in `docs/agent/README.md`.

For a code change, open only the matching rows. Leave `docs/CHANGELOG_INTERNAL.md` and `docs/ROADMAP.md` unread.

## Models

Subagents and other models may be used without asking first, for exploration, review, reports and mechanical work. Two rules:

- Never use a "contributor" tier model. The owner named `opencode-go/gemini-4-argon-contributor` explicitly; treat every `*-contributor` the same way.
- Never send project code to a provider the owner has not approved. Approved so far: `opencode-go/claude-haiku-5-5`.

Antigravity's own agent API (Gemini 3.8 Flash, and the owner's Gemini 4 Argon) can be driven from here when the IDE is running; the address, the token and the read-only rule are in `docs/agent/antigravity-bridge.md`. The API needs a CSRF token the IDE keeps to itself, so in practice **the owner is the bridge**: a brief goes out, an answer comes back. Gemini 4 Argon is not reachable from this workspace at all — the plain model's provider has no funds, and the contributor tier is vetoed.

## Done when

`npm.cmd run build` (PowerShell uses `npm.cmd`). If Rust changed, `cargo test --manifest-path src-tauri/Cargo.toml`.

One task, one folder. Stop when that check passes. Then commit. Never skip the commit, and do not ask first. Do not push unless the user asks.

## Commit

Message shape: `type: why`

English, imperative, no trailing period. One task, one commit. Types: `fix`, `feat`, `refactor`, `test`, `docs`, `chore`.

```
fix: keep the notification list above the store
docs: commit every completed change without asking
```

## After a release

Draft the announcement tweet and hand it to the user; they post it themselves. No emoji except 👇, and links only in the first reply, never the main tweet. Write it as a plain dev update — what was fixed, what was added — not marketing copy. Version line, one short paragraph, `Notes in the reply👇`; the reply is `Release notes and download: <release tag URL>`. Detail: `docs/agent/README.md`.

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
| Strings | `src/locales/*.json` (16 files, same keys). `npm.cmd run locales` |

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
10. Code comments are English. Every `t("key")` exists in `src/locales/en.json`.
11. Settings shows the Steam client, not a row per Steam game. A Steam app is downloading only while bytes remain and the client is actually transferring.
12. Do not write a file with PowerShell's `Get-Content`/`Set-Content` round trip: it re-encodes the text, so "—" becomes "â€”" and a Turkish fold or a regex quietly stops matching. Use the edit tool or Node.
