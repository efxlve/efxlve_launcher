# TAURI_IPC_REFERENCE.md â€” Efxlve Launcher Backend IPC Reference

> **Primary Audience:** AI Agents & Core Developers.  
> **Purpose:** Exhaustive catalog of all 153 Tauri backend commands, argument naming conventions, return types, and emitted background event payloads. Â§2.1â€“Â§2.17 document the most-used groups in detail; Â§4 holds the generated complete index.

---

## 1. Golden Rules of IPC in Efxlve Launcher

1. **camelCase Argument Rule (CRITICAL):**  
   Tauri v2 maps JavaScript object keys to Rust parameter names. Even if a Rust function has `app_name: String` or `install_dir: Option<String>`, the frontend JS invocation **MUST** pass `{ appName, installDir }`. A snake_case payload (`{ app_name }`) will be deserialized as `null` or empty without throwing a compile error.
2. **stdout vs. stderr in Legendary CLI:**  
   - Pure data commands (like `list --json`, `status --json`) emit JSON to **stdout**.
   - Download/install progress (`= Progress: 45.2%`, transfer speeds, disk write rates) is emitted to **stderr**.
   - Do NOT attempt to parse JSON from stderr.
3. **Frontend Render Disipline (Rule 15):**  
   During high-frequency IPC events (`download-progress`, `move-game-progress`, `verify-progress`), **NEVER** call the full page `render()`. Target specific DOM elements by ID or data attribute (`[data-dlbtn]`, `[data-dlbar]`, `#dl-stat-speed`) to maintain 120 FPS and zero layout thrashing.
4. **Offline Resilience:**  
   Subprocess calls (`legendary list`) can take seconds or fail if network is down. The UI must always load from `epic_cached_library` instantly first.

---

## 2. Tauri Commands Catalog

### 2.1. Core Application & Window Commands

| Command Name (Invoke String) | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `app_minimize` | `() => Promise<void>` | `src-tauri/src/main.rs` | Minimizes the main OS window. |
| `app_toggle_maximize` | `() => Promise<void>` | `src-tauri/src/main.rs` | Toggles maximized / restored window state. |
| `app_is_maximized` | `() => Promise<boolean>` | `src-tauri/src/main.rs` | Checks if window is currently maximized. |
| `app_close` | `() => Promise<void>` | `src-tauri/src/main.rs` | Gracefully terminates background tasks and closes the app. |
| `app_set_decorations` | `(decorations: boolean) => Promise<void>` | `src-tauri/src/main.rs` | Toggles OS native window titlebar/decorations. |
| `show_store_view` | `() => Promise<void>` | `src-tauri/src/main.rs` | Displays the native embedded child webview for Epic Games Store. |
| `hide_store_view` | `() => Promise<void>` | `src-tauri/src/main.rs` | Hides the embedded store webview. |
| `resize_store_view` | `(x: number, y: number, width: number, height: number) => Promise<void>` | `src-tauri/src/main.rs` | Synchronizes embedded store webview bounds with launcher container. |
| `destroy_store_view` | `() => Promise<string>` | `src-tauri/src/main.rs` | Closes the store child webview to release its Chromium renderer memory; recreated on demand. |
| `library_dir` | `() => Promise<string>` | `src-tauri/src/main.rs` | Returns the app data directory used for local caches and settings. |
| `open_folder` | `(path: string) => Promise<void>` | `src-tauri/src/main.rs` | Opens Windows File Explorer at the specified folder path. |
| `app_set_minimize_to_tray` | `(enabled: boolean) => Promise<void>` | `src-tauri/src/main.rs` | When enabled, closing the window hides it to the tray (downloads keep running). |
| `app_set_tray_labels` | `(show: string, quit: string) => Promise<void>` | `src-tauri/src/main.rs` | Sets the localized tray menu labels from the frontend. |

---

