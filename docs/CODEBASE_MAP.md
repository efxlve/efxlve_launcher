# CODEBASE_MAP.md — Efxlve Launcher Source & Symbol Index

> **Primary Audience:** AI Agents & Core Developers.
> **Purpose:** Instant symbol lookup, architecture mapping, and file navigation. Read this to locate any function, state variable, module, or view in under 5 seconds.

---

## 1. Project Directory Structure

```
efxlve_launcher/
├── src/                               # Frontend Application (Vite 6 + TypeScript 5.6)
│   ├── main.ts                        # Minimal orchestrator & bootstrap (~113 lines)
│   ├── epic.ts                        # Tauri invoke wrappers & TypeScript IPC models (~1.200 lines)
│   ├── i18n.ts                        # Localization engine & translation lookup (~128 lines)
│   ├── vite-env.d.ts                  # Vite client type definitions
│   ├── core/                          # Fundamental Shared Infrastructure (15 modules)
│   │   ├── state.ts                   # Central reactive state 'S' & O(1) accessor helpers
│   │   ├── render.ts                  # Render bus (main.ts registers render/scheduleRender/notify)
│   │   ├── dom.ts                     # DOM caching and safe query selectors
│   │   ├── nav.ts                     # Top titlebar navigation, views & LB/RB switching
│   │   ├── toast.ts                   # PlayStation 5 toast notification system
│   │   ├── selectors.ts               # Filter, sort, collection & advanced search logic
│   │   ├── epic-actions.ts            # Core game action dispatchers (play, install, cancel)
│   │   ├── game-view.ts               # Common game presentation helpers
│   │   ├── recent.ts                  # Recently played games registry
│   │   ├── window.ts                  # Window controls (minimize, maximize, close-to-tray)
│   │   ├── icons.ts                   # Zero-emoji vector SVG icon generator
│   │   ├── collection-icons.ts        # Built-in collection vector icon lookup
│   │   ├── utils.ts                   # Formatting helpers (bytes, time, string escaping)
│   │   ├── constants.ts               # Default configurations, thresholds, limits
│   │   └── types.ts                   # Core frontend type definitions
│   ├── features/                      # Modular Feature Domains (24 subsystems)
│   │   ├── auth/                      # Login, EGL import, progressive sync, account switcher
│   │   │   ├── auth-actions.ts        # Boot, progressive login, logout, library sync
│   │   │   └── account-switcher.ts    # Saved-account vault: switch / add / remove / cancel
│   │   ├── collections/               # Category & collection management, EGL import
│   │   │   └── collections-view.ts
│   │   ├── context-menu/              # Desktop PS5 right-click context menu
│   │   │   └── context-menu.ts
│   │   ├── cover/                     # Custom cover selector & SteamGridDB browser
│   │   │   └── cover-view.ts
│   │   ├── dlc/                       # DLC inspection & selective install tags
│   │   │   ├── dlc-manager.ts
│   │   │   └── selective-install.ts
│   │   ├── downloads/                 # Downloads hub, speed canvas & auto-update scheduler
│   │   │   ├── downloads-view.ts
│   │   │   └── auto-update.ts
│   │   ├── drawer/                    # Game detail drawer (Overview, Trophy, DLC, Specs)
│   │   │   ├── drawer-view.ts
│   │   │   └── drawer-widgets.ts
│   │   ├── events/                    # Central event bus (click-router, inputs, IPC)
│   │   │   ├── click-router.ts        # [data-act] / [data-view] event delegation
│   │   │   ├── input-listeners.ts     # Keyboard, search, mouse & gamepad shortcuts
│   │   │   └── ipc-listeners.ts       # Tauri event listeners & app bootstrap (initApp)
│   │   ├── freegames/                 # Weekly free games shelf & claim navigation
│   │   │   └── freegames.ts
│   │   ├── gamepad/                   # 10-foot gamepad navigation loop & controller HUD
│   │   │   └── gamepad.ts
│   │   ├── install/                   # Epic-style install location dialog
│   │   │   └── install-dialog.ts
│   │   ├── library/                   # Main library grid, shelves & progressive chunking
│   │   │   └── library-view.ts
│   │   ├── manage/                    # Game properties, executable paths & env/wrappers
│   │   │   └── manage-view.ts
│   │   ├── move-game/                 # Drive migration wizard with live transfer rates
│   │   │   ├── move-game-view.ts
│   │   │   └── move-game-actions.ts
│   │   ├── notifications/             # Notification center drawer & system alerts
│   │   │   └── notifications.ts
│   │   ├── onboarding/                # Auth screen, progressive loading & setup wizard
│   │   │   └── onboarding-view.ts
│   │   ├── playtime/                  # Playtime tracking, history & manual editing
│   │   │   └── playtime-view.ts
│   │   ├── presence/                  # Discord Rich Presence toggle & status sync
│   │   │   └── presence.ts
│   │   ├── profile/                   # PS5 trophy showcase, levels, friends & most played
│   │   │   ├── profile-view.ts
│   │   │   └── profile-avatar.ts      # Account-specific local avatar (WebP crop)
│   │   ├── screenshots/               # F12 capture gallery, lightbox & format conversion
│   │   │   └── screenshots-view.ts
│   │   ├── settings/                  # Settings view (Account, Downloads, Integrations...)
│   │   │   └── settings-view.ts
│   │   ├── storage/                   # Drive storage breakdown & disk visualization
│   │   │   └── storage-view.ts
│   │   ├── store/                     # Embedded Epic Games Store child webview manager
│   │   │   └── store-view.ts
│   │   └── updates/                   # Launcher self-update (check/download/install gating)
│   │       └── update-manager.ts
├── .github/
│   └── workflows/
│       └── release.yml                # Tag-driven signed build + GitHub Release + latest.json
│   ├── locales/                       # 15 Language Localization Dictionaries (flat dotted keys)
│   │   ├── tr.json                    # Turkish (Primary, 1.249 keys)
│   │   ├── en.json                    # English (Primary, 1.249 keys, full parity)
│   │   └── ...                        # ar, de, es, fr, it, ja, ko, pl, pt-BR, ru, th, zh-Hans, zh-Hant (core keys, fall back to en)
│   └── styles/                        # 29 Modular PS5 Console Dark Stylesheets + index.css
│       ├── index.css                  # Master CSS entry point (imports all modules)
│       ├── tokens.css                 # Obsidian palette, lavender accents & radii
│       ├── base.css                   # Global reset, typography, zero-emoji rules
│       ├── components.css             # Shared buttons, pills & segmented rails
│       ├── aero-toolbar.css           # Frosted top bar & tab navigation
│       ├── library.css                # Game cards, portrait grid & infinite scroll
│       ├── library-toolbar.css        # Apple Precision segmented rail & search capsule
│       ├── shelves.css                # Horizontal game shelves & category rows
│       ├── gamehub.css                # Game detail hub layout
│       ├── drawer.css                 # Slide-over game detail drawer
│       ├── achievements.css           # Achievement/trophy lists
│       ├── trophies.css               # Trophy tiers & prestige card
│       ├── downloads.css              # Download rows & legacy tiles
│       ├── downloads-hub.css          # Downloads dashboard & speed chart canvas
│       ├── profile.css                # Trophy showcase, rank badges & player cards
│       ├── friends.css                # Friends sidebar list
│       ├── settings.css               # Settings sidebar & grouped cards
│       ├── auth.css                   # Login screen, marquee backdrop & loading sequence
│       ├── gamepad.css                # Focus rings, controller hints & 10-ft layout
│       ├── focus.css                  # Global :focus-visible rings
│       ├── screenshots.css            # Gallery grid & lightbox
│       ├── screenshot-share.css       # Share modal
│       ├── steamgrid.css              # SteamGridDB cover picker
│       ├── critic.css                 # Critic score widgets
│       ├── manage.css                 # Manage modal
│       ├── move-game.css              # Move-game wizard
│       ├── storage.css                # Storage manager
│       ├── playtime.css               # Playtime editor
│       ├── notifications.css          # Notification center
│       └── store-loading.css          # Store loading placeholder
├── src-tauri/                         # Rust Backend (Tauri v2 + Tokio)
│   ├── Cargo.toml                     # Rust dependencies (serde, tokio, reqwest, tauri 2.x)
│   ├── tauri.conf.json                # Tauri v2 configuration & window permissions
│   └── src/
│       ├── main.rs                    # App builder, child webview hooks, tray & IPC table (98 commands)
│       ├── presence.rs                # Discord Rich Presence IPC socket client
│       └── legendary/                 # Backend Subsystem Modules (21 files)
│           ├── mod.rs                 # Subsystem module exports
│           ├── commands.rs            # 55+ #[tauri::command] IPC bridge handlers
│           ├── accounts.rs            # Account switcher vault (archive/activate/remove sessions)
│           ├── models.rs              # Serde data transfer models for Legendary & Epic
│           ├── client.rs              # Legendary CLI process execution & flag builder
│           ├── cache.rs               # NVMe cache reader & library snapshot generator
│           ├── transfers.rs           # Download queue, install/uninstall & progress reader
│           ├── downloader.rs          # Asynchronous asset streaming downloader
│           ├── screenshots.rs         # Low-level VK_F12 keyboard hook & image compressor
│           ├── profile.rs             # Epic GraphQL trophy XP & level parser
│           ├── friends.rs             # Epic Online Services friends list reader
│           ├── freegames.rs           # Epic Store weekly free promotional game parser
│           ├── steamgrid.rs           # SteamGridDB REST client for high-res artwork
│           ├── playtime.rs            # Per-game playtime tracker & session database
│           ├── move_game.rs           # Multi-drive game installation mover
│           ├── backup.rs              # Automatic game save backup on process termination
│           ├── skip.rs                # 401 catalog item skipping & stub manifest generator
│           ├── hltb.rs                # HowLongToBeat completion stats scraper
│           ├── critic.rs              # OpenCritic review aggregator & score tier parser
│           ├── collections.rs         # Custom collections store & EGL import parser
│           └── paths.rs               # File system paths resolver for Legendary configs
├── docs/                              # Architecture, Design & Operations Documentation
│   ├── AGENTS.md                      # Core operational rules, invariants & recent log
│   ├── ARCHITECTURE.md                # System architecture diagrams & data flow
│   ├── CODEBASE_MAP.md                # Symbol & file index (this file)
│   ├── DESIGN_SYSTEM.md               # PlayStation 5 Console Dark Design System
│   ├── TAURI_IPC_REFERENCE.md         # Tauri IPC command dictionary & signatures (98 commands)
│   ├── AI_DEVELOPER_GUIDE.md          # Onboarding guide & mental models for AI/devs
│   ├── REFACTOR_PLAN.md               # Completed modularization plan & design history
│   ├── ROADMAP.md                     # Feature roadmap & tracked bug backlog
│   ├── CROSS_PLATFORM.md              # Linux/macOS Wine & Proton research guide
│   └── CHANGELOG_INTERNAL.md          # Release logs & development history (§1–166)
├── README.md                          # Open-source public repository presentation
└── CONTRIBUTING.md                    # Community contribution & coding standards
```

