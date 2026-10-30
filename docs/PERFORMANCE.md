# PERFORMANCE.md — low-end tuning without removing features

The launcher must stay feature-complete on a high-end PC and remain usable on a
4 GB / integrated-GPU laptop. Optimisation therefore targets **work the engine
does**, never the feature set or the visual layout.

## Rules

1. No feature or page is removed or hidden to make a benchmark look better.
2. Prefer doing less work over doing the same work faster: page large lists,
   debounce input, pause hidden work and bound caches.
3. Animation and glass are optional effects, not functionality. The
   **Settings → Appearance → Reduce motion and effects** switch removes motion,
   `backdrop-filter` and hover lifts while every control stays in place.
4. A change is kept only when it is measurable: fewer DOM nodes, fewer decoded
   images, fewer polling calls, or less main-thread work.

## What WebView2 makes expensive

Microsoft's WebView2 performance guide describes the constraints this app has to
live with ([source](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance)):

- Each WebView2 control brings a browser, renderer and GPU process. Many
  controllers cost memory even before the page renders anything.
- Heavy JavaScript, frequent host/web messages and long lists raise CPU and
  memory. Debounce/throttle and batch communication are the recommended fixes.
- `MemoryUsageTargetLevel = Low` and `TrySuspendAsync()` can lower an inactive
  webview's memory, and must be paired with a restore path.
- Large image payloads should be lazy-loaded; the initial view should stay light.

The launcher already uses one main webview, lazy covers and disk-backed image
caches. The remaining wins are in list size, decoded data URLs and work done while
the window is hidden.

## Implemented in this pass

