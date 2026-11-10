# Cloud Saves — start here

This page is the **short version**. You do not need to understand the architecture to use cloud saves. Pick the guide that matches the storage you already have:

| I already use… | Read this | Difficulty |
|---|---|---|
| OneDrive, Dropbox, Google Drive desktop, iCloud, Nextcloud, Syncthing or a NAS | [Folder guide](CLOUD_FOLDER_GUIDE.md) | Easiest — no account inside the launcher |
| Google Drive directly | [Google Drive guide](GOOGLE_DRIVE_SETUP_GUIDE.md) | Medium — one free OAuth client |
| Nextcloud, ownCloud, Box, Hetzner Storage Box or any WebDAV server | [WebDAV guide](CLOUD_WEBDAV_GUIDE.md) | Easy if you have the address |
| S3, Backblaze B2, OneDrive, Dropbox, Mega, pCloud or another rclone service | [rclone guide](CLOUD_RCLONE_GUIDE.md) | Medium — install rclone once |

## The one-minute version

1. **Settings → Cloud Saves & Backup** → turn on **Enable Cloud Save Backup**.
2. Choose the provider that matches your guide.
3. Fill the two or three fields the guide names.
4. Press **Test Connection**, then **Save**.
5. Open a game → **Manage** → **Backup to Cloud**.

Restoring is the same page: **Manage** → **Sync Cloud** → **Restore**.

## What gets backed up?

- The game's save folder, packed into one archive (`.tar.gz` for the cloud, `.efxsave` when you export it).
- A small metadata file with the timestamp, size, file count and a SHA-256 of the save tree.
- The launcher's own profile (custom games, collections, playtime, achievements, notes, themes) when you use **Launcher data** on the same page.

A save archive is portable: **Export save** writes a `.efxsave` you can copy to a
USB drive or another PC, and **Import save** adds it to the same game under any
store before restoring it.

It does **not** back up the game itself, screenshots, videos or your account passwords. Those stay where they are.

Before a restore overwrites anything, the launcher snapshots the current saves as `pre-restore-…`, so a wrong restore can be undone.

A save folder is found in this order: an explicit custom path, the store's own install record, Ubisoft's product layout, the bundled Ludusavi index, then the generic folder scans. The Ludusavi index covers more than 11,000 titles and carries only concrete `save` paths, so a wildcard entry can never widen a backup to a whole user folder. When the save tree is byte-identical to the last successful upload, the next automatic upload keeps the existing cloud archive instead of packing and sending another copy.

## Technical notes

The sections below describe the implementation and the roadmap for contributors. They are not required reading for setup.

---

## 1. What a backup is

Two layers share one format:

- **Local backup** — `<local backup root>/<safe-key>/<timestamp>/`
  - `data/` is a raw copy of the game's save folder.
  - The root is `<config>/backups` unless **Backup location** on the Cloud
    settings page points it somewhere else, such as another drive.
  - A new copy is staged in a dot-prefixed folder and only renamed into place
    after `backup_info.json` is written, so a crash cannot leave a half copy in
    the list. Two backups that start in the same second get a `-1`, `-2` suffix.
    Imports use the same staging step.
  - `backup_info.json` stores id, app key, timestamp, size, file count, the
    original save path, the recognized logical root (`Documents`, `SavedGames`,
    `LocalAppData`, `RoamingAppData`, `Home`) and the path below that root.
    A restore on another PC resolves the same root under its own profile; an
    older archive without those fields falls back to the absolute path and the
    detection scans.
  - `<config>` is `%USERPROFILE%\.config\legendary` on Windows and
    `~/.config/legendary` on Linux/macOS.
- **Cloud archive** — the local backup directory packed into
  `<timestamp>.tar.gz`, then uploaded with its SHA-256 and file count.
- **Upload marker** — `<config>/backups/<safe-key>/.last-upload.json` records
  the last uploaded id and save-tree hash. An automatic upload whose current
  hash matches skips both the local archive and the network, but only while the
  provider still lists that archive.
- **Encrypted profile** — a `.efxprofile` with a non-empty password starts with
  `EFXENC1`, a scrypt salt and an AES-256-GCM nonce. The importer detects the
  magic and asks for the password; a plain `.efxprofile` from an older build
  still imports without one.

`<safe-key>` replaces `::` with `__` and removes characters that are invalid in
a Windows path segment (`backup_key` in `legendary/backup.rs`). Epic names pass
through unchanged; `gog::123` becomes `gog__123`. This was a real bug: every
non-Epic local backup failed on Windows before the fix.

