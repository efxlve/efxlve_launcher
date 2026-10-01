# Agent guide

Read this before editing Efxlve Launcher. It is the map. The rules live in `AGENTS.md`. Design tokens live in `docs/DESIGN_SYSTEM.md`. The command list lives in `docs/TAURI_IPC_REFERENCE.md`.

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
| Epic IPC command | `src-tauri/src/legendary/commands/<file>.rs`, then register it in `src-tauri/src/main.rs`, then wrap it in `src/epic.ts` |
| Epic install / queue / launch | `src-tauri/src/legendary/transfers.rs` |
| Epic account vault | `src-tauri/src/legendary/accounts.rs` |
| GOG | `src-tauri/src/gogdl/` |
| Steam library, details, achievements | `src-tauri/src/steam.rs` |
| Steam sign-in and DPAPI vault | `src-tauri/src/steam_auth.rs` |
| Embedded store webviews | `src-tauri/src/store_host.rs` |
| Strings | `src/locales/*.json` (15 files, same keys). Rust sends `@t:key` plus `\u{1f}` args. The UI translates them with `localizeMessage` |

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

## Still large

These files are still above the ~1,500 line target. They were not split because their private helpers call each other in both directions; a mechanical cut would create circular modules.

| File | Why it is one module today |
|---|---|
| `legendary/transfers.rs` | Queue, progress parser, install monitor, uninstall, and launch share one state machine |
| `steam.rs` | VDF parser, library, store details, achievements, and screenshots share the parser |
| `steam_auth.rs` | Protobuf login, QR, and the DPAPI vault are one session state machine |
| `store_host.rs` | Webview host. The long `STORE_EXTENSION_SCRIPT` is injected JavaScript, not Rust logic |

## Verify

`cargo test` is the backend check (account-vault path tests, Steam language path tests, store bounds tests). `npm.cmd run build` is the TypeScript check. The window itself is a Tauri app; the Vite bundle is not the product UI.
