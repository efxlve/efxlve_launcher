# TODO

Open work, in the order it should be picked up. Each item is sized so it can
land as one commit with `npm run build` (plus `cargo test` when Rust changed).

## 0. Game page: revision after 0.1.30 (owner asked for this)

The owner is not happy with the new game page yet ("daha da kötüleşiyor gibi"),
even though the objective changes landed: three media strips became two, the
sidebar went from twelve rows to three, the scores merged into one card, and the
IGDB facts moved under the description. Revisit with fresh screenshots before
touching anything:

- The credits line under the About text may be too heavy; try it as one muted
  line without the hairline.
- Similar games moved to the very bottom of the page (it used to sit under the
  description); check whether that pushed useful content out of sight.
- The sidebar is short on games with no HowLongToBeat and no scores, which
  leaves a tall empty column next to a long left column.
- `docs/design-brief-game-page.md` holds the external design review this came
  from, including the two points that were deliberately not followed
  (anti-cheat stays in the hero, the achievements stat stays in the hero).

Status, 2026-10-19: the page was rebuilt to the reviewed mockup (340 px hero,
personal blocks first, one scores card with two bodies, a five-item action row
plus the `...` menu, the news card, the community link chips, library-aware
similar games). The three bullets above were then checked against real
screenshots of the rendered page, taken in a plain browser through the fake
bridge (wide layout forced, both columns):

- Credits: they are tags + link chips + "Powered by IGDB" now, 119 px tall, and
  the hairline is a 6% line — the weight is gone, so the "one muted line"
  experiment is not needed. Resolved.
- Similar games at the bottom: the reading order is personal → About → news →
  similar, which reads as "what you own → what it is → what is new → what else
  to play". Kept as it is; only the owner's eye can settle it.
- Short sidebar: the scores card leads with "You: 14 h" and the comparison bar,
  so it is no longer empty without HowLongToBeat. A game with no scores and no
  lengths still leaves the column thin; the news card moved to the main column,
  which is where the space is.

Still only the owner can check: the hero with real artwork, and the `...` menu
opened by hand (its markup, its three items and its open/close behaviour were
verified in the browser harness, not in the app window).

A second review brief is ready for that round:
`docs/agent/briefs/game-page-after-redesign.md` (eight open decisions: the
duplicated collection button, where similar games sit, the thin sidebar, the
empty-state card, whether the news card is enough of a reason to come back, the
feed choice, what still reads as a database, and the first three changes). Paste
it into Antigravity and bring the answer back.

## 0b. Remaining plan items

1. Repaint diet: resolved 2026-10-19. An IGDB answer repaints only the About
   block, similar games and the scores card (`repaintIgdbBlocks`); a late
   achievement answer repaints the hero chips, the open achievements body and
   the personal block, not the whole overview. A DLC answer repaints only the
   DLC body; an EOS scan repaints only the "this copy" card. Full repaints here
   used to reset the reader's scroll position for two or three numbers or one
   list.
2. Keyboard and TV pass over the game page (tab order, focus ring, controller).
   Done on 2026-10-18: the game page already uses real buttons (no click target is
   a div), `:focus-visible` is styled globally, and the tab strip is a row of
   buttons. What was missing app-wide was the other half of the keyboard: a card
   could take focus and then Enter did nothing, because the router only listens
   for clicks. `input-listeners.ts` now turns Enter/Space on a focused `[data-act]`
   into that click, which woke up 14 targets (library cards, screenshot cards,
   cover picks, download rows, profile rows, task rows, critic badges). The
   controller stays TV-only by design; that page has its own focus model.
3. Picture cache, take two: back as `src-tauri/src/image_cache.rs` +
   `src/core/picture-cache.ts` (2026-10-18). The pictures the game page paints
   (hero art, IGDB screenshots, similar-game covers) are fetched once, kept on
   disk under `<app_data>/images` and handed to the WebView as `data:` URLs — no
   asset protocol, which was the suspect in the first version. Nothing runs at
   boot: `prefetchRecentPicturesWhenIdle` waits for an idle moment, and the hero
   of the open page is the only picture asked for eagerly. Settings → Advanced
   has the size row and a clear button.
