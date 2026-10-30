# Efxlve Launcher

<p align="center">
  <img src="./src-tauri/icons/128x128.png" alt="Efxlve Launcher" width="96" />
</p>

<p align="center">
  <strong>Universal Gaming Hub for Windows, Linux and macOS</strong><br>
  A unified, ultra-fast desktop launcher for Epic Games, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net and Riot.<br>
  Built with Tauri 2, Rust, and Vanilla TypeScript. Zero framework bloat.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-222" alt="Windows, Linux and macOS" />
  <img src="https://img.shields.io/badge/version-0.1.42-222" alt="Version 0.1.41" />
  <img src="https://img.shields.io/badge/license-GPL--3.0-222" alt="GPL-3.0" />
</p>

Efxlve Launcher eliminates the need to keep multiple heavy launchers running in the background. It opens instantly from local disk cache, so your library is immediately accessible even offline. Installs, updates, and launches for managed stores are powered by native Rust wrappers around the `legendary`, `gogdl` and Nile CLIs, while client-owned stores keep using their own apps.

> **Platform note:** Windows 10/11 (x64) is the primary target. Linux (x86_64) and macOS (Apple Silicon) preview builds are attached to every release; Linux ships as AppImage, deb and rpm, macOS as an unsigned dmg. Store CLIs download the right binary (an existing system `legendary` is used first), Wine/Proton/umu and the macOS toolchain are managed in Settings → Compatibility, and the overlay panel, library, stores, downloads and cloud saves use the Tauri webview on every platform. Native Windows surfaces — screen capture, clips, the FPS/HUD layer, the controller bridge and taskbar badges — are disabled on Linux/macOS instead of failing silently. Epic installs do not need Epic's own client: the launcher manages them through `legendary`, the same way Heroic does, so Epic's Linux preview client is optional.

---

## Key Features

- **Unified Library:** Browse Epic Games, GOG, Amazon Games, Steam, Xbox, EA, Ubisoft, Battle.net and Riot games in a single responsive cover grid or compact list view.
- **Achievements:** Every connected store keeps its own achievement set, with rarity tiers, unlock dates, guides, notes and a platinum state. A launcher-only editor can mark an achievement earned or clear an unlock for one game when a store misses it or when a delisted title deserves a fresh run; the store account is never touched, each edit is labelled in the list, and one click re-syncs the store's own progress. Unlocks from every store land in one local history — recent unlocks, a monthly count, a streak and your rarest find — and a burst of unlocks shares one notification card instead of burying the rest. Three pinned achievements form a profile showcase, and an unlock can save a screenshot of the moment to the game's gallery. A user-added game can pull its set and progress from RetroAchievements through the official web API.
- **Embedded Stores:** Browse Epic Games, GOG, Steam, Xbox, Battle.net, Ubisoft, EA and Amazon Games inside native child webviews.
- **Console Dark Aesthetic (Hydra):** Pure black surfaces (`#000000`), subtle 1px hairline borders, single pure white accent (`--accent #ffffff`), and tabular numbers with zero layout jitter. Three more surfaces are available in Settings → Appearance: Carbon Dark, **Pure White** and **Gloss** (sky/water glass with a blue accent).
- **Dedicated 10-ft TV Mode:** Full controller navigation (`A: Select`, `B: Back`, `LB/RB: categories`) with a compact command bar, cinematic stage, labelled shelf and card titles, designed for TV and couch gaming.
- **Multi-Account Vault:** Connect multiple Epic, GOG, Steam and Amazon accounts. Fast 1-click account switching without re-entering credentials.
- **Downloads & Transfers:** Real-time bandwidth and disk write metrics, speed limiter, concurrent download control, and pause/resume capability.
- **Cloud & Local Save Backups:** One-click local and cloud backups. The **Folder** provider works with OneDrive, Dropbox, a NAS or any folder your sync client already handles — no OAuth and no API keys. Google Drive, WebDAV, **rclone** (S3, Backblaze B2, Dropbox, OneDrive, Mega and 70+ more) and auto-sync on game exit are available too; every restore snapshots the current saves first so a wrong restore can be undone. **Launcher data** (custom games, collections, playtime, achievements, notes, themes and settings) can be exported to a `.efxprofile` file or synced through the same provider. New to this? Start with the [Folder guide](docs/CLOUD_FOLDER_GUIDE.md), or pick [Google Drive](docs/GOOGLE_DRIVE_SETUP_GUIDE.md), [WebDAV](docs/CLOUD_WEBDAV_GUIDE.md) or [rclone](docs/CLOUD_RCLONE_GUIDE.md).
- **In-Game Screenshot Hook:** Dedicated F12 screenshot capture with asynchronous WebP/AVIF compression, an editor, and a clip recorder. Windows only; the gallery still reads existing screenshots on Linux/macOS.
- **In-Game Overlay:** Open the controller-friendly panel from the launcher header or the tray from the moment the app starts, or with Shift+Tab (Windows) over a game. It brings performance telemetry with 1% / 0.1% frame-time lows, a 60 Hz frametime graph, CPU/GPU temperatures and CPU/GPU power, a native HUD with minimal/compact/full layouts, corner and text-color choices, a per-app audio mixer, a safe external crosshair, captures, notes with pasted maps and checklists, achievements with a tracked-achievement HUD, Spotify/SMTC music, Discord status, a browser and a picture-in-picture guide player. Floating widgets stay clear of the command bar and remember their place; pinned widgets stay over the game as a click-through HUD when the panel closes.
- **SteamGridDB Integration:** Automatic high-resolution covers and support for custom user artwork.
- **Compatibility Toolbox:** Wine/Proton runners (GE-Proton, Proton-CachyOS), umu-launcher, DXVK/VKD3D-Proton and the macOS toolchain can be downloaded, inventoried and selected from Settings → Compatibility. Detected Steam/Lutris/Wine runners are usable too, and selected layers are copied into each game's prefix. The game page's System tab adds per-title runner, layer and exact-prefix overrides, a Prepare prefix action with progress, and an open-folder button.
- **Compatibility Signals:** Steam game pages show Valve's Steam Deck category, the ProtonDB community tier and Are We Anti-Cheat Yet? status. Each answer is cached for a day and links back to its source.
- **Smart Collections & Status:** Manual collections now sit beside auto-updating smart collections for almost finished, playing, completed, on-hold and forgotten games. A game page can mark its status, and a random-game button picks from the current filters.
- **Accessible by design:** Interface scale from 80% to 150%, a reduced-motion/effects mode, visible keyboard focus and 16 languages. No page or feature is hidden at any scale.
- **16 Languages:** Full interface parity across 16 languages with automatic system language detection.
- **Self-Updating:** In-app updates powered by signed GitHub Releases.

