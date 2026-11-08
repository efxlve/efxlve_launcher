# DESIGN_SYSTEM.md — Efxlve Desktop Design System

> **Primary audience:** UI engineers and contributors.
> **One rule above all:** the launcher has exactly one visual language. Do not borrow screens from Apple, PlayStation, Xbox or the macOS App Store. If a new screen needs a pattern that is not described here, extend this document first, then build it.

---

## 1. Why this document was rewritten

The closed beta verdict was unanimous: "it smells like AI". The cause was not any single color — it was the absence of a decision. Each screen imitated a different product (console profile, Apple frosted top bar, App Store downloads, Xbox achievements), buttons changed color five times, and 30 stylesheets redefined the same components. The fix is consistency, not more decoration.

Direction: **Hydra / Heroic desktop layout** - fixed left sidebar, quiet cover grid, a strong game page, one accent color. The gamepad / couch experience lives in a separate **Stage Mode** (experimental; see section 8) while **Full Screen Mode** keeps the classic scaled desktop for mouse and keyboard users, so the desktop UI can stay dense and pointer-first.

---

## 2. Layout

```
+------------+---------------------------------------------+
| sidebar    | window bar (drag region, 36px)          _ □ x|
| 252px      +---------------------------------------------+
| account    |                                             |
| Store      |   #view (page content, max 1600px)          |
| Library    |                                             |
| Friends    |                                             |
| Settings   |                                             |
|  --------  |                                             |
| games...   |                                             |
|  --------  |                                             |
| Downloads  |                                             |
+------------+---------------------------------------------+
```

- `--sidebar-w: 252px`, `--winbar-h: 34px`. The sidebar has Store, Library, Friends and Settings in the primary list, Recently Played in the flexible middle, and Downloads pinned at the bottom. Account management stays on the account chip / Accounts page; there is no separate sidebar account-switcher panel. The embedded store webview is positioned from the live content box, not a hardcoded inset. The active sidebar row is a 2px left rule, not a filled pill.
- The page header owns exactly one control besides the back button, the title and the search field: the storefront tabs, visible only on the store view. Segmented pills, sliding gliders and drop shadows are not used there (see §4).
- Pages use `.page` (padding 24px 32px) with an optional `.page-head` (title + actions on one line).
- The game page replaces the view area (it is not a side drawer).

## 3. Tokens (`src/styles/tokens.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#000000` | window background (true black, Hydra) |
| `--surface-1` | `#0a0a0a` | sidebar, cards |
| `--surface-2` | `#141414` | inputs, hovered rows |
| `--surface-3` | `#1e1e1e` | pressed / selected |
| `--line` | `rgba(255,255,255,0.06)` | dividers, borders |
| `--text` | `#ffffff` | primary text |
| `--text-2` | `#9a9a9a` | secondary text |
| `--text-3` | `#5c5c5c` | hints, meta |
| `--accent` | `#ffffff` | the single interactive accent (selection, focus, links, progress) |
| `--ok` | `#2fb36d` | Play, online, success |
| `--warn` | `#e0a32e` | update available, offline, paused |
| `--err` | `#e5484d` | errors, destructive |

- Themes come from the registry in `src/core/themes.ts`. A colour-only theme is
  one entry with `tokens` (written to `:root[data-surface="<id>"]` at runtime)
  and needs no CSS; `midnight` is the reference. A theme that changes shapes,
  backgrounds or glass adds a `[data-surface="<id>"]` block in `themes.css`;
  `white`, `blades` and `gloss` do. The Settings picker, the stored choice, the boot script
  and the child-webview palette all read the registry, so a new theme leaves no
  switch half-wired. Components read tokens, never literal colours: a literal is
  what makes one theme look broken in another.
- `data-surface="soft"` lives in `tokens.css`; `white` and `gloss` replace the
  same token set in `themes.css`. White Mode is a light palette with a dark
  accent. Gloss adds a sky/water background, glossy glass cards and a
  blue accent; its gradients, glow and blur are intentional theme exceptions to
  §10 and must not leak into the flat themes.
- Custom CSS (Settings > Appearance) is the user's own stylesheet: stored as
  `efxlve-custom-css`, injected as `#efxlve-custom-css` before the first paint,
  capped at 20000 characters. It layers over any built-in theme, so the curated
  palettes stay untouched.