### 2.2. Authentication & Legendary Binary Lifecycle

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_setup_status` | `() => Promise<SetupStatus>` | `legendary/commands.rs` | Checks if `legendary.exe` is installed, its version, and if download is needed. |
| `epic_ensure_binary` | `() => Promise<string>` | `legendary/commands.rs` | Automatically downloads and extracts standalone `legendary.exe` if absent. |
| `epic_login_with_code` | `(code: string) => Promise<string>` | `legendary/commands.rs` | Authenticates Epic account using authorization code from `https://legendary.gl/epiclogin`. |
| `epic_import_egl` | `() => Promise<string>` | `legendary/commands.rs` | Imports session tokens directly from official Epic Games Launcher installation. |
| `epic_logout` | `() => Promise<string>` | `legendary/commands.rs` | Clears credentials and invalidates active session. |
| `epic_get_saved_accounts` | `() => Promise<SavedAccount[]>` | `legendary/commands.rs` + `accounts.rs` | Lists archived sessions in the account switcher vault. |
| `epic_switch_account` | `(accountId: string) => Promise<SavedAccount>` | `legendary/commands.rs` + `accounts.rs` | Activates an archived session without re-authentication and restores its library snapshot. |
| `epic_remove_saved_account` | `(accountId: string) => Promise<void>` | `legendary/commands.rs` + `accounts.rs` | Deletes an archived session from the vault (never the active one). |

---

### 2.3. Library, Metadata & Instant Cache

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_cached_library` | `() => Promise<CachedLibrary>` | `legendary/commands.rs` + `cache.rs` | **Ultra-fast instant load (<15ms)** directly reading `%USERPROFILE%\.config\legendary`. |
| `epic_list_games` | `() => Promise<EpicGame[]>` | `legendary/commands.rs` | Full network library query via `legendary list --json --third-party`. |
| `epic_list_installed` | `() => Promise<EpicInstalled[]>` | `legendary/commands.rs` | Queries locally installed games from Legendary. |
| `epic_list_skipped` | `() => Promise<string[]>` | `legendary/commands.rs` | Returns list of permanently skipped 401 unpurchased/removed catalogue items. |
| `epic_check_updates` | `() => Promise<GameUpdateInfo[]>` | `legendary/commands.rs` | Checks for pending version updates across all installed games. |

---

### 2.4. Game Execution, Transfers & Installation

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_install_game` | `(appName: string, installDir?: string \| null) => Promise<string>` | `legendary/transfers.rs` | Enqueues and starts game installation (`-y install <app> --base-path <dir> --skip-dlcs --skip-sdl`). |
| `epic_resume_pending_download` | `() => Promise<string>` | `legendary/transfers.rs` | Resumes the download persisted on disk after the launcher restarted. |
| `epic_install_with_options` | `(appName: string, installTags: string[], dlcAppIds: string[], installDir?: string \| null) => Promise<string>` | `legendary/transfers.rs` | Selective install with custom language/high-res tags and DLC app IDs. |
| `epic_pause_download` | `(appName: string) => Promise<string>` | `legendary/transfers.rs` | Pauses active download worker process. |
| `epic_resume_download` | `(appName: string) => Promise<string>` | `legendary/transfers.rs` | Resumes paused download queue item. |
| `epic_cancel_download` | `(appName: string) => Promise<string>` | `legendary/transfers.rs` | Cancels download and purges temporary chunk caches. |
| `epic_get_queue` | `() => Promise<DlQueueStatus>` | `legendary/transfers.rs` | Fetches active queue status, running item ID, and pending queue order. |
| `epic_reorder_queue` | `(appName: string, action: "up"\|"down"\|"top"\|"now"\|"remove") => Promise<DlQueueStatus>` | `legendary/transfers.rs` | Moves item up/down or forces immediate priority in queue. |
| `epic_uninstall_game` | `(appName: string, keepFiles: boolean) => Promise<string>` | `legendary/transfers.rs` | Uninstalls game files and unlinks local manifest. |
| `shared_library_index` | `() => Promise<SharedLibraryIndex>` | `shared_library.rs` | Union of every saved account's library from disk snapshots (no network) with per-game owner info. |
| `epic_take_pending_launch` | `() => Promise<string \| null>` | `main.rs` | Game requested by a desktop shortcut (`--launch <app>`), consumed once by the UI. |
| `epic_launch_game` | `(appName: string) => Promise<string>` | `legendary/transfers.rs` | Launches game process (supports third-party launchers like `link2ea://`). |
| `epic_default_install_dir` | `() => Promise<string>` | `legendary/transfers.rs` | Returns default OS installation directory for games. |
| `epic_set_install_dir` | `(dir: string \| null) => Promise<EpicSettings>` | `legendary/transfers.rs` | Updates global default installation folder path. |

---

