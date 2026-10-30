# CROSS_PLATFORM.md — Linux & macOS Compatibility Layer (Research and Architecture)

> **Status:** core layer, store CLIs, compatibility tools and the launch chain are implemented (2026-10-23).
> Linux/macOS packaging is attached to releases; the Flatpak bundle is built by the Package workflow, while Flatpak signing/publishing, signing/notarization and real-hardware validation remain open.
> **Goal:** define how Efxlve Launcher moves beyond Windows, which Wine/Proton/D3DMetal layers it uses, and where the platform abstraction lives. Heroic Games Launcher is the reference model.

---

## 1. Why this is possible

Efxlve Launcher already has two major portability advantages:

1. **The `legendary` CLI is platform-independent.** Epic authentication, catalog, manifests, downloads and cloud saves run through the Python-based `legendary` CLI, which ships Linux and macOS binaries. The Rust backend is only a process wrapper (`client.rs`, `transfers.rs`), so that layer is largely reusable.
   Epic's Linux preview client released in October 2026 is a separate application; this launcher still manages Epic installs through `legendary` and does not require the official client. Heroic uses the same approach.
2. **Tauri v2 + Vite/TypeScript is platform-independent.** The interface, controller navigation, themes and render discipline work unchanged.

**Windows-only surfaces that need a portable path:**
- Windows Registry scans (`cache.rs` EGL detection, `commands.rs` third-party launcher hub).
- Low-level keyboard hook and screenshot capture (`screenshots.rs`, Win32 `SetWindowsHookEx`).
- Native child webview for the embedded Epic Store (`main.rs` `add_child`, `HWND`-based on Windows).
- Windows shell integration: `explorer`, `link2ea://`, `.lnk` shortcuts.
- Drive enumeration (`move_game.rs`, Windows drive letters).

---

## 2. Shared architecture: platform abstraction

The intended shape is a `src-tauri/src/platform/` module beside the existing `legendary/` modules. `#[cfg(target_os = "...")]` selects the implementation at compile time; business logic talks through a trait.

```rust
// platform/mod.rs
pub trait PlatformHost {
    /// Default game install root (Win: %USERPROFILE%\Games, Linux/macOS: ~/Games).
    fn default_install_dir(&self) -> PathBuf;
    /// System drives / mounted volumes (Win: C:, D:; Linux/macOS: mount points).
    fn system_drives(&self) -> Vec<SystemDriveInfo>;
    /// Reveal a folder in the file manager (explorer / xdg-open / open).
    fn reveal_in_file_manager(&self, path: &Path) -> Result<()>;
    /// Screenshot capture hook (Win: Win32 hook; Linux: XDG portal; macOS: screencapture).
    fn install_screenshot_hook(&self, hotkey: u32) -> Result<()>;
    /// Third-party launcher protocols (Win: link2ea://, uplay://; other: none / via Wine).
    fn launch_third_party(&self, protocol: &str, app_name: &str) -> Result<()>;
}
```

Two implementations behind `cfg`: `platform/windows.rs` preserves current behavior, and `platform/unix.rs` covers Linux + macOS, with `cfg(target_os = "macos")` for macOS-only branches.

---

## 3. Linux architecture (Wine / Proton / umu)

Heroic model: `legendary launch <app> --no-wine --wrapper "<runner> run"`.

### 3.1 Runner layer

| Component | Role |
|---|---|
| **GE-Proton** (`proton-ge-custom`) | Recommended default; Valve Proton plus GloriousEggroll patches (media codecs, anti-cheat compatibility). |
| **Proton-cachyos** | Alternative performance-oriented runner. |
| **Wine-GE / Wine-Lutris** | Non-Steam cases that need plain Wine. |
| **umu-launcher** | Standard launcher for running Proton outside the Steam Runtime (manages `STEAM_COMPAT_*`). Modern Heroic default. |
| **DXVK** | DirectX 9/10/11 → Vulkan translation. |
| **VKD3D-Proton** | DirectX 12 → Vulkan translation. |
| **Gamescope / GameMode** | Nested compositor / CPU governor optimization (Steam Deck friendly). |

### 3.2 Prefix manager (one isolated `WINEPREFIX` per game)