---

## Download & Install

The current release is **v0.1.42**:
[github.com/efxlve/efxlve_launcher/releases/tag/v0.1.41](https://github.com/efxlve/efxlve_launcher/releases/tag/v0.1.41)

### Which file should I download?

| Your system | Download this | Notes |
|---|---|---|
| **Windows 10/11 (64-bit)** | `Efxlve.Launcher_0.1.41_x64-setup.exe` | Recommended. Normal installer with Start-menu and uninstall entries. |
| Windows, no installer wanted | `efxlve-launcher-portable.zip` | Extract anywhere and run `efxlve-launcher.exe`. Launcher data stays in `portable-data` beside it. |
| Windows, managed deployment | `Efxlve.Launcher_0.1.41_x64_en-US.msi` | For shops, labs or scripted installs. |
| **Linux (x86_64)** | `Efxlve.Launcher_0.1.41_amd64.AppImage` | Portable single file: `chmod +x` and run. |
| Linux, Debian/Ubuntu | `Efxlve.Launcher_0.1.41_amd64.deb` | Install with your software centre or `sudo apt install ./file.deb`. |
| Linux, Fedora/RHEL | `Efxlve.Launcher-0.1.41-1.x86_64.rpm` | Install with your software centre or `sudo rpm -i file.rpm`. |
| **macOS (Apple Silicon)** | `Efxlve.Launcher_0.1.41_aarch64.dmg` | Open the DMG and drag the app to Applications. Unsigned preview: right-click → Open the first time. |

The `.sig` files and `latest.json` are **updater metadata**, not installers. The app downloads them itself; you never need to open them.

Requirements: Windows needs Microsoft Edge WebView2 (pre-installed on Windows 11). Linux needs a desktop with GTK3/WebKitGTK 4.1; the AppImage bundles what it can. The macOS build is an **Apple Silicon preview** and is not notarized yet.

### Portable mode

The Windows portable zip contains `portable.txt`. When that file sits next to `efxlve-launcher.exe`, the launcher keeps its roaming/local data and legendary config in `portable-data` beside the executable, so the whole folder can move on a USB stick. Game installs, saves and the Steam library stay where they already are.

### Uninstall & clean removal

Closing the window sends the launcher to the tray instead of quitting, so **quit it first**: right-click the tray icon → **Quit**, or end `efxlve-launcher.exe` in Task Manager. Then remove it from Settings → Apps and delete what the uninstaller leaves behind:

| Folder | What it holds |
|---|---|
| `%APPDATA%\com.efxlve.launcher` | Settings, caches, helper binaries (`legendary`, `gogdl`, `nile`, `comet`), logs and feedback reports |
| `%LOCALAPPDATA%\com.efxlve.launcher` | The WebView2 profile (`EBWebView`); a damaged profile is the usual reason the window never appears |
| `%USERPROFILE%\.config\legendary` | Epic account sessions, the installed list and save backups |
| `%USERPROFILE%\.config\efxlve` | Screenshot thumbnails and the compatibility tools |

If **start with Windows** was enabled, also delete the `EfxlveLauncher` value under `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`.

Uninstalling never touches your games: install folders, saves, the Steam library and `Pictures\Efxlve Screenshots` stay where they are. A portable install is removed by deleting its folder, and its data lives in `portable-data` beside the executable. On Linux and macOS the same files sit in the platform's app-data folder for `com.efxlve.launcher` (`~/.local/share/…` and `~/Library/Application Support/…`), plus `~/.config/efxlve` and `~/.config/legendary`.

---

## Cloud saves in one minute

You do **not** need to read the architecture document to turn cloud saves on. Pick the guide that matches where you already keep files:

- [Folder guide](docs/CLOUD_FOLDER_GUIDE.md) — easiest; OneDrive, Dropbox, Google Drive desktop, Nextcloud or a NAS folder. No account setup inside the launcher.
- [Google Drive guide](docs/GOOGLE_DRIVE_SETUP_GUIDE.md) — connect Drive directly with your own free OAuth client.
- [WebDAV guide](docs/CLOUD_WEBDAV_GUIDE.md) — Nextcloud, ownCloud, Hetzner Storage Box or any WebDAV server.
- [rclone guide](docs/CLOUD_RCLONE_GUIDE.md) — 70+ services including S3, Backblaze B2, OneDrive, Mega and pCloud.

The short version: **Settings → Cloud → Enable**, choose a provider, fill the two or three fields the guide names, press **Test Connection**, then **Save**. Open a game → **Manage** → **Backup to Cloud**. The same page can export or cloud-sync the launcher profile (custom games, achievements, notes, themes).

---

## Build from Source

### Prerequisites
- Windows 10/11 with the MSVC toolchain, or Linux/macOS with the platform Tauri prerequisites below
- Node.js 20+
- Rust stable

**Windows**

```powershell
git clone https://github.com/efxlve/efxlve_launcher.git
cd efxlve_launcher
npm.cmd install
npm.cmd run tauri dev
```

> **Note:** In Windows PowerShell, always use `npm.cmd` rather than `npm` to avoid execution policy errors.

**Linux (Debian/Ubuntu)**

```bash
sudo apt install build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libwebkit2gtk-4.1-dev
npm install
npm run tauri dev
```

Fedora/Arch and the full list are in the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). The overlay uses the normal Tauri webview; on Wayland some compositors ignore always-on-top requests, so the panel can sit behind a fullscreen game.