4. Screenshots workstream (parked, see section 7).
5. Library covers: the grid renders its first 48 cards and appends more as a
   sentinel scrolls into view, and WebView2 keeps the pictures in its own disk
   cache between runs, so the repeat case was already covered. What was missing
   was the next chunk: `prefetchNextCovers` (library-view.ts, `PREFETCH_COVERS`)
   warms the 24 covers just past the rendered chunk through `requestIdleCallback`,
   once per URL, never in offline or paginated mode. Scrolling into them shows
   pictures instead of empty boxes.

## 0c. Caching and speed (owner's next focus, after the list above)

Every metadata source already caches on disk (IGDB, HowLongToBeat, the critic
service, Wikipedia, store specs — see `docs/GAME_PAGE_REWORK.md` §9), so the
remaining work is pictures and prefetching:

- Pictures: the game page's own cache came back as item 3 above (base64 data
  URLs, idle prefetch only); the library's covers are 0b.5 (the idle prefetch of
  the next chunk shipped; a second disk copy of what the WebView already caches
  is not worth it).
- Prefetch while idle: shipped for library covers (`prefetchNextCovers`) and for
  the recently played hero art (`prefetchRecentPicturesWhenIdle`).
- Idle cost first: transparency (section 2) and TV mode (section 1) are the two
  known CPU drains; measure with the task manager page before and after.

Status, 2026-10-19: the cache warm-up landed. `game-prefetch.ts` walks the six
recent/first installed games once per 12 hours, after the window is idle, and
fills HLTB, critic, requirements, achievements, DLC, screenshots, news (only for
titles with a Steam copy) and IGDB plus its pictures. The page's in-memory maps
are filled too, so a later open is local. A card the pointer rests on for 700 ms
is warmed as well, so the non-recent part of a large grid is covered too. The GOG
details call is now one per-session promise (`game-details-cache.ts`) instead of
one per open, the three
library loaders (`loadSteamLibrary`, `loadCompanionLibrary`,
`loadEpicAchSummaries`) share an in-flight promise, and the boot path reads the
network profile/settings/autostart in one parallel batch. Store-detail arrivals
patch their own blocks instead of calling `openEpicModal` and rebuilding the tab.
The achievement-summary pass is reused for 30 seconds unless a refresh or account
switch forces it, so boot and the first background sync no longer parse the same
150+ schemas twice. Companion cover resolution, store playtime and the paged Xbox
achievement pass now wait for the window to go idle instead of running on top of
the first library paint.

Steam's client metadata is cached on disk as well: the parsed `appinfo.vdf` map
goes to `<app_data>/steam/appinfo_metadata.json` (keyed by source path, mtime and
size). On the dev machine the cold parse + write was 134 ms; the warm disk read
was 29 ms for 1,820 apps, against 132 ms for the parse alone. A Steam update
invalidates the copy and forces one new parse.

## 0d. Community follow-ups (open)

- Berke: the Discord consent fix shipped in 0.1.31 (the RPC scope list plus the
  stop-on-decline). Ask him to try it and report.
- Gyro: his crash is still unexplained. The revert (0.1.32, prepared but not
  released) is the prime suspect fix; the Windows Event Log entry — the
  "faulting module name" — would settle it. `logs\crash.log` (0.1.31 and later)
  catches panics.
- hidaaan: asked for a switch that limits the screenshot scan to the chosen
  folder. Shipped in the local tree (`5ce9e223`): `SCREENSHOT_SCAN_ALL` plus the
  Settings row, off means the chosen folder only. Confirm with him at release.



## 1. TV mode modernization (needs a screen)

The mode works — timers are cleaned up, reduced motion is respected, gamepad
navigation and fullscreen are wired — but it is the oldest surface in the app:
`tv-mode.css` (43 kB) predates the current design tokens, and `tv-mode.ts`
(41 kB) + `tv-hub.ts` + `tv-panels.ts` + `tv-profile.ts` carry their own layout
language. A visual pass needs screenshots; it cannot be done blind.

- Rebuild the home screen on the current tokens: type scale, spacing, focus ring.
- Reuse the library card visuals (`pcard`) for the shelf instead of the bespoke
  TV cards.
- Keep what works: gamepad navigation, boot animation, clock, battery, panels.

