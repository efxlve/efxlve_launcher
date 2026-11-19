# Mod support

The launcher installs, enables, disables and removes mods for games it already
installs and launches. It does not host downloads, it does not ship a mod loader,
and it never touches a game's store manifest.

Everything a store owns stays the store's: the launcher only adds files, records
what it added, and can take them back out.

## Layout

All state lives under `<app data>/mods/<game>/`:

| Path | Job |
|---|---|
| `staging/<mod id>/` | Unpacked mod files, exactly as they will appear in the game |
| `mods.json` | Installed mods: source, version, priority, enabled flag |
| `deployed.json` | Files currently placed in the game folder, and which mod owns each |
| `backup/<relative path>` | Game files a deploy displaced |

`mods.json` and `deployed.json` follow the JSON-store shape `upscalers/store.rs`
already uses: a `schema` number, sorted entries, and a temp-file rename on save.

The staging folder must be on the game's volume. A hard link cannot cross
volumes, so `deploy` checks the volume first and falls back to copying. The
active mode is recorded in `deployed.json` and shown in the panel, because copy
mode costs disk and takes longer.

## Deploy

`deploy` builds the desired file set from the enabled mods, lowest priority
first so a later mod wins a shared path, then applies the difference against
`deployed.json`:

1. An entry no longer wanted: delete the file, or move `backup/<rel>` back.
2. A new entry whose path is an existing game file: move that file to
   `backup/<rel>` first. The backup is never overwritten, so a second deploy
   cannot lose the original.
3. A new entry over an empty path: hard link from staging, or copy.

`undeploy` reverses every recorded entry. It is idempotent and safe to run
twice, because `deployed.json` is written before the first change and each step
is a compare-then-act.

Hard links are the default: no extra disk, no administrator rights, and the game
cannot tell the file from a normal one. A symbolic link needs Developer Mode or
elevation. A user-mode virtual filesystem (what Mod Organizer 2 does) requires
injecting a DLL into the game process; that is not something this launcher will
do, and it is the reason hard links are used instead of a prettier abstraction.

## Game profiles

`mods/profile.rs` holds one record per supported game. Adding a game is data,
not a new deploy path:

| Field | Job |
|---|---|
| `id` | Store-independent key used for the state folder |
| `roots` | Folders a mod may write into, relative to the install |
| `wrap` | Archive folder that is the mod root, when the archive ships one |
| `settings_file` | Load-order or enable file to rewrite, with its base folder |
| `loader` | Loader a profile needs before mods work (`none`, `bepinex`, `smapi`, `skse`) |
| `launch_args` | Arguments or environment the loader needs |
| `anticheat` | Title refuses mods; the panel says so and deploy stops |

A profile with `loader: none` and one `roots` entry covers every drop-in title.
That is the whole of phase 1.

## Archive intake

Accepted: a `.zip` file, or a folder the user drops. `.7z` and `.rar` are
refused with the instruction to unpack first; adding a decoder is a decision for
later, not a silent failure.

Every entry is checked before anything is written:

- No absolute path, no `..`, no drive letter, no leading separator.
- No symbolic link or hard link entry.
- No reserved Windows device name (`CON`, `NUL`, `COM1`, ...), no trailing dot
  or space on a component.
- The resolved path must stay under the staging root after canonicalising.
- A cap on entry count and total unpacked size, so a zip bomb cannot fill the
  disk.

The archive root is resolved as a whole: when every entry shares one top folder
and the profile expects files at the root, that folder is dropped. Mixed roots
are staged as-is and the panel shows the resulting tree before the user commits.

Mods run inside the game. The panel names the files that will be placed and
flags executables and DLLs in the archive, but it does not scan them and does
not run installers, `.bat` files or setup programs found inside an archive.

## Lifecycle hooks

A deployed mod is not safe from the store. Epic, GOG and Steam verify against
their own manifest and rewrite any file that differs, which leaves a mod half
erased and a save half broken.

So every store operation on a modded game calls `undeploy` first and `deploy`
after:

- Install, update, repair and verify, including the launcher's own Manage
  actions.
- Uninstall: `undeploy` runs before the store removes the folder, so the
  launcher's backups are cleared rather than orphaned.
- A running game blocks both directions; the panel reports it instead of
  retrying.

## Sources

Each source only produces a folder to stage. Deploy is identical for all three.

1. **Local.** A zip or folder the user picked. No account, no terms, no network.
2. **Thunderstore.** Public API, no key. A package's `manifest.json` carries its
   dependencies, so the resolver can install a mod and what it needs.
3. **Nexus Mods.** A registered application with SSO. API download links are
   Premium-only; a free account goes through the site's `nxm://` link, which is
   the path every mod manager uses. The launcher never scrapes a download page,
   never harvests a CDN URL and never ships a personal API key.

Nexus stays an isolated module with its own switch, so a policy change costs a
toggle rather than a rewrite. `store_host.rs` and `store_extension.js` stay out
of it: reading store pages for mod data is scraping.

## Not doing

- Injecting a filesystem hook into a game process.
- Downloading from a site that forbids it, or bypassing a download gate.
- Running an installer or script that an archive contains.
- Modding a title with kernel anti-cheat, or any title whose profile says so.
- Shipping mod files, a loader, or a mod list inside the app bundle.
- Touching `appmanifest_*.acf` or a store's install record.

## Phases

Each phase is one commit with the check that covers it.

**1. Engine and the first game.** `mods/{archive,manifest,profile,deploy}.rs`
plus tests, one profile with `loader: none`, and a Mods panel in the game drawer
that takes a zip or a drop, lists mods, enables, disables and removes them.
Done when a real mod deploys, the game loads it, remove restores the folder, and
`cargo test` covers deploy, undeploy and a refused archive.

**2. Conflicts and order.** Two mods on one path are reported with the winning
mod, and the panel reorders priority. Profiles with a settings file write it.
Done when a shared path moves owner after a reorder and the game reads the new
order.

**3. Lifecycle.** `undeploy` runs before verify, update and uninstall, and
`deploy` runs after, from every store path. Done when a verify with a mod
deployed leaves the game playable and the mod still active.

**4. Second game.** A profile with a different root and a loader proves the
split. Done when the first game needs no deploy change.

**5. Loaders.** BepInEx, SMAPI and script extenders install as a pinned
package, with the launch argument or environment the profile declares.

**6. Thunderstore.** Search, install with dependencies, update check.

**7. Nexus.** Registration, SSO, `nxm://` intake, free-account path.

## Files

| Path | Job |
|---|---|
| `src-tauri/src/mods/mod.rs` | Exports |
| `src-tauri/src/mods/archive.rs` | Safe unpack into staging |
| `src-tauri/src/mods/manifest.rs` | `mods.json` and `deployed.json` |
| `src-tauri/src/mods/profile.rs` | Per-game records |
| `src-tauri/src/mods/deploy.rs` | Deploy, undeploy, diff |
| `src-tauri/src/mods/commands.rs` | IPC surface |
| `src/features/mods/mods-panel.ts` | Panel mounted by the game drawer |
| `src/mods.ts` | Typed command wrappers |