### 2.5. Cloud Saves, Verification & System Management

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_verify_game` | `(appName: string) => Promise<string>` | `legendary/commands.rs` | Validates file integrity and repairs corrupted hashes (`legendary verify`). |
| `epic_sync_saves` | `(appName: string) => Promise<string>` | `legendary/commands.rs` | Synchronizes local save games with Epic cloud storage (`legendary sync-saves`). |
| `epic_get_game_settings` | `(appName: string) => Promise<GameLocalSettings>` | `legendary/commands.rs` | Reads per-game launch arguments, auto-update, and cloud save flags. |
| `epic_save_game_settings` | `(settings: GameLocalSettings) => Promise<void>` | `legendary/commands.rs` | Persists per-game custom launch parameters and options. |
| `epic_create_desktop_shortcut` | `(appName: string) => Promise<string>` | `legendary/commands.rs` | Generates Windows desktop shortcut (`.lnk`) pointing to launcher launch protocol. |

---

### 2.6. Local Save Backups

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_backup_save` | `(appName: string) => Promise<SaveBackupInfo>` | `legendary/commands.rs` | Creates a zipped, timestamped local backup of game save directory. |
| `epic_list_backups` | `(appName: string) => Promise<SaveBackupInfo[]>` | `legendary/commands.rs` | Lists all existing local save backups for a game. |
| `epic_restore_backup` | `(appName: string, backupId: string) => Promise<string>` | `legendary/commands.rs` | Restores a selected snapshot into the active save folder. |
| `epic_delete_backup` | `(appName: string, backupId: string) => Promise<void>` | `legendary/commands.rs` | Deletes a backup archive from disk. |
| `epic_open_backup_folder` | `(appName: string) => Promise<string>` | `legendary/commands.rs` | Opens Explorer window at save backup archive folder. |

---

### 2.7. Trophies, Profile & Game Information

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_player_profile` | `(forceRefresh?: boolean) => Promise<EpicPlayerProfile>` | `legendary/commands.rs` + `profile.rs` | Epic GraphQL profile query: player level, total XP, and platinum trophy counts. |
| `epic_get_achievements` | `(appName: string, forceRefresh?: boolean) => Promise<EpicAchievementsData>` | `legendary/commands.rs` | Detailed achievement list with rarity, XP, and unlock dates. |
| `epic_get_achievements_summary` | `() => Promise<Record<string, EpicAchievementSummary>>` | `legendary/commands.rs` | Batch trophy summary across all games. |
| `epic_get_system_requirements` | `(title: string, appName: string, forceRefresh?: boolean) => Promise<GameRequirementsResponse>` | `legendary/commands.rs` | Scrapes official Epic Store hardware specs (CPU, GPU, RAM, OS). |
| `epic_get_hltb` | `(title: string, appName: string, forceRefresh?: boolean) => Promise<HltbData>` | `legendary/commands.rs` + `hltb.rs` | HowLongToBeat completion times (Main Story, Extra, Completionist). |
| `epic_get_critic` | `(title: string, appName: string, forceRefresh?: boolean) => Promise<CriticData>` | `legendary/commands.rs` + `critic.rs` | OpenCritic, Metacritic, and Goygoy Engine review aggregator. |
| `epic_get_game_dlcs` | `(appName: string) => Promise<GameDlcResponse>` | `legendary/commands.rs` | Returns owned and available DLC packs. |
| `epic_get_install_options` | `(appName: string) => Promise<GameInstallOptions>` | `legendary/commands.rs` | Reads manifest selective installation tags. |

---

### 2.8. SteamGridDB Cover Art Management

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_steamgrid_key` | `() => Promise<string \| null>` | `legendary/steamgrid.rs` | Retrieves stored SteamGridDB API key. |
| `epic_set_steamgrid_key` | `(apiKey: string) => Promise<void>` | `legendary/steamgrid.rs` | Saves custom SteamGridDB API key. |
| `epic_test_steamgrid_key` | `(apiKey: string) => Promise<boolean>` | `legendary/steamgrid.rs` | Verifies SteamGridDB API key validity. |
| `epic_search_steamgrid` | `(term: string) => Promise<SteamGridGame[]>` | `legendary/steamgrid.rs` | Searches game titles on SteamGridDB. |
| `epic_get_steamgrid_covers` | `(gameId: number, assetType?: "grids"\|"heroes", styles?: string, dimensions?: string) => Promise<SteamGridImage[]>` | `legendary/steamgrid.rs` | Fetches custom portrait covers or wide hero backdrops. |

---

