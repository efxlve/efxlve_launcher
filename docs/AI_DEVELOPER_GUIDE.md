# AI_DEVELOPER_GUIDE.md — Efxlve Launcher Onboarding & Mental Model

> **Primary Audience:** AI Agents (LLMs) & New Core Contributors.  
> **Purpose:** Read this first to immediately gain a complete mental model of the codebase, avoid known traps, and follow safe development patterns.

---

## 1. High-Level Architecture & Mental Model

```
                    ┌────────────────────────────┐
                    │    Vite + TypeScript 5.6   │
                    │  Vanilla UI (No Framework) │
                    │    120 FPS / Gamepad-First │
                    └─────────────┬──────────────┘
                                  │ Tauri v2 IPC (invoke / emit)
                    ┌─────────────┴──────────────┐
                    │     Rust Backend Core      │
                    │   (Tauri 2.x, Tokio, MSVC) │
                    └──────┬──────────────┬──────┘
                           │              │
        ┌──────────────────┴───┐      ┌───┴───────────────────┐
        │  Legendary CLI       │      │  Rust Native Services │
        │  (GPL-3.0 Subprocess)│      │  • Screenshots Hook   │
        │  • Auth / Manifests  │      │  • Drive Mover        │
        │  • Game Installs     │      │  • SteamGridDB REST   │
        │  • Cloud Saves       │      │  • HLTB / OpenCritic  │
        └──────────────────────┘      │  • Playtime Tracker   │
                                      └───────────────────────┘
```

### The 3 Core Tenets:
1. **Cache-First Hydration (The Heroic Principle):**  
   Never block the user interface waiting for a network request or CLI subprocess. At startup, `epic_cached_library` reads local manifests directly from `%USERPROFILE%\.config\legendary` in under 15ms. The UI renders immediately. Background network synchronization (`epic_list_games`) runs silently and applies delta updates.
2. **Deterministic O(1) State Lookups:**  
   With 500+ games, searching arrays via `.find(g => g.app_name === id)` inside render functions causes severe frame drops. Global state maintains synchronized HashMaps (`epicSummariesMap`, `epicGamesRawMap`, `playtimeMap`). Always call `summaryOf(appName)` or `rawOf(appName)`.
3. **Targeted DOM Mutation (Zero Layout Thrashing):**  
   During active game downloads, `download-progress` events fire multiple times per second. **Never call `render()` on progress events.** Directly update the progress bar (`#dl-hero-fill`) and metrics (`#dl-stat-speed`).

---

## 2. The 8 Invariant Traps (Do NOT Fall Into These)

| Trap | Symptom | Safe Solution |
|---|---|---|
| **1. snake_case Tauri args** | Command receives `null` or defaults without error. | Tauri converts Rust `app_name` to JS `{ appName }`. Always use camelCase in `invoke()`. |
| **2. Parsing Legendary stdout for progress** | Download percentage never updates. | Legendary emits progress (`= Progress: 50%`) to **stderr**. stdout only contains clean JSON data. |
| **3. `onclick="stopPropagation()"` in Modals** | Clicks on buttons inside modals stop working. | Main UI uses global document-level event delegation (`data-act`). Stopping propagation breaks event routing. |
| **4. Rendering all 500+ cards at once** | 7,000+ DOM nodes freeze browser rendering. | Use Progressive Chunking: initial 48 cards + 36 cards on scroll via `#lib-scroll-sentinel` IntersectionObserver. |
| **5. Null manifest paths in JSON** | Rust deserialization panics or fails silently. | Legendary CLI outputs `manifest_path: null` for uninstalled games. Models must use `deserialize_with = "null_string"`. |
| **6. Permanent 401 Catalog Items** | Library sync hangs or crashes. | Delisted/unowned games yield permanent 401s. `skip.rs` marks them in `skipped.json` and generates stub metadata. |
| **7. Store Webview iframe attempt** | Epic Games Store page displays blank/refuses to connect. | Epic blocks iframes (`X-Frame-Options: DENY`). Must use native child webview (`unstable` + `add_child`). |
| **8. Layout thrashing in Gamepad Loop** | Gamepad navigation stutters or drops frames. | Do not read `getBoundingClientRect()` or `getComputedStyle()` inside the 170ms gamepad polling loop. |
| **9. Raw OS Emojis in UI** | Cheap, amateur look; inconsistent rendering across Windows versions. | Strictly zero emojis. Always use Lucide / inline SVG vector icons (`icon("name", size)`) or ISO codes. |
| **10. Missing `tabular-nums` on counters** | Numbers jumping cause buttons and cards to visually jitter/shake. | Enforce `font-variant-numeric: tabular-nums` on all speeds, sizes, times, and counts. |

