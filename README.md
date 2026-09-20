# Efxlve Launcher 🎮

<p align="center">
  <img src="./dist/assets/logo.png" alt="Efxlve Launcher Logo" width="128" onerror="this.style.display='none'"/>
</p>

<p align="center">
  <strong>A high-performance, PlayStation 5 console-inspired desktop launcher for your Epic Games library.</strong><br>
  Built with Tauri v2, Rust, and Vanilla TypeScript for maximum speed and minimal memory footprint.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-v2-blue?logo=tauri" alt="Tauri v2"/>
  <img src="https://img.shields.io/badge/Rust-2021%20Stable-orange?logo=rust" alt="Rust"/>
  <img src="https://img.shields.io/badge/Frontend-Vite%20%2B%20TypeScript-blue?logo=typescript" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Platform-Windows%20x86__64-brightgreen?logo=windows" alt="Windows"/>
  <img src="https://img.shields.io/badge/License-GPL--3.0-purple" alt="License"/>
</p>

---

## ✨ Features

- 🎮 **PlayStation 5 Console Dark Aesthetic:** Obsidian & midnight blue interface (`#07080d`), cinematic game hero spotlight, 3D floating showcase posters, and refined typography.
- 🕹️ **10-Foot Gamepad Navigation:** Full game controller support (Xbox, PlayStation DualSense, DirectInput) with spatial navigation, D-pad browsing, and dedicated console HUD.
- 🏆 **Epic Achievements & Platinum Trophies:** Instant offline achievement tracking with dedicated PlayStation-style 4-tier trophy hub (Platinum, Gold, Silver, Bronze counters), progress levels, and secret achievement spoiler protection.
- ⚡ **Blazing Fast & Ultra Lightweight:** Progressive chunk rendering (<5ms render times for 500+ games), instant NVMe cache hydration, low RAM consumption (<90 MB idle vs 800+ MB on official launcher).
- ⬇️ **Advanced Download Manager:** Multi-game queue, pause/resume, download speed and disk write charts, integrity verification, and customizable installation directories.
- 🛒 **Embedded Epic Games Store:** Browse store pages, claim free weekly games, and inspect PDP product details directly inside a native embedded child webview.
- 🎨 **Custom Covers & Hero Art:** Built-in SteamGridDB integration for high-resolution custom vertical covers, wide heroes, and logos.
- 📸 **In-Game Screenshot Manager:** Native background F12 capture hook, screenshot gallery, and multi-format compression (WebP / AVIF).
- 🤝 **Partner Launchers & Anti-Cheat Detection:** Automatic detection and one-click launch for EA App (`link2ea://`), Ubisoft Connect, Rockstar Games Launcher, BattlEye, and Easy Anti-Cheat.
- 🛡️ **Zero-Crash Manifest Recovery:** Fault-tolerant catalog parsing (`skip.rs`) that automatically recovers from discontinued or 401-blocked Epic catalog items.

---

## 🛠️ Architecture Overview

Efxlve Launcher wraps the battle-tested, open-source [`legendary`](https://github.com/legendary-gl/legendary) CLI via a high-performance native Rust backend:

- **Frontend:** Pure Vanilla TypeScript + Vite 6 (Zero heavy frameworks, instant DOM updates).
- **Backend:** Tauri v2, Tokio async runtime, Rust native system APIs.
- **Data Pipeline:** **Cache-First** architecture. Local metadata is read in 0ms on startup; remote library synchronization runs silently in the background.

For full technical details, diagrams, and data flow pipelines, read **[ARCHITECTURE.md](./ARCHITECTURE.md)**.

---

## 🚀 Getting Started

### Prerequisites
- **Windows 10 / 11 (x86_64)**
- **WebView2 Runtime** (Pre-installed on Windows 11)
- For building from source:
  - [Node.js 20+](https://nodejs.org/)
  - [Rust Stable](https://rustup.rs/) (MSVC toolchain with Visual Studio C++ Build Tools)

### Installation & Development

1. **Clone the repository:**
   ```powershell
   git clone https://github.com/your-username/efxlve_launcher.git
   cd efxlve_launcher
   ```

2. **Install frontend dependencies:**
   ```powershell
   npm.cmd install
   ```

3. **Run the desktop app in development mode:**
   ```powershell
   npm.cmd run tauri dev
   ```

4. **Build production binaries:**
   ```powershell
   npm.cmd run tauri build
   ```

---

## 🎮 Controller Shortcuts (10-Foot Mode)

| Button / Key | Action |
|---|---|
| **A / ✕ (Cross)** | Select / Launch / Inspect |
| **B / ○ (Circle)** | Back / Close Modal or Lightbox |
| **X / □ (Square)** | Toggle Favorite |
| **Y / △ (Triangle)** | Focus Library Search |
| **LB / RB (L1 / R1)** | Cycle Navigation Tabs & Filters |
| **D-Pad / Left Stick** | Spatial Navigation through Game Grid |

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!
Please check out **[CONTRIBUTING.md](./CONTRIBUTING.md)** and **[AGENTS.md](./AGENTS.md)** before submitting code.

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)** — conforming with the underlying `legendary` CLI engine.

### Acknowledgments
- [`legendary`](https://github.com/legendary-gl/legendary) by derrod for the incredible Epic Games client backend.
- [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher) for architectural inspiration.
- [SteamGridDB](https://www.steamgriddb.com/) for community game assets.
