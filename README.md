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
  <img src="https://img.shields.io/badge/version-0.1.26-222" alt="Version 0.1.26" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-222" alt="GPL-3.0" />
</p>

Efxlve Launcher eliminates the need to keep multiple heavy launchers running in the background. It opens instantly from local disk cache, so your library is immediately accessible even offline. Installs, updates, and launches for managed stores are powered by native Rust wrappers around the `legendary`, `gogdl` and Nile CLIs, while client-owned stores keep using their own apps.

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

The current release is **v0.1.26**.

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
- [docs/TAURI_IPC_REFERENCE.md](./docs/TAURI_IPC_REFERENCE.md) — 236 Tauri IPC commands and event schemas.
- [AGENTS.md](./AGENTS.md) — Operational guidelines for AI agents and core developers.

---

## License

GNU General Public License v3.0 (GPL-3.0). See [LICENSE](./LICENSE) for details.
Special thanks to the [legendary](https://github.com/legendary-gl/legendary), [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), and [SteamGridDB](https://www.steamgriddb.com/) projects.
