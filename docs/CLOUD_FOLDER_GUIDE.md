# Cloud Saves with a Folder (easiest)

**Use this if:** OneDrive, Dropbox, Google Drive for desktop, iCloud Drive, Nextcloud, Syncthing or a NAS already syncs a folder on your PC.

**You do not need:** an account inside Efxlve, an API key, an OAuth client, a server address or a password. The sync app you already use does all the uploading.

---

## What happens

1. The launcher writes a `.tar.gz` save archive into a folder you choose.
2. Your OneDrive/Dropbox/Nextcloud client notices the new file and uploads it.
3. On another PC, the same client downloads it, and Efxlve restores it.

The launcher never talks to OneDrive, Dropbox or Google directly in this mode. If your sync client is paused, the backup is only local until it resumes.

---

## Before you start

- Install and sign in to your sync client.
- Wait until it says **Up to date** / **All files synced**.
- Pick a folder that is inside the synced area, not a folder next to it.

Not sure where that is?

| Sync app | Typical folder |
|---|---|
| OneDrive (Windows) | `C:\Users\<you>\OneDrive` |
| Dropbox | `C:\Users\<you>\Dropbox` |
| Google Drive for desktop | `G:\My Drive` or `C:\Users\<you>\Google Drive` |
| iCloud Drive (Windows/macOS) | `iCloudDrive` in your user folder |
| Nextcloud | `C:\Users\<you>\Nextcloud` or `~/Nextcloud` |
| Syncthing | the folder you shared |
| NAS | the mapped drive, e.g. `Z:\Saves` |

---

## Step 1 — Create a save folder

Inside the synced folder, create a new folder named **EfxlveSaves**.

Examples:

- `C:\Users\Efe\OneDrive\EfxlveSaves`
- `C:\Users\Efe\Dropbox\EfxlveSaves`
- `/Users/efe/Nextcloud/EfxlveSaves`

Do not create it inside `Program Files` or another protected folder.

---

## Step 2 — Turn on cloud backup

1. Open Efxlve Launcher.
2. Go to **Settings → Cloud**.
3. Turn on **Enable Cloud Save Backup**.
4. Under **Cloud Provider**, choose **Folder (OneDrive / Dropbox / NAS)**.
5. Click **Choose folder** and select the **EfxlveSaves** folder you just created.
6. Click **Test Connection**.
   - You should see a message like `Folder is ready: …`.
7. Click **Save**.

If Test Connection fails, the folder is not writable or does not exist. Create it again and retry.

---

## Step 3 — Make your first backup

1. Open **Library**.
2. Open a game's **Manage** page.
3. Find the **Cloud Save Backup** section.
4. Click **Backup to Cloud**.

The launcher creates a local backup first, then writes the archive into:

```
<EfxlveSaves>\efxlve_saves\<game-key>\<timestamp>.tar.gz
```

Open the folder in Explorer/Finder to confirm the file appeared.

Wait for your sync client to upload it before closing the PC. The upload speed is your sync client's speed, not Efxlve's.

---

## Step 4 — Restore on another PC

1. Install the same sync client and sign in.
2. Wait until **EfxlveSaves** is fully downloaded.
3. Install Efxlve Launcher.
4. **Settings → Cloud**: enable, choose **Folder**, pick **EfxlveSaves**, Test, Save.
5. Open the game → **Manage** → **Restore** next to the archive you want.

Before overwriting anything, the launcher snapshots the current saves. If you restore the wrong archive, open the local backup list and restore the `pre-restore-…` snapshot.

---

## Optional — keep the launcher itself too

**Settings → Cloud → Launcher data** can export or cloud-sync:

- custom games
- collections
- playtime
- achievements caches
- notes
- custom themes and settings

This is a separate `.efxprofile` archive. It does **not** contain passwords, API keys or Steam sessions.

---

## Troubleshooting

**Test Connection says the folder is not writable**
- Pick a folder under your user profile, not `Program Files`.
- On macOS, check System Settings → Privacy & Security → Files and Folders.
- On Linux, check that the mount is mounted read-write.

**Backup succeeded but nothing appears in the cloud**
- Open your sync client and check for errors or paused sync.
- Make sure the folder is inside the synced tree, not a sibling folder.
- On Windows, OneDrive "Files On-Demand" can keep the file online-only; that is fine, it still uploads.

**The other PC does not see the archive**
- Wait for the sync client to finish downloading.
- Press **Sync Cloud** in the game's Manage page to refresh the list.

**I picked the wrong folder**
- Go back to Settings → Cloud, choose the correct folder, Test, Save. Existing archives are not moved automatically.

---

## Privacy

- Archives are ordinary files inside your own sync folder.
- They are **not encrypted** by Efxlve. Your sync provider's access control protects them.
- Anyone with access to that folder can read the saves, so keep the account secure.

[Back to the cloud overview](CLOUD_SAVES.md) · [WebDAV guide](CLOUD_WEBDAV_GUIDE.md) · [rclone guide](CLOUD_RCLONE_GUIDE.md) · [Google Drive guide](GOOGLE_DRIVE_SETUP_GUIDE.md)
