# CODEBASE_MAP.md — Efxlve Launcher Source & Symbol Index

> **Primary Audience:** AI Agents & Core Developers.
> **Purpose:** Instant symbol lookup, architecture mapping, and file navigation. Read this to locate any function, state variable, module, or view in under 5 seconds.

---

## 1. Project Directory Structure

```
efxlve_launcher/
├── src/                               # Frontend Application (Vite 6 + TypeScript 5.6)
│   ├── main.ts                        # Minimal orchestrator & bootstrap (~86 lines)
│   ├── epic.ts                        # Tauri invoke wrappers & TypeScript IPC models (~860 lines)
│   ├── i18n.ts                        # Localization engine & translation lookup (~110 lines)
│   ├── vite-env.d.ts                  # Vite client type definitions
│   ├── core/                          # Fundamental Shared Infrastructure (15 modules)
│   │   ├── state.ts                   # Central reactive state 'S' & O(1) accessor helpers
│   │   ├── render.ts                  # Batched requestAnimationFrame render scheduler
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
│   ├── features/                      # Modular Feature Domains (22 subsystems)
│   │   ├── auth/                      # Epic Games authentication & login flow
│   │   ├── collections/               # Category & collection management, EGL import
│   │   ├── context-menu/              # Desktop PS5 right-click context menu
│   │   ├── cover/                     # Custom game cover selector & SteamGridDB browser
│   │   ├── dlc/                       # Game DLC inspection & installation management
│   │   ├── downloads/                 # Downloads hub, speed graph canvas & queue controls
│   │   ├── drawer/                    # Game detail drawer (Overview, Trophy, DLC, Specs)
│   │   ├── events/                    # Central event bus (click-router, inputs, IPC)
│   │   ├── freegames/                 # Weekly free games shelf & claim navigation
│   │   ├── gamepad/                   # 10-foot gamepad navigation loop & controller HUD
│   │   ├── library/                   # Main library grid, shelves & progressive chunking
│   │   ├── manage/                    # Game properties, executable paths & env/wrappers
│   │   ├── move-game/                 # Drive migration wizard with live transfer rates
│   │   ├── notifications/             # Notification center drawer & system alerts
│   │   ├── onboarding/                # First-time user welcome wizard
│   │   ├── playtime/                  # Playtime tracking, history & manual editing
│   │   ├── presence/                  # Discord Rich Presence toggle & status sync
│   │   ├── profile/                   # PS5 trophy showcase, levels, friends & most played
│   │   ├── screenshots/               # F12 capture gallery, lightbox & format conversion
│   │   ├── settings/                  # Settings modal (Launcher, System, Integrations)
│   │   ├── storage/                   # Drive storage breakdown & disk visualization
│   │   └── store/                     # Embedded Epic Games Store child webview manager
│   ├── locales/                       # 15 Language Localization Dictionaries
│   │   ├── tr.json                    # Turkish (Primary, 1,177 keys)
│   │   ├── en.json                    # English (Primary, 1,177 keys)
│   │   └── ...                        # ar, de, es, fr, it, ja, ko, pl, pt-BR, ru, th, zh
│   └── styles/                        # 28 Modular PS5 Console Dark Stylesheets
│       ├── index.css                  # Master CSS entry point
│       ├── tokens.css                 # Obsidian palette, lavender accents & radii
│       ├── base.css                   # Global reset, typography, zero-emoji rules
│       ├── aero-toolbar.css           # Glassmorphic top bar & tab navigation
│       ├── library.css                # Game cards, portrait grid & infinite scroll
│       ├── shelves.css                # Horizontal game shelves & category rows
│       ├── drawer.css                 # Slide-over game detail drawer
│       ├── downloads-hub.css          # Downloads dashboard & speed chart canvas
│       ├── profile.css                # Trophy showcase, rank badges & player cards
│       ├── gamepad.css                # Focus rings, controller hints & 10-ft layout
│       └── ...                        # Component-specific stylesheets
├── src-tauri/                         # Rust Backend (Tauri v2 + Tokio)
│   ├── Cargo.toml                     # Rust dependencies (serde, tokio, reqwest, tauri 2.x)
│   ├── tauri.conf.json                # Tauri v2 configuration & window permissions
│   └── src/
│       ├── main.rs                    # App builder, child webview hooks & IPC table
│       ├── presence.rs                # Discord Rich Presence IPC socket client
│       └── legendary/                 # Backend Subsystem Modules (20 files)
│           ├── mod.rs                 # Subsystem module exports
│           ├── commands.rs            # 50+ #[tauri::command] IPC bridge handlers
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
│   ├── TAURI_IPC_REFERENCE.md         # Tauri IPC command dictionary & signatures
│   ├── AI_DEVELOPER_GUIDE.md          # Onboarding guide & mental models for AI/devs
│   ├── REFACTOR_PLAN.md               # Completed modularization plan & design history
│   ├── ROADMAP.md                     # Feature roadmap & tracked bug backlog
│   ├── CROSS_PLATFORM.md              # Linux/macOS Wine & Proton research guide
│   └── CHANGELOG_INTERNAL.md          # Release logs & development history (§1–165)
├── README.md                          # Open-source public repository presentation
└── CONTRIBUTING.md                    # Community contribution & coding standards
```