A restore is deliberately two-step:

1. Download and unpack the remote archive into a temporary local backup.
2. Snapshot the **current** save folder as `pre-restore-<timestamp>` before
   copying anything over it. If the snapshot cannot be written, the restore is
   refused. The snapshot appears in the normal local backup list, so a wrong
   restore can be undone without another provider.

A cloud restore first downloads the archive and shows its file list, target
folder, size and date without touching the saves. The confirmation is a
one-use token valid for five minutes; applying it re-hashes the local save
tree and refuses when the game wrote new saves while the preview was open.
Closing the preview drops the token and the temporary archive.

A local restore uses the same preview from the backup folder already on disk,
shows the target folder the logical roots resolve to, and refuses while the
game is running or when the save tree changed after the preview. The preview
also re-hashes the backup against the checksum recorded when it was created, so
a damaged copy is refused instead of restored. Neither path can overwrite saves
on a single stray click.

---

## 2. Providers

| Provider | Where it writes | Setup |
|---|---|---|
| **Folder** | `<chosen folder>/efxlve_saves/<safe-key>/<timestamp>.tar.gz` | Choose a folder that OneDrive, Dropbox, Syncthing or a NAS client already syncs. No OAuth, account or API key. |
| **WebDAV** | `<base url>/efxlve_saves/<safe-key>/` | Nextcloud, ownCloud, a NAS WebDAV share. Basic auth. |
| **Google Drive** | Hidden `appDataFolder` | Bring-your-own OAuth desktop client. See the setup guide. |
| **rclone** | `<remote>:<folder>/efxlve_saves/<safe-key>/` | Any remote already configured in rclone (S3, B2, Dropbox, OneDrive, Mega, SFTP, ...). No OAuth code in the launcher; rclone owns the credentials. |
| **None** | Local backups only | The restore snapshot and manual local backups still work. |

Folder provider rules:

- The chosen folder must be writable; **Test connection** creates
  `efxlve_saves`, writes and removes a probe file.
- **Detected on this PC** buttons list sync roots that already exist, without
  reading anything inside them: OneDrive (including a work account and another
  drive), Dropbox, Google Drive, iCloud Drive, Nextcloud and MEGA. One click
  saves the path and runs the same test; no manual typing is needed.
- A downloaded/deleted archive must resolve inside `efxlve_saves`; absolute
  paths and `..` components are rejected before any file operation.
- The folder is a plain directory. The launcher never talks to the cloud
  client; it only writes files and lets the client sync them.

WebDAV notes:

- Remote ids are absolute URLs; Nextcloud's `/remote.php/dav/files/<user>/...`
  hrefs are resolved with `Url::join`, so the base path is not duplicated.
- Uploads and listings use the same safe key, so `gog::123` stays one folder.

Google Drive notes:

- Only the `drive.appdata` scope is requested.
- Client ID/secret and refresh token stay in the local settings file.
- The appDataFolder is hidden from the normal Drive root; the setup guide shows
  how to inspect it.

---

## 3. Save path resolution

`create_backup` resolves a save folder in this order:

1. A save path passed explicitly by the caller.
2. The game's local setting (`custom_save_path`), editable in the Manage drawer.
3. The installed manifest's `save_path`.
4. For `ubisoft::<product>` keys, the Ubisoft resolver in
   `companion/ubi_direct/saves.rs` (see below).
5. Heuristic detection from the game title and install folder.

Steam titles are resolved from `userdata/<account>/<appid>/remote` first: the
newest non-empty account folder wins, so a save the Steam client wrote is found
before a title guess.

Ubisoft titles do not follow the Epic layout. The resolver checks, in order:
the direct install's `<install>\Saves` folder written by the compatibility shim,
the official client's `savegames\<account>\<uplay_id>` (then `<product_id>`)
under `%LOCALAPPDATA%\Ubisoft Game Launcher` and the launcher folder in Program
Files, and `Documents\My Games\<title>` (then `Documents\Ubisoft\<title>`). A
folder that already holds files wins over an empty one, so progress recorded by
the official client is backed up before the shim folder has ever been written.
The Manage panel shows the same resolved folder with an Open button.

Restore resolves a destination the same way: custom path, then the original
path with `Documents`, `Saved Games` or `AppData` rewritten under the current
home, then the installed manifest/heuristics. `HOME` is used on Linux/macOS when
`USERPROFILE` is absent.