---

## 2. Frontend Infrastructure Symbol Map (`src/core/`)

| Module | Primary Responsibilities | Key Exported Symbols |
|---|---|---|
| `state.ts` | Single reactive state store `S` and deterministic O(1) lookup helpers. | `S`, `getCustomAvatar()`, `setEpicGamesRaw(list)`, `setEpicSummaries(list)` |
| `render.ts` | Render bus: `main.ts` registers the real implementations at startup. | `registerRender()`, `render()`, `scheduleRender()`, `notify()`, `openEpicModal()`, `closeAllModals()` |
| `nav.ts` | Top navigation bar, view state router, and LB/RB controller switching. | `updateNavIndicator()`, `updateChrome()`, `updateBadge()`, `navGoBack()`, `navGoForward()` |
| `selectors.ts` | Filter state, sort algorithms (`trCollator`), collection and advanced search queries (`dev:`, `is:`). | `epicVisibleSummaries()`, `trCollator`, `summaryOf()`, `rawOf()`, `lastPlayedLabel()` |
| `epic-actions.ts` | Dispatching high-level game actions to Tauri backend with optimistic UI updates. | `epicPlay()`, `epicInstall()`, `epicCancel()`, `refreshUpdates()` |
| `toast.ts` | PlayStation 5 console toast notification banner dispatch. | `toast(message, type, duration)` |
| `dom.ts` | Safe DOM lookup and cached query selectors. | `viewEl`, `modalRoot`, `$id(id)`, `closeModal()` |
| `icons.ts` | Zero-emoji vector SVG generator adhering to PS5 console aesthetic. | `icon(name, size, className)`, `IconName` |
| `collection-icons.ts` | Vector icon mapper for user and system collections. | `collectionMarker()`, `isCollectionIcon()` |
| `recent.ts` | Recently played games persistent stack (max 8 entries). | `pushRecent(appName)`, `getRecentApps()`, `pruneRecent()` |
| `window.ts` | Native window operations and system tray minimize integration. | `handleWindowResize()`, `updateMaxIcon()` |
| `utils.ts` | Pure formatting utilities for bytes, playtimes, dates, and HTML sanitization. | `fmtBytes(bytes)`, `fmtPlaytime(mins)`, `esc(string)`, `parseEnvText()` |
| `constants.ts` | Static configuration values, thresholds, localStorage keys and chunking parameters. | `isTauri`, `NO_DESC`, `INITIAL_CARD_CHUNK` (48), `MORE_CARD_CHUNK` (36), `SEARCH_DEBOUNCE_MS` (120) |
| `types.ts` | Shared TypeScript interfaces and union declarations. | `View`, `DrawerTab`, `EpicSort`, `EpicFilter`, `CardSize`, `SavedAccount` |

