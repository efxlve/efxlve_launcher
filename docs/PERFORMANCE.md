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
| Library prefetch | 24 covers normally, 8 in reduced-effects mode | Fewer network/decode jobs on slow disks and integrated GPUs |
| Steam running poll | Skips ticks while `document.visibilityState !== "visible"` | The hidden launcher stops repainting badges every 15 s; the next visible tick catches up |
| Steam running watcher | Reads `HKCU\Software\Valve\Steam\Apps` directly instead of spawning `reg query` every 3 s | No recurring helper process and no registry-output parsing in the background |
| Game process watch | Matches executable names from one name-only snapshot before reading every process image path; the full path walk remains for a name hit and the kill/hotkey paths | An idle machine no longer opens hundreds of process handles every 4 s |
| Overlay panel | Built on the first Shift+Tab/header open and destroyed two minutes after it closes; the page replays the open payload when it becomes ready | No hidden WebView2 renderer, process tree or overlay app is kept alive from boot for an overlay nobody opened |
| Download chart | Stops sampling and drawing while the window is hidden | A minimized launcher does not run a per-second canvas/DOM pass for a Steam or Epic transfer |
| Mini player | Polls and paints only while the launcher is visible | Spotify state checks and sidebar repaints no longer run behind a hidden window |
| Effects | Global reduced-effects class: no animation, no transition, no backdrop blur; focus ring preserved; spinner exempt | Removes continuous compositing on weak GPUs without moving or hiding controls |
| Image cache clear | Also clears the in-memory map and request set | The Settings button actually releases RAM, not only disk |
| Media Studio scan | The newest 300 captures are chosen before any thumbnail is built, and the thumbnails are spread over four workers with a progress event | The first scan decoded a preview for every file on disk in one blocking response, so the tab stayed empty with no sign of work |
| Clips list | `avi_seconds` reads the 52-byte `avih` header instead of the whole file | Opening the clips page read every recording end to end — hundreds of megabytes per clip — just to fill a length column |
| Steam install path | The registry answer is trusted for 60 s instead of being re-read per call | The achievement watcher asked every 1.5 s, and each answer spawned two `reg.exe` processes |
| Overlay hotkey | Game identity is cloned on the hotkey edge, not every tick; the pad probe runs every fourth tick | Two strings were allocated 50 times a second for a value only an edge reads, and XInput was polled 200 times a second |
| Gamepad loop | A connected but idle pad polls on a 40 ms timer and returns to rAF on the first press | A pad nobody touched kept the renderer drawing a frame every refresh for the whole session |
| Installed-game watch | The signature is skipped while the window is hidden and rebuilt on the first visible frame | A hidden launcher rebuilt a string over the whole installed library every 20 s |
| Library card tilt | The pointer handler returns immediately outside the library view | Every pointer move in settings, the store or the drawer walked ancestors for a card that cannot exist there |
| Achievement watcher | The unlock parse runs only when the Steam stats file or the emulator achievement file changed (size + mtime), with a 10 s safety rebuild | The 800 ms loop used to re-read and parse the Steam schema and rescan every emulator folder 4,500 times an hour for a fact that had not changed |

## Remaining opportunities

- **Inactive WebView2 memory target.** Wry exposes the controller on Windows;
  setting `MemoryUsageTargetLevel = Low` and calling `TrySuspendAsync()` when the
  launcher is hidden would cut the main library renderer's memory. It needs a
  matching `Resume()` path and testing across WebView2 versions. The overlay
  panel no longer needs it: the idle release destroys that webview entirely.
- **Store webview recycling.** Embedded stores keep child webviews alive for fast
  switching. Closing idle ones after a timeout would reduce process memory, but
  reopening must stay instant enough to keep the current UX.
- **Settings code split.** `settings-view.ts` is the largest frontend module. A
  dynamic import when Settings first opens would shorten initial parse; the
  handler surface has to be separated first.
- **Image decode budget.** `loading="lazy"` helps network and decode, but very
  large cover sources still decode at full size. Asking the image cache for a
  width-appropriate rendition is the next step.
- **WebView2 environment sharing.** Child store webviews should share one
  environment; this must be verified in the Windows host rather than assumed.
