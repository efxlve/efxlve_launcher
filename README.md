# Efxlve Launcher

<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="Efxlve Launcher" width="96" />
</p>

<p align="center">
  <strong>Universal Gaming Hub for Windows</strong><br>
  A unified, ultra-fast desktop launcher for Epic Games, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net and Riot.<br>
  Built with Tauri 2, Rust, and Vanilla TypeScript. Zero framework bloat.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20x86__64-222" alt="Windows" />
  <img src="https://img.shields.io/badge/version-0.1.28-222" alt="Version 0.1.28" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-222" alt="GPL-3.0" />
</p>

Efxlve Launcher eliminates the need to keep multiple heavy launchers running in the background. It opens instantly from local disk cache, so your library is immediately accessible even offline. Installs, updates, and launches for managed stores are powered by native Rust wrappers around the `legendary`, `gogdl` and Nile CLIs, while client-owned stores keep using their own apps.

> **Platform note:** The launcher currently ships for Windows 10/11 (x64). Linux and macOS support is in the works and coming soon.

---

## Key Features

- **Unified Library:** Browse Epic Games, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net and Riot games in a single responsive cover grid or compact list view.
- **Embedded Stores:** Browse Epic Games, GOG, Steam, Xbox, Battle.net, Ubisoft, EA and Amazon Games inside native child webviews.
- **Console Dark Aesthetic (Hydra / PS5):** Pure black surfaces (`#000000`), subtle 1px hairline borders, single pure white accent (`--accent #ffffff`), and tabular numbers with zero layout jitter.
- **Dedicated 10-ft TV Mode:** Full controller navigation (`A: Select`, `B: Back`, `LB/RB: Shelves`) designed for TV and couch gaming.
- **Multi-Account Vault:** Connect multiple Epic, GOG, Steam and Amazon accounts. Fast 1-click account switching without re-entering credentials.
- **Downloads & Transfers:** Real-time bandwidth and disk write metrics, speed limiter, concurrent download control, and pause/resume capability.
- **Cloud & Local Save Backups:** Automated local backups on game exit, plus WebDAV and Google Drive cloud integration.
- **In-Game Screenshot Hook:** Dedicated F12 screenshot capture with asynchronous WebP/AVIF compression.
- **SteamGridDB Integration:** Automatic high-resolution covers and support for custom user artwork.
- **15 Languages:** Full interface parity across 15 languages with automatic system language detection.
- **Self-Updating:** In-app updates powered by signed GitHub Releases.

---

## Download & Install

The current release is **v0.1.28**.

