# What has been verified, and how

The browser harness (`tmp-ss.html`: `index.html` plus a fake Tauri bridge, see
`%TEMP%\opencode\build-ss-page.mjs`) boots the real app in a plain Chromium, so
the launcher can be driven and looked at without a game or an account. Every row
below says which way it was checked. **Harness** means the real render code ran
with faked backend answers; **app** means it still needs the owner's own run.

Written 2026-10-19, after the game-page redesign and the screenshots/clips work.

## Verified in the harness

| Surface | What was checked |
|---|---|
| Game page, first screen | Hero measures 340 px, title 30 px, meta line "Online · Studio · 2016 · PEGI 18" with the live state chip, the five-item action row (Play, Manage, heart, store, `...`) |
| Game page, `...` menu | Opens on click, three items, closes on a second click and on an outside click, `aria-expanded` follows, Escape closes it before the page |
| Game page, version picker | Appears only with two or more store copies, lists both with installed state, opens and closes, does not touch the `...` menu |
| Game page, overview order | Personal blocks first on an installed game (last session → moments → next trophies → empty card), then About, news, similar games |
| Game page, scores card | One card, two bodies: "You: 14 h" with the comparison bar, HLTB rows, IGDB/OpenCritic/Metacritic badges |
| Game page, DLC tab | Store rows stay the install surface; IGDB's `dlcs`/`expansions` appear below them as a separate block, duplicate titles are dropped, the block follows the DLC search, and the IGDB link opens the right game page |
| Game page, lazy fetches | HLTB and critic fill their own containers and are asked for once per game; the skeletons only show while the answer is in flight |
| Game page, personal block | Repaints in place when a session ends (same DOM node, scroll kept), shows "+2 trophies" as soon as the store reports them; does nothing on another tab or another game |
| Game page, hero stats | Trophy count follows a finished session (5/20 → 7/20) |
| Screenshots page | Toolbar, filters, 34-shot gallery, clips section with first-frame thumbnails that decode (112×64), five per-row actions, join button with two clips, thumbnail cache survives a repaint |
| Screenshots page, reload | A capture and a saved clip both reload the gallery and the clip list through `screenshots-changed` |
| Library | Real boot from `epic_setup_status` + `epic_cached_library`: grid, tabs, store filter, sort, cover placeholders, playtime and trophy chips, store marks |
| Library, keyboard | A card takes focus and Enter opens the game page (the Enter/Space bridge), which also proves the click router is attached |
| Downloads | Active card with progress bar, five metrics, speed chart, queue with reorder/download-now/remove and order numbers |
| Settings → Screenshots | Folder row, "scan store folders too" switch with its explanation, watched-folders list, hotkey row |
| Settings → Downloads | Picture cache row showing its size next to Clear |
| Settings → System | App update rows, system toggles, backend and library folder |
| Settings → Compatibility | Target selector (this PC / Linux / macOS), grouped store/runner/runtime/translation/helper rows, installed and detected chips, project links, runner/prefix/umu controls; a detected system runner is selectable and its path is shown; target switch hides the launch block; a large install asks for confirmation with its size |
| Game page → System → Compatibility | A per-game runner select appears with "use global", the managed runners and detected system runners; installed DXVK/VKD3D get per-game switches that inherit the global choice; a prefix field with browse/save accepts an exact folder and an empty field falls back to the global root; the saved choice is selected; on Windows the card hides itself because launches are direct |
| Compatibility layer prefix | Unit test: an empty prefix is left alone; a `pfx/system.reg` prefix resolves to `pfx`; a root `system.reg` resolves to the root folder |
| Game page → System → Prepare prefix | A pending prepare saves an unsaved prefix field first, then calls `compat_prepare_prefix`; the status line is busy during the call and becomes "Prefix hazır." afterwards; the prefix value stays in the field |
| Game page → System → Open prefix | The "Aç" button calls `compat_open_game_prefix` with the game key and shows the "Klasör açıldı" toast |
| Game page → System → Prefix status | A fake initialized state shows "Prefix hazır."; the command is called with the game key when the System tab opens |
| Game page → System → Diagnostics | The button calls `compat_game_diagnostics`, writes the returned text to the clipboard, and shows the "Tanılama kopyalandı." toast |
| Game page → Overview → Stats and cloud | Two separate sidebar widgets sit above the score card: "İstatistikler" shows SÜRE/KUPA above next achievements, "Bulut" names the provider (Steam test: "Steam Cloud tarafından yönetilir"; local Epic test: "Yerel Kayıt"). The scores card contains only IGDB/OpenCritic/Metacritic. Steam genre fallback maps `Strategy` → `Strateji`, `Open world` → `Açık Dünya` |
| Settings → Compatibility → Diagnostics | `handleCompatAction("compat-copy-diagnostics")` calls `compat_diagnostics`, writes its text to the clipboard and shows the same toast |
| Launch preflight | Code path only: all three launchers await `prepare_prefix_for_launch` before `launch_spec`; it returns immediately on Windows or when no layer is enabled, and a preparation failure is non-fatal. Real `wineboot` timing still needs Linux/macOS hardware |
| Launch toast | A pending launch shows one timerless "Oyun başlatılıyor…" toast; resolving the launch replaces it with the success toast. The progress-event path is wired in `ipc-listeners`; the harness cannot fire the Tauri event after boot, so the seconds update is code-reviewed only |
| Game page late data | An IGDB answer leaves the About section and scores card in place and does not rebuild the tab; a delayed achievement answer changes the hero from "—" to "7/20" while the tab strip and content element keep their harness markers, so the overview was not repainted; a delayed DLC answer turns "Eklentiler taranıyor…" into the add-on list while the tab strip keeps its marker; a delayed EOS scan adds the "EOS Desteği" row to the copy card while the tab strip and card element keep their markers |
| Steam → System → ProtonDB | A fake Steam game resolves a gold summary; the copy card shows a gold "Altın" pill linking to `https://www.protondb.com/app/1091500` with the community-rating tooltip; the command is called once per app |
| Steam → System → Anti-cheat | A fake Halo app resolves "Supported" with Easy Anti-Cheat; the copy card shows a green "Destekliyor" pill linking to `https://areweanticheatyet.com/game/halo-the-master-chief-collection`; the command is called once per app |
| Epic → System → Anti-cheat | A fake Hades app resolves "Broken" via the Epic namespace; the copy card shows a red "Bozuk" pill linking to `https://areweanticheatyet.com/game/hades`; the command receives `{namespace:"hades"}` |
| Steam → System → Steam Deck | A fake category-3 report shows a green "Doğrulanmış" pill linking to the Steam store page; the command is called once per app |
| Offline compatibility rows | With `S.offlineMode` set, the three badge commands are called with `offline:true`; a fake cached answer still paints the Deck, ProtonDB and anti-cheat pills, and no network path is entered. A null cache-only answer is not remembered: reopening the System tab calls again, and going online retries the fetch |
| Notes | Search box, scope filters, empty list state, editor panel ("pick a note"), no crash |
| Profile | Banner, online chip, account count, game/trophy counters, recents |
| Task manager | Launcher's own usage rows |
| Collections | The per-game modal ("which categories will include Hades"), backdrop, new/save actions |
| Storage manager | Disk rows: installed games, games/other/free split |
| Game page, hero action bar | The right side shows a compact "Son oturum" summary (playtime, when, trophies); with no launcher session it falls back to the store's last-played date, and a never-played title shows the short "Henüz oynanmadı" state. The personal block no longer repeats the last-session card |
| Settings → Appearance → Theme | Four choices: Siyah, Yumuşak Siyah, Beyaz Mod, Frutiger Aero. The active option is visibly selected in both light themes, the choice is stored under `efxlve-surface`, and the first paint reads the same key |
| White Mode | Light background, dark text, light cards, dark active segmented control, light scrollbar; library, game page and Settings render without white-on-white text |
| Frutiger Aero | Sky/water gradient, glass header/sidebar/cards, glossy blue primary action, dark text; Settings theme row and game page render cleanly, with the active segment tinted blue |
| TV home, second pass | Command bar with EFXLVE TV mark, compact category pills, icon-only status chips at 1080 px, stage kicker/description/pill actions, shelf heading/count/card titles, focused card ring; search icon keeps its width |
| TV category change | Clicking a category repaints the shelf and heading; the controller path shares the same paint guard in `applyFocus` (gamepad itself still needs the app) |
| TV hub, themed desktop | With Aero selected, the hub's `.card` / `.gp-side-card` surfaces stay dark and readable; the desktop theme is scoped out of `body.tv-mode` |
| Overlay, boot isolation | `overlay.html` loads `browser-shared.ts` only; `browser-window.ts` is no longer in the resource graph, so its top-level boot cannot fire `overlay_browser_tabs` / `overlay_browser_show` inside the panel |
| Overlay, default layout | At 1083×873 the performance widget sits at 24/72, the captures widget stacks below it at 24/464, and music sits at the right edge; none overlap the command bar or each other. At 1280×800 the three default widgets form one row |
| Overlay, saved layout | Deliberately saved `{x:8,y:8}` positions are treated as the old hidden-window clamp and replaced by the tiled defaults; dragging cannot put a header under the command bar or a widget below the viewport |
| Overlay, popover | The recent-games popover opens below the command bar and is not clipped by the topbar |
| Overlay, reset layout | Settings → Appearance → "Düzeni sıfırla" clears every `efxlve-ov-pos-*` key and moves the open performance/settings widgets back to their default positions (24/72 and centered); the row fits the settings widget |
| Overlay, hidden work | Clock/media/clip intervals and the gamepad rAF are stopped by `overlay-close` and by `document.hidden`; with no controller the loop falls back to a 250 ms check. Saved widgets for pages disabled in the launcher (Spotify/Discord/browser) are dropped at restore; settings and a valid DM companion stay allowed |
| Overlay, Discord first screen | With no SDK session, friends or call, the social widget shows one centered connect card (Discord mark, "Bağlı değil", feature row, connect + open Discord) instead of the old profile row and dead empty list; the chat widget uses the same card. Checked at 480×580 in the harness and laid out for the default 330×540 widget. A connected account with no friends gets an "Arkadaş ekle" action; a filtered empty list gets a clear-search action |
| Overlay, Discord colours | Outgoing message, unread count and send button use the launcher accent/on-accent tokens; composer focus uses the accent border; no Discord purple remains in the overlay CSS |
| Themes, dark overlays | In Aero the game-page hero tools compute `rgb(248,250,252)` on their dark bubble; same rules cover cover badges, screenshot chips/buttons, SGDB tags, profile banner chips, the version picker rows, the account-switch name and the collection editor's two dark input fields. White theme gets the same treatment |
| Themes, Aero cost | The remaining `backdrop-filter` on the Aero winbar/sidebar/header is gone; the chrome computes an opaque white gradient and `backdropFilter: none` while keeping the sky/water shell readable |
| TV hub | Header strip, stage, shelf, focus ring, empty category (see TODO §1). Second pass: "Oyun Merkezi" kicker above the title, white active tab pill, the long critic label shortened to "İnceleme", and the next-trophies card sits directly on the page instead of inside a second bordered box |
| TV stores | At 1083 px the eight storefront tabs collapse to labelled icons and the L1/R1 glyphs no longer collide with the labels; the back control keeps "Geri"; each icon keeps its storefront name as a tooltip |
| TV downloads | The empty download panel uses the flat `#05070a` console surface instead of inheriting the home screen's blue-black radial wash; header title, back and exit remain readable |
| TV profile | With zero tracked playtime the "Oynandı" stat shows an em dash instead of repeating "Oynanmadı"; the rest of the profile layout is unchanged |
| Gallery cap note | Appears at 300 captures with the right count, stays away below it |
| Live tests | All 26 `#[ignore]`d ones; the expected reds are listed in `docs/agent/README.md` |
| Update chain | `tauri.conf.json` carries a minisign public key, the private key lives in GitHub secrets only, nothing in the repo |

## Still needs the app window

- The hero with **real artwork** (the harness has no cover files), and the hero's
  look at a maximised window.
- The `...` menu and the version picker **by hand** (their behaviour is verified,
  their feel is not).
- Everything that needs a real game or account: launching, installing, the
  recorder, the overlay, Steam sign-in, the embedded store.
- Compatibility downloads and extraction with the real GitHub releases (the
  harness used a fake catalogue), and the Wine/Proton launch path on an actual
  Linux or macOS build.
- The two open design questions in `docs/agent/briefs/game-page-after-redesign.md`.

## Notes for the next session

- The harness answers the boot commands (`epic_setup_status`,
  `epic_cached_library`, `library_dir`) and the game page's lazy ones, so
  `renderEpic()`, `renderDownloads()` and the drawer all render for real.
- The desktop browser bridge wedges after heavy scripts (a tab loop over six
  drawer tabs timed out twice). A fresh tab recovers it; keep evaluated scripts
  short and one surface at a time.
- `tmp-ss.html` is gitignored; the harness builder lives in `%TEMP%\opencode`.