### 2.9. Screenshots & Compression Subsystem

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_game_screenshots` | `(appName: string, title: string) => Promise<GameScreenshotItem[]>` | `legendary/screenshots.rs` | Loads screenshot gallery for a specific game. |
| `epic_delete_game_screenshot` | `(filePath: string) => Promise<boolean>` | `legendary/screenshots.rs` | Deletes a screenshot file. |
| `epic_open_game_screenshots_folder`| `(appName: string, title: string) => Promise<void>` | `legendary/screenshots.rs` | Opens folder containing screenshots in Windows Explorer. |
| `epic_set_screenshot_hotkey` | `(vkey: number) => Promise<void>` | `legendary/screenshots.rs` | Updates global keyboard capture hook hotkey. |
| `epic_replace_screenshot_with_compressed` | `(originalPath: string, compressedBase64: string, newExt: string) => Promise<GameScreenshotItem>` | `legendary/screenshots.rs` | Replaces large PNG with AVIF/WebP compressed file. |

---

### 2.10. Drive Relocation & Game Mover

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_system_drives` | `() => Promise<SystemDriveInfo[]>` | `legendary/commands.rs` | Scans Windows drives with total and free byte counts. |
| `epic_select_folder_dialog` | `(defaultPath?: string \| null) => Promise<string \| null>` | `legendary/commands.rs` | Native Windows folder selection dialog. |
| `epic_move_game` | `(appName: string, targetBasePath: string) => Promise<MoveGameResult>` | `legendary/commands.rs` + `move_game.rs` | Moves game files between disks, updates manifest, and verifies integrity. |
| `epic_cancel_move_game` | `(appName: string) => Promise<boolean>` | `legendary/commands.rs` + `move_game.rs` | Cancels active file transfer and restores original state. |

---

### 2.11. Collections & Categories

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_collections` | `() => Promise<GameCollection[]>` | `legendary/commands.rs` | Returns user collections and game assignments. |
| `epic_save_collection` | `(name: string, appNames: string[], id?: string \| null, emoji?: string \| null) => Promise<GameCollection>` | `legendary/commands.rs` | Creates or updates a collection. |
| `epic_delete_collection` | `(id: string) => Promise<void>` | `legendary/commands.rs` | Removes a collection. |
| `epic_set_game_collections`| `(appName: string, collectionIds: string[]) => Promise<void>` | `legendary/commands.rs` | Updates collection memberships for a game. |
| `epic_import_egl_collections`| `() => Promise<GameCollection[]>` | `legendary/commands.rs` | Imports collections from official Epic Games Launcher. |

### 2.12. Discord Rich Presence (Optional)

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_presence_configure` | `(enabled: boolean, clientId: string) => Promise<void>` | `presence.rs` | Enables/disables presence and persists the Discord application id. |
| `epic_presence_update` | `(details, state, largeImage?, largeText?, smallImage?, startMs?) => Promise<void>` | `presence.rs` | Pushes a localized activity plus optional HTTPS images and an elapsed-time start. |
| `epic_presence_clear` | `() => Promise<void>` | `presence.rs` | Clears the current activity. |

> Presence is **off by default**. A single background worker thread owns the Discord IPC client, de-duplicates updates and backs off on failures; it exits when disabled, so idle cost is zero. The activity text is localized in the frontend and forwarded as plain strings.

### 2.13. EOS Overlay (Detection Only)

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `eos_overlay_status` | `() => Promise<EosOverlayStatus>` | `main.rs` | Reports the system-wide EOS Overlay state (`{ installed, path, version, overlaySupported }`); version/support flags are read from the EOS service registry key. |
| `epic_detect_eos` | `(installPath: string) => Promise<boolean>` | `main.rs` | Bounded scan of a game's install directory for the EOS SDK runtime (`EOSSDK-*.dll` / `EpicOnlineServices`). Runs on a blocking thread; the frontend caches the result per game. |

> The EOS Social Overlay is an Epic service injected into **game** processes (Shift+F3), not into our webview. It is installed system-wide by the Epic Games Launcher, so the launcher only detects its presence and links to the folder â€” it cannot host Epic's social UI itself.

### 2.14. GOG.COM Integration (OAuth, Library, Achievements, Transfers)

