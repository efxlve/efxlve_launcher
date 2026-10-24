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
| Effects | Global reduced-effects class: no animation, no transition, no backdrop blur; focus ring preserved; spinner exempt | Removes continuous compositing on weak GPUs without moving or hiding controls |
| Image cache clear | Also clears the in-memory map and request set | The Settings button actually releases RAM, not only disk |

## Remaining opportunities

- **Inactive WebView2 memory target.** Wry exposes the controller on Windows;
  setting `MemoryUsageTargetLevel = Low` and calling `TrySuspendAsync()` when the
  launcher is hidden would cut renderer memory. It needs a matching `Resume()`
  path and testing across WebView2 versions.
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