Detection is platform-aware (`detect_save_path` in `legendary/backup.rs`):

| Platform | Roots, in order |
|---|---|
| Windows | Saved Games, Documents\My Games, Documents, AppData\LocalLow, `%LOCALAPPDATA%`, `%APPDATA%`, install folder |
| Linux | `$XDG_DATA_HOME` (default `~/.local/share`), `~/.config/unity3d`, `~/Documents`, `~/Saved Games`, then `AppData/Local`, `AppData/LocalLow`, `Documents` and `Saved Games` inside each prefix under `~/Games/Efxlve/Prefixes`, then the same folders inside every `steamapps/compatdata/*/pfx` prefix |
| macOS | the same XDG/Documents roots, `~/Library/Application Support`, then the prefixes above |

The prefix pass reads both a plain Wine tree and Proton's `pfx/drive_c` layout.
Steam's own `compatdata` tree is the last resort: the app id is Steam's, not the
launcher's, so every Proton prefix in every Steam library is searched only after
the cheaper roots miss.

---

## 4. User flows

**Settings → Cloud Saves & Backup**

- Enable cloud backup and choose Folder, Google Drive, WebDAV or rclone.
- Folder: path field, native folder picker, Test connection, Save.
- WebDAV: URL, username, password, Test, Save.
- Google Drive: Client ID/secret, Save, Test, Connect with Google.
- rclone: remote path (`remote:folder`), Test, Save; rclone itself is installed
  and configured by the user.
- **Test Connection** stores the time and result on the device. The cloud card
  on the same page shows the last pass or failure, so "Configured" never hides
  an untested provider; changing the destination clears the old result.
- Auto-sync on game exit is a separate switch. It backs up the changed save
  locally, and uploads it when a provider is configured; it works with no
  account setup. The per-game **Include in automatic backups** switch opts a
  game out of the exit backup, the daily run and both bulk buttons.
- **Local backups** is the first group on the page. **Back up all games
  locally** walks every installed game from a supported store (Epic, GOG,
  Amazon, Steam, Ubisoft, EA, Xbox, Battle.net and custom) and writes a local
  archive with no provider configured; **Open backup folder** opens the root
  that holds them. **Backup location** moves that root to another drive; an
  empty field restores `<config>/backups`.
- **Daily local backup** creates one local backup per installed game at most
  once a day while the launcher is open, even with no cloud provider. A game
  whose save tree already matches its newest local backup is skipped, so the
  daily pass does not fill the disk with identical copies. It shares the
  progress row with the bulk actions.
- **Keep the last N versions** prunes older local backups and cloud archives
  after a successful backup. 0 (the default) keeps every backup; pre-restore
  snapshots are never pruned. A per-game value in Manage → Save wins over this
  shared number.
- **Back up all installed games** walks every installed game from a supported
  store, creates a local backup and uploads it. The row shows progress while it
  runs and reports the failure count at the end; games without a save folder are
  skipped. **Restore newest** does the same walk and restores each game's newest
  cloud archive after a confirmation; every restore snapshots the current local
  saves first.

**Game Manage drawer**

- **Backup to Cloud** — creates a fresh local backup, uploads the archive and
  refreshes the list.
- **Export save** — writes the selected local backup as a portable `.efxsave`
  file to a folder you pick. The file carries the save tree and its metadata.
  A password is optional and encrypts the file with AES-256-GCM; it is typed
  twice, and a mismatch is refused before anything is written. The archive is
  staged beside the target and renamed when complete; exporting the same backup
  twice adds `(1)`, `(2)` instead of overwriting.
- **Import save** — adds a `.efxsave` from any store to the open game. An
  encrypted file asks for its password. It shows up in the history and
  **Restore** applies it to this game's save folder, so a Steam save can
  continue in the GOG install of the same title. The preview names the store the
  archive came from.
- **Include in automatic backups** — a per-game switch; when it is off, the exit
  backup, the daily run and both bulk buttons skip the game while manual backups
  still work.
- **Keep the last versions** — a per-game number for local and cloud archives;
  0 uses the shared Cloud setting.
- **Restore** — downloads the selected archive and snapshots current saves
  first. When the newest local backup is newer than the selected cloud archive,
  a confirmation explains which is newer before overwriting anything. Both sides
  carry a save-tree SHA-256, so an identical tree skips the warning even when the
  timestamps differ.
