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
| 232px      +---------------------------------------------+
|  search    |                                             |
|  Library   |   #view (page content, max 1600px)          |
|  Store     |                                             |
|  Downloads |                                             |
|  --------  |                                             |
|  games...  |                                             |
|  --------  |                                             |
|  profile   |                                             |
|  settings  |                                             |
+------------+---------------------------------------------+
```

- `--sidebar-w: 232px`, `--winbar-h: 36px`. The embedded store webview is positioned from these two values (`store_insets` in `main.rs`); change them together.
- Pages use `.page` (padding 24px 32px) with an optional `.page-head` (title + actions on one line).
- The game page replaces the view area (it is not a side drawer).

## 3. Tokens (`src/styles/tokens.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0e0f12` | window background |
| `--surface-1` | `#15161a` | sidebar, cards |
| `--surface-2` | `#1c1d22` | inputs, hovered rows |
| `--surface-3` | `#25262c` | pressed / selected |
| `--line` | `rgba(255,255,255,0.07)` | dividers, borders |
| `--text` | `#ececef` | primary text |
| `--text-2` | `#a3a4ad` | secondary text |
| `--text-3` | `#6c6d77` | hints, meta |
| `--accent` | `#3d8bfd` | the single interactive accent (selection, focus, links, progress) |
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
- **Tabs** `.tabs > .tab` — text tabs with a 2px accent underline on the active tab. Used for library filters, game page sections and settings sub-sections.
- **Chip / badge** `.chip` — 20px, `--r-sm`, tinted by state only.
- **Card** `.card` — surface-1, `--line` border, `--r-md`, 16px padding.
- **List row** `.row` — 48–56px, hover surface-2; the only list pattern (downloads, queue, updates, settings rows).
- **Modal** `.modal-backdrop > .modal` — surface-1, `--r-md`, 1 shadow level.
- **Empty state** `.empty` — 36px muted icon, one title, one sentence, one button.

## 5. Motion

- Transitions: `opacity`, `color`, `background-color`, `border-color` only, 120ms ease-out.
- No transform zoom/lift on hover, no infinite animations, no Ken-Burns, no pulses. The only allowed keyframe is the loading spinner, which must stop when loading ends.
- `:active` press feedback: `transform: scale(0.98)` on buttons only.

## 6. Forbidden (zero tolerance)

- Gradients on buttons or surfaces, neon/glow `box-shadow`, `background-clip: text`.
- `backdrop-filter` anywhere.
- Emojis in UI text (use `icon()` SVGs or ISO language codes).
- Per-screen button styles. If a screen needs a new button look, it does not.
- Borrowed brand vocabulary in class names (`ps5-`, `apple-`, `xbox-`, `aero-`) for new code.

## 7. Performance contract

Reference hardware: 8 GB RAM, 5th-gen i5, integrated GPU, HDD, slow network.

- Library: progressive chunks (48 + 36), `loading="lazy"` covers, in-place card patching (`patchLibraryCardDom`); never a full `innerHTML` rebuild on progress events.
- Idle = zero work: no rAF loops, no polling, no running CSS animations.
- Shadows: one level (`--shadow-pop`) and only on floating layers (menus, modals, toasts).

## 8. TV Mode

Gamepad/couch use is a separate full-screen view (`S.view = "tv"`, `src/features/gamepad/tv-mode.ts`): horizontal cover rows, large focus ring, A/B/LB/RB mapping. Desktop screens do not carry 10-foot sizing constraints. When a controller connects, a toast offers to switch to TV Mode.
