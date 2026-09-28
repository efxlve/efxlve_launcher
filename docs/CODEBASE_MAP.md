# CODEBASE_MAP.md — Efxlve Launcher Source & Symbol Index

> **Primary Audience:** AI Agents & Core Developers.
> **Purpose:** Instant symbol lookup, architecture mapping, and file navigation. Read this to locate any function, state variable, module, or view in under 5 seconds.
> **Last synced:** 28.09.2026 (v0.1.17 tree: 15 locales × 1.361 keys, 143 Tauri commands, 44 Rust files).

---

## 1. Project Directory Structure

```
efxlve_launcher/
├── src/                               # Frontend Application (Vite 6 + TypeScript 5.6)
│   ├── main.ts                        # Minimal orchestrator & bootstrap (130 lines: render/scheduleRender/closeAllModals)
│   ├── epic.ts                        # Tauri invoke wrappers & TypeScript IPC models (~1.340 lines)
│   ├── gog.ts                         # GOG-specific IPC wrappers & models
│   ├── i18n.ts                        # Localization engine (dynamic chunk per language, en/tr bundled)
│   ├── core/                          # Fundamental shared infrastructure (16 modules)
│   │   ├── state.ts                   # Central reactive state 'S'
│   │   ├── render.ts                  # Render bus (main.ts registers the real implementations)
│   │   ├── dom.ts                     # DOM root references and safe queries
│   │   ├── nav.ts                     # Sidebar shell: active item, badges, recent list, account switcher popover, nav history
│   │   ├── toast.ts                   # Console toast notification system
│   │   ├── selectors.ts               # O(1) lookup maps (`epicSummariesMap`, `allGamesMap`) + summary/raw accessors
│   │   ├── epic-actions.ts            # Game action dispatchers (play, install, cancel, uninstall, updates)
│   │   ├── game-view.ts               # Shared game presentation helpers + `patchLibraryCardDom`
│   │   ├── epic-playtime.ts           # Epic server playtime merge (never lowers local values)
│   │   ├── recent.ts                  # Recently played registry
│   │   ├── window.ts                  # Window controls and resize handling
│   │   ├── icons.ts                   # Zero-emoji vector SVG icon generator + empty states
│   │   ├── collection-icons.ts        # Built-in collection marker icons
│   │   ├── utils.ts                   # Formatting/escaping helpers
│   │   ├── constants.ts               # Thresholds, localStorage keys, chunk sizes
│   │   └── types.ts                   # Core frontend types (`View` includes `"tv"` and `"friends"`)
│   ├── features/                      # Modular feature domains (28 subsystems)
│   │   ├── accounts/                  # Accounts page: Epic + GOG cards, switchers, sign-in blocks
│   │   ├── auth/                      # Epic/GOG login, EGL import, progressive sync, account vaults
│   │   ├── changelog/                 # Changelog modal (TR/EN release notes, 1:1 with GitHub Releases)
│   │   ├── cloud-backup/              # Cloud save backup (WebDAV & Google Drive) actions + views
│   │   ├── collections/               # Collection editor, tags, EGL import
│   │   ├── context-menu/              # Custom right-click menu
│   │   ├── cover/                     # Custom cover/hero manager + SteamGridDB picker
│   │   ├── dlc/                       # Selective install tags (languages, packs, DLCs)
│   │   ├── downloads/                 # Downloads hub, speed chart, scheduled auto-update
│   │   ├── drawer/                    # Full-page game page (overview, achievements, DLC, screenshots, manage, specs)
│   │   ├── eos/                       # EOS overlay detection + installer helper
│   │   ├── events/                    # click-router + 8 domain handlers, input listeners, IPC listeners (initApp)
│   │   ├── friends/                   # Friends page: merged, read-only Epic + GOG list with filter/search
│   │   ├── gamepad/                   # Controller polling/HUD + separate TV Mode view
│   │   ├── install/                   # Install location dialog
│   │   ├── library/                   # Grid/list library, pagination, hide-games modal, library options
│   │   ├── manage/                    # Manage popup: verify, location, saves, cloud row, launch flags, uninstall
│   │   ├── move-game/                 # Cross-drive game mover dialog
│   │   ├── notifications/             # Notification center (bell, unread badge, persisted history)
│   │   ├── onboarding/                # Login screen + progressive loading sequence
│   │   ├── palette/                   # Ctrl+K command palette
│   │   ├── playtime/                  # Manual playtime editor
│   │   ├── presence/                  # Discord Rich Presence sync
│   │   ├── profile/                   # Profile, avatar upload, hide-achievements modal
│   │   ├── screenshots/               # Screenshot gallery, lightbox, share, batch compression
│   │   ├── settings/                  # Settings view (Account, Downloads, Integrations, Appearance, Screenshots, System, About)
│   │   ├── storage/                   # Storage manager (per-drive sizes)
│   │   ├── store/                     # Embedded Epic/GOG store child webview manager
│   │   └── updates/                   # Launcher self-update (check/download/install gating)
│   ├── locales/                       # 15 language dictionaries (flat dotted keys)
│   │   ├── tr.json                    # Turkish (primary, 1.332 keys)
│   │   ├── en.json                    # English (1.332 keys, full parity)
│   │   └── ar, de, es, fr, it, ja, ko, pl, pt-BR, ru, th, zh-Hans, zh-Hant  # all at full parity
│   └── styles/                        # 13 stylesheets (12 modules + index.css)
│       ├── index.css                  # Master CSS entry (imports every module in cascade order)
│       ├── tokens.css                 # Flat palette, single accent, radii, reset
│       ├── components.css             # Buttons, inputs, tabs, chips, rows, modal frame, toasts
│       ├── shell.css                  # Window bar, sidebar, notification panel, store switcher
│       ├── library.css                # Cover grid, list view, toolbar, dropdowns, pager
│       ├── game-page.css              # Game page hero, tabs, achievements, manage, screenshots
│       ├── downloads.css              # Download card, speed chart, grouped lists
│       ├── settings.css               # Settings sub-nav and row panels
│       ├── profile.css                # Profile header, showcase, progress lists
│       ├── friends.css                # Friends page rows, avatars, store tokens
│       ├── modals.css                 # Shared modal frame + dialog layouts
│       ├── accounts.css               # Accounts page cards
│       └── tv-mode.css                # TV Mode full-screen shell
├── src-tauri/                         # Rust Backend (Tauri v2 + Tokio)
│   ├── Cargo.toml
│   ├── tauri.conf.json                # Window, bundle, updater endpoint & public key
│   └── src/                           # 47 Rust files
│       ├── main.rs                    # App builder, window/store hooks, tray, IPC table (143 commands)
│       ├── presence.rs                # Discord Rich Presence worker
│       ├── eos.rs                     # Epic Online Services overlay detection
│       ├── legendary/                 # Epic backend (25 files)
│       │   ├── commands.rs            # 55+ #[tauri::command] entry points
│       │   ├── transfers.rs           # Install/update/uninstall, queue, progress parsing, EGL manifest sync
│       │   ├── accounts.rs            # Epic account vault (archive/activate/remove sessions)
│       │   ├── cache.rs               # Disk readers, library snapshot, EGL `.item` helpers
│       │   ├── import_installed.rs    # Portable-folder game scanner & import
│       │   ├── download_resume.rs     # Partial download resume records
│       │   ├── playtime.rs / playtime_session.rs / library_playtime.rs  # Local + server playtime
│       │   ├── profile.rs / friends.rs# Epic GraphQL profile & friends
│       │   ├── screenshots.rs         # Hotkey hook, capture, compression
│       │   ├── backup.rs              # Local save backup/restore
│       │   ├── move_game.rs           # Cross-drive mover + EGL/legendary manifest updates
│       │   ├── collections.rs / skip.rs / hltb.rs / critic.rs / steamgrid.rs / wiki.rs
│       │   └── models.rs / client.rs / downloader.rs / paths.rs / mod.rs
│       ├── gogdl/                     # GOG backend (12 files: api_client, accounts, cache, commands, galaxy, galaxy_playtime, updates, launcher, paths, transfers, models, mod)
│       └── cloud_backup/              # Cloud saves (7 files: manager, archive, webdav, gdrive, commands, models, mod)
├── docs/                              # Architecture, design & operations documentation
│   ├── ROADMAP.md                     # Prioritized backlog (audit findings live in §6)
│   ├── CHANGELOG_INTERNAL.md          # Development history (§1–174)
│   ├── TAURI_IPC_REFERENCE.md         # IPC command dictionary (143 commands)
│   ├── REFACTOR_PLAN.md               # Modularization record + remaining splits
│   ├── DESIGN_SYSTEM.md               # Single desktop design language
│   └── CROSS_PLATFORM.md              # Linux/macOS research
├── README.md
└── CONTRIBUTING.md
```

