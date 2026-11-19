# Mod support

The game page shows where a game's mods live. For a small number of games the
launcher can also install them, but that is an upgrade, not the entry price.

A launcher cannot own a mod manager per game: each title brings its own loader,
folder layout, load-order file and conflict rules. A directory of sources costs
the same for one game and for the whole library, so it is the floor. Install is
added where it pays.

## Sources

Each row is a place a player can go. A source resolves to an exact page when the
game's id is known and to that site's own search when it is not.

| Source | Exact target | Account |
|---|---|---|
| Nexus Mods | `nexusmods.com/<slug>` | Free account; Premium for one-click manager downloads |
| Steam Workshop | `steamcommunity.com/app/<appid>/workshop/` | The game must be owned on Steam |
| Thunderstore | `thunderstore.io/c/<community>/` | None |
| mod.io | `mod.io/g/<slug>` | None to browse |
| GameBanana | `gamebanana.com/games/<id>` | None |
| PCGamingWiki | the game's wiki page | None |

A source row never opens a download or a file. It opens a page the player reads
in their own browser, under their own account. That is why the directory needs
no API key, no registration and no permission from anyone.

## Resolution

The identity of a game is its title plus whatever ids the store already gave us:
the Steam app id, the Epic catalog namespace, the GOG product id.

1. **Curated row.** A hand-checked entry in the table maps the game to each
   source's id. This is the only path that produces an exact page.
2. **Derived.** Used only where a site's slug is provably the slugified title.
   This is checked per source, not assumed: a guessed slug opens the wrong game,
   which is worse than a search.
3. **Search.** The fallback for every game the table has never seen. It always
   resolves, so no game is unsupported.

A wrong link is the only failure mode that matters here, so the table is data
that can be corrected without touching code, and a missing row degrades to
search instead of guessing.

Two checks behind that rule, made against the live sites:

- Nexus Mods ignores a keyword on its search page (`/search?gsearch=` renders an
  empty result), so the fallback is the games index, not a query. `riskofrain2`
  is a 404 while `riskofrain` is a different game: deriving the slug from a
  title is exactly the mistake this table exists to prevent.
- Thunderstore's communities page filters in the browser only, so it has no
  query URL either. Its community list is the fallback.

## The table

One row per game. Every field is optional and independent:

```json
{ "steam": "292030", "nexus": "witcher3", "thunderstore": null,
  "modio": null, "gamebanana": null, "pcgamingwiki": "The_Witcher_3:_Wild_Hunt" }
```

Adding a game is one row. It is not a support matrix and it is not required for
a source to work: only for that source to land on the exact page. The table
grows from what players actually open, not from a launch-day checklist.

## Where the rows appear

One card on the game page, next to the existing external links, driven by
`src/core/mod-sources.ts`. Every store's game page mounts the same card, so a
Steam game, an Epic game and a custom entry resolve through the same code.

The card is presentation only: no network call, no cache, no IPC. That keeps it
free on the store page and impossible to break a launch with.

## Install, later

Install stays a per-game commitment and lands only for a profile whose mods are
drop-in files:

| Step | What it needs |
|---|---|
| Stage | `<app data>/mods/<game>/staging/<mod>/` |
| Deploy | Hard link into the game folder, copy when the volume differs |
| Track | `deployed.json` records every placed path and the file it displaced |
| Undeploy | Runs before a store verify, update or uninstall, and again after |

Hard links are used because they cost no disk, need no administrator, and the
game cannot tell the file from a normal one. A symbolic link needs Developer
Mode; a user-mode virtual filesystem (Mod Organizer 2's approach) needs a DLL
injected into the game process, and that is not something this launcher does.

A profile is one record: the folders a mod may write into, the optional
load-order file, the loader the game needs, and its launch argument. A profile
with no loader and one folder covers every drop-in title.

Archive intake is the part that must not be improvised: no absolute path, no
`..`, no link entry, no reserved Windows name, and the resolved path must stay
under the staging root after canonicalising. A cap on entry count and unpacked
size stops a zip bomb.

## Not doing

- Injecting a filesystem hook into a game process.
- Scraping a download page, harvesting a CDN URL, or bypassing a download gate.
- Running an installer or script found inside a mod archive.
- Shipping mod files, a loader, or a mod list in the app bundle.
- Touching `appmanifest_*.acf` or a store's install record.
- Offering install for a title with kernel anti-cheat.

## Phases

Each phase is one commit with the check that covers it.

**1. Source card.** `src/core/mod-sources.ts` holds the table and the resolver;
the game page's link card shows every source, exact where the table has an id
and search everywhere else. Done when a Steam, an Epic and a GOG game each open
the right page, and a game with no row still opens a useful search.

**2. Steam page and custom games.** The same card on the Steam game page and on
a custom entry, so every library row can reach its sources.

**3. Table growth.** Rows for the games players open most, corrected from
reports. Data only.

**4. Install engine.** Staging, deploy, undeploy and the manifest, with tests,
behind a profile that has no loader. No UI yet.

**5. Install for one game.** The drop-a-zip panel for that profile, with the
store lifecycle hooks wired.

**6. Loaders and a second game.** BepInEx, SMAPI and script extenders arrive as
pinned packages with the launch argument the profile declares.

**7. Remote search.** Thunderstore and mod.io can be searched in place: both
answer without a key. Nexus stays a link until an application is registered.

## Files

| Path | Job |
|---|---|
| `src/core/mod-sources.ts` | Source table, resolver, per-source caveat |
| `src/features/mods/mods-card.ts` | Card mounted by a game page |
| `src-tauri/src/mods/profile.rs` | Per-game install profile (phase 4) |
| `src-tauri/src/mods/deploy.rs` | Deploy, undeploy, diff (phase 4) |