- Radius: `--r-sm: 6px` (buttons, inputs, chips) and `--r-md: 10px` (cards, modals, covers). Nothing else. No `999px` pills except 50% avatars and status dots. Stage Mode keeps the same quiet radius scale; it does not invent a pill language.
- Spacing: multiples of 4px.
- Type: system UI font (`Segoe UI Variable`, `Segoe UI`, system-ui). Sizes: 12 / 13 / 14 / 18 / 26. Weights: 400, 500, 600 (700 only for the game title).
- Numbers that change (speed, percent, playtime, counters) always use `font-variant-numeric: tabular-nums`.

## 4. Components (`src/styles/components.css`)

Defined once, reused everywhere:

- **Button** `.btn` — 32px, `--r-sm`. Variants: default (surface-2), `.primary` (accent), `.play` (ok), `.update` (warn text on warn tint), `.danger`, `.ghost`. `.lg` = 44px for the one primary action on a page. `.small` = 28px.
- **Icon button** `.icon-btn` — 32x32, transparent until hover.
- **Input / select / search** `.input` — 32px, surface-2, accent border on focus.
- **Toggle** `.switch` — 34x20 track.
- **Brand marks are content, not decoration (decision, 29.09.2026):** each store card on the Accounts page leads with that store's own logo (`src/assets/stores/`, 24px inside a 34px slot, bundled by Vite so nothing is fetched at runtime). This is the single documented exception to "colour only communicates state": a brand mark identifies its owner, and a recoloured or invented mark would be worse than a coloured one. The exception is bounded — logos appear **only** in store cards (Accounts, and Integrations where a store row exists), never in the chrome: the header storefront tabs stay text-only, no badge, chip or subtitle may carry a brand colour, and a logo is never used as a background, watermark or empty-state illustration. Faces of people, product art and game covers are content in the same sense; everything else in the interface still obeys the accent-only rule. Provenance and trademark handling: `src/assets/stores/README.md`; the legal notice in Settings → About names every owner.
- **Tabs** `.tabs > .tab` — text tabs with a 2px accent underline on the active tab. Used for library filters, game page sections and settings sub-sections. The storefront switcher in the page header (`#store-switcher.store-tabs`) is the same `.tab` item stretched to the full header height, with a **single sliding underline** (`.store-tabs-underline`, 140ms transform/width, disabled under `prefers-reduced-motion`) positioned by `nav.ts` on view and resize — never an observer or a loop. It lists all nine embedded storefronts (Epic Games / GOG / Steam / Xbox / Battle.net / Ubisoft / EA / Riot Games / Amazon Games) as brand names in Latin script in every locale; the row scrolls horizontally rather than wrapping when the window is narrow. While a storefront is still loading, the active tab carries the launcher's spinner (`.is-loading`); that is the only motion allowed in the header. The header carries no other control, and the storefront row is the only switcher — never add a second segmented control next to it.
- **Storefront order is fixed and deliberate (decision, 29.09.2026):** Epic Games → GOG → Steam → Xbox → Battle.net → Ubisoft → EA → Riot Games → Amazon Games. The criterion is two-stage and checkable: first the storefronts the launcher itself manages (install, update, launch, library and playtime data) in integration order — Epic, then GOG, then Steam — and then the browse-only storefronts (embedded shop pages, where nothing installs from here) by how often a PC player actually shops there: Xbox (Game Pass catalogue), Battle.net (Blizzard titles), then Ubisoft and EA, whose PC catalogue is mostly bought on Steam or Epic, and Riot Games, whose titles are free to play and live in its own client. Amazon Games closes the row as a cloud-service claims page (Luna) with nothing to install locally. Two alternatives were considered and rejected: **alphabetical** (it would lead with a store the launcher cannot transact with, and alphabetical order is a tool for long, homogeneous, scannable lists — settings or language pickers — not for branded tabs) and **usage-sorted** (dynamic reordering under the user's cursor destroys spatial memory for a gain of zero: every tab is visible at once, so there is nothing to hunt for). Reordering is a one-time, data-backed release decision — never per-user, never automatic. Keyboard and controller focus follow the same DOM order, which is the second reason the order must not move.
- **Chip / badge** `.chip` — 20px, `--r-sm`, tinted by state only.
- **Info box** `.info-box` - surface-1, `--line` border, `--r-sm`, one info icon and one sentence. Used where an explanation is needed but must not live inside a card body (the Accounts page: accounts are optional, client stores keep their own games; the Downloads page: which downloads the settings apply to; the Cloud Saves page: where backups go).
- **Support matrix** `.acc-details` - a native `<details>` inside a store card: nine feature rows (library, install, launch, achievements, playtime, cloud, store, screenshots) with a state word and a one-line note. Collapsed by default so the Accounts page stays a short list of cards; the Accounts page groups the cards under three captions (launcher-managed stores, client stores, coming soon).
- **Settings details** `.settings-details` - a native `<details>` styled as a settings row: the summary shows the row title and a status chip, the body holds the fields. Used for keys that are set once (Integrations: Steam Web API key, SteamGridDB).
- **Card** `.card` — surface-1, `--line` border, `--r-md`, 16px padding.
- **List row** `.row` — 48–56px, hover surface-2; the only list pattern (downloads, queue, updates, settings rows).
- **Alphabet rail** `.lib-alpha` — a fixed 9px A–Z column on title sorts. Present buckets are buttons, empty ones stay disabled; it is not shown for year, rating or playtime sorts.
- **Game-art backdrop** `#game-scene` — opt-in fixed layer holding the selected game's blurred wide art. With it on, the title bar and sidebar become 58% translucent with a 22px blur, and the game page loses its opaque layer; a theme's own scene yields to it. Off by default.
- **Modal** `.modal-backdrop > .modal` — surface-1, `--r-md`, 1 shadow level.
- **Empty state** `.empty` — 36px muted icon, one title, one sentence, one button. Inside a panel or tab card the same content uses `.empty-panel`: the icon sits in a 44px `--surface-2` tile so the block reads as a state, not as a dashed placeholder, in every theme.
- **In-game notification** (`src/features/achievement-card/ach-card.ts`) — one card component, rendered by both the Settings stage and the in-game toast webview (`src-tauri/src/overlay/toast.rs`). 520px wide (normal; 440 small, 600 large), 16px corners, the selected theme or rarity palette on a dark plate, a 6px accent bar, a 54px medallion with the achievement art or a trophy, a rarity line, one bold 18px title and one 13px muted line (all single-line with ellipsis), plus god-rays, a dashed orbit ring, a border comet and a 14-particle burst. It takes one of six screen anchors, never takes focus or input, and the Settings preview runs the same markup and keyframes.

## 5. Motion

- Transitions: `opacity`, `color`, `background-color`, `border-color` at 140ms ease-out.
- One documented exception (29.09.2026): the Manage panel's search field opens from its header icon with a `width` + `opacity` transition at 140ms ease-out. The motion explains where the field came from; it never loops and never plays on a hover.
- Allowed one-shot keyframes (must stop): `page-in` (view change), `fade-in` (game hero, store loading, overlay). Never loop except the loading spinner.
- **Platinum celebration (game page, decision 25.10.2026):** a completed achievement set gets one short celebration when the cup is painted: an accent glow bloom, an expanding ring, sparkles, a monochrome particle burst and a single shine sweep, plus a small rise-in for the card and a pop for the filled trophy in the achievements tab. The glow follows `--accent`, so it stays legible in White, Gloss and Blades. It runs once and stops; `prefers-reduced-motion` removes it. This is the only particle burst in the launcher besides the achievement notification card; do not reuse it for downloads, updates or other counters.
- No transform zoom/lift on hover, no Ken-Burns, no pulses. The library cover grid is the one exception: a card lifts as one unit (cover and caption together), the cover takes a calm 3D tilt, and a cursor-following light crosses it. Layout never moves; the cover scales from its bottom edge so the caption gap stays constant. `prefers-reduced-motion` disables the tilt, lift and light.
- `:active` press feedback: `transform: scale(0.98)` on buttons only.

## 6. Forbidden (zero tolerance)

- Gradients on buttons or surfaces, neon/glow `box-shadow`, `background-clip: text`. The single exception is the image scrim under the game page / TV hero title (`.gp-hero-scrim`), which exists only for text legibility over key art.
- `backdrop-filter` outside the opt-in glass theme scene and the game-art backdrop; both are user-selected, never a default surface.
- Emojis in UI text (use `icon()` SVGs or ISO language codes).
- Per-screen button styles. If a screen needs a new button look, it does not.
- Borrowed brand vocabulary in class names (`ps5-`, `apple-`, `xbox-`, `aero-`) for new code.

## 7. Performance contract

Reference hardware: 8 GB RAM, 5th-gen i5, integrated GPU, HDD, slow network.

- Library: progressive chunks (48 + 36), `loading="lazy"` covers, in-place card patching (`patchLibraryCardDom`); never a full `innerHTML` rebuild on progress events.
- Repeated tiles and rows carry `contain: layout paint` + `content-visibility: auto` with an intrinsic size close to the real one. Removing the containment was measured to raise >20ms frames from 2 to ~50 while scrolling 500 games; do not drop it.
- Idle = zero work: no rAF loops, no polling, no running CSS animations.
- Shadows: one level (`--shadow-pop`) and only on floating layers (menus, modals, toasts).

## 8. Stage Mode (experimental)

Stage is the controller-first, full-screen shell. It is a **mode**, not a `View`: `S.stage.active` switches the render branch, the desktop DOM stays alive underneath, and leaving Stage restores the page and scroll position. `S.stage.route` owns Home, Library, Downloads, Settings and the game programme; the desktop navigation history never sees them. The store page is the one exception: its child webview is parked on entry, so exit returns to the last non-store page rather than leaving a hidden store surface behind.

- **Look.** A dark stage where the game art supplies the colour and the focus supplies the light. The UI stays monochrome; the focus ring is white with a soft spotlight shadow, never the desktop blue ring. Hero, key art and programme pages may use one scrim gradient for text legibility; no neon, no decorative loops, no backdrop blur. The typographic poster fallback (four layouts, no invented artwork) covers titles without a cover.
- **Shell.** A 58px status line (brand, beta chip, download chip, network, pad battery, clock, menu), a leading 66–120px chapter spine (Home, Library, Downloads, Settings, Menu), a scrolling stage, and a hint bar that names only the actions of the current screen. The programme page hides the spine and uses a tab strip instead.
- **Screens.** Home is one cinematic hero for the last played game, then a 16:9 filmstrip of recent titles, portrait shelves for "up next" and "ready to play", and a collection mosaic row. Library is a cover wall plus a side stage that previews the focused game; it renders in 96-card chunks, appends the next chunk at the fold, and accepts a collection or store filter. Programme is a playbill: hero art, a persistent primary action, and Overview / Achievements / Extras tabs; Achievements is a filterable list (all/unlocked/locked, hidden handling, rarity, XP, dates), Extras holds the stills viewer and cloud backup. Downloads is a compact transfer list with a reorderable queue. Settings has General / Controller / Appearance / About tabs for text size, TV safe area, sound, haptics, launch preferences and controller status. The quick menu is a bottom sheet, not a grid of round icons.
- **Focus.** Stage owns a `[data-gp-scope]` subset; only the top overlay carries `[data-gp-item]`. Focus changes dispatch `stage:focus` and patch the side stage or reveal a caption instead of rebuilding the screen. The render guard skips full repaints on download ticks; the top download chip is patched in place. A modal (install/manage/confirm) takes the ring immediately when it opens and returns it when it closes.
- **Input.** `A` opens/confirms/plays, `B` backs out (on Home it opens the quick menu; in the still viewer it closes it), `X` quick-plays the focused game, `Y` favourites or switches the library layout, `LB/RB` changes section, programme tab or Settings tab, `LT/RT` changes the library store filter, `View/Select` opens search, `Menu/Start` opens the quick menu. The on-screen keyboard uses the same focus engine. Keyboard arrows/Enter/Escape/Ctrl+K and mouse hover/click mirror the pad.
- **Sound.** Optional synthesised ticks for move, select, back, launch and error, plus short pad haptics where the controller exposes `vibrationActuator`. Both default on at a low volume, both are one switch away in Settings, and pointer hover never chirps. No sampled audio ships with the app.
- **Motion.** Animations belong to a transition, not to every data repaint: `stage-page-enter` on a route change, `stage-overlay-enter` when an overlay opens, and a 420ms launch curtain. `prefers-reduced-motion` and the global reduce-effects switch remove them; the focus ring stays.
- **Performance.** The shell is a lazy `stage-render` chunk (about 76 kB minified / 18 kB gzip); the desktop bundle keeps only the mode state, the boot frame and the gamepad bridge. The first entry waits for that one import, then every screen is in memory.
- **Beta.** Stage is labelled BETA in the title bar, in its own status line and in Settings → Controller. Full Screen Mode remains available as the classic, desktop-scaled option. Store pages, cloud restore, full profile management and advanced game management stay in desktop mode; Stage offers a "manage in desktop" escape hatch and a direct cloud back-up action. No console-brand vocabulary is used in class names, strings, documentation or release notes; the vocabulary is stage, reel, shelf, programme, stills, curtain and quick menu.