| Command Name | Rust Handler Location | Description |
|---|---|---|
| `gog_auth_status` | `gogdl/commands.rs` | Session state + GOG user id/username from disk cache. |
| `gog_auth_code` | `gogdl/commands.rs` | Exchanges the pasted authorization code for tokens and caches the profile name. |
| `gog_logout` | `gogdl/commands.rs` | Clears the stored GOG tokens. |
| `gog_cached_library` / `gog_list_games` | `gogdl/commands.rs` | Instant disk snapshot / remote GOG Galaxy library (with GamesDB enrichment). |
| `gog_get_game_details` | `gogdl/commands.rs` | Official description, developer, 1600px hero and system requirements. |
| `gog_get_achievements` / `gog_get_achievements_summary` / `gog_sync_achievements` | `gogdl/commands.rs` | Per-game achievement list, cached summaries for library covers, background refresh. |
| `gog_get_system_requirements` | `gogdl/commands.rs` | Windows minimum/recommended tables from the v2 API. |
| `gog_get_saved_accounts` / `gog_switch_account` / `gog_remove_saved_account` | `gogdl/accounts.rs` | Multi-account vault. |
| `gog_detect_galaxy_games` | `gogdl/galaxy.rs` | Lists games the official GOG Galaxy client installed (registry scan, folders verified). |
| `gog_sync_galaxy_installed` | `gogdl/galaxy.rs` | Registers detected Galaxy installs in this launcher (returns how many were added). |
| `gog_check_updates` | `gogdl/updates.rs` | Compares installed build ids with the newest public builds (disk-cached, force flag for a manual refresh). |
| `gog_sync_playtime` | `gogdl/galaxy_playtime.rs` | Reads hours played in the official GOG Galaxy client from its local SQLite database (read-only). |
| `gog_install_game` / `gog_cancel_download` | `gogdl/transfers.rs` | gogdl download with streamed progress. |
| `gog_import_game` / `gog_verify_game` / `gog_uninstall_game` | `gogdl/transfers.rs` | Folder import, file verification, clean uninstall. |
| `gog_launch_game` / `gog_stop_game` | `gogdl/launcher.rs` | DRM-free launch with crash-safe playtime recording. |

### 2.15. Cloud Save Backup (WebDAV & Google Drive)

| Command Name | Rust Handler Location | Description |
|---|---|---|
| `cloud_backup_get_settings` / `cloud_backup_save_settings` | `cloud_backup/commands.rs` | Provider, credentials, enable flag and auto-sync preference. |
| `cloud_backup_test_connection` | `cloud_backup/commands.rs` | Validates the WebDAV/Drive configuration. |
| `cloud_backup_start_gdrive_auth` / `cloud_backup_disconnect_gdrive` | `cloud_backup/commands.rs` | OAuth2 PKCE loopback flow and disconnect. |
| `cloud_backup_upload_game` / `cloud_backup_list_game` / `cloud_backup_download_game` / `cloud_backup_delete_remote` | `cloud_backup/commands.rs` | Per-game archive upload, listing, restore and delete. |

> The automatic path runs on game exit (`trigger_auto_sync_on_exit`) and reports through the `cloud-sync-complete` event.

### 2.16. Settings, Network Profiles & Offline Mode

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_settings` | `() => Promise<EpicSettings>` | `legendary/commands.rs` | Reads persisted launcher settings (install dir, CDN, alternative binary, flags). |
| `epic_get_network_profile` | `() => Promise<string>` | `legendary/commands.rs` | Returns the active download worker profile (`max` \| `balanced` \| `low`). |
| `epic_set_network_profile` | `(profile: string) => Promise<void>` | `legendary/commands.rs` | Persists the worker profile used for new downloads. |
| `epic_get_offline_mode` | `() => Promise<boolean>` | `legendary/commands.rs` | True when Epic network requests are suppressed. |
| `epic_set_offline_mode` | `(enabled: boolean) => Promise<void>` | `legendary/commands.rs` | Toggles offline mode. |
| `epic_measure_cdns` | `(baseUrls: string[]) => Promise<CdnProbe[]>` | `legendary/commands.rs` | Probes Epic CDN hosts (time-to-first-byte) and returns them fastest-first. |
| `epic_set_preferred_cdn` | `(host: string \| null) => Promise<void>` | `legendary/commands.rs` | Pins the preferred CDN hostname (null reverts to automatic routing). |
| `epic_cleanup_cache` | `() => Promise<string>` | `legendary/commands.rs` | Deletes legendary's temporary/metadata/manifest files. |

### 2.17. EGL Integration & Third-Party Launchers

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_detect_egl_games` | `() => Promise<EglDetectedGame[]>` | `legendary/commands.rs` + `cache.rs` | Scans EGL manifests and the registry for games installed by the official launcher. |
| `epic_sync_egl_installed` | `() => Promise<number>` | `legendary/commands.rs` + `cache.rs` | Imports detected EGL installations into legendary's installed list. |
| `epic_third_party_launchers` | `() => Promise<ThirdPartyLauncher[]>` | `legendary/commands.rs` | Detects EA App and Ubisoft Connect installations and versions. |

