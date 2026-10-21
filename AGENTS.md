# AGENTS.md

The only agent instruction file in this repository. It is loaded every turn by
DeepSeek Harness.

## Model policy

- All work runs on **DeepSeek V4.1 Flash** through **DeepSeek Harness**. A newer
  DeepSeek release takes over this file unchanged.
- This is the repository's only agent instruction file. Do not add another agent,
  editor, IDE or provider configuration, and do not reintroduce a rule file that
  was removed.
- Do not send project code to a provider the owner has not approved.
  Contributor-tier models are vetoed.
- Subagents, when used, run through the same Harness and the same model.

## What the project is

A Windows desktop launcher: Tauri 2 + Rust + vanilla TypeScript (Vite 6). It
wraps the Legendary (Epic), gogdl (GOG) and Nile (Amazon) CLIs, reads the local
Steam client, and hosts store pages in native child webviews. There is no web
framework and no virtual DOM.

## Task map

Open only the row that matches the task. Do not read the rest of the tree first.

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
| In-game overlay | `src-tauri/src/overlay/`, `src/features/overlay/` |
| Custom games | `src-tauri/src/custom_games.rs`, `src/features/custom-games/`, `src/custom-games.ts` |
| Compatibility runners | `src-tauri/src/compat/`, `src/compat.ts` |
| Download progress DOM | `src/features/events/ipc-listeners.ts` (`applyDlDomUpdate`) |
| A screen | `src/features/<name>/` |
| Shared state | `src/core/state.ts`, lookups in `src/core/selectors.ts` |
| Strings | `src/locales/*.json` (16 files, same keys). `npm.cmd run locales` |
| IPC command names | `docs/IPC_INDEX.md` (regenerate with `node scripts/ipc-index.mjs`) |

Names exported from a Rust folder are listed in that folder's `mod.rs`
(`pub use file::{...}`). Callers keep the old paths, so open `mod.rs` first.

## Commands

```powershell
npm.cmd run build                          # tsc --noEmit && vite build
npm.cmd run locales                        # every locale has the same keys
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri dev                      # the real app window
```

Use `npm.cmd`, not `npm`, in PowerShell.

## Done when

The check that covers the change passes:

- Frontend or shared code: `npm.cmd run build`.
- Rust changed: `cargo test --manifest-path src-tauri/Cargo.toml`.

One task, one commit. Stop when the check passes, commit, and do not ask first.
Never push unless the user asks.

## Commit

Message shape: `type: why`

English, imperative, no trailing period. One task, one commit. Types: `fix`,
`feat`, `refactor`, `test`, `docs`, `chore`.

```
fix: keep the notification list above the store
docs: commit every completed change without asking
```

## Traps

1. JS IPC fields are camelCase (`appName`). Rust fields are snake_case
   (`app_name`).
2. Legendary progress is on stderr. stdout is JSON.
3. Clicks use one document listener and `data-act`. Leave the event bubbling;
   do not call `stopPropagation()`.
4. Download and IPC progress patch `data-dlbtn`, `data-dlbar` or
   `patchLibraryCardDom`. Never re-render the view there.
5. A hot library lookup uses `summaryOf` or `rawOf`, never a linear `.find()`
   across the library.
6. A child webview builder does not call `additional_browser_args`. It silently
   breaks the store webviews.
7. Icons are `icon("name", size)` or an ISO code (`TR`, `EN`). No OS emoji.
   Covers have no permanent playtime or trophy badge. Color means status: green
   online, amber updating, red error.
8. Speeds, percents, playtime and counters use
   `font-variant-numeric: tabular-nums`.
9. An account vault id passes `vault_id::is_vault_id` before `Path::join`, and a
   Steam language passes the supported-code allowlist before it becomes a file
   name.
10. Code comments are English. Every `t("key")` exists in `src/locales/en.json`.
11. Settings shows the Steam client, not a row per Steam game. A Steam app is
    downloading only while bytes remain and the client is actually transferring.
12. Do not write a file with PowerShell's `Get-Content`/`Set-Content` round trip:
    it re-encodes the text, so "—" becomes "â€”" and a Turkish fold or a regex
    quietly stops matching. Use the edit tool or Node.

## Layout rules

- `core/` must not import `features/`. Features import `core/` and assign to the
  binding `S`; they do not reassign it.
- One file, one job. Past about 1,500 lines, split along a one-way dependency.
  Do not cut a state machine in half if the two halves call each other.
- Rust folders: `legendary/transfers/` (`parse`, `paths`, `guard`, `queue`,
  `launch`, `uninstall`), `legendary/commands/` (one file per job), `steam/`,
  `steam_auth/` (`wire`, `vault`, `session`).
- `store_extension.js` is injected into the store webview; `store_host.rs` only
  places and sizes that webview.

## Project documents

These are the only project documents. A new document needs a concrete job; do not
add journals, audits or handoff notes.

| File | Job |
|---|---|
| `README.md` | Public overview, features, credits, build steps |
| `ARCHITECTURE.md` | Subsystem boundaries and data flow |
| `CONTRIBUTING.md` | UI contract and engineering standards for contributors |
| `TODO.md` | Open work only, newest first |
| `docs/DESIGN_SYSTEM.md` | Design tokens and layout contracts |
| `docs/IPC_INDEX.md` | Generated Tauri command index |
| `docs/OVERLAY_ROADMAP.md` | Overlay architecture and open work |
| `docs/CROSS_PLATFORM.md` | Linux/macOS compatibility layer |
| `docs/GOOGLE_DRIVE_SETUP_GUIDE.md` | Google Drive backup setup |

## Release

The workflow pushes a placeholder body (`releaseBody` in
`.github/workflows/release.yml`). Replace it after the tag publishes:

```powershell
node scripts/release-notes.mjs 0.1.34 "$env:TEMP\notes.md"
gh release edit v0.1.34 --notes-file "$env:TEMP\notes.md"
```

`scripts/release-notes.mjs <version> <out.md>` reads that version's entry from
`src/features/changelog/changelog-view.ts` and writes the release body, so the
release page and the in-app changelog never drift.

Run `node scripts/bump-version.mjs <version>` to keep `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the README version line
in sync.

## After a release

Draft the announcement tweet and hand it to the user; they post it themselves.

- No emoji except 👇. Links only in the first reply, never in the main tweet.
- Write a plain dev update: what was fixed, what was added. Not marketing copy.
- Shape: version line, one short paragraph (fixes first, then additions), then
  `Notes in the reply👇`.
- First reply: `Release notes and download: https://github.com/efxlve/efxlve_launcher/releases/tag/v<version>`
- Use the tag URL, never `/releases/latest`; X caches the link card of an
  unchanged URL.
- Keep the main tweet under 280 characters.