---

## 2. Frontend Infrastructure Symbol Map (`src/core/`)

| Module | Primary Responsibilities | Key Exported Symbols |
|---|---|---|
| `state.ts` | Single reactive state store `S` and deterministic O(1) lookup helpers. | `S`, `rawOf(appName)`, `summaryOf(appName)`, `setEpicGamesRaw(list)`, `setEpicSummaries(list)`, `isGameRunning(appName)` |
| `render.ts` | High-frequency update batching on `requestAnimationFrame` boundaries. | `scheduleRender()`, `render()`, `updateChrome()` |
| `nav.ts` | Top navigation bar, view state router, and LB/RB controller switching. | `switchView(view)`, `updateNavIndicator()`, `navNextTab()`, `navPrevTab()` |
| `selectors.ts` | Filter state, sort algorithms (`trCollator`), collection and advanced search queries (`dev:`, `is:`). | `epicVisibleSummaries()`, `trCollator`, `setActiveCollection(id)`, `setLibFilter(filter)` |
| `epic-actions.ts` | Dispatching high-level game actions to Tauri backend with optimistic UI updates. | `actionLaunchGame(appName)`, `actionInstallGame(appName)`, `actionCancelDownload(appName)` |
| `toast.ts` | PlayStation 5 console toast notification banner dispatch. | `showToast(message, type, duration)` |
| `dom.ts` | Safe DOM lookup and cached query selectors. | `$id(id)`, `qs(selector)`, `qsa(selector)` |
| `icons.ts` | Zero-emoji vector SVG generator adhering to PS5 console aesthetic. | `icon(name, size, className)` |
| `collection-icons.ts` | Vector icon mapper for user and system collections. | `getCollectionIconSvg(iconKey, size)` |
| `recent.ts` | Recently played games persistent stack (max 8 entries). | `pushRecent(appName)`, `getRecentApps()` |
| `window.ts` | Native window operations and system tray minimize integration. | `minimizeWindow()`, `maximizeWindow()`, `closeWindow()`, `toggleTray()` |
| `utils.ts` | Pure formatting utilities for bytes, playtimes, dates, and HTML sanitization. | `fmtBytes(bytes)`, `fmtPlaytime(mins)`, `fmtDate(iso)`, `esc(string)` |
| `constants.ts` | Static configuration values, thresholds, and chunking parameters. | `INITIAL_CARD_CHUNK` (48), `MORE_CARD_CHUNK` (36), `SEARCH_DEBOUNCE_MS` (120) |
| `types.ts` | Shared TypeScript interfaces and enum declarations. | `ViewMode`, `SortMode`, `FilterMode`, `EpicSummary`, `EpicGame` |

---

## 3. Frontend Feature Subsystems (`src/features/`)

