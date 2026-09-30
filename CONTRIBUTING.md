# Contributing to Efxlve Launcher

Efxlve Launcher is an open-source Universal Gaming Hub for Windows, aggregating Epic Games, GOG, and Steam in a single unified client. The frontend is frameworkless Vanilla TypeScript (Vite 6). The native backend is Rust on Tauri v2.

Issues and pull requests are welcome. Read this guide and [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) before making interface or architectural changes. If an AI assistant is assisting, it must adhere to [AGENTS.md](./AGENTS.md) and `.cursorrules`.

---

## 1. Design & UI Invariants

The application has a strict, uncompromising visual contract:

- **Surface & Palette:** True black background (`#000000`), subtle 1px hairline borders, and single pure white accent (`--accent #ffffff`). Colors convey status only (green = online, amber = update/idle, red = error/counter).
- **No Decorative AI Glitz:** No decorative rainbow gradients, no neon glow (`box-shadow glow`), no gradient text, no glass blur on repeated items, and no turning every button into a 999px pill.
- **Zero-Emoji Policy:** Never use OS emojis (🎮, 🚀, ✨, etc.) in buttons, notifications, toasts, or tabs. Always use clean inline SVG icons (`icon("name", size)`) or ISO language codes (`TR`, `EN`).
- **Tabular Numerals:** Speeds (MB/s), percentages, download bars, game playtimes, and trophy counters must use `font-variant-numeric: tabular-nums` to prevent visual jitter.
- **No Layout Shift on Focus:** Focus rings are 2px `--accent` with 2px offset. Do not scale cards (`transform: scale(...)`) on focus.
- **Microcopy:** Short, calm, professional console language. No excessive exclamation marks or marketing hyperbole.

---

## 2. Engineering Standards

- **Code Comments:** Write all comments strictly in English. Explain the non-obvious *why*, not just the *what*.
- **Modularity:** Keep files focused and under ~500–1000 lines. Place feature-specific UI in `src/features/<feature>/` and shared utilities in `src/core/`.
- **Targeted DOM Mutation:** Never destroy and re-render the entire library (`viewEl.innerHTML = ...`) on download progress or IPC events. Use in-place card patching (`patchLibraryCardDom`, `data-dlbtn`, `data-dlbar`).
- **O(1) Data Structures:** Maintain and use `rawOf` and `summaryOf` hash maps. Never use linear `.find()` in high-frequency rendering paths.
- **Tauri IPC Naming:** Arguments are camelCase on the JavaScript side (`appName`), matching snake_case in Rust (`app_name: String`).
- **Internationalization (i18n):** User-facing strings must use `t("key")`. All 15 locale JSON files in `src/locales/` must maintain 1:1 key parity.
- **PowerShell Tooling:** Always use `npm.cmd` instead of `npm` on Windows PowerShell.

---

## 3. Required Verification

Before submitting changes, ensure the following commands pass with zero errors:

```powershell
npm.cmd run build          # Typecheck (tsc --noEmit) and Vite production build
cargo check                # Rust backend validation
cargo test                 # Rust unit tests
```

---

## 4. Commits & Pull Requests

- Use standard English imperative commit messages (`feat: ...`, `fix: ...`, `refactor: ...`, `perf: ...`, `docs: ...`).
- Never commit private keys, updater signing keys, secrets, or local configuration files.