---

## 3. Frontend Feature Subsystems (`src/features/`)

| Feature Directory | Module Files | Responsibilities |
|---|---|---|
| `auth/` | `auth-actions.ts`, `account-switcher.ts` | Legendary boot, instant cache hydration, progressive login/import sequence, logout, saved-account vault (switch/add/cancel/remove). |
| `library/` | `library-view.ts` | Main game view, shelves (free games + recently played), portrait grid, progressive chunking via `#lib-scroll-sentinel`. |
| `drawer/` | `drawer-view.ts`, `drawer-widgets.ts` | Slide-out game detail drawer, trophy listing, DLC checklist, hardware specs, critic/HLTB widgets. |
| `downloads/` | `downloads-view.ts`, `auto-update.ts` | Active download hero, real-time speed chart canvas, queue controls, scheduled auto-update timer. |
| `profile/` | `profile-view.ts`, `profile-avatar.ts` | PS5 trophy level, prestige card, most-played showcase, friends sidebar, local account avatar crop/upload. |
| `gamepad/` | `gamepad.ts` | 10-foot controller input loop, spatial focus navigation and HUD button legend. |
| `events/` | `click-router.ts`, `input-listeners.ts`, `ipc-listeners.ts` | Central `[data-act]` delegation, keyboard/search/mouse shortcuts, Tauri IPC listeners and `initApp()` bootstrap. |
| `store/` | `store-view.ts` | Embedded Epic Games Store native child webview lifecycle, resizing and idle cleanup. |
| `settings/` | `settings-view.ts` | Settings sidebar (Account, Downloads, Integrations, Appearance, Screenshots, System, About), language switch, account switcher UI. |
| `notifications/` | `notifications.ts` | Slide-in notification center, unread badge and historical activity alerts. |
| `freegames/` | `freegames.ts` | Epic Weekly Free Games shelf (current and upcoming promotions with mobile filtering). |
| `context-menu/` | `context-menu.ts` | Custom PS5 desktop right-click menu (Play, Properties, Move, Favorite, Uninstall). |
| `manage/` | `manage-view.ts` | Game configuration modal (custom executable, launch flags, wrapper commands, environment variables). |
| `move-game/` | `move-game-view.ts`, `move-game-actions.ts` | Multi-drive installation mover dialog with real-time transfer progress and drive free-space checks. |
| `screenshots/` | `screenshots-view.ts` | In-game F12 screenshot gallery, fullscreen lightbox, format conversion, clipboard copy and share modal. |
| `collections/` | `collections-view.ts` | Custom user categories, tags, EGL collection importer and shelf filters. |
| `cover/` | `cover-view.ts` | Custom game artwork manager and SteamGridDB high-resolution cover art picker. |
| `dlc/` | `dlc-manager.ts`, `selective-install.ts` | Add-on/DLC checklist and selective install-tag picker with install/uninstall actions. |
| `install/` | `install-dialog.ts` | Epic-style install location dialog: base folder picker, sizes, auto-update and shortcut preferences; chains into the selective modal. |
| `playtime/` | `playtime-view.ts` | Game session duration display, playtime synchronization and manual time editor. |
| `presence/` | `presence.ts` | Discord Rich Presence state synchronization and game title broadcasting. |
| `storage/` | `storage-view.ts` | Storage management dashboard showing per-drive installation sizes and capacity bars. |
| `onboarding/` | `onboarding-view.ts` | Login screen, progressive loading sequence and first-run Legendary binary setup. |
| `updates/` | `update-manager.ts` | Launcher self-update: startup/focus/manual checks, silent background download, notification action and install gating (never while a game download or session runs). |