- A prefix is created per game under `~/Games/Efxlve/Prefixes/<AppName>`.
- Proton receives `STEAM_COMPAT_DATA_PATH=<prefix>`, `STEAM_COMPAT_CLIENT_INSTALL_PATH` and `STEAM_COMPAT_APP_ID=0`.
- DXVK/VKD3D toggles, FSR/sharpness, `nvidiaPrime`, `useGameMode` and `WINEDLLOVERRIDES` are added to the per-game `GameLocalSettings` schema (the existing structure is extended).
- Winetricks/protontricks-style operations run inside the prefix through the runner's own `wine` binary.

### 3.3 Wine manager (runner download and management)

- Runners download under `~/.config/efxlve/tools/{wine,proton}`.
- Known Heroic locations are also scanned: `~/.steam/root/compatibilitytools.d`, `~/.steam/steam/steamapps/common`, `~/.local/share/lutris/runners/wine`, `/usr/share/steam`.
- GE-Proton / Wine-GE downloads use GitHub Releases with SHA-256 verification (reusing the `downloader.rs` infrastructure).

### 3.4 Compatibility information

- **ProtonDB** API/badge in the game detail drawer.
- **Steam Deck Verified** status when available.
- Anti-cheat warning for titles that risk a ban under Wine/Proton (as in the Heroic FAQ).

### 3.5 Packaging

- **AppImage** — distribution-independent portable build (primary preview artifact).
- `.deb` / `.rpm` — distro packages (attached to releases).
- **Flatpak** (`com.efxlve.launcher`) - manifest and desktop entry live in `flatpak/`; the
  Package workflow extracts the AppImage into the manifest source and builds a `.flatpak`
  bundle. Signing the bundle and publishing it to a Flatpak repository remain open.
- AUR is a secondary community channel.

---

## 4. macOS architecture (Apple Silicon focused)

> **Key fact (2026):** CrossOver 27 dropped Intel Macs and 32-bit bottles; the ecosystem is focused on **Apple Silicon (M1+)** and **macOS Sonoma+**. The design targets that.

| Layer | Option | Note |
|---|---|---|
| **Primary (free)** | **Apple Game Porting Toolkit 4** (D3DMetal) + Wine (Gcenx build) | DirectX 11/12 → Metal; Apple's licence limits commercial redistribution, so the user installs it. |
| **Alternative** | **DXMT** (D3D → Metal, open source) | Common in free stacks without CrossOver. |
| **Commercial** | **CrossOver** bottle management | Similar to Heroic's `wineCrossoverBottle` model. |
| **Runner** | Wine-Crossover, Wine-Staging, GPTK | Heroic's macOS Wine Manager equivalent. |

- Prefix: CrossOver bottle or `WINEPREFIX`, depending on the macOS version.
- MetalFX / D3DMetal DLL overrides are managed per prefix.
- Rosetta 2 is only for x86_64 helper processes; games run under the Apple Silicon native Wine.

---

## 5. Mapping platform-specific surfaces

| Windows feature | Linux equivalent | macOS equivalent |
|---|---|---|
| Registry EGL/launcher scan | `legendary` config + `~/.steam` scan | CrossOver bottle / `~/Library` scan |
| Win32 F12 keyboard hook | XDG Desktop Portal `GlobalShortcuts` or `evdev` | `screencapture` + global hotkey (CGEventTap) |
| Native child webview store | Tauri child webview (WebKitGTK) | Tauri child webview (WKWebView) |
| `explorer` / `.lnk` shortcut | `xdg-open`, `.desktop` file | `open`, `.app`/alias |
| `link2ea://`, `uplay://` | Wine registry handler or native launcher | CrossOver bottle handler |
| Drive letters | `lsblk` / mount points | `/Volumes` scan |
| `--max-workers`, `--max-shared-memory` | Same legendary flags apply | Same legendary flags apply |

---

## 6. Phased implementation plan

