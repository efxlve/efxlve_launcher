# Game page design brief (for an external design review)

Paste the prompt below into a design-capable model together with two screenshots
of the game detail page (top of the page, and the part below it). Bring the
answer back here; the parts that fit `docs/DESIGN_SYSTEM.md` get implemented.

## Prompt

```
You are a senior product designer. Review the attached screenshots of a Windows
desktop game launcher (dark, monochrome, no brand colours) and propose a cleaner
information architecture for the GAME DETAIL page.

Context you must respect (the product's own design system, not a suggestion):
- One accent colour: white. Colour communicates state ONLY (green = ok/online,
  amber = update/paused, red = error/destructive).
- Tokens: bg #000, surface-1 #0a0a0a, surface-2 #141414, line
  rgba(255,255,255,0.06), text #fff, text-2 #9a9a9a, text-3 #5c5c5c. Radius 6px
  (controls) / 10px (cards). Spacing in multiples of 4. Type: 12/13/14/18/26px,
  weights 400/500/600 (700 only for the game title).
- Forbidden: gradients, glows, backdrop-filter, emoji, per-screen button styles,
  hover lift/zoom.
- Motion: 140ms ease-out on opacity/colour/background/border only.
- Existing components: .btn (32px; primary/play/update/danger/ghost; .lg 44px;
  .small 28px), .icon-btn, .chip, .card, .row (48-56px), .tabs, .info-box,
  .empty-state.
- The page today, top to bottom: hero key art with the title and a meta line
  (developer, year, anti-cheat) -> one action row (Play/Update, Manage,
  favourite, store page, store-version selector) and three hero stats (playtime,
  achievements, cloud) -> six tabs (Overview, Achievements, DLC, Screenshots,
  Notes, System) -> collection chips -> About box (description, clamped with
  "read more", plus a source note) -> IGDB block (community score, release date,
  publisher, age ratings, genre tags, 6 screenshots, 6 similar games) ->
  "Moments" strip (the player's own captures) -> "Next achievements" (3 rows) ->
  right sidebar with three cards: HowLongToBeat (3 rows), critic scores (2 rows)
  and a features card (controller, cloud, achievements, offline, game modes,
  external launcher, anti-cheat, EOS).

What the owner reports: the page reads as cluttered; the same fact appears twice
(developer in the hero and in the IGDB block; genre/platform/play-mode split
across the IGDB block and the features card); the right column is a wall of small
muted rows; three media strips sit one after another (screenshots, similar games,
moments).

Deliver EXACTLY this, no prose padding:
1. DIAGNOSIS - max 8 bullets, each naming a specific element above and why it hurts.
2. PROPOSED LAYOUT - sections in order, top to bottom, one line each saying what
   it contains and which existing component/token it uses. State explicitly what
   moves, what merges, what collapses behind a control, and what is deleted.
3. SIDEBAR - what stays, what merges, what moves into the tab strip.
4. RISKS - max 5 bullets (what could get worse for a player who only presses Play).
Rules: no new colours, no component types beyond the list above, every fact may
appear exactly once, and the layout must survive 0 screenshots, 0 similar games,
no achievements and no playtime (empty states).
```

## What is already fixed (do not spend the review on these)

- Developer/publisher near-duplicates are gone (loose company-name comparison).
- Platform, installed size and build moved from the overview's features card to
  **System → "The copy on this PC"**.
- The About box clamps long descriptions behind "read more".
- The Manage panel is sectioned and searchable; its search opens from a header
  icon.