---

## 4. Rust Backend Subsystem Registry (`src-tauri/src/`)

| File / Subsystem | Primary Responsibilities |
|---|---|
| `main.rs` | Application entry point, window event dispatcher (`WindowEvent::Resized`), system tray setup, child webview lifecycle, and the Tauri command registration table (98 commands). |
| `presence.rs` | Discord Rich Presence IPC client (`discord-rich-presence`). Updates playing status, elapsed time, and cover keys. |
| `legendary/commands.rs` | 55+ Tauri IPC entry points (`#[tauri::command]`). Bridges frontend invoke calls to backend services. |
| `legendary/accounts.rs` | Account switcher vault: archives `user.json` + library snapshot per account, activates sessions and prunes credentials. |
| `legendary/cache.rs` | Instant disk manifest reader (`%USERPROFILE%\.config\legendary`) and snapshot cache (`efxlve_library_snapshot.json`). |
| `legendary/client.rs` | Child process spawner for `legendary.exe` CLI with arguments, environment, and stream redirection. |
| `legendary/transfers.rs` | Game installation, uninstallation, process monitoring, download queue execution, and stderr speed/progress parsing. |
| `legendary/downloader.rs` | HTTP streaming asset downloader for remote images and cover art. |
| `legendary/screenshots.rs` | Windows low-level keyboard hook (`VK_F12`), background frame capture, and WebP/AVIF compression worker. |
| `legendary/profile.rs` | Authenticated Epic Games GraphQL client for player profile, levels, and trophy XP calculation. |
| `legendary/friends.rs` | Epic Online Services friends list scraper and presence parser. |
| `legendary/freegames.rs` | Epic Games Store promotional free games parser (filters mobile offers and computes accurate claim windows). |
| `legendary/steamgrid.rs` | SteamGridDB REST client for high-res grid covers, hero banners, and transparent logos. |
| `legendary/playtime.rs` | Per-game playtime tracker database (`playtimes.json`) and session recording. |
| `legendary/move_game.rs` | Cross-drive game folder relocation engine with copy progress calculation and manifest updates. |
| `legendary/backup.rs` | Automated save game state backup triggered when game processes exit. |
| `legendary/skip.rs` | Permanent 401 error handler for delisted/unowned games; generates stub manifests in `skipped.json`. |
| `legendary/hltb.rs` | HowLongToBeat completion statistics scraper and cache. |
| `legendary/critic.rs` | OpenCritic review aggregator, score parsing, and tier determination. |
| `legendary/collections.rs` | Custom collections store (`collections.json`) and Epic Games Launcher EGL collection importer. |
| `legendary/paths.rs` | Reliable resolution of Legendary configuration, cache, and metadata directory paths. |
| `legendary/models.rs` | Serde data transfer models for Legendary CLI outputs, Epic API responses, and frontend payloads. |

---

## 5. Event Delegation Architecture (`data-act`)

Instead of attaching inline `onclick` handlers, the application routes all interactions through centralized event delegation in `src/features/events/click-router.ts`:

```html
<button data-act="epic-play" data-id="AppName">Play</button>
<button data-act="epic-install" data-id="AppName">Install</button>
<button data-act="drawer-tab" data-tab="achievements">Achievements</button>
<button data-act="nav-tab" data-view="downloads">Downloads</button>
```

To locate the execution logic for any UI element:
1. Identify its `data-act` attribute in the HTML template.
2. Open `src/features/events/click-router.ts` and locate the matching `case "your-data-act":` or `if (act === "your-data-act")` block.