| Phase | Scope | Output | Status |
|---|---|---|---|
| **F0** | `platform/` abstraction + `cfg` skeleton; Windows behavior unchanged. | Build green on all three platforms. | Implemented with `cfg` modules and Unix stubs. |
| **F1** | Linux: `legendary` + plain Wine launch; prefix management; `xdg-open`. | Basic library/game on Linux. | Implemented; hardware validation open. |
| **F2** | Wine Manager (GE-Proton/Wine-GE), automatic DXVK/VKD3D install, umu integration. | Heroic-level Linux experience. | Tool manager and layer copying implemented. |
| **F3** | ProtonDB badges, Gamescope/GameMode, Flatpak + AppImage packaging. | Steam Deck-friendly distribution. | ProtonDB/Deck badges exist; Flatpak open. |
| **F4** | macOS Apple Silicon: GPTK/DXMT runner management, CrossOver bottle support. | Game launch on macOS. | Toolchain implemented; signing and hardware validation open. |
| **F5** | Cross-platform screenshot hook and shell integrations. | Feature parity. | Works on Windows; hidden elsewhere. |

---

## 7. Risks and constraints

- **Anti-cheat:** kernel-level anti-cheat (EAC/BattlEye) does not run under Wine/Proton for most titles; the user must be warned.
- **Apple licence:** GPTK/D3DMetal may not be redistributed commercially; the launcher only manages the user's own installation and does not bundle the binary.
- **Performance target stays:** Wine/Proton translation adds CPU/GPU cost; the low-overhead/120 FPS discipline on the UI side (AGENTS.md) applies unchanged.
- **legendary fork:** Heroic uses its own fork; upstream compatibility must be tracked.

---

## 8. Implemented first layer (2026-10-19)

This section describes what is in the code; it does not imply that every platform package is production-ready.

### 8.1 Store CLIs per platform

- `legendary/paths.rs` and `gogdl/paths.rs` select the correct release asset for the OS and architecture (Windows x64/ARM64, Linux x64/ARM64, macOS x64/ARM64). Downloaded files are marked executable on Unix.
- On Unix, a user-installed `legendary` (PATH, `~/.local/bin`, `/usr/local/bin`, Homebrew) is used first and the download is skipped. The version is checked with `legendary -V`; a broken copy falls back to the downloaded one. This helps when GitHub is unreachable or the distro already ships legendary.
- Nile and Comet already had pinned assets for every platform; behavior is unchanged.

### 8.2 Compatibility tool manager

`src-tauri/src/compat/` is split into three jobs:

| File | Job |
|---|---|
| `catalog.rs` | 16-tool catalog, platform/asset mapping, archive type |
| `install.rs` | GitHub release check (6-hour cache), download, SHA-256, extraction, folder record, uninstall, IPC |
| `launch.rs` | Wine/Proton/umu wrapper, `WINEPREFIX`, `STEAM_COMPAT_*`, `PROTONPATH`, `GAMEID`, `STORE` |

- Tools install under `<app_data>/compat/<os>-<arch>/<tool>/<tag>`; each install has `manifest.json`. `.tar.gz`, `.tar.xz`, `.tar.zst`, `.tar` and plain files are supported. Archive paths are checked for `..`/root escapes.
- If the GitHub asset has a `digest`, SHA-256 is verified; the downloaded size is also compared with the declared size.
- Interrupted downloads are kept as `.part` and resumed with an HTTP Range request. A completed part is verified and reused without a second download; a server that ignores Range restarts from zero. Removing a tool deletes its parts too.
- Large downloads emit `compat-progress` with percentage and can be cancelled. A second download of the same tool is refused.
- From Windows the user can pick `linux-x86_64`, `linux-aarch64`, `macos-x86_64` or `macos-aarch64` as the target, for preparing a tool tree before packaging. Launching always uses the tree of the running platform.

### 8.3 Launch chain