Status, 2026-10-19: the hub was opened in the browser harness, so its structure
is now known even though its look still needs a real screen. What is there and
works: the header strip (L1/R1 category tabs with counts, search, account chip,
stores, downloads, battery, clock, exit), the stage (large title, store and
installed chips, three actions, focus ring), the shelf (poster-only cards with a
focus ring and running/update badges), the empty-category state, and the boot
overlay. The shelf's posters come from the picture cache, which fills on the
first library pass; in the harness that pass never ran, so the cards showed the
placeholder. Two things only a real screen can answer: whether the shelf's
poster cards should become the library's `pcard` visuals, and whether the
type scale still reads at 1920 px.

## 2. Window transparency cost

`tauri.conf.json` uses a frameless `transparent: true` window, so the compositor
pays for alpha on every frame. Idle CPU is ~11% of one core after the Discord
prewarm fix (launcher 2.5%, GPU 2.7%, renderer 5.6%).

- Disable transparency while the window is unfocused, or
- offer a "solid background" switch in Settings → Appearance for low-end PCs.

## 3. Screenshots workstream — shipped, with room to grow

Done: opt-in sidebar page (filters, favorites, multi-select, batch), canvas
editor (crop, rotate, flip, pen, arrow, rectangle, mosaic, text, undo/redo,
save a copy or overwrite a PNG), one-click sharing (Discord webhook, X and
Reddit via clipboard + compose window), the F9 MJPEG-AVI clip recorder, and
cutting/joining clips (`afad22b7`): a trim copies the chosen frame range into a
new file — MJPEG frames are their own keyframes, so nothing is re-encoded — and
a join appends clips that share one size and frame rate, refusing the rest.
A clip range can also go straight to a Discord webhook: the range is cut into
the temp folder on the way out, so the upload is a real clip and nothing is left
behind. A webhook takes 8 MB, so the dialog shows what a range weighs and has a
button that shrinks it to fit.

Left, in rough priority:
- A compressed clip for sharing: Discord takes 8 MB, which a clip at full quality
  passes in a second or two, so `clip_share_discord` cuts the range and sends
  that (`b1a3c1e` style lossless copy). Re-encoding the frames smaller is the
  real answer and it belongs with section 8's encoder.
- Screenshot `SteamGridDB` upload? Not planned; the picker already covers covers.
- The recorder's ~30 fps ceiling and what a GPU path would take: section 8.

## 4. Startup: what is left

Measured through `<app_data>/perf.log` on the dev machine (before → after):

| mark | before | after |
|---|---|---|
| `paint:shell` | 162 ms | ~150 ms |
| `library:epic-cached` | 2.26 s | ~0.6 s |
| `library:companion` | 4.19 s | ~0.7 s |
| `library:steam` | 5.0 s | ~0.8 s (day-long cache) |
| `boot:ready` | 1.6 s | ~0.7 s |

Left: `epicGetNetworkProfile` and the CDN/shortcut prefetch are still awaited on
the boot path (a few IPC round trips, ~50 ms). Not worth another pass unless a
slow start shows up again.

## 5. Bundle size

Measured 2026-10-18 (`npm run build`): `main` 302 kB, `utils` 297 kB, the shared
CSS 233 kB — the ~1.1 MB minified the plan mentions. The 597 kB `spotify-client`
chunk is the Web Playback SDK and is already loaded lazily (only when the music
engine starts), and each locale is its own 126-240 kB chunk, so only the active
one is fetched.

What is left is splitting the rare views (tv mode ~41 kB, store, discord) behind
dynamic imports (ROADMAP 6.3). That is ~100-150 kB off a cold start, it touches
the core render switch, and it only pays off on low-end machines: not worth the
risk until something else forces a change there.

## 6. IGDB — live

The proxy runs on `efxlve.com/api/igdb` (the website repo's
`netlify/functions/igdb.mjs` plus the redirect above the SPA rule), with
`IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` set in Netlify. Verified 2026-10-15:
the endpoint answers with JSON for a real query, and the launcher's default
server address already points at it, so no user setup is involved.

Two bugs surfaced only once the transport was real, both fixed:

- `igdb_enrich` bailed out when the credential store was empty, which is always
  the case in proxy mode — game pages never asked IGDB at all. The guard now
  asks the transport.
- `S.igdbConfigured` was only ever set by the Settings loader, so a game page
  opened before Settings enriched nothing. The game page now loads the status
  once by itself.

IGDB `dlcs`/`expansions` now fill the DLC tab (2026-10-19): the backend asks
for both lists (`CACHE_SCHEMA` 5), and the tab adds an "IGDB'den ek paketler"
block under the store's install rows. Titles the store already lists are
dropped; the block follows the DLC search and repaints in place when the IGDB
answer lands. Remaining idea: a "power user" way back to own credentials now
that the row is always visible.

