# CODEBASE_MAP.md — Efxlve Launcher Source & Symbol Index

> **Primary Audience:** AI Agents & Core Developers.
> **Purpose:** Instant symbol lookup, architecture mapping, and file navigation. Read this to locate any function, state variable, or view in under 5 seconds.

---

## 1. Project Directory Structure

```
efxlve_launcher/
├── src/                         # Frontend Application (Vite + TypeScript)
│   ├── main.ts                  # Main Orchestrator, Views, Event Delegation (~11,000 lines)
│   ├── epic.ts                  # Tauri Invoke Wrappers, Type Definitions (~1,500 lines)
│   └── styles.css               # Global Stylesheet (~10,500 lines)
├── src-tauri/                   # Rust Backend (Tauri v2)
│   ├── Cargo.toml               # Rust dependencies (serde, tokio, reqwest, tauri 2.x)
│   ├── tauri.conf.json          # Tauri configuration, window definitions, permissions
│   └── src/
│       ├── main.rs              # App builder, native child webview, Tauri command table
│       └── legendary/           # Backend Subsystems
│           ├── mod.rs           # Module exports
│           ├── models.rs        # Serde models for Legendary CLI & Epic Games
│           ├── commands.rs      # Tauri #[tauri::command] handlers
│           ├── client.rs        # legendary CLI process execution & argument builder
│           ├── cache.rs         # Local disk manifest/cache reader (NVMe instant read)
│           ├── transfers.rs     # Download queue, install, uninstall, launch, speed
│           ├── screenshots.rs   # F12 background capture hook, gallery, compression
│           ├── profile.rs       # Epic GraphQL profile & trophy queries
│           ├── steamgrid.rs     # SteamGridDB asset lookup & cover search
│           ├── playtime.rs      # In-game playtime tracker & session store
│           ├── move_game.rs     # Game installation mover across drives
│           ├── skip.rs          # 401 catalog item skipping & stub generation
│           ├── hltb.rs          # HowLongToBeat completion times
│           └── critic.rs        # OpenCritic review aggregator
├── docs/                        # AI & Developer Documentation
│   ├── CHANGELOG_INTERNAL.md    # Historical release logs (Sections 1–78)
│   ├── CODEBASE_MAP.md          # Symbol, state, and function index (this file)
│   ├── DESIGN_SYSTEM.md         # PlayStation 5 Console Dark Design System
│   └── TAURI_IPC_REFERENCE.md   # Tauri commands & IPC payload reference
├── ARCHITECTURE.md              # System design diagrams & data flow
├── AGENTS.md                    # Core operational rules & invariants (118 lines)
├── README.md                    # GitHub open-source showcase
└── CONTRIBUTING.md              # Community contribution guidelines
```

---

## 2. Frontend Symbol Map (`src/main.ts`)

| Concern / Subsystem | Key Functions & Symbols | Line Range (approx.) |
|---|---|---|
| **Core State & Setup** | `epicPhase`, `epicSummaries`, `epicGamesRaw`, `epicGamesRawMap`, `epicSummariesMap`, `playtimeMap`, `availableUpdates`, `runningGames`, `epicFav`, `epicRecent` | Lines 250–320 |
| **Lookup Helpers (O(1))** | `rawOf(appName)`, `summaryOf(appName)`, `setEpicGamesRaw()`, `setEpicSummaries()` | Lines 280–310, 590–615 |
| **Formatting Helpers** | `fmtBytes()`, `fmtPlaytime()`, `esc()`, `fmtAchDate()`, `toEpicSlug()` | Lines 605–630, 2430–2445 |
| **Render Orchestrator** | `render()`, `scheduleRender()`, `updateChrome()`, `updateNavIndicator()` | Lines 2310–2355, 620–650 |
| **Library View** | `renderEpic()`, `renderEpicItems()`, `renderHeroSpotlight()`, `epicCardPortrait()`, `epicRowHtml()`, `renderShelfSection()`, `renderEpicShelves()` | Lines 5840–6340 |
| **Progressive Chunking** | `INITIAL_CARD_CHUNK` (48), `MORE_CARD_CHUNK` (36), `renderedCardCount`, `setupLibScrollObserver()`, `resetCardChunk()` | Lines 5960–6040 |
| **Filtering & Sorting** | `epicVisibleSummaries()`, `trCollator`, `activeCollectionId`, `epicFilter`, `epicSort` | Lines 2550–2610 |
| **Detail Drawer (Modal)** | `openEpicModal()`, `closeModal()`, `renderDrawerTab()`, `activeDrawerTab` | Lines 2830–3210 |
| **Drawer Tabs** | `renderDrawerOverview()`, `renderDrawerAchievements()`, `renderDrawerDlcs()`, `renderDrawerScreenshots()`, `renderDrawerSpecs()` | Lines 3220–4750 |
| **Downloads Hub** | `renderDownloads()`, `drawSpeedCanvas()`, `pushSpeedData()`, `activeDlMetrics` | Lines 900–1450 |
| **PS5 Trophy Profile** | `renderProfile()`, `renderProfileGameCards()`, `playerProfileData` | Lines 1910–2290 |
| **Settings & Manage** | `renderSettings()`, `renderManageModal()`, `loadSettingsView()` | Lines 7100–7800 |
| **Global Click Delegation** | `document.addEventListener("click", ...)` (data-act router) | Lines 8500–9750 |
| **Global Input & Search** | `document.addEventListener("input", ...)` (`libSearchTimer` 120ms debounce) | Lines 9900–10050 |
| **Tauri IPC Listeners** | `listen("download-progress")`, `listen("game-status")`, `listen("screenshot-captured")` | Lines 10250–10500 |
| **Controller / Gamepad** | `gamepadLoop()`, `handleGamepadDirectionalMove()`, `updateGamepadHud()`, `initGamepadSupport()` | Lines 10550–10940 |