---

## 2. Frontend Infrastructure Symbol Map (`src/core/`)

| Module | Primary Responsibilities | Key Exported Symbols |
|---|---|---|
| `state.ts` | Single state store `S` plus the custom-avatar resolver. | `S`, `getCustomAvatar()` |
| `render.ts` | Render bus; `main.ts`/`ipc-listeners.ts` register the real implementations. | `registerRender()`, `render()`, `scheduleRender()`, `notify()`, `openEpicModal()`, `closeAllModals()`, `presenceSync()` |
| `nav.ts` | Sidebar shell: active item, download/update badge, recent list (signature-gated), account popover, nav history. | `updateChrome()`, `updateSidebarActive()`, `updateBadge()`, `updatePageHeader()`, `navGoBack()`, `navGoForward()`, `updateSidebarAccountSwitcher()` |
| `selectors.ts` | O(1) maps + filtering helpers. | `summaryOf()`, `rawOf()`, `libraryItemOf()`, `epicVisibleSummaries()` (library-view), `gameStoresLabel()`, `totalLibraryGamesCount()`, `setEpicSummaries()`, `setGogSummaries()` |
| `epic-actions.ts` | Game actions with optimistic UI + `S.libraryDataRev` bumps. | `epicPlay()`, `epicInstall()`, `epicCancel()`, `epicUninstall()`, `refreshEpicInstalled()`, `refreshUpdates()` |
| `epic-playtime.ts` | Merge Epic server playtime without lowering local values. | `syncEpicServerPlaytimes()` |
| `game-view.ts` | Shared markup for cards, badges, download bars, action buttons. | `patchLibraryCardDom()`, `epicActionButtons()`, `epicArt()`, `libraryCoverStats()`, `achSummaryOf()`, `toggleFav()` |
| `toast.ts` | Console toast banners. | `toast(message, type, duration)` |
| `dom.ts` | Root element references and modal close helper. | `viewEl`, `modalRoot`, `toastsEl`, `manageRoot`, `closeModal()` |
| `icons.ts` | Zero-emoji SVG generator + empty/loading states. | `icon(name, size)`, `emptyState()`, `IconName` |
| `recent.ts` | Recently played stack (8 entries, installed-only pruning). | `pushRecent()`, `getRecentApps()`, `pruneRecent()` |
| `window.ts` | Window controls and resize handling. | `handleWindowResize()`, `updateMaxIcon()` |
| `utils.ts` | Formatting & escaping. | `fmtBytes()`, `fmtPlaytime()`, `esc()`, `parseEnvText()`, `cleanStoreDescription()` |
| `constants.ts` | Thresholds and persisted keys. | `isTauri`, `INITIAL_CARD_CHUNK` (48), `MORE_CARD_CHUNK` (36), `HIGHLIGHT_INSTALLED_KEY`, `IGNORED_UPDATES_KEY` |
| `types.ts` | Shared unions. | `View` (incl. `"tv"`), `DrawerTab`, `EpicSort`, `EpicFilter`, `EpicViewMode`, `NotifKind` |

