# AGENTS.md — Efxlve Launcher

This file is the operational rule set for people and coding agents. For the file map, read `docs/agent/README.md` first. History lives in `docs/CHANGELOG_INTERNAL.md`.

## 1. What this is

Efxlve Launcher is a Windows x86_64 desktop game hub. It makes Epic, GOG, and Steam usable from one window so those clients do not have to stay open in the background.

- Backend: Rust (Tauri 2) wraps the Legendary CLI and gogdl, reads local Steam VDF files, and opens store pages as native WebView2 child windows.
- Frontend: Vite 6 + TypeScript 5.6. No framework. DOM updates and O(1) maps.

## 2. Commands

```powershell
npm.cmd run tauri dev
npm.cmd run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

PowerShell must call `npm.cmd`, not `npm`.

## 3. Rules

1. **Performance.** No O(N²) scans of a 500+ game library. Use `rawOf` and `summaryOf`. No idle `requestAnimationFrame`, polling, or animation. Paint from the disk cache first; sync the network behind that. Never rebuild a view with `innerHTML` on progress or IPC. Patch the node (`patchLibraryCardDom`, `data-dlbtn`).
2. **No emoji.** Buttons, toasts, tabs, and badges use `icon("name", size)` or an ISO language code (`TR`, `EN`).
3. **Look.** True black `#000000`, 1px hairlines, one white accent `--accent`. Color means status only: green online, amber updating, red error. No neon glow, gradient text, decorative gradients, `backdrop-filter: blur`, or 999px pills.
4. **Covers stay clean.** No permanent playtime or trophy badges on library covers. Do not show the same number twice on one screen. The game page is a wide hero, one primary action (`Play` / `Install`), and a quiet content column.
5. **Controller.** TV Mode is `src/features/gamepad/tv-mode.ts` (A select, B back, LB/RB shelves). A later Virtual Controller Bridge should present DualSense as XInput for games that only accept Xbox pads.
6. **Tabular numbers.** Speeds, percents, playtimes, and trophy counts use `font-variant-numeric: tabular-nums`.
7. **Module size.** One job per file. Past ~1,500 lines, split by responsibility. `core/` never imports `features/`.
8. **English.** Code comments are English.
9. **Git.** Commit and push only when the user asks. Messages are imperative English (`feat:`, `fix:`, `refactor:`).
10. **Child webviews.** Do not call `WebviewBuilder::additional_browser_args`. It blanks the child WebView2.

## 4. Map

- `src/core/` — state, selectors, nav, render bus, IPC-facing helpers.
- `src/features/` — library, store, downloads, settings, profile, gamepad, events.
- `src-tauri/src/legendary/commands/` — Epic IPC, one file per job. External path stays `legendary::commands::*`.
- `src-tauri/src/legendary/transfers.rs` — install queue, progress, launch.
- `src-tauri/src/gogdl/` — GOG session, library, transfers.
- `src-tauri/src/steam.rs` and `steam_auth.rs` — Steam library/details and DPAPI sign-in.
- `src-tauri/src/store_host.rs` — embedded store webviews.
- `src-tauri/src/main.rs` — process boot, window, tray, IPC registration.
- `docs/agent/README.md` — where to edit, and the traps.
- `docs/DESIGN_SYSTEM.md` — color, type, buttons, cards.
- `docs/TAURI_IPC_REFERENCE.md` — IPC commands.
- `docs/ROADMAP.md` — planned work.
