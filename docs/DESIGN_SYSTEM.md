# DESIGN_SYSTEM.md — Efxlve Desktop Design System

> **Primary audience:** AI agents and UI engineers.
> **One rule above all:** the launcher has exactly one visual language. Do not borrow screens from Apple, PlayStation, Xbox or the macOS App Store. If a new screen needs a pattern that is not described here, extend this document first, then build it.

---

## 1. Why this document was rewritten

The closed beta verdict was unanimous: "it smells like AI". The cause was not any single color — it was the absence of a decision. Each screen imitated a different product (PS5 profile, Apple frosted top bar, App Store downloads, Xbox achievements), buttons changed color five times, and 30 stylesheets redefined the same components. The fix is consistency, not more decoration.

Direction: **Hydra / Heroic desktop layout** — fixed left sidebar, quiet cover grid, a strong game page, one accent color. The gamepad / couch experience lives in a separate **TV Mode** (Playnite and Steam Big Picture model) so the desktop UI can stay dense and mouse/keyboard-first.

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

- Radius: `--r-sm: 6px` (buttons, inputs, chips) and `--r-md: 10px` (cards, modals, covers). Nothing else. No `999px` pills except 50% avatars and status dots.
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
- **Tabs** `.tabs > .tab` — text tabs with a 2px accent underline on the active tab. Used for library filters, game page sections and settings sub-sections. The storefront switcher in the page header (`#store-switcher.store-tabs`) is the same `.tab` item stretched to the full header height, with a **single sliding underline** (`.store-tabs-underline`, 140ms transform/width, disabled under `prefers-reduced-motion`) positioned by `nav.ts` on view and resize — never an observer or a loop. It lists all eight embedded storefronts (Epic Games / GOG / Steam / Xbox / Battle.net / Ubisoft / EA / Riot Games) as brand names in Latin script in every locale; the row scrolls horizontally rather than wrapping when the window is narrow. While a storefront is still loading, the active tab carries the launcher's spinner (`.is-loading`); that is the only motion allowed in the header. The header carries no other control, and the storefront row is the only switcher — never add a second segmented control next to it.
- **Storefront order is fixed and deliberate (decision, 29.09.2026):** Epic Games → GOG → Steam → Xbox → Battle.net → Ubisoft → EA → Riot Games. The criterion is two-stage and checkable: first the storefronts the launcher itself manages (install, update, launch, library and playtime data) in integration order — Epic, then GOG, then Steam — and then the browse-only storefronts (embedded shop pages, where nothing installs from here) by how often a PC player actually shops there: Xbox (Game Pass catalogue), Battle.net (Blizzard titles), then Ubisoft and EA, whose PC catalogue is mostly bought on Steam or Epic, and Riot Games, whose titles are free to play and live in its own client. Two alternatives were considered and rejected: **alphabetical** (it would lead with a store the launcher cannot transact with, and alphabetical order is a tool for long, homogeneous, scannable lists — settings or language pickers — not for branded tabs) and **usage-sorted** (dynamic reordering under the user's cursor destroys spatial memory for a gain of zero: every tab is visible at once, so there is nothing to hunt for). Reordering is a one-time, data-backed release decision — never per-user, never automatic. Keyboard and controller focus follow the same DOM order, which is the second reason the order must not move.
- **Chip / badge** `.chip` — 20px, `--r-sm`, tinted by state only.
- **Info box** `.acc-info` — surface-1, `--line` border, `--r-sm`, one info icon and one sentence. Used where an explanation is needed but must not live inside a card body (the Accounts page: accounts are optional, client stores keep their own games).
- **Support matrix** `.acc-details` — a native `<details>` inside a store card: nine feature rows (library, install, launch, achievements, playtime, cloud, store, screenshots) with a state word and a one-line note. Collapsed by default so the Accounts page stays a short list of cards; the Accounts page groups the cards under three captions (launcher-managed stores, client stores, coming soon).
- **Card** `.card` — surface-1, `--line` border, `--r-md`, 16px padding.
- **List row** `.row` — 48–56px, hover surface-2; the only list pattern (downloads, queue, updates, settings rows).
- **Modal** `.modal-backdrop > .modal` — surface-1, `--r-md`, 1 shadow level.
- **Empty state** `.empty` — 36px muted icon, one title, one sentence, one button.

## 5. Motion

- Transitions: `opacity`, `color`, `background-color`, `border-color` at 140ms ease-out.
- Allowed one-shot keyframes (must stop): `page-in` (view change), `fade-in` (game hero, store loading, overlay). Never loop except the loading spinner.
- No transform zoom/lift on hover, no Ken-Burns, no pulses. `prefers-reduced-motion` disables the one-shot keyframes.
- `:active` press feedback: `transform: scale(0.98)` on buttons only.

## 6. Forbidden (zero tolerance)

- Gradients on buttons or surfaces, neon/glow `box-shadow`, `background-clip: text`. The single exception is the image scrim under the game page / TV hero title (`.gp-hero-scrim`), which exists only for text legibility over key art.
- `backdrop-filter` anywhere.
- Emojis in UI text (use `icon()` SVGs or ISO language codes).
- Per-screen button styles. If a screen needs a new button look, it does not.
- Borrowed brand vocabulary in class names (`ps5-`, `apple-`, `xbox-`, `aero-`) for new code.

## 7. Performance contract

Reference hardware: 8 GB RAM, 5th-gen i5, integrated GPU, HDD, slow network.

- Library: progressive chunks (48 + 36), `loading="lazy"` covers, in-place card patching (`patchLibraryCardDom`); never a full `innerHTML` rebuild on progress events.
- Repeated tiles and rows carry `contain: layout paint` + `content-visibility: auto` with an intrinsic size close to the real one. Removing the containment was measured to raise >20ms frames from 2 to ~50 while scrolling 500 games; do not drop it.
- Idle = zero work: no rAF loops, no polling, no running CSS animations.
- Shadows: one level (`--shadow-pop`) and only on floating layers (menus, modals, toasts).

## 8. TV Mode

Gamepad/couch use is a separate full-screen view (`S.view = "tv"`, `src/features/gamepad/tv-mode.ts`): horizontal cover rows, large focus ring, A/B/LB/RB mapping. Desktop screens do not carry 10-foot sizing constraints. When a controller connects, a toast offers to switch to TV Mode.
