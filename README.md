# Efxlve Launcher

<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="Efxlve Launcher" width="96" />
</p>

<p align="center">
  A fast desktop launcher for an Epic Games library on Windows.<br>
  Tauri 2, Rust, and TypeScript. No UI framework.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20x86__64-222" alt="Windows" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-222" alt="GPL-3.0" />
</p>

Efxlve keeps the library on disk and opens from that cache. A network sync runs in the background and does not block the window. Downloads, installs, and launches go through [legendary](https://github.com/legendary-gl/legendary).

The interface is a fixed sidebar, a cover grid, and a full game page. Surfaces are black. The accent is white. Green, amber, and red are used only for status.

## What it does

- Library as a cover grid or a denser list, with search, filters, and sort.
- Game page with the primary action, about text, achievements, add-ons, screenshots, and system requirements.
- Download queue with pause, resume, speed, and a chosen install folder.
- Epic Games Store inside the app, including free games.
- More than one Epic account, with a switch that does not ask for the password again.
- Custom covers through SteamGridDB, or a file you pick.
- Screenshots with a hotkey, only while the game window is in front.
- Move an installed game to another folder or drive.
- EA App and Ubisoft Connect games launch through their own apps.
- Optional Discord status, tray, and signed app updates.
- Interface languages follow the operating system until you pick one in Settings.

Gamepad play is a separate full-screen TV Mode. The desktop screens stay built for a mouse and keyboard. Every control can still be focused from the keyboard.

## Requirements

- Windows 10 or 11, 64-bit
- WebView2 (already present on Windows 11)

To build from source: Node.js 20 or newer, and Rust stable with the MSVC toolchain.

## Build

```powershell
git clone https://github.com/efxlve/efxlve_launcher.git
cd efxlve_launcher
npm.cmd install
npm.cmd run tauri dev
```

On PowerShell, use `npm.cmd`. `npm` is often blocked by the execution policy.

```powershell
npm.cmd run build          # typecheck and frontend build
npm.cmd run tauri build    # installer
```

From `src-tauri`:

```powershell
cargo check
cargo test
```

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) for how data moves through the app
- [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) for layout, color, and components
- [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a change
- [AGENTS.md](./AGENTS.md) if you are using an AI assistant on this repo

## License

GNU General Public License v3.0. The launcher wraps `legendary`, which is also GPL-3.0.

Thanks to [legendary](https://github.com/legendary-gl/legendary), [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), and [SteamGridDB](https://www.steamgriddb.com/).