---

## 3. Frontend Feature Subsystems (`src/features/`)

| Feature Directory | Module Files | Responsibilities |
|---|---|---|
| `accounts/` | `accounts-view.ts` | Epic + GOG account cards, saved-account rows, copyable account-id chip, sign-in blocks. |
| `auth/` | `auth-actions.ts`, `account-switcher.ts`, `gog-auth-actions.ts`, `gog-account-switcher.ts` | Epic/GOG login (web login + code paste + EGL import), progressive sync, account vault switching. |
| `changelog/` | `changelog-view.ts` | `CHANGELOG_DATA` (TR/EN, 1:1 with GitHub Releases) + modal. |
| `cloud-backup/` | `cloud-backup-actions.ts`, `cloud-backup-view.ts` | WebDAV/Google Drive settings card, manage-row upload/sync/restore/delete. |
| `collections/` | `collections-view.ts` | Collection editor, tags, EGL import, in-place game list updates. |
| `context-menu/` | `context-menu.ts` | Custom right-click menu (play, properties, move, favorite, hide, uninstall). |
| `cover/` | `cover-view.ts` | Custom cover/hero manager and SteamGridDB picker. |
| `dlc/` | `selective-install.ts` | Selective install tags modal (languages, packs, DLCs). |
| `downloads/` | `downloads-view.ts`, `auto-update.ts` | Active download card, speed chart, queue/updates/recent lists, scheduled auto-update. |
| `drawer/` | `drawer-view.ts`, `drawer-widgets.ts` | Game page: hero, action bar, tabs, achievements, specs, screenshots, HLTB/critic widgets. Store text wins over the Wikipedia fallback (gated fetch). |
| `eos/` | `eos-install.ts` | EOS overlay status card + installer helper. |
| `events/` | `click-router.ts`, `handlers/*` (8 files), `input-listeners.ts`, `ipc-listeners.ts` | `[data-act]`/`[data-view]` delegation, keyboard/mouse shortcuts, IPC listeners, `initApp()` bootstrap. |
| `gamepad/` | `gamepad.ts`, `tv-mode.ts` | Controller polling (only while connected) + HUD; TV Mode full-screen view with hero and cover rows. |
| `friends/` | `friends-view.ts` | Friends page: merged Epic + GOG list with live GOG presence, Epic last-seen, "Active" filter, incoming-request actions and 60s presence polling only while open. |
| `install/` | `install-dialog.ts` | Install location dialog (sizes, folder picker, auto-update/shortcut). |
| `library/` | `library-view.ts`, `library-options.ts`, `hide-games.ts` | Grid/list rendering with progressive chunks and pagination, filter/sort UI, hidden-games modal. |
| `manage/` | `manage-view.ts` | Manage popup sections and in-place updates (verify, save folder, paths, launch extras, cloud row). |
| `move-game/` | `move-game-view.ts`, `move-game-actions.ts` | Cross-drive mover dialog with live progress and free-space checks. |
| `notifications/` | `notifications.ts` | Bell, unread badge, capped persisted history, panel rendering with signature guard. |
| `onboarding/` | `onboarding-view.ts` | Login screen, progressive loading stages, EGL import bridge. |
| `palette/` | `palette.ts` | Ctrl+K palette (pages, actions incl. TV Mode, game search). |
| `playtime/` | `playtime-view.ts` | Manual playtime editor modal. |
| `presence/` | `presence.ts` | Discord Rich Presence context builder + sync (opt-in). |
| `profile/` | `profile-view.ts`, `profile-avatar.ts`, `hide-achievements.ts` | Profile showcase, local avatar crop/upload, hidden-achievement modal. |
| `screenshots/` | `screenshots-view.ts` | Gallery, lightbox, share modal, delete confirm, batch compression. |
| `settings/` | `settings-view.ts` | Settings sections, language switch, screenshot/tv/system cards, download profiles and CDN rail. |
| `storage/` | `storage-view.ts` | Storage manager with per-drive sizes, move/uninstall actions. |
| `store/` | `store-view.ts` | Embedded Epic/GOG store child webview lifecycle, bounds sync, loading screen. |
| `updates/` | `update-manager.ts` | Self-update checks (startup/focus/manual), silent download, install gating. |

