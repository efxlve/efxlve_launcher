# CLOUD_SAVES.md — Save Backup Architecture and Roadmap

Current behavior of the local and cloud save backup system, plus the open work.
The user-facing Google Drive walkthrough is in
[GOOGLE_DRIVE_SETUP_GUIDE.md](./GOOGLE_DRIVE_SETUP_GUIDE.md); this document owns
the architecture and the roadmap.

---

## 1. What a backup is

Two layers share one format:

- **Local backup** — `<config>/backups/<safe-key>/<timestamp>/`
  - `data/` is a raw copy of the game's save folder.
  - `backup_info.json` stores id, app key, timestamp, size, file count and the
    original save path.
  - `<config>` is `%USERPROFILE%\.config\legendary` on Windows and
    `~/.config/legendary` on Linux/macOS.
- **Cloud archive** — the local backup directory packed into
  `<timestamp>.tar.gz`, then uploaded with its SHA-256 and file count.

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
4. Heuristic detection from the game title and install folder.

Restore resolves a destination the same way: custom path, then the original
path with `Documents`, `Saved Games` or `AppData` rewritten under the current
home, then the installed manifest/heuristics. `HOME` is used on Linux/macOS when
`USERPROFILE` is absent.

Detection is platform-aware (`detect_save_path` in `legendary/backup.rs`):

| Platform | Roots, in order |
|---|---|
| Windows | Saved Games, Documents\My Games, Documents, AppData\LocalLow, `%LOCALAPPDATA%`, `%APPDATA%`, install folder |
| Linux | `$XDG_DATA_HOME` (default `~/.local/share`), `~/.config/unity3d`, `~/Documents`, `~/Saved Games`, then `AppData/Local`, `AppData/LocalLow`, `Documents` and `Saved Games` inside each prefix under `~/Games/Efxlve/Prefixes` |
| macOS | the same XDG/Documents roots, `~/Library/Application Support`, then the prefixes above |

The prefix pass reads both a plain Wine tree and Proton's `pfx/drive_c` layout.
Steam's own `compatdata` tree is not scanned: the app id is not known here, and
scanning every prefix would cost more than it is worth. A game launched through
Steam's Proton still needs its folder picked once in Manage.

---

## 4. User flows

**Settings → Cloud**

- Enable cloud backup and choose Folder, Google Drive, WebDAV or rclone.
- Folder: path field, native folder picker, Test connection, Save.
- WebDAV: URL, username, password, Test, Save.
- Google Drive: Client ID/secret, Save, Test, Connect with Google.
- rclone: remote path (`remote:folder`), Test, Save; rclone itself is installed
  and configured by the user.
- Auto-sync on game exit is a separate switch. With Folder selected it works
  with no account setup.
- **Daily local backup** creates one local backup per installed game at most
  once a day while the launcher is open, even with no cloud provider. It shares
  the progress row with the bulk actions.
- **Keep the last N versions** prunes older local backups and cloud archives
  after a successful backup. 0 (the default) keeps every backup; pre-restore
  snapshots are never pruned.
- **Back up all installed games** walks every installed Epic, GOG, Amazon and
  custom game, creates a local backup and uploads it. The row shows progress
  while it runs and reports the failure count at the end; games without a save
  folder are skipped. **Restore newest** does the same walk and restores each
  game's newest cloud archive after a confirmation; every restore snapshots the
  current local saves first.

**Game Manage drawer**

- **Backup to Cloud** — creates a fresh local backup, uploads the archive and
  refreshes the list.
- **Restore** — downloads the selected archive and snapshots current saves
  first. When the newest local backup is newer than the selected cloud archive,
  a confirmation explains which is newer before overwriting anything.
- **History** — timestamp, size and file count; newest first.
- **Delete / Delete all** — removes remote archives for that game.

Cloud links from the Manage drawer and the Cloud settings card now open the
**Cloud** settings section instead of Integrations.

### Provider setup

Every provider is configured in **Settings → Cloud**, works on Windows, Linux and
macOS, and stores its settings only on the local machine. The first three fields
are optional: the launcher creates the `efxlve_saves` folder when it is missing.

#### Folder provider

Use this when a sync client already handles the upload: OneDrive, Dropbox,
Google Drive for desktop, iCloud Drive, Nextcloud desktop, Syncthing or a NAS
share mounted as a drive.

1. Install and sign in to the sync client, and let it finish its first sync.
2. Create a folder for the launcher, for example `EfxlveSaves` inside OneDrive,
   Dropbox or `~/Nextcloud`.
3. Settings → Cloud → enable the feature → choose **Folder** → **Choose
   folder** → **Save** → **Test Connection**.
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
   **Save**.

Self-signed certificates are not accepted yet; use a valid certificate or the
Folder provider behind a sync client.

#### Google Drive

Google Drive uses an OAuth Desktop client created in the user's own Google
Cloud project, and stores archives in the hidden `appDataFolder`. The
step-by-step guide is in
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
3. In Settings → Cloud choose **rclone**, press **List remotes** and pick one,
   then append a folder, for example `gdrive:efxlve_saves` or
   `s3:my-bucket/efxlve_saves`.
4. **Test Connection** creates the folder when needed; **Save** stores the path.

The launcher runs the same `rclone` binary that `rclone config` uses, so
existing credentials and encrypted configs keep working. If rclone is not on
`PATH`, the launcher also checks `/usr/local/bin`, `/opt/homebrew/bin`,
`/opt/local/bin`, `/snap/bin` and `~/.local/bin`; restart the app after
installing it on Windows.

---

## 5. Storage and safety

- Provider credentials live in
  `<config>/cloud_backup_settings.json` on the local machine. They are not sent
  anywhere except the selected provider. With rclone the launcher stores only
  the `remote:folder` path; the credentials stay in the user's own rclone
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
- Credentials are currently stored as plain JSON. Moving them to the OS
  keychain is open work.

---

## 6. Open work

Ordered by user value:

1. **Confirm the detected save folder** — discovery now covers the XDG roots,
   macOS `~/Library/Application Support` and the launcher's Wine/Proton
   prefixes; a detected path the user can confirm once and then reuse would make
   the result explicit. Steam `compatdata` scanning is a separate gap.
2. **Conflict detection** — the timestamp comparison before a restore is in
   place; comparing hashes before the overwrite is still open.
3. **Provider polish** — WebDAV digest auth and self-signed certificate opt-in,
   and a Google Drive “test before connect” path.
4. **Secrets at rest** — OS keychain or an encrypted local vault; never log
   tokens.
5. **Remote migration** — local folders created before `backup_key` are moved to
   the safe key automatically; WebDAV/Folder archives stored under raw `::`
   names still need a one-time remote rename or a legacy fallback in the listing.
6. **Real Linux/macOS validation** — save paths, restore targets, case-sensitive
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
  `cloud_backup_open_folder`, `cloud_backup_rclone_remotes`

Google Drive auth:

- `cloud_backup_start_gdrive_auth`, `cloud_backup_disconnect_gdrive`

Generated command names and arguments are indexed in
[IPC_INDEX.md](./IPC_INDEX.md).
