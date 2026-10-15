# Game page & Manage — rework plan

Status: proposal, waiting on the open questions in §7. Written 2026-10-15, right
after IGDB became the game page's first data source.

Read `docs/DESIGN_SYSTEM.md` before touching anything here: the visual language is
decided, so every item below has to be expressed in its tokens and components.

## 1. Where the two surfaces stand today

| File | Lines | Job |
|---|---|---|
| `src/features/drawer/drawer-view.ts` | 1447 | hero, tabs, overview, DLC, achievements, requirements, lazy fetches |
| `src/features/drawer/drawer-widgets.ts` | 1036 | presentational cards (HLTB, critic, features, achievements list) |
| `src/features/drawer/igdb-view.ts` | 164 | IGDB block + the per-game cache |
| `src/features/manage/manage-view.ts` | 651 | the Manage popup, 55 `data-act` actions, per-store branches |
| `src/styles/game-page.css` | 637 | the page's own styles |

The game page is a full view (not a drawer): hero art + title + meta, one action
row, three hero stats, then six tabs — Genel Bakış, Başarımlar, Eklentiler,
Ekran Görüntüleri, Notlar, Sistem. The overview holds the collection chips, the
About box, the IGDB block, the moments strip and the next achievements; the
sidebar holds HowLongToBeat, the critic scores and the features card. Manage is a
popup with grouped rows (files, saves, playtime, cover, shortcut, launch).

Data sources, in the order they are consulted now: IGDB (metadata, media,
similar games), the game's own store (description, requirements, DLC, cover
art), Wikipedia (description fallback), HowLongToBeat (durations), OpenCritic /
Metacritic / Steam (review scores), the local clients (achievements, playtime).

## 2. What the rework should fix

1. **The same fact appears twice, sometimes with two different values.**
   - The developer shows in the hero line *and* inside the IGDB block.
   - The IGDB score shows in the IGDB block (71 for Dead by Daylight) *and* in the
     critic card, where a second lookup answers 67 for the same game.
   - Game modes and platform show in the IGDB block *and* in the features card.
2. **The IGDB block reads like a raw dump**: four age ratings from four
   organisations in one row (GRAC 19+, ACB MA 15+, USK 18, CLASS_IND 18), genres
   and facts competing for the same line.
3. **The overview is a long single scroll.** The facts sit under a description
   that can run ten lines, and the media strips push the progress content
   (achievements, moments) below the fold.
4. **The Sistem tab and the features card overlap**: platform, controller and
   cloud appear in both; the tab adds requirements, languages and build.
5. **Every async answer repaints too much.** The IGDB arrival repaints the whole
   overview (`openEpicModal`), and HLTB, critic, requirements, screenshots and
   achievements each patch their own corner. On the reference hardware
   (8 GB / 5th-gen i5 / HDD) that is visible.
6. **Manage is a wall.** 55 actions in one popup, no sections, no search, no
   focus handling, and every store family's body in the same file.
7. **Keyboard and controller** never got an explicit pass on either surface.

## 3. Target shape

- **Facts first.** The hero carries the title, the developer, the anti-cheat note
  and one fact row: release year · genres · age rating · IGDB score. No fact
  appears twice on the page.
- **One owner per fact:**
  | Fact | Owner |
  |---|---|
  | Developer, anti-cheat, store badge | hero line |
  | Year, genres, age rating, IGDB score | hero fact row |
  | External review scores | critic card (IGDB row drops out) |
  | Controller, cloud, achievements count, EOS, platform, build | features card |
  | Requirements, languages | Sistem tab |
  | Media (screenshots, similar games) | IGDB block, trimmed to media |
- **Collapse what is long.** The About box clamps to six lines with "devamını
  oku"; media strips show one row and hand the rest to a "tümünü gör" affordance
  (the pattern the moments strip already uses).
- **Manage becomes a panel**: four sections (Genel, Dosyalar, Kayıtlar,
  Gelişmiş) with a search field, every existing action kept, one module per store
  family instead of one 651-line file.

## 4. Phases

Each phase is one commit and its own check (`npm.cmd run build`, plus
`cargo test` when Rust moves; `npm.cmd run locales` for new strings).

**Faz 0 — measurement harness (S).** `perfMark` around the game page open and
around each repaint; count DOM nodes, images and listeners when the page opens;
write the numbers into `TODO.md` so every later phase has a before/after.

**Faz 1 — fact sheet and de-duplication (M).** Hero fact row; IGDB block trimmed
to media + a single age rating (region-priority, the rest behind a tooltip);
critic card loses its IGDB row; features card keeps its facts and the Sistem tab
keeps the requirements.

**Faz 2 — overview layout (M).** Order: chips → facts → About (clamped) →
media → progress. Sidebar rules: HLTB, scores, features, nothing else.