---

## 4. Rust Backend Subsystem Registry (`src-tauri/src/`)

| File / Subsystem | Primary Responsibilities |
|---|---|
| `main.rs` | App builder, window/store events, tray, settings persistence, IPC registration (143 commands). |
| `presence.rs` | Discord Rich Presence worker (opt-in, `presence_enabled`). |
| `eos.rs` | Epic Online Services overlay detection & install state. |
| `legendary/commands.rs` | Epic IPC entry points (library, install, verify, move, settings, EGL, shortcuts). |
| `legendary/transfers.rs` | Install/update/uninstall pipelines, queue, progress parsing, **EGL `.item` version sync on success**, playtime session hooks. |
| `legendary/cache.rs` | Disk readers, library snapshot, EGL manifest helpers (`sync_egl_manifest_version`, `remove_egl_manifests_for_game`). |
| `legendary/accounts.rs` | Epic account vault (archive `user.json` + snapshot, activate, remove). |
| `legendary/import_installed.rs` | Portable folder scan/import, `.item` rewrite helpers. |
| `legendary/download_resume.rs` | Partial download records and cleanup rules. |
| `legendary/playtime.rs`, `playtime_session.rs`, `library_playtime.rs` | Local session tracking, crash recovery marker, Epic server playtime. |
| `legendary/profile.rs`, `friends.rs` | Epic GraphQL profile/XP; friends list, incoming requests and last-online presence (unofficial Web APIs). |
| `legendary/screenshots.rs` | Hotkey hook, capture, compression worker. |
| `legendary/backup.rs` | Local save backup/restore. |
| `legendary/move_game.rs` | Cross-drive relocation + EGL/legendary manifest path updates. |
| `legendary/collections.rs`, `skip.rs`, `hltb.rs`, `critic.rs`, `steamgrid.rs`, `wiki.rs` | Collections, 401 skipping, HLTB, OpenCritic, SteamGridDB, Wikipedia fallback. |
| `legendary/models.rs`, `client.rs`, `downloader.rs`, `paths.rs` | Models, CLI process runner, binary downloader, path resolver. |
| `gogdl/*` | GOG OAuth, library, achievements, requirements, install/verify/launch, accounts, **friends list + live Galaxy presence** (`chat.gog.com`, `presence.gog.com`), **GOG Galaxy detection/sync** (`galaxy.rs`), **Galaxy playtime import** (`galaxy_playtime.rs`) and **update checking** (`updates.rs`, content-system build feed). |
| `cloud_backup/*` | WebDAV + Google Drive save archives, auto-sync on game exit. |

