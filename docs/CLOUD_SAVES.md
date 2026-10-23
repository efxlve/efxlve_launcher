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

The heuristics are still Windows-first. On Linux/macOS set the game's save
folder explicitly from Manage before backing it up. Proton prefixes
(`compatdata/<appid>/pfx/drive_c/users/steamuser/...`) are not scanned yet; that
is tracked below.

---

## 4. User flows

**Settings → Cloud**

- Enable cloud backup and choose Folder, WebDAV or Google Drive.
- Folder: path field, native folder picker, Test connection, Save.
- WebDAV: URL, username, password, Test, Save.
- Google Drive: Client ID/secret, Save, Test, Connect with Google.
- Auto-sync on game exit is a separate switch. With Folder selected it works
  with no account setup.

**Game Manage drawer**

- **Backup to Cloud** — creates a fresh local backup, uploads the archive and
  refreshes the list.
- **Restore** — downloads the selected archive and snapshots current saves
  first.
- **History** — timestamp, size and file count; newest first.
- **Delete / Delete all** — removes remote archives for that game.

Cloud links from the Manage drawer and the Cloud settings card now open the
**Cloud** settings section instead of Integrations.

---

## 5. Storage and safety

- Provider credentials live in
  `<config>/cloud_backup_settings.json` on the local machine. They are not sent
  anywhere except the selected provider.
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

1. **Native save discovery on Linux/macOS** — XDG data/config roots, macOS
   `~/Library/Application Support`, and Proton `compatdata` prefixes. Let the
   user confirm the detected folder once, then remember it.
2. **Retention and scheduled local backups** — keep the last N versions, run a
   daily local backup even with no provider, and prune old archives.
3. **Bulk actions** — “back up all installed games”, “restore the newest backup
   for every game”, with a progress list instead of one toast.
4. **Conflict detection** — compare local and remote timestamps and hashes
   before a restore; show “local is newer / remote is newer” and let the user
   choose. The pre-restore snapshot already makes the destructive case
   recoverable.
5. **Auto-sync feedback** — a background queue, per-game status, and a toast
   when an automatic backup fails. Today the failure is visible only in the
   manage row.
6. **Provider polish** — WebDAV digest auth and self-signed certificate opt-in,
   a Google Drive “test before connect” path, and a Folder “open in file
   manager” button.
7. **Secrets at rest** — OS keychain or an encrypted local vault; never log
   tokens.
8. **Migration** — old WebDAV archives stored under raw `::` names need a
   one-time folder rename or a legacy fallback in the listing.
9. **Real Linux/macOS validation** — save paths, restore targets, case-sensitive
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
  `cloud_backup_delete_remote`, `cloud_backup_delete_all_remote`

Google Drive auth:

- `cloud_backup_start_gdrive_auth`, `cloud_backup_disconnect_gdrive`

Generated command names and arguments are indexed in
[IPC_INDEX.md](./IPC_INDEX.md).