### 2.18. Playtime Tracking

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `epic_get_playtimes` | `() => Promise<Record<string, PlaytimeRecord>>` | `legendary/commands.rs` + `playtime.rs` | Returns the persisted per-game playtime database. |
| `epic_set_playtime` | `(appName: string, totalSeconds: number, lastPlayed?: string \| null) => Promise<PlaytimeRecord>` | `legendary/commands.rs` + `playtime.rs` | Overwrites a game's playtime (manual editor) and returns the updated record. |

### 2.19. Controller Support & Steam Detection

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `controller_support_status` | `() => Promise<ControllerSupportStatus>` | `controller.rs` | Reports whether an XInput bridge (ViGEmBus service) and the Steam client are present, with the Steam install path. Registry only, no network. |
| `steam_status` | `() => Promise<SteamStatus>` | `steam.rs` | Steam client presence, install path and the number of games found in its app manifests. |
| `steam_list_installed` | `() => Promise<SteamGame[]>` | `steam.rs` | Reads every `steamapps/appmanifest_*.acf` across all library folders (`libraryfolders.vdf`), deduplicated by app id. |
| `steam_launch_game` → `steam_game_action` | `(appId: string, action: "launch" \| "install" \| "uninstall" \| "validate") => Promise<void>` | `steam.rs` | Hands the action to the Steam client via the matching `steam://` URL; non-numeric ids and unknown actions are rejected. The launcher never starts Steam executables itself. |
| `steam_sync_playtime` | `() => Promise<Record<string, SteamPlaytime>>` | `steam.rs` | Reads the newest `userdata/<id>/config/localconfig.vdf` and maps app ids to playtime (seconds) + last played. |
| `steam_get_game_details` | `(appId: string, language?: string) => Promise<SteamGameDetails>` | `steam.rs` | Steam store description, developer, hero art, add-on ids and requirement bullets (HTML flattened), cached on disk for six hours. |
| `steam_get_api_key` / `steam_set_api_key` | `() => Promise<string \| null>` / `(apiKey: string) => Promise<void>` | `steam.rs` | Opt-in Steam Web API key, stored in `settings.json` next to the SteamGridDB key. Needed for achievements only. |
| `steam_get_achievements` | `(appId: string, force?: boolean) => Promise<EpicAchievementsData>` | `steam.rs` | Schema (names, descriptions, icons) + the player's unlocks + global unlock rates for rarity, merged into the shared achievement shape and cached for an hour. Resolves the SteamID64 from `loginusers.vdf`. |
| `steam_get_achievements_summary` | `() => Promise<Record<string, EpicAchievementSummary>>` | `steam.rs` | Cached achievement summaries for the library covers; disk only, no network and no key needed. |

### 2.20. Shared Library (All Accounts)

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `shared_library_index` | `() => Promise<SharedLibraryIndex>` | `shared_library.rs` | Union of every saved account's disk snapshot, excluding the active account's games and non-game entries (DLCs, UE/Fab assets, mobile-only). Owner is reported per game for the one-click switch. |

### 2.21. External Stores (EA App / Ubisoft Connect / Xbox)

| Command Name | TypeScript Signature | Rust Handler Location | Description |
|---|---|---|---|
| `external_detect_games` | `(store: "ea" \| "ubisoft" \| "xbox") => Promise<ExternalGame[]>` | `external_stores.rs` | Detects games installed by that store: EA registry keys + `installerdata.xml` content id, Ubisoft product ids (missing folders are skipped) and Xbox `MicrosoftGame.config` titles with the package family name resolved through one PowerShell call. Registry/disk only. |
| `external_launch_game` | `(store: string, id: string) => Promise<void>` | `external_stores.rs` | Hands the launch to the store: `link2ea://launchgame/<id>` (or the EA App itself), `uplay://launch/<id>/0`, or `shell:appsFolder\<PackageFamilyName>!App`. Ids are validated; unknown stores are rejected. |

---

## 3. Background IPC Event Payloads

Tauri emits events to the webview asynchronously. Listen to them using `listen<T>(eventName, handler)`.