---

## 3. Step-by-Step Feature Recipes

### Recipe A: Adding a New Tauri Backend Command

1. **Rust Implementation:**  
   Add your async or sync handler in `src-tauri/src/legendary/commands.rs` (or appropriate submodule):
   ```rust
   #[tauri::command]
   pub async fn epic_my_new_command(app_name: String) -> Result<String, String> {
       // Implementation...
       Ok("Success".into())
   }
   ```
2. **Register in Tauri Handler Table:**  
   Open `src-tauri/src/main.rs` and add `legendary::commands::epic_my_new_command` inside `tauri::generate_handler![...]`.
3. **TypeScript Wrapper & Type Definition:**  
   Open `src/epic.ts` and declare the typed wrapper with camelCase argument:
   ```typescript
   export const epicMyNewCommand = (appName: string) =>
     invoke<string>("epic_my_new_command", { appName });
   ```
4. **Wire to UI via Event Delegation:**  
   In `src/main.ts`, avoid inline click listeners. Use HTML data attributes:
   ```html
   <button class="ps5-btn primary" data-act="my-action" data-id="${esc(appName)}">Run</button>
   ```
   Handle in the global click router:
   ```typescript
   if (act === "my-action") {
     const id = el.dataset.id;
     if (id) await epicMyNewCommand(id);
   }
   ```

---

### Recipe B: Adding a Detail Drawer Tab

1. Drawer tabs are rendered in `renderEpicModal()` inside `src/main.ts`.
2. Add the tab button in the drawer header with `data-act="drawer-tab"` and `data-tab="your-tab-name"`.
3. Create `renderDrawerYourTab(summary: EpicSummary, raw: EpicGame)` returning HTML string.
4. Add case in `renderDrawerTab(tabName)` router.
5. Apply styling adhering strictly to `docs/DESIGN_SYSTEM.md` using `--ps5-surface-2` and `--ps5-radius-lg`.

---

## 4. Debugging & Troubleshooting Matrix

### Scenario 1: Game Fails to Launch
- **Check:** Does the game require a third-party launcher (EA App / Ubisoft Connect)?
- **Diagnosis:** Run `legendary launch <app_name> --dry-run` or check `isThirdPartyManaged()`. EA games must use `link2ea://` protocol URI.
- **File:** `src-tauri/src/legendary/transfers.rs` (`epic_launch_game`).

### Scenario 2: Active Download Shows 0 B/s or Disappears
- **Check:** Did Legendary prompt for DLC confirmation on stdin?
- **Diagnosis:** `legendary install` must ALWAYS include `-y` flag as the first argument to avoid interactive CLI prompts that freeze the process.
- **File:** `src-tauri/src/legendary/client.rs`.

### Scenario 3: Missing Custom Covers
- **Check:** Is SteamGridDB API key configured?
- **Diagnosis:** Inspect Settings -> SteamGridDB API. If unset, fallback priority is: Custom User Cover -> SteamGrid Cached Cover -> Official Epic KeyImage (`DieselGameBox` / `OfferImageWide`).
- **File:** `src-tauri/src/legendary/steamgrid.rs`.

---

## 5. Coding & Contribution Disipline

- **Windows Build Command:** Always run `npm.cmd run build` (PowerShell restriction).
- **Zero Dead Code:** Never leave temporary diagnostic scripts, `.mjs` test runners, or unused CSS rules.
- **Documentation Updates:** Whenever completing a task, summarize changes in `AGENTS.md` and commit with conventional commit format.
