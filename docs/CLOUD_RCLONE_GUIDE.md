# Cloud Saves with rclone (S3, B2, Dropbox, OneDrive, Mega…)

**Use this if:** your storage is not one of the built-in providers, or you want one tool for several services.

rclone is a free command-line program that connects to 70+ storage services. Efxlve does **not** bundle it: you install rclone once, configure the remote once, and the launcher reuses that configuration.

---

## What you need

- A computer where you can install rclone.
- The login details for the storage service (for example an S3 key, a Dropbox account, or a Backblaze B2 bucket).
- About 10 minutes the first time.

---

## Step 1 — Install rclone

### Windows

Open PowerShell and run one of:

```powershell
winget install Rclone.Rclone
```

or, if you use Scoop:

```powershell
scoop install rclone
```

Close and reopen the launcher after installing so it sees the new `PATH`.

### macOS

```bash
brew install rclone
```

### Linux

Use your distribution's package, or the official installer:

```bash
sudo apt install rclone        # Debian/Ubuntu
sudo dnf install rclone        # Fedora
```

Download page: <https://rclone.org/downloads/>

Check it works:

```bash
rclone version
```

---

## Step 2 — Create a remote once

Run:

```bash
rclone config
```

You will see a menu. The short version:

1. Type `n` for **New remote**.
2. Give it a name with no spaces, for example `gdrive`, `onedrive`, `b2` or `s3`.
3. Choose the storage type from the list.
4. Answer the questions for that provider. For OAuth services, rclone opens a browser once.
5. Accept the defaults when you are unsure.
6. When asked **Keep this remote?**, answer `y`.
7. Type `q` to quit.

Test the remote:

```bash
rclone lsd gdrive:
```

Replace `gdrive` with your remote name. You should see folders, or nothing if the account is empty. No error means it works.

Where the configuration lives:

- Windows: `%APPDATA%\rclone\rclone.conf`
- macOS/Linux: `~/.config/rclone/rclone.conf`

Keep that file private; it contains access tokens.

---

## Step 3 — Prepare a folder

You can let the launcher create it, or make it yourself:

```bash
rclone mkdir gdrive:efxlve_saves
```

Examples of destinations:

| Service | Remote path to enter in Efxlve |
|---|---|
| Google Drive | `gdrive:efxlve_saves` |
| OneDrive | `onedrive:Saves/Efxlve` |
| Dropbox | `dropbox:EfxlveSaves` |
| Backblaze B2 | `b2:my-bucket/efxlve_saves` |
| Amazon S3 | `s3:my-bucket/efxlve_saves` |
| Mega | `mega:EfxlveSaves` |
| pCloud | `pcloud:EfxlveSaves` |

The part before the colon must match the remote name from `rclone config`.

---

## Step 4 — Enter it in Efxlve

1. Open **Settings → Cloud**.
2. Turn on **Enable Cloud Save Backup**.
3. Choose **rclone**.
4. Click **List remotes**.
   - Your configured remotes appear as buttons, for example `gdrive:`.
   - If the list is empty, rclone is not installed or has no remote yet.
5. Click a remote, then edit the path after it. For example `gdrive:` becomes `gdrive:efxlve_saves`.
6. Click **Test Connection**.
7. Click **Save**.

The launcher runs the same `rclone` binary as your terminal. If rclone is installed in a non-standard place, put it on `PATH` or install it in one of these folders:

- `/usr/local/bin`
- `/opt/homebrew/bin`
- `/opt/local/bin`
- `/snap/bin`
- `~/.local/bin`

---

## Step 5 — Back up and restore

1. Open a game → **Manage**.
2. Click **Backup to Cloud**.
3. Wait for the upload. The archive path is `<remote>:<folder>/efxlve_saves/<game-key>/<timestamp>.tar.gz`.

On a new PC:

1. Install rclone and create **the same remote** (or copy `rclone.conf` from the old PC).
2. Configure Efxlve with the same remote path.
3. Open the game → **Manage** → **Sync Cloud** → **Restore**.

---

## Common errors

| Message | Meaning | Fix |
|---|---|---|
| `rclone is not installed` | The launcher cannot find the binary | Install rclone, or add its folder to `PATH`, then restart the launcher |
| `directory not found` | The remote path is wrong | Run `rclone lsd remote:` and check the folder name |
| `failed to configure ...` | The remote has no valid token | Run `rclone config reconnect remote:` |
| `401` / `403` | The cloud token expired or lacks scope | Reconnect the remote in `rclone config` |
| Upload is very slow | It is your connection to the provider | Try another provider or the Folder guide |

---

## Privacy

- Efxlve stores only the `remote:folder` string. Credentials stay in rclone's own config.
- Archives are **not encrypted** by Efxlve. If you want encryption, configure rclone's `crypt` backend and use the encrypted remote as the destination.
- Revoke access from the provider's security page if you stop using it.

[Back to the cloud overview](CLOUD_SAVES.md) · [Folder guide](CLOUD_FOLDER_GUIDE.md) · [WebDAV guide](CLOUD_WEBDAV_GUIDE.md) · [Google Drive guide](GOOGLE_DRIVE_SETUP_GUIDE.md)