- **History** — timestamp, size and file count; newest first. The shield button
  next to an archive downloads it, validates `backup_info.json`, and re-hashes
  the save tree against the checksum recorded at backup time; the row then shows
  **Intact**, **Damaged** or **No hash** (an older archive without a checksum).
- **Delete / Delete all** — removes remote archives for that game.

**Backups page**

The **Backups** section at the bottom of the page lists every installed game
with its newest local archive, a stale marker after seven days, and the include
switch. Each row can back up, export or restore in place, and an imported
archive that belongs to a game that is not installed stays listed under the
title it was exported from. A search field and All / Backed up / Missing /
Stale filters keep a large library manageable; the shield button re-hashes an
archive against the SHA-256 recorded at backup time and reports a damaged copy
before a restore would. The list is local-only: cloud archives are listed on
each game's **Manage → Save** page.

**Export everything** writes a migration folder: the launcher profile plus every
game's newest save. **Import from a folder** restores those saves and the
profile on the new PC, then restarts the launcher. The same optional password
protects both the profile and the saves.

Cloud links from the Manage drawer and the settings card open the
**Cloud Saves & Backup** section instead of Integrations.

### Provider setup

Every provider is configured in **Settings → Cloud Saves & Backup**, works on Windows, Linux and
macOS, and stores its settings only on the local machine. The first three fields
are optional: the launcher creates the `efxlve_saves` folder when it is missing.

#### Folder provider

Use this when a sync client already handles the upload: OneDrive, Dropbox,
Google Drive for desktop, iCloud Drive, Nextcloud desktop, Syncthing or a NAS
share mounted as a drive.

1. Install and sign in to the sync client, and let it finish its first sync.
2. Settings → Cloud Saves & Backup → enable the feature → choose **Folder**. Press the
   **Detected on this PC** button for the client, or choose a folder by hand
   (for example `EfxlveSaves` inside OneDrive).
3. **Test Connection** creates `efxlve_saves` when the folder is writable, then
   **Save**.
4. Archives appear as `<folder>/efxlve_saves/<game-key>/<timestamp>.tar.gz` and
   the sync client uploads them like any other file. The launcher never talks to
   the cloud directly in this mode.

Typical locations: `%USERPROFILE%\OneDrive\EfxlveSaves` on Windows,
`~/Library/CloudStorage/...` or `~/Dropbox/EfxlveSaves` on macOS, and
`~/Nextcloud/EfxlveSaves` or a mounted share on Linux.

#### WebDAV

Works with Nextcloud, ownCloud, Box, Hetzner Storage Box and any other WebDAV
server.

1. Enter the full collection URL, including the base path. Nextcloud:
   `https://cloud.example.com/remote.php/dav/files/<user>/`.
2. Use an **app password** rather than the account password when the server
   offers one.
3. **Test Connection** creates `efxlve_saves` and checks write access, then
   **Save**. A legacy collection stored under a raw `::` name is moved to the
   safe key with `MOVE` on the first listing or upload; an existing target is
   never overwritten.

Self-signed certificates are refused by default; the **Allow a self-signed
certificate** checkbox turns verification off for that one provider. Use it only
for a server you control. Basic and digest authentication are supported; an app
password is still preferable when the server offers one.

#### Google Drive

Google Drive uses an OAuth Desktop client created in the user's own Google
Cloud project, and stores archives in the hidden `appDataFolder`. **Test
Connection** checks the client before the browser opens, so a wrong client ID is
reported without a failed sign-in. The step-by-step guide is in
[GOOGLE_DRIVE_SETUP_GUIDE.md](./GOOGLE_DRIVE_SETUP_GUIDE.md), and the same steps
are available from the **Setup Guide** button in the Cloud settings card.

#### rclone

[rclone](https://rclone.org/) already speaks to 70+ storage services (S3 and any
S3-compatible store, Backblaze B2, Dropbox, OneDrive, Mega, pCloud, Box, SFTP,
WebDAV and more), so one provider covers services the launcher does not integrate
directly.

1. Install rclone: `winget install Rclone.Rclone` or `scoop install rclone` on
   Windows, `brew install rclone` on macOS, or the package from
   <https://rclone.org/downloads/> on Linux.
2. Configure the remote once with `rclone config` and check it with
   `rclone lsd <remote>:`.
3. In Settings → Cloud Saves & Backup choose **rclone**, press **List remotes** and pick one,
   then append a folder, for example `gdrive:efxlve_saves` or
   `s3:my-bucket/efxlve_saves`.