**Faz 3 — repaint diet (M).** IGDB arrival patches the affected containers
instead of rebuilding the overview; batch the store/HLTB/critic paints into one
scheduled repaint; normalize `loading="lazy"` + `decoding="async"` + sized IGDB
URLs on every strip image; `content-visibility` on the long lists.

**Faz 4 — Manage rework (L).** Sections + search, same handlers, split per store
(`manage/epic.ts`, `manage/gog.ts`, `manage/companion.ts`, `manage/amazon.ts`),
confirmations in front of uninstall/verify, focus trap and Esc.

**Faz 5 — keyboard and TV (S).** Tab order, focus ring on every interactive
element, controller navigation across tabs and strips, TV Mode parity.

**Faz 6 — polish (S).** Skeletons instead of spinners where the shape is known,
empty and error states (IGDB down, store offline), and a locale pass.

## 5. How the work is split

- One phase, one worktree, one commit. Never two writers in the same file.
- Where a second agent earns its keep:
  - **Read-only audits** (parallel, no conflicts): a perf audit of the drawer's
    repaints, an inventory of the 55 Manage actions and what each touches, an
    accessibility pass over the tabs and the popup.
  - **A separate folder** (parallel, mergeable): the Manage panel lives in
    `src/features/manage/` and the game page in `src/features/drawer/`, so a
    second agent can rework Manage in its own worktree while the drawer work
    happens here. `src/locales/*.json` is the shared resource — new keys go in
    last, from one script, or the two branches collide.
  - **Design variants**: a design-focused model can propose two or three fact-row
    arrangements, but the answer has to be written in `DESIGN_SYSTEM.md` tokens;
    the document is the arbiter, not taste.
- What stays with one owner: integration, the checks, and the commits.

## 6. Risks

- Five store families run through the same page (Epic, GOG, Steam, companion
  clients, Amazon) — every layout change is verified against all five.
- Manage's 55 actions: the rework changes markup and grouping only; handlers stay
  where they are, so a broken flow can always be traced to a row, not a rewrite.
- The IGDB-first data flow landed today; the rework must not reintroduce the
  "text appears, then gets replaced" flicker it removed.
- 16 locales for every new string.

## 7. Open questions

1. Fact row under the hero title, or keep a separate "IGDB'den" card? (The plan
   above assumes the fact row, with the card reduced to media.)
2. Sistem tab: keep it, or fold requirements into the overview?
3. Manage: keep the popup, or move it to a full page with room to breathe?
4. Visual refresh: structure only, or spacing/typography tuning inside the
   current tokens?
5. "Anlar": stays on the overview, or moves fully into the Screenshots tab?

## 8. Suggested start

Faz 0 + Faz 1 in two commits: they are the biggest visible win, they touch the
fewest files, and every later phase builds on the fact row. Manage (Faz 4) can
start in parallel in a second worktree, since it shares no file with Faz 1.

## 9. Caching (audited 2026-10-15)

The rule: a game page that was opened once must open again without a network
wait — data and pictures alike.

Already on disk, verified by reading the call paths:

| Source | Cache |
|---|---|
| IGDB metadata | `<app_data>/igdb/game-<id>.json`, `lookup.json`, `age-ratings.json` |
| HowLongToBeat | `<config>/legendary/hltb-v4/<app>-<year>.json` |
| Review scores | `<config>/legendary/critic/*.json` |
| Wikipedia blurb | `<config>/wiki_about/<app>_<lang>_v1.json` |
| Store requirements | `<config>/specs/<app>.json` |
| Achievements, playtime, DLC | the client's own files — no network at all |

Missing, and now added: **pictures**. The hero art, the IGDB screenshots and the
similar-game covers were fetched from the network on every open.

- `src-tauri/src/image_cache.rs`: `cache_images(urls)` downloads a batch into
  `<app_data>/images/<sha256[0..16]>.<ext>` (four at a time, 20 s timeout, 12 MB
  per file, 512 MB per directory with oldest-first trimming), plus
  `image_cache_size()` and `clear_image_cache()`.
- The asset protocol is enabled for `$APPDATA/images/**`, so the webview paints
  the local file through `convertFileSrc`.
- `src/core/image-cache.ts`: `cachedImage(url)` for the markup, `warmImages()`
  to ask in the background and swap what is already on screen, and
  `prefetchRecentImages()` — called from the boot path 2.5 s after `boot:ready`
  for the eight recently played games.
- Wired: the game hero, the IGDB screenshots and the similar covers. Settings →
  Sistem shows the size and clears it.

Left for Faz 3: the same treatment for library covers (bounded, visible page
only) and a hover prefetch, so even a first-ever open paints from disk.