| Area | Change | Why it helps |
|---|---|---|
| Collections picker | First page is 120 rows; **Show more** adds another 120 | A 1,000-game library no longer creates ~1,000 rows and images before the modal opens |
| Collections gallery | Plain scrim, static cover tint behind the poster fan, no per-card entrance or hover fan | The full-screen backdrop blur plus a 28 px blur behind every card and a scale-in animated the whole panel each frame; opening now paints once |
| Collections picker | `content-visibility: auto` on rows with a fixed 64 px intrinsic size | Off-screen rows skip layout/paint while keeping every row accessible |
| Collection search | 120 ms debounce, then one rebuild | Typing no longer walks every store on each keypress |
| Collection checkbox | Updates the existing `.col-custom-cb` node instead of rebuilding the list | A click is now O(1) DOM work and the tick is correct immediately |
| Collection dropdown | 2×2 cover mosaic per collection, four covers, lazy images | Collections are recognisable at a glance without opening each one |
| Picture memory cache | 32-entry LRU instead of an unbounded `Map` | Long sessions cannot retain every decoded `data:` URL |
| Library prefetch | 24 covers normally, 8 in reduced-effects mode; the skip list is capped at 2,000 URLs | Fewer network/decode jobs on slow disks and integrated GPUs, and a huge library cannot grow the URL set without bound |
| Steam running poll | Skips ticks while `document.visibilityState !== "visible"` | The hidden launcher stops repainting badges every 15 s; the next visible tick catches up |
| Steam running watcher | Reads `HKCU\Software\Valve\Steam\Apps` directly and waits on `RegNotifyChangeKeyValue`; the 3 s poll is only the fallback | No recurring helper process, no registry-output parsing, and no periodic wake while Steam's app flags are unchanged |
| Game process watch | One name-only snapshot serves every installed game; the full path walk remains for a name hit and the kill/hotkey paths | An idle machine no longer opens hundreds of process handles every 4 s, and the folder tick no longer scans the process table once per game |
| Overlay panel | Built on the first Shift+Tab/header open and destroyed two minutes after it closes; the page replays the open payload when it becomes ready | No hidden WebView2 renderer, process tree or overlay app is kept alive from boot for an overlay nobody opened |
| Overlay frame-time lows | The ETW callback fills a 2048-frame ring per pid; the 1 Hz worker copies the ring under the lock and sorts outside it | The 1% / 0.1% lows cost one small copy and sort per second, and the per-present callback never waits for a percentile pass |
| Overlay audio mixer | Polls the default endpoint every 2 s only while the Audio tab is open; COM objects are created per command on a blocking worker, and a slider holds the poll for 1.5 s | The mixer costs nothing with the tab closed and does not keep a long-lived COM worker or audio device handle |
| Overlay crosshair | A small software-rendered BGRA DIB is updated only on show/config and a 2 s recentre; the layered window is hidden when off | The crosshair costs nothing while off and one tiny render per update, with no extra process or WebView renderer |
| Note images | Pasted screenshots are resized to ≤960 px and JPEG-compressed to ≤150k characters before the save; Rust caps 3 per note and re-validates the data URL | A pasted map stays small enough for the notes file, and the editor never writes an uncompressed clipboard image |
| Browser PiP | The existing browser window is resized and its chrome hidden; the page child webview is re-placed, no second renderer | A guide video costs the tab it already had, not a second WebView2 process |
| Overlay browser tabs | Inactive tabs are suspended and the active tab resumes before navigation; tab state is dropped when the tab closes | A hidden YouTube/guide tab kept its renderer timers alive for the two-minute overlay idle window |
| Download chart | Stops sampling and drawing while the window is hidden | A minimized launcher does not run a per-second canvas/DOM pass for a Steam or Epic transfer |
| Mini player | Polls and paints only while the launcher is visible | Spotify state checks and sidebar repaints no longer run behind a hidden window |
| Effects | Global reduced-effects class: no animation, no transition, no backdrop blur; focus ring preserved; spinner exempt | Removes continuous compositing on weak GPUs without moving or hiding controls |
| Image cache clear | Also clears the in-memory map and request set | The Settings button actually releases RAM, not only disk |
| Media Studio scan | The newest 300 captures are chosen before any thumbnail is built, and the thumbnails are spread over four workers with a progress event | The first scan decoded a preview for every file on disk in one blocking response, so the tab stayed empty with no sign of work |
| Clips list | `avi_seconds` reads the 52-byte `avih` header instead of the whole file | Opening the clips page read every recording end to end — hundreds of megabytes per clip — just to fill a length column |
| Steam install path | The registry answer is trusted for 60 s instead of being re-read per call | The achievement watcher asked every 1.5 s, and each answer spawned two `reg.exe` processes |
| Overlay hotkey | Game identity is cloned on the hotkey edge, not every tick; the pad probe runs every fourth tick | Two strings were allocated 50 times a second for a value only an edge reads, and XInput was polled 200 times a second |
| Overlay hotkey idle | The listener sleeps on a 250 ms cadence when the panel is closed, no game is active, and the launcher is hidden or minimized; the launcher/game path keeps the 20 ms poll | A tray/minimized launcher kept waking 50 times a second for a shortcut with no target |
| Gamepad loop | A connected but idle pad polls on a 40 ms timer and returns to rAF on the first press | A pad nobody touched kept the renderer drawing a frame every refresh for the whole session |
| Installed-game watch | The signature is skipped while the window is hidden and rebuilt on the first visible frame | A hidden launcher rebuilt a string over the whole installed library every 20 s |
| Library card tilt | The pointer handler returns immediately outside the library view | Every pointer move in settings, the store or the drawer walked ancestors for a card that cannot exist there |
| Achievement watcher | The unlock parse runs only when the Steam stats file or the emulator achievement file changed (size + mtime), with a 10 s safety rebuild | The 800 ms loop used to re-read and parse the Steam schema and rescan every emulator folder 4,500 times an hour for a fact that had not changed |
| Achievement store poll | Store-backed reads run on a 60 s cadence (30 s for Ubisoft's local cache); local/definition answers and titles with no achievement set stop the timer's work | The 3-4 s loop hit GOG/EA/Xbox APIs and spawned `legendary` every 16 s, while the native watcher already owns live local unlocks |
| GOG achievements | A 60 s in-memory cache serves repeated opens; a forced refresh bypasses it and the running-session poll refreshes it | Opening the drawer twice or switching tabs re-requested the same Gameplay API answer |
| Ubisoft achievements | The parsed schema and base64 icons are cached by file identity; a 30 s session tick only reads the small spool and rebuilds the rows | Every tick decompressed the achievement zip and re-encoded every icon |
| Companion achievements | EA and Xbox answers are cached for 60 s per store/game/language; the session poll forces a fresh answer and link/unlink clears the cache | Opening the drawer twice or switching tabs repeated the EA GraphQL/Xbox REST request |
| Settings panels | Task Manager, Achievements and Theme are separate chunks loaded when their section opens; the boot bundle no longer parses them | Three self-contained panels sat in the page chunk even when the user never opened them |
| Picture renditions | The cache resizes wide pictures to the width the page paints (hero 1600, screenshot 640, cover 480, thumbnail 240) and stores that JPEG variant | Full-size covers and screenshots were decoded and carried over IPC even when painted at a fraction of their size |
| Main webview | The shell renderer stays awake; its memory target drops while hidden or minimized, and the child store, Spotify, Discord and overlay pages suspend individually | Suspending the main controller with child webviews made WebView2 recover the renderer, which reloaded the page and reset the view |
| Store webviews | Parked storefronts are suspended with the hidden or minimized window and resumed when the store returns; prewarmed pages that never painted are left alone | The three warm storefronts kept their timers and renderers alive behind the library, and the active store stayed visible to WebView2 when the window was minimized |

## Remaining opportunities

- **WebView2 suspend on Unix.** The main renderer suspends on Windows through
  `webview_power`; the Unix stubs are no-ops, so a native equivalent is still
  open there.
- **Store webview idle timeout.** The three most recently used storefronts stay
  warm; a time-based close could drop the rest when the launcher has been idle,
  but reopening must stay instant enough to keep the current UX.
- **Settings action surface.** The Task Manager, Achievements and Theme panels
  are separate chunks loaded when their section opens. The outer Settings page
  still ships in the main chunk because its action handlers import the library
  graph; splitting that surface is the next step.
- **Custom cover renditions.** The game page and its panels ask the picture cache
  for sized renditions, but the library grid still paints the source URL
  directly. Very large user-chosen covers would benefit from the same cache.
- **WebView2 environment sharing.** Child store webviews should share one
  environment; this must be verified in the Windows host rather than assumed.