## 7. Screenshots — pass done (2026-10-18), the fault was the recorder

The "the whole workstream is broken" report was about the clip recorder: it had
never written a file on this machine, and the clips it did write had no sound and
a header that drifted 20 s away from the sound track. All three are fixed
(`de3358ac`, `71ba668c`, `19b191b4`, `cc231746`). The rest of the workstream was
then checked against the real folders:

- Listing: 34 captures, every game title detected (`Ekran görüntüsü …`,
  `Dead_by_Daylight_Screenshot_…`, the GTA folder with an en-dash), 85 ms, no
  file dropped (`test_live_all_screenshots_scan`).
- Previews: PNG and WebP both served; a file GDI+ cannot decode reports an empty
  preview and the WebView builds and caches one (`live_preview_real_captures`).
- Screenshots page: gallery, filters, favourites, select mode, batch buttons,
  lightbox, editor (27 tools), share sheet, clips section — driven through the
  DOM with no console error.
- Game page: the Moments strip, its lightbox, navigation, the editor and the
  share sheet — same result.
- Sharing: the Discord webhook path answers 413/401/429 with its own message
  instead of failing silently. The 8 MB limit still means a big PNG has to be
  compressed first, which the compressor does.
- Clips in the list now carry a frame: the first `00dc` chunk of our own AVI,
  read without a decoder (`clip_thumbnail`).

Still open: the concrete symptom from the user's own screen, if it returns.

## 8. GPU recorder: the way past ~30 fps (owner asked for it, later)

The MJPEG/GDI recorder cannot hold the rates the settings offer, and no amount of
tuning changes that. Measured on the dev machine (2026-10-18, `frame_cost_by_height`
and `screen_read_cost_probe`, both `cargo test -- --ignored`):

| step | cost |
|---|---|
| GDI screen read (`BitBlt`), full 2560x1600 | 26-46 ms |
| the same read at 384x240 output | 29 ms — the cost is the screen, not the frame |
| GDI+ JPEG encode | 5-15 ms |

So the ceiling is ~20 fps at native size and ~26 fps at 720p, whatever the user
asks for. The 60 and 120 buttons in Settings are therefore disabled
(`CLIP_FPS_SUPPORTED` in `ss-settings.ts`) and `clipFps()` falls back to 30.

Getting to 60/120 means a second recorder beside the current one:

- Read frames on the GPU: Desktop Duplication API (DXGI) or Windows Graphics
  Capture, into a staging texture — the read stops costing CPU time per frame.
- Encode with the hardware encoder: Media Foundation H.264 (the OS picks NVENC,
  QuickSync or AMF), instead of one JPEG per frame.
- Keep the MJPEG writer as the fallback: no codec licence, plays everywhere,
  and it is the only path on machines without a hardware encoder.
- The clip list, the settings rows and the overlay widget stay as they are; only
  the recorder behind them changes.

Interim state (0.1.32-local, `19b191b4`): the AVI header carries the *measured*
frame rate, so a machine that cannot hold the requested rate still writes a file
whose picture and sound are the same length. Before that fix, a 47 s recording
with 779 frames claimed 30 fps, played its picture in 26 s and drifted 20.5 s
away from its 46.5 s sound track.

## 9. Linux/macOS compatibility layer (preparation)

Shipped 2026-10-19: `src-tauri/src/compat/` (catalogue, GitHub release cache,
resumable download/extract/verify/remove, launch wrapper), platform-aware
Legendary and GOGdl assets, detected system runners, DXVK/VKD3D prefix
deployment, and Settings → Compatibility with a target-platform selector so a
Linux/macOS tree can be staged from Windows. See `docs/CROSS_PLATFORM.md` §8 for
the exact surface.

Still open:
- First-run `wineboot`/prefix creation with progress and a retry path.
- Flatpak/AppImage/`.deb`/AUR and macOS `.app`/notarization.
- ProtonDB/Steam Deck badges and anti-cheat notices on the game page.
- Platform implementations for the screenshot hook, embedded store webview and
  drive scan (F0/F5).
- `wine-crossover` is detection-only until a maintained release source exists;
  `vulkan-helper-rs` is source-only.