**macOS**

Install Xcode Command Line Tools (`xcode-select --install`), then:

```bash
npm install
npm run tauri dev
```

Wine/Proton and the Apple Game Porting Toolkit/DXMT stack are managed from Settings → Compatibility. The launcher does not redistribute Apple's GPTK.

### Verification & Testing
```powershell
npm.cmd run build          # Typecheck & Vite bundle verification
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

On Linux/macOS use `npm run build` and `cargo check` from `src-tauri`.

---

## Architecture & Design Guidelines

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Subsystem boundaries, cache-first hydration, and data pipelines.
- [docs/CLOUD_SAVES.md](./docs/CLOUD_SAVES.md) — Cloud/local save backup architecture, user setup and open work.
- [docs/GOOGLE_DRIVE_SETUP_GUIDE.md](./docs/GOOGLE_DRIVE_SETUP_GUIDE.md) — Step-by-step Google Drive Cloud Save Backup setup guide.
- [docs/DESIGN_SYSTEM.md](./docs/DESIGN_SYSTEM.md) — Hydra console dark tokens, layout contracts, and UI invariants.
- [docs/OVERLAY_ROADMAP.md](./docs/OVERLAY_ROADMAP.md) — In-game overlay research, architecture and milestones.
- [docs/CROSS_PLATFORM.md](./docs/CROSS_PLATFORM.md) — Linux/macOS compatibility layer, runners and packaging plan.
- [docs/IPC_INDEX.md](./docs/IPC_INDEX.md) — Generated index of the Tauri IPC commands.
- [TODO.md](./TODO.md) — Open work.
- [AGENTS.md](./AGENTS.md) — The project rules loaded by DeepSeek Harness.

---

## Special Thanks

Special thanks to [legendary](https://github.com/legendary-gl/legendary), [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), [Hydra Launcher](https://github.com/hydralauncher/hydra), [Playnite](https://github.com/JosefNemec/Playnite), [steam-case-covers](https://github.com/diegobergonsi/steam-case-covers), [SteamGridDB](https://www.steamgriddb.com/), [SteamDB Browser Extension](https://github.com/SteamDatabase/BrowserExtension) and [Augmented Steam](https://github.com/IsThereAnyDeal/AugmentedSteam) — and to every project below. The in-app legal notice (Settings → About) carries the trademark and data-source details; this section credits everything the app is inspired by and built on.

### Design & UX inspiration

- [Hydra Launcher](https://github.com/hydralauncher/hydra) — the console-dark direction this UI follows: true-black surfaces, hairline borders, a single white accent, the quiet cover grid and the game-page layout.
- [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher) — the cache-first principle (paint the library from local disk before any network call) and the legendary/gogdl wrapper approach.
- [Playnite](https://github.com/JosefNemec/Playnite) — the 10-ft TV Mode model, and the reference for reading Xbox title history and achievement progress.
- [steam-case-covers](https://github.com/diegobergonsi/steam-case-covers) — the physical retail game box framing and header strip design for library covers.
- Steam Big Picture and the console system UI — controller navigation patterns in TV Mode.

### Store backends

These open-source tools ship with the launcher or are downloaded once at first use, and do the actual store work:

- [legendary](https://github.com/legendary-gl/legendary) — Epic Games installs, updates, cloud saves and launch.
- [gogdl](https://github.com/Heroic-Games-Launcher/heroic-gogdl) — GOG installs, updates and cloud saves.
- [Nile](https://github.com/imLinguin/nile) — Amazon Games library, installs and updates.
- [Comet](https://github.com/imLinguin/comet) — open-source GOG Galaxy Communication Service, run while a GOG game plays so achievements unlock without the Galaxy client.
- [SteamGridDB](https://www.steamgriddb.com/) — high-resolution cover art for the library grid.

### Storefront extensions & community tooling

- [SteamDB Browser Extension](https://github.com/SteamDatabase/BrowserExtension) (BSD-3-Clause, Copyright © 2013-present SteamDB) — community pricing history, concurrent player stats, SteamDB rating metrics, and direct links injected into the Steam store view.
- [Augmented Steam](https://github.com/IsThereAnyDeal/AugmentedSteam) (GPL-3.0, Copyright © IsThereAnyDeal / Augmented Steam contributors) — digital store price comparisons via IsThereAnyDeal, HowLongToBeat completion times, OpenCritic & Metacritic user scores, and DRM alert styling.

### Compatibility runtimes

These are downloaded on demand from Settings → Compatibility and used only on the platform they target:

- [GE-Proton](https://github.com/GloriousEggroll/proton-ge-custom) and [Proton-CachyOS](https://github.com/CachyOS/proton-cachyos) — Wine/Proton runners.
- [umu-launcher](https://github.com/Open-Wine-Components/umu-launcher) — runs Proton inside the Steam Runtime.
- [DXVK](https://github.com/doitsujin/dxvk) and [VKD3D-Proton](https://github.com/HansKristian-Work/vkd3d-proton) — DirectX 9/10/11 and 12 to Vulkan.
- [Game Porting Toolkit](https://github.com/Gcenx/game-porting-toolkit), [macOS Wine builds](https://github.com/Gcenx/macOS_Wine_builds), [DXVK-macOS](https://github.com/Gcenx/DXVK-macOS) and [DXMT](https://github.com/3Shain/dxmt) — macOS toolchain.
- [Heroic Epic Integration](https://github.com/Etaash-mathamsetty/heroic-epic-integration) — the Epic Games Launcher stand-in used inside a prefix.
- [vulkan-helper-rs](https://github.com/imLinguin/vulkan-helper-rs) — Vulkan capability probe used by the Heroic stack.
- CrossOver is detected when installed; its Wine build is not redistributed by this launcher.

On a game page, the System tab can override the global runner, choose DXVK/VKD3D for that title, select an exact prefix folder, show whether the prefix exists, prepare it with `wineboot` progress and open it in the file manager. Layers are applied only after the prefix has been initialized; with layers enabled, the launch path prepares the prefix before starting the game, so the first launch already gets them. The explicit Prepare action does the same wait ahead of time.

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
- [xz2](https://github.com/alexcrichton/xz2-rs) / [zstd](https://github.com/gyscos/zstd-rs) — `.tar.xz` and `.tar.zst` runtime archives.
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