4. **Test Connection** creates the folder when needed; **Save** stores the path.

The launcher runs the same `rclone` binary that `rclone config` uses, so
existing credentials and encrypted configs keep working. If rclone is not on
`PATH`, the launcher also checks `/usr/local/bin`, `/opt/homebrew/bin`,
`/opt/local/bin`, `/snap/bin` and `~/.local/bin`; restart the app after
installing it on Windows.

#### Launcher profile (custom games, achievements, themes)

Save archives cover game saves; the launcher's own data travels in a separate
`.efxprofile` archive. **Settings → Cloud Saves & Backup → Launcher data** has:

- **Export to file** — pick a folder; the archive is written as
  `efxlve_profile_<timestamp>.efxprofile`. Move it with a USB drive or another
  cloud client.
- **Import from file** — pick an archive, confirm, and the launcher restarts with
  the restored data.
- **Upload to cloud / Restore from cloud** — uses the same Folder, WebDAV,
  Google Drive or rclone provider as save backups. The archive is stored under
  the reserved `__efxlve_profile__` key, not as a game, and the newest five
  versions are kept.
- **Upload launcher data daily** uploads the profile at most once a day while the
  launcher is open, so the newest archive is ready after a format.

The archive contains custom games, collections, playtime, Epic/GOG/Steam
achievement caches, notes and their images, deleted-note recovery copies,
skipped library entries, custom themes, browser bookmarks and the portable
launcher settings. It does **not** contain passwords, OAuth tokens, Steam
sessions, API keys, Discord webhooks or absolute install/screenshot paths.
Those stay on the machine and are re-entered after a format; the provider
settings are excluded for the same reason.

Every import writes a safety archive to
`<config>/profile_backups/pre_restore_<timestamp>.efxprofile` before copying
anything, so a wrong import can be rolled back. The archive itself is not
encrypted; it relies on the provider's access control, so keep the cloud account
and the export file private. After a format, install the launcher, configure the
same provider under Settings → Cloud Saves & Backup, and press **Restore from cloud**: the
newest profile is shown with its date. The launcher cannot restore itself before
a provider is configured because the credentials are deliberately not in the
profile.

---

## 5. Storage and safety

- Provider credentials are sealed by the OS store: Windows DPAPI
  (`cloud_secrets.bin` in the config folder), macOS Keychain through `security`,
  or Linux Secret Service through `secret-tool`. The settings JSON keeps only
  non-secret fields. If the platform store is unavailable the value falls back
  to the JSON file instead of being lost. Secrets are not sent anywhere except
  the selected provider. With rclone the launcher stores only the
  `remote:folder` path; the credentials stay in the user's own rclone
  configuration.
- rclone paths and ids are validated against the configured base path before a
  download or delete, so a tampered id cannot reach another remote folder.
- Folder provider paths are validated against the provider root; WebDAV and
  Google Drive ids come from their own listings.
- Archives carry a SHA-256 and file count in the local metadata; the folder
  provider cannot verify a remote archive without unpacking, so it reports the
  size only.
- A failed restore snapshot aborts the restore. A failed upload leaves the local
  backup in place.

---

## 6. Open work

- **Real Linux/macOS validation** — save paths, restore targets, case-sensitive
  paths, and writable permissions.

---

## 7. Commands

Local backup:

- `epic_backup_save`, `epic_list_backups`, `epic_restore_backup`,
  `epic_delete_backup`, `epic_open_backup_folder`

Cloud:

- `cloud_backup_get_settings`, `cloud_backup_save_settings`,
  `cloud_backup_test_connection`, `cloud_backup_upload_game`,
  `cloud_backup_list_game`, `cloud_backup_download_game`,
  `cloud_backup_delete_remote`, `cloud_backup_delete_all_remote`,
  `cloud_backup_open_folder`, `cloud_backup_suggest_folders`,
  `cloud_backup_rclone_remotes`, `cloud_backup_remote_hash`,
  `cloud_backup_verify_archive`

Google Drive auth:

- `cloud_backup_start_gdrive_auth`, `cloud_backup_disconnect_gdrive`

Launcher profile:

- `profile_export`, `profile_import`, `profile_cloud_upload`,
  `profile_cloud_list`, `profile_cloud_restore`

Generated command names and arguments are indexed in
[IPC_INDEX.md](./IPC_INDEX.md).