---

## 5. Event Delegation Architecture (`data-act`)

All interactions route through centralized delegation in `src/features/events/click-router.ts`, which dispatches to eight domain handlers:

```
src/features/events/handlers/
├── auth-handlers.ts        # Epic/GOG login, account switching, library refresh (both stores)
├── cloud-backup-handlers.ts# Provider, upload, sync, restore, delete
├── collection-handlers.ts  # Collection editor modal actions
├── cover-handlers.ts       # Cover/hero picker actions
├── downloads-handlers.ts   # Queue, pause/resume, priority, CDN, install dir
├── drawer-handlers.ts      # Game page tabs, DLCs, requirements, store links
├── manage-handlers.ts      # Verify, saves, cross-drive move, launch extras, playtime
└── screenshot-handlers.ts  # Gallery, lightbox, share, compression
```

```html
<button data-act="epic-play" data-id="AppName">Play</button>
<button data-act="epic-install" data-id="AppName">Install</button>
<button data-act="drawer-tab" data-tab="achievements">Achievements</button>
<button data-view="downloads">Downloads</button>
```

To locate the execution logic for any UI element:
1. Identify its `data-act` attribute in the HTML template.
2. Check `click-router.ts` (nav/modals/settings toggles) and then the matching `handlers/*.ts` case.
