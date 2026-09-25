# Efxlve Launcher

<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="Efxlve Launcher" width="96" />
</p>

<p align="center">
  A desktop launcher for an Epic Games library on Windows.<br>
  Tauri 2, Rust, and TypeScript. No UI framework.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20x86__64-222" alt="Windows" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-222" alt="GPL-3.0" />
</p>

Efxlve opens from the library already on disk. A network sync runs behind that and does not hold the window. Installs, updates, and launches go through [legendary](https://github.com/legendary-gl/legendary).

The window is a fixed sidebar and one main page. Surfaces are black. The accent is white. Green, amber, and red are status, not decoration.

![Library. A cover grid with playtime and achievement counts on each tile.](./docs/screenshots/library.jpg)

The library is a cover grid. Each tile can show playtime and achievement progress. Search, filters, collections, and sort sit on one row. A denser list is there when the grid is the wrong shape for what you are looking for. Games that are not installed stay in the grid, slightly dimmed.

## Game page

Open a game and the cover becomes the page. Play, or Update when a newer build is waiting. Time played, trophies, a story-length estimate, and review scores sit on the same bar. About, achievements, add-ons, screenshots, and system requirements are tabs under that.

![Cyberpunk 2077. Play, six minutes played, 53 of 57 trophies, and review scores.](./docs/screenshots/game.jpg)

Studio, a required launcher, and anti-cheat share one line under the title, separated by a dot. The Update button is the only update label on the page.

![Grand Theft Auto V Enhanced, with an update ready and Rockstar Games Launcher listed under the title.](./docs/screenshots/update.jpg)

Manage opens in its own window: verify files, move the install, open the folder, create a desktop shortcut, change the cover, sync cloud saves, keep a local backup, and set launch arguments.

![Manage for Cyberpunk 2077. Install path, cloud saves, and launch arguments.](./docs/screenshots/manage.png)

## Downloads

An active download shows network speed, disk write, size, and time left, with a short graph of the last samples. Updates waiting on installed games are listed under that. Installed games stay on the same page, with Play on each row.

![Downloads. Alan Wake Remastered in progress, and Grand Theft Auto V Enhanced waiting for an update.](./docs/screenshots/downloads.png)

Pause and resume keep the partial files. Closing the window while a download is running hides the launcher to the tray instead of stopping the transfer. You pick the install folder before a new game starts. A folder you already filled, including a portable drive, can be scanned and attached to the library. Rockstar, EA, and Ubisoft folders are skipped unless Epic Games Launcher already finished that install.

## Store

The Epic Games Store opens inside the window, next to the sidebar. A game you already own is marked In Library. The store page itself follows the language of the Epic account, so it can differ from the launcher language.

![Epic Games Store inside the launcher. Owned games are marked In Library.](./docs/screenshots/store.jpg)

## Profile

Profile is the account you are signed in with: games, time, trophies, and XP, then achievement progress per game. Recently played sits on the side, with friends under it.

![Profile. Achievement progress for the signed-in account, recently played games, and friends.](./docs/screenshots/profile.png)

## Also in the app

- More than one Epic account. Switching does not ask for the password again.
- Fifteen interface languages. With no saved choice, the launcher follows Windows.
- Screenshots from a hotkey, only while that game's window is in front.
- Custom covers from SteamGridDB, or a picture you pick.
- EA App and Ubisoft Connect games launch through their own apps.
- Optional Discord status, a tray icon, and signed updates from GitHub Releases.
- A separate full-screen TV Mode for a gamepad. The desktop screens stay built for a mouse and keyboard. Every control can still be focused from the keyboard.

## Requirements

- Windows 10 or 11, 64-bit
- WebView2, already present on Windows 11

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

`tauri dev` and a loose executable do not update themselves. Signed updates apply to a copy installed from the NSIS setup.

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) for how data moves through the app
- [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) for layout, color, and components
- [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a change
- [AGENTS.md](./AGENTS.md) if an AI assistant is writing the patch

## License

GNU General Public License v3.0. The launcher wraps `legendary`, which is also GPL-3.0.

Thanks to [legendary](https://github.com/legendary-gl/legendary), [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), and [SteamGridDB](https://www.steamgriddb.com/).