| Feature Directory | Module Files | Responsibilities |
|---|---|---|
| `library/` | `render-library.ts`, `render-cards.ts`, `render-shelves.ts`, `chunking.ts` | Main game view, portrait cards, horizontal shelves, and `#lib-scroll-sentinel` infinite scroll. |
| `drawer/` | `drawer.ts`, `overview-tab.ts`, `achievements-tab.ts`, `dlc-tab.ts`, `specs-tab.ts` | Slide-out game detail drawer, trophy listing, DLC checklist, and hardware specs. |
| `downloads/` | `downloads.ts`, `speed-canvas.ts`, `queue-manager.ts` | Active download hero tile, real-time speed chart canvas, pause/resume, and queue reordering. |
| `profile/` | `profile.ts`, `trophies.ts`, `friends.ts`, `most-played.ts` | PS5 trophy level, platinum/gold/silver/bronze breakdown, friends list, and most played shelf. |
| `gamepad/` | `gamepad.ts`, `navigation.ts`, `hud.ts` | 10-foot controller input loop, spatial focus navigation, HUD button legend, and DualSense/Xbox mappings. |
| `events/` | `click-router.ts`, `input-listeners.ts`, `ipc-listeners.ts` | Central `[data-act]` event delegation, debounced search inputs, and Tauri IPC event listeners. |
| `store/` | `store.ts`, `webview-controller.ts` | Embedded Epic Games Store native child webview, automatic idle cleanup, and resizing hooks. |
| `settings/` | `settings.ts`, `integrations.ts`, `download-settings.ts` | Settings dialog: language switch, Discord RPC, auto-save backups, and launcher integrations. |
| `notifications/` | `notifications.ts`, `notification-center.ts` | Slide-in notification drawer, unread notification counter, and historical activity alerts. |
| `freegames/` | `freegames.ts` | Epic Weekly Free Games showcase shelf (current and upcoming promotions with mobile filtering). |
| `context-menu/` | `context-menu.ts` | Custom PS5 desktop right-click menu (Play, Properties, Move, Favorite, Uninstall). |
| `manage/` | `manage.ts` | Game configuration modal (custom executable selection, launch flags, wrapper commands, environment variables). |
| `move-game/` | `move-game.ts` | Multi-drive installation mover dialog with real-time transfer progress and drive free space checks. |
| `screenshots/` | `screenshots.ts`, `gallery.ts` | In-game F12 screenshot gallery, fullscreen lightbox, format conversion, and clipboard copy. |
| `collections/` | `collections.ts`, `dialog.ts` | Custom user game categories, tags, EGL collection importer, and shelf filters. |
| `cover/` | `cover.ts` | Custom game artwork manager and SteamGridDB high-resolution cover art picker. |
| `auth/` | `auth.ts`, `login-modal.ts` | Epic Games account login dialog, SID / web authorization code input, and status checking. |
| `dlc/` | `dlc.ts` | Add-on and DLC selection checklist with install/uninstall action handling. |
| `playtime/` | `playtime.ts` | Game session duration display, playtime tracking synchronization, and manual time editor. |
| `presence/` | `presence.ts` | Discord Rich Presence state synchronization and game title broadcasting. |
| `storage/` | `storage.ts` | Storage management dashboard showing per-drive installation sizes and capacity bars. |
| `onboarding/` | `onboarding.ts` | First-run setup guide for newly installed launchers and library path setup. |

---

## 4. Rust Backend Subsystem Registry (`src-tauri/src/`)

| File / Subsystem | Primary Responsibilities |
|---|---|
| `main.rs` | Application entry point, window event dispatcher (`WindowEvent::Resized`), system tray setup, child webview lifecycle, and Tauri command registration table. |
| `presence.rs` | Discord Rich Presence IPC client (`discord-rich-presence`). Updates playing status, elapsed time, and cover keys. |
| `legendary/commands.rs` | 50+ Tauri IPC entry points (`#[tauri::command]`). Bridges frontend invoke calls to backend services. |
| `legendary/cache.rs` | Instant NVMe disk manifest reader (`%USERPROFILE%\.config\legendary`) and snapshot cache (`efxlve_library_snapshot.json`). |
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
<button data-act="epic-play" data-id="AppName">Oyna</button>
<button data-act="epic-install" data-id="AppName">Kur</button>
<button data-act="drawer-tab" data-tab="achievements">Başarımlar</button>
<button data-act="nav-tab" data-view="downloads">İndirmeler</button>
```

To locate the execution logic for any UI element:
1. Identify its `data-act` attribute in the HTML template.
2. Open `src/features/events/click-router.ts` and locate the matching `case "your-data-act":` or `if (act === "your-data-act")` block.