- Epic: `legendary launch --wrapper "<runner> [run]"` plus environment variables.
- GOG: the game exe is launched behind the selected wrapper.
- Amazon: `nile launch --no-wine --wrapper "<runner> [run]"` plus environment.
- Precedence: the game's own `wrapper` setting → compatibility-manager selection → (on Windows) Epic relay. If umu-launcher is installed and enabled, it is used instead of Proton. By default every game gets its own prefix under `<prefix>/<appName>`; selecting a full folder on the game page overrides it.
- DXVK and VKD3D-Proton, when enabled on the Compatibility page, are copied once into the real Wine prefix (`system32`/`syswow64`) and `WINEDLLOVERRIDES` is set at launch. Proton keeps its prefix under `compatdata/pfx`, so the copy goes there; plain Wine and umu use the root. If the prefix has not been initialized by `wineboot` yet (no `system.reg`), layers are not written on that boot, so Proton's first setup cannot overwrite the DLLs; they are applied on the next launch. Off by default; per-game `env_vars` can override it.
- With no explicit choice, the launcher uses the first runner it downloaded, then the first system runner (Steam `compatibilitytools.d`, Lutris, system Wine). "Off" now really means off: `compat_runner_enabled = false` skips the launch wrapper entirely unless a game has an explicit exception. umu-launcher can also run from a system `umu-run`, not only the launcher's downloaded copy.
- The game page's System tab can select a per-game runner, DXVK/VKD3D switches and an exact prefix folder. The choice lives in `<app_data>/compat/games.json` and overrides the global setting only for that game. An explicit game choice also overrides the global off switch, so compatibility can be enabled for one title. When the layer selection matches the global one, the record is removed and the game inherits the global setting again. An empty prefix field uses the global root and game name; a filled one is used as-is, so an existing Steam `compatdata` prefix can be reused.
  The **Open** button reveals the game's prefix: Proton's real `pfx` folder when initialized, otherwise the compatdata root. The status text on the same row shows whether the prefix is ready. **Copy diagnostics** puts runner, prefix, Wine root and layer paths on the clipboard as plain text with no credentials, for Linux/macOS bug reports. Settings → Compatibility has the same button and also copies platform, target, tool folder, managed versions, detected system runners and launch settings.
- The game page's **Prepare prefix** button calls `compat_prepare_prefix`: it runs `wineboot -u` with the selected runner, emits `compat-prefix-progress`, times out after 180 seconds, then copies layers into the real prefix. The same preparation runs before a normal launch when layers are enabled, so the first launch receives them. With no layers the wait is skipped and Wine/Proton initializes the prefix normally. A preparation error does not block the game; the next launch retries. The launch notification stays visible during preparation and shows elapsed seconds, then returns to "Launching…" on error.
- On Windows, `launch_spec` and `compat_prepare_prefix` do not launch; the existing Windows path is preserved and the preparation command returns an explicit error.

On the Steam game page's "copy on this PC" card, the ProtonDB community rating is shown by Steam app id. The response is cached on disk per app for one day; on a network error the old copy is used, and if none exists the row is hidden. The row links to the ProtonDB page. The same card shows Are We Anti-Cheat Yet? status: one `games.json` file is downloaded once a day and searched by app id; the status, anti-cheat names and a link to the game page are shown. Besides Steam ids, 73 games matching the Epic catalog namespace (`storeIds.epic.namespace`) are covered. If there is no record or the source is unreachable, the row stays hidden. Valve's Steam Deck compatibility report is also shown on the same card: `resolved_category` 1 is unsupported, 2 playable, 3 verified; the response is cached per app daily.

### 8.4 Interface

Settings → Compatibility: target-platform selector, store CLIs, runners, runtimes, translation layers and helpers; version/size, installed version, system copies, install/remove/update and live progress. The bottom shows the default runner for this PC, version, prefix folder and umu switch. The runner list shows Steam `compatibilitytools.d`, Lutris and system Wine copies next to launcher-downloaded versions; the selected folder is stored as `compat_runner_path` and takes precedence over the launcher's own copy at launch. The page also shows the real size of the tool folder and can clean partial download/extraction parts with one button.

### 8.5 Remaining work

- **Flatpak** is built by the Package workflow as an unsigned `.flatpak` bundle; publishing to a Flatpak repository and signing it remain open. macOS signing/notarization is still open; `.deb`/`.rpm`/AppImage and `.dmg`/`.app` are attached to releases, but the macOS app is unsigned and not notarized.
- GPTK/D3DMetal licence: the binary is not bundled; the user manages their own installation.
- Real-hardware validation on Linux/macOS: game launch, Proton prefix, Steam library and store webviews.
- macOS signing/notarization and Apple Silicon native runner validation. The overlay's transparent window uses the `macos-private-api` feature; that private API blocks Mac App Store distribution, but direct download is unaffected.
- Steam `compatdata` prefixes are included in save discovery as a last resort; because the Steam app id is unknown to the launcher, the match is by game name and only runs when cheaper roots return nothing.
- Platform implementations for the screenshot hook, clip recording, FPS/HUD and taskbar badge (today they work on Windows and are hidden elsewhere).
- `wine-crossover` is detection-only (the Gcenx/winecx repository is 404); `vulkan-helper-rs` is source-only and is not downloaded.