### 3.1. `download-progress`
Emitted by `transfers.rs` every ~250â€“500ms during an active download/installation.

```typescript
export interface DlProgressEvent {
  id: string;                  // Game appName (e.g. "Salt")
  progress: number;            // 0.0 to 100.0
  done: boolean;               // True when download & installation is finished
  speed?: string | null;       // Formatted network speed (e.g. "18.4 MB/s")
  speedBytes?: number | null;  // Raw network speed in bytes/sec
  diskSpeed?: string | null;   // Formatted disk write speed (e.g. "24.1 MB/s")
  diskBytes?: number | null;   // Raw disk write speed in bytes/sec
  eta?: string | null;         // Formatted estimated time (e.g. "4m 12s")
  etaSeconds?: number | null;  // Raw ETA seconds
  downloadedBytes?: number | null;
  totalBytes?: number | null;
}
```

### 3.2. `game-status`
Emitted by `transfers.rs` and `playtime.rs` when a game starts or exits.

```typescript
export interface GameStatusEvent {
  id: string;                   // Game appName
  running: boolean;            // True while process is active
  sessionSeconds?: number;     // Elapsed seconds in current session
  totalSeconds?: number;       // Cumulative lifetime seconds played
  sessionCount?: number;       // Lifetime launch count
  lastPlayed?: string;         // ISO date string
  lastPlayedTimestamp?: number;// Epoch milliseconds
}
```

### 3.3. `move-game-progress`
Emitted by `move_game.rs` during inter-drive game transfer.

```typescript
export interface MoveGameProgress {
  id: string;
  stage: "preparing" | "moving" | "verifying" | "cleaning" | "complete" | "failed";
  percent: number;             // 0.0 to 100.0
  copied_bytes: number;
  total_bytes: number;
  speed: string;               // e.g. "124 MB/s"
  eta: string;                 // e.g. "1 dk 30 sn"
  current_file: string;
  files_copied: number;
  total_files: number;
}
```

### 3.4. `verify-progress` & `verify-complete`
Emitted by `commands.rs` during game file verification.

```typescript
export interface VerifyProgressEvent {
  id: string;
  current: number;
  total: number;
  percent: number;
  speed: string;
  detail?: string;
}

export interface VerifyCompleteEvent {
  id: string;
  success: boolean;
  message: string;
}
```

### 3.5. `screenshot-captured`
Emitted by `screenshots.rs` when the global hotkey (F12) captures an in-game screenshot.

```typescript
export interface GameScreenshotItem {
  id: string;
  file_path: string;
  file_name: string;
  date_str: string;
  timestamp: number;
  size_bytes: number;
  size_str: string;
  data_url: string;            // Base64 thumbnail for instant preview
}
```

### 3.6. `cloud-sync-complete`
Emitted after a manual save sync **and** after the automatic cloud upload that runs when a game exits.

```typescript
export interface CloudSyncCompleteEvent {
  id: string;        // composite game id (e.g. "Ginger" or "gog::123")
  success: boolean;
  message: string;   // "@t:..." descriptor or raw text; empty on success
}
```

### 3.7. `screenshots-updated`
Emitted by `screenshots.rs` when the hotkey capture flow adds a new file (also after batch compression).

```typescript
export interface ScreenshotsUpdatedEvent {
  id: string;
  count: number;
}
```

---

---

## 4. Complete Command Index (generated from `generate_handler!`)