1. Download the latest installer (`.exe`) from [Releases](https://github.com/efxlve/efxlve_launcher/releases/latest).
2. Requirements: Windows 10 or 11 (64-bit). Microsoft Edge WebView2 (pre-installed on Windows 11).

---

## Build from Source

### Prerequisites
- Windows 10/11 x86_64
- Node.js 20+
- Rust stable with MSVC toolchain

```powershell
git clone https://github.com/efxlve/efxlve_launcher.git
cd efxlve_launcher
npm.cmd install
npm.cmd run tauri dev
```

> **Note:** In Windows PowerShell, always use `npm.cmd` rather than `npm` to avoid execution policy errors.

### Verification & Testing
```powershell
npm.cmd run build          # Typecheck & Vite bundle verification
cargo check                # Fast Rust backend check (run from src-tauri)
cargo test                 # Rust unit tests
```

---

## Architecture & Design Guidelines

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Subsystem boundaries, cache-first hydration, and data pipelines.
- [docs/GOOGLE_DRIVE_SETUP_GUIDE.md](./docs/GOOGLE_DRIVE_SETUP_GUIDE.md) — Step-by-step Google Drive Cloud Save Backup setup guide.
- [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) — Hydra console dark tokens, layout contracts, and UI invariants.
- [docs/OVERLAY_ROADMAP.md](./docs/OVERLAY_ROADMAP.md) — In-game overlay research, architecture and milestones.
- [docs/TAURI_IPC_REFERENCE.md](./docs/TAURI_IPC_REFERENCE.md) — 236 Tauri IPC commands and event schemas.
- [AGENTS.md](./AGENTS.md) — Operational guidelines for AI agents and core developers.

---

## Special Thanks

Special thanks to [legendary](https://github.com/legendary-gl/legendary), [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), [Hydra Launcher](https://github.com/hydralauncher/hydra), [Playnite](https://github.com/JosefNemec/Playnite) and [SteamGridDB](https://www.steamgriddb.com/) — and to every project below. The in-app legal notice (Settings → About) carries the trademark and data-source details; this section credits everything the app is inspired by and built on.

### Design & UX inspiration

- [Hydra Launcher](https://github.com/hydralauncher/hydra) — the console-dark direction this UI follows: true-black surfaces, hairline borders, a single white accent, the quiet cover grid and the game-page layout.
- [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher) — the cache-first principle (paint the library from local disk before any network call) and the legendary/gogdl wrapper approach.
- [Playnite](https://github.com/JosefNemec/Playnite) — the 10-ft TV Mode model, and the reference for reading Xbox title history and achievement progress.
- Steam Big Picture and the PS5 system UI — controller navigation patterns in TV Mode.

### Store backends

These open-source tools ship with the launcher or are downloaded once at first use, and do the actual store work:

- [legendary](https://github.com/legendary-gl/legendary) — Epic Games installs, updates, cloud saves and launch.
- [gogdl](https://github.com/Heroic-Games-Launcher/heroic-gogdl) — GOG installs, updates and cloud saves.
- [Nile](https://github.com/imLinguin/nile) — Amazon Games library, installs and updates.
- [Comet](https://github.com/imLinguin/comet) — open-source GOG Galaxy Communication Service, run while a GOG game plays so achievements unlock without the Galaxy client.
- [SteamGridDB](https://www.steamgriddb.com/) — high-resolution cover art for the library grid.

### Frontend libraries & tooling

- [Tauri 2](https://github.com/tauri-apps/tauri) JS API and its [plugins](https://github.com/tauri-apps/plugins-workspace) — opener, process, updater, notification.
- [Lucide](https://lucide.dev/) — the icon set.
- [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/) and the [Tauri CLI](https://github.com/tauri-apps/tauri) — types, bundling and build tooling.

### Rust crates

Direct dependencies of the backend; each crate keeps its own license:

- [tauri](https://github.com/tauri-apps/tauri) and tauri-build — window, IPC, tray and the plugin host.
- [serde](https://github.com/serde-rs/serde) / [serde_json](https://github.com/serde-rs/json) — (de)serialization.
- [tokio](https://github.com/tokio-rs/tokio) — async runtime.
- [reqwest](https://github.com/seanmonstar/reqwest) — HTTP client with rustls.
- [rusqlite](https://github.com/rusqlite/rusqlite) — bundled SQLite for local caches.
- [notify](https://github.com/notify-rs/notify) — file watching (Steam manifests).
- [discord-rich-presence](https://github.com/vionya/discord-rich-presence) — Discord activity while a game runs.
- [flate2](https://github.com/rust-lang/flate2) / [tar](https://github.com/alexcrichton/tar-rs) — archive extraction for store tools.
- [sha2](https://github.com/RustCrypto/hashes) — checksums for downloaded binaries.
- [rsa](https://github.com/RustCrypto/RSA) — Steam sign-in encryption.
- [zeroize](https://github.com/RustCrypto/utils) — wiping secrets from memory.
- [rand](https://github.com/rust-random/rand), [base64](https://github.com/marshallpierce/rust-base64), [url](https://github.com/servo/rust-url) — protocol helpers.
- [qrcode](https://github.com/kennytm/qrcode-rust) — Steam QR sign-in.
- [thiserror](https://github.com/dtolnay/thiserror) — error types.
- [hidapi](https://github.com/ruabmbua/hidapi-rs) and [vigem-client](https://github.com/sudden-break/vigem-client) — gamepad and virtual-pad support on Windows.
- [crc32fast](https://github.com/srijs/rust-crc32fast) — Steam manifest checksums on Windows.

### Icons, marks and artwork

- Store and service marks belong to their owners and are shown only to identify those stores and services (nominative use). Some monochrome shapes are redrawn from [Simple Icons](https://simpleicons.org/) (CC0-1.0) — see [src/assets/stores/README.md](./src/assets/stores/README.md).
- Game covers and artwork come from the stores themselves and from SteamGridDB.

---

## License

GNU General Public License v3.0 (GPL-3.0). See [LICENSE](./LICENSE) for details.
Third-party components keep their own licenses; the list above and the in-app legal notice name their owners.