### 8.6 Current behavior outside Windows

This section describes what the code does on Linux/macOS; it does not imply a production package.

- **Store CLIs:** `legendary`, `gogdl`, Nile and Comet are downloaded for the OS + architecture and marked `0o755` on Unix. On Unix a system-installed `legendary` is tried first. A missing platform returns an explicit error instead of trying to run a Windows binary.
- **Game launch:** Epic, GOG, Amazon and custom games go through `compat::launch_spec` into the Wine/Proton/umu wrapper. On Windows the wrapper is skipped.
- **Process tracking:** Linux/macOS match the install folder/EXE name through `sysinfo`; GOG and Steam PID checks use `kill -0`. This keeps game sessions and overlay context working without Windows.
- **File pickers:** `zenity`/`kdialog` on Linux and `osascript` on macOS; if missing, the current value is kept. The Windows PowerShell picker is unchanged.
- **Steam:** instead of the registry, the launcher scans `~/.steam/steam`, `~/.steam/root`, `~/.steam/debian-installation`, `~/.local/share/Steam`, Flatpak (`~/.var/app/com.valvesoftware.Steam/...`), Snap (`~/snap/steam/...`) and `~/Library/Application Support/Steam`. `steam.pid` is read in both the client folder and its parent; if absent, the process name is used. `steam://` opens through `xdg-open`/`open`.
- **Overlay:** the panel is a Tauri webview, available from the header button and tray menu as soon as the launcher starts. The Shift+Tab global hotkey, HUD/FPS layer, screenshots and clip tabs are Windows-only. On Linux/macOS those tabs are hidden; the panel still opens performance (CPU/RAM only; FPS/GPU/VRAM cards are Windows-only), notes, achievements and browser pages. The Spotify tab (`librespot` Connect receiver) and Discord social tab (Social SDK / RPC) are Windows-only and hidden on Unix; the Spotify web player and Discord web client still work in the launcher pages. The music card and tab shortcuts are only drawn on Windows.
- **Store webviews:** Tauri child webviews are used. The WebView2-specific Chrome extension layer is Windows-only; other platforms open the store page without extensions, while the currency script keeps working.
- **Windows-only and hidden surfaces:** controller bridge (ViGEm), taskbar badge, EOS/Epic relay, `.lnk` shortcuts, registry scans and game move that creates a drive-letter target. On Unix the move button is hidden; `get_system_drives` returns real mount points and capacities.
- **Steam session:** Windows seals the token with DPAPI. On Unix the token is written to Secret Service / Keychain first; when no keychain exists it falls back to a `0600` file readable only by the current user. Deleting the account removes both the file and the keychain record.
- **Save folder:** `detect_save_path` searches per platform. On Linux: `$XDG_DATA_HOME` (default `~/.local/share`), `~/.config/unity3d`, `~/Documents`, `~/Saved Games`; macOS adds `~/Library/Application Support`. Then it scans `AppData/Local`, `AppData/LocalLow`, `Documents` and `Saved Games` inside every prefix under `~/Games/Efxlve/Prefixes`. As a last resort it scans every `steamapps/compatdata/*/pfx` prefix in the Steam libraries for the same folders; the Steam app id is unknown, so the match is by game name.

## 9. References

- Heroic Games Launcher — https://heroicgameslauncher.com (GPL-3.0)
- GE-Proton — https://github.com/GloriousEggroll/proton-ge-custom
- umu-launcher — https://github.com/Open-Wine-Components/umu-launcher
- DXVK — https://github.com/doitsujin/dxvk
- VKD3D-Proton — https://github.com/HansKristian-Work/vkd3d-proton
- Apple Game Porting Toolkit — https://developer.apple.com/games/game-porting-toolkit
- Gcenx GPTK build — https://github.com/Gcenx/game-porting-toolkit
- ProtonDB — https://www.protondb.com