| Rust file | # | Commands |
|---|---|---|
| `cloud_backup/commands.rs` | 9 | `cloud_backup_get_settings`, `cloud_backup_save_settings`, `cloud_backup_test_connection`, `cloud_backup_start_gdrive_auth`, `cloud_backup_disconnect_gdrive`, `cloud_backup_upload_game`, `cloud_backup_list_game`, `cloud_backup_download_game`, `cloud_backup_delete_remote` |
| `controller.rs` | 1 | `controller_support_status` |
| `eos.rs` | 2 | `eos_overlay_status`, `eos_install_redistributable` |
| `external_stores.rs` | 2 | `external_detect_games`, `external_launch_game` |
| `gogdl/commands.rs` | 17 | `gog_auth_status`, `gog_auth_code`, `gog_logout`, `gog_cached_library`, `gog_list_games`, `gog_get_game_details`, `gog_get_achievements`, `gog_get_achievements_summary`, `gog_sync_achievements`, `gog_get_system_requirements`, `gog_get_saved_accounts`, `gog_switch_account`, `gog_remove_saved_account`, `gog_detect_galaxy_games`, `gog_sync_galaxy_installed`, `gog_check_updates`, `gog_sync_playtime` |
| `gogdl/launcher.rs` | 2 | `gog_launch_game`, `gog_stop_game` |
| `gogdl/transfers.rs` | 5 | `gog_install_game`, `gog_cancel_download`, `gog_uninstall_game`, `gog_import_game`, `gog_verify_game` |
| `legendary/commands.rs` | 58 | `epic_setup_status`, `epic_ensure_binary`, `epic_list_games`, `epic_list_skipped`, `epic_cached_library`, `epic_list_installed`, `epic_login_with_code`, `epic_import_egl`, `epic_logout`, `epic_get_saved_accounts`, `epic_switch_account`, `epic_remove_saved_account`, `epic_get_settings`, `epic_measure_cdns`, `epic_set_preferred_cdn`, `epic_cleanup_cache`, `epic_get_achievements`, `epic_get_achievements_summary`, `epic_get_hltb`, `epic_get_critic`, `epic_get_system_requirements`, `epic_detect_egl_games`, `epic_sync_egl_installed`, `epic_third_party_launchers`, `epic_verify_game`, `epic_get_game_settings`, `epic_save_game_settings`, `epic_set_custom_save_path`, `epic_sync_saves`, `epic_create_desktop_shortcut`, `epic_get_game_dlcs`, `epic_get_install_options`, `epic_check_updates`, `epic_get_playtimes`, `epic_set_playtime`, `epic_get_network_profile`, `epic_set_network_profile`, `epic_get_offline_mode`, `epic_set_offline_mode`, `epic_get_auto_desktop_shortcut`, `epic_set_auto_desktop_shortcut`, `epic_backup_save`, `epic_list_backups`, `epic_restore_backup`, `epic_delete_backup`, `epic_open_backup_folder`, `epic_get_collections`, `epic_save_collection`, `epic_reorder_collections`, `epic_delete_collection`, `epic_set_game_collections`, `epic_import_egl_collections`, `epic_get_player_profile`, `epic_get_system_drives`, `epic_import_installed_folder`, `epic_select_folder_dialog`, `epic_move_game`, `epic_cancel_move_game` |
| `legendary/library_playtime.rs` | 1 | `epic_sync_epic_playtimes` |
| `legendary/screenshots.rs` | 9 | `epic_get_game_screenshots`, `epic_set_screenshot_hotkey`, `epic_replace_screenshot_with_compressed`, `epic_delete_game_screenshot`, `epic_open_game_screenshots_folder`, `epic_get_screenshot_dir`, `epic_get_screenshot_move_info`, `epic_open_screenshot_dir`, `epic_set_screenshot_dir` |
| `legendary/steamgrid.rs` | 5 | `epic_get_steamgrid_key`, `epic_set_steamgrid_key`, `epic_test_steamgrid_key`, `epic_search_steamgrid`, `epic_get_steamgrid_covers` |
| `legendary/transfers.rs` | 13 | `epic_install_game`, `epic_install_with_options`, `epic_resume_pending_download`, `epic_cancel_download`, `epic_pause_download`, `epic_resume_download`, `epic_reorder_queue`, `epic_get_queue`, `epic_uninstall_game`, `epic_default_install_dir`, `epic_set_install_dir`, `epic_launch_game`, `epic_stop_game` |
| `legendary/wiki.rs` | 1 | `epic_get_wiki_about` |
| `main.rs` | 15 | `app_set_minimize_to_tray`, `library_dir`, `show_store_view`, `resize_store_view`, `hide_store_view`, `set_store_palette_hold`, `destroy_store_view`, `open_folder`, `epic_detect_eos`, `app_minimize`, `app_toggle_maximize`, `app_is_maximized`, `app_close`, `app_set_decorations`, `app_set_tray_labels` |
| `presence.rs` | 3 | `epic_presence_configure`, `epic_presence_update`, `epic_presence_clear` |
| `shared_library.rs` | 1 | `shared_library_index` |
| `steam.rs` | 9 | `steam_status`, `steam_list_installed`, `steam_game_action`, `steam_sync_playtime`, `steam_get_game_details`, `steam_get_api_key`, `steam_set_api_key`, `steam_get_achievements`, `steam_get_achievements_summary` |

**Total: 153 commands**