---

## 3. Global State Registry (`src/main.ts`)

| Variable | Type | Purpose |
|---|---|---|
| `epicSummaries` | `EpicSummary[]` | Parsed list of all owned games (titles, covers, installed status, install sizes). |
| `epicSummariesMap` | `Map<string, EpicSummary>` | **O(1) lookup** by `appName`. Always use `summaryOf(appName)`. |
| `epicGamesRaw` | `EpicGame[]` | Raw JSON metadata from Legendary CLI. |
| `epicGamesRawMap` | `Map<string, EpicGame>` | **O(1) lookup** by `appName`. Always use `rawOf(appName)`. |
| `playtimeMap` | `Map<string, PlaytimeRecord>` | Total tracked seconds, last played timestamps, session counts. |
| `availableUpdates` | `Map<string, UpdateInfo>` | Set of games with pending patches/updates from Epic. |
| `runningGames` | `Set<string>` | IDs of currently running game processes. |
| `epicFav` | `Set<string>` | Favorited game IDs (persisted in `localStorage`). |
| `epicRecent` | `string[]` | Ordered list of recently launched games (max 8, persisted in `localStorage`). |
| `loadedAchievements` | `Map<string, GameAchievementsData>` | In-memory cached achievement lists per game. |
| `loadedScreenshots` | `Map<string, GameScreenshotItem[]>` | In-memory cached screenshot lists per game. |

---

## 4. Rust Backend Subsystem Registry (`src-tauri/src/legendary/`)

| File | Primary Responsibilities |
|---|---|
| `commands.rs` | Entry point for 40+ Tauri IPC commands. Bridges frontend calls to internal modules. |
| `cache.rs` | High-speed direct disk reader for `%USERPROFILE%\.config\legendary` (`installed.json`, `metadata/`). |
| `client.rs` | Spawns `legendary.exe` CLI processes with correct flags, environment, and pipes. |
| `transfers.rs` | Handles game downloads, installations, uninstalls, pauses, queue reordering, and game launch. |
| `screenshots.rs` | Windows low-level keyboard hook (`VK_F12`), background capture, WebP/AVIF compression. |
| `profile.rs` | Executes authenticated Epic Games GraphQL queries for trophy XP and player levels. |
| `steamgrid.rs` | SteamGridDB REST client for custom game covers, heroes, and logos. |
| `playtime.rs` | Local playtime tracking database (`playtimes.json`). |
| `skip.rs` | Discontinued/delisted catalog item detection (401 handler) and stub manifest generator. |
| `move_game.rs` | Multi-drive game installation migration with real-time transfer progress. |
| `hltb.rs` | HowLongToBeat completion length scraper and cache. |
| `critic.rs` | OpenCritic tier calculator and review reception parser. |

---

## 5. Event Delegation Router (`data-act`)

Instead of inline `onclick` handlers, the entire UI uses document-level event delegation:
```html
<button data-act="epic-play" data-id="AppName">Oyna</button>
<button data-act="epic-fav" data-id="AppName">Favori</button>
<button data-act="drawer-tab" data-tab="achievements">Başarımlar</button>
```
To find what happens when an element is clicked, grep for `act === "your-data-act"` in `src/main.ts` around lines 8500–9750.
