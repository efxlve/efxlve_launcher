# Module layout

Read `docs/agent/README.md` first. This file is the size rule and the split that keeps each file inside one job.

Explanations in source and in this file are English. User-facing copy lives in `src/locales/*.json`, not in comments.

## Rule

One file, one job. Past about 1,500 lines, split along a one-way dependency. `core/` does not import `features/`. Callers keep the old Rust paths (`steam::steam_status`, `legendary::transfers::epic_install_game`, `steam_auth::steam_login_begin`, `legendary::commands::*`).

Do not rename state with a regex. Move one function, then `npm.cmd run build` or `cargo test`.

## Rust folders

| Folder | Open first | Jobs |
|---|---|---|
| `src-tauri/src/steam/` | `mod.rs` | VDF parser, library, store details, achievements, screenshots, `steam://` actions |
| `src-tauri/src/steam_auth/` | `mod.rs` | Protobuf bodies (`wire.rs`), DPAPI vault (`vault.rs`), sign-in commands (`session.rs`) |
| `src-tauri/src/legendary/commands/` | `mod.rs` | Epic IPC, one file per job |
| `src-tauri/src/legendary/transfers/` | `mod.rs` | Progress parser, install queue, launch, uninstall, delete guard |
| `src-tauri/src/store_host.rs` | — | Child webview placement. The injected page script is `store_extension.js` |

## Frontend

`src/main.ts` only boots the window. Screens live in `src/features/<name>/`. Shared state is the object `S` in `src/core/state.ts`. Lookups go through `summaryOf` and `rawOf`.

## Checks

```powershell
npm.cmd run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Use `npm.cmd`, not `npm`, in PowerShell.
