# Cloud Saves with WebDAV

**Use this if:** you already have a Nextcloud, ownCloud, Box, Hetzner Storage Box or another WebDAV server, and you want the launcher to upload saves directly.

**You need:** the server address, a username and an app password. No OAuth client and no developer account.

---

## What WebDAV is, in one paragraph

WebDAV is a standard way to read and write files on a server over HTTPS. Nextcloud and ownCloud expose your files through it. Efxlve creates a folder called `efxlve_saves` there and writes one `.tar.gz` per backup. You can see and download those files from the server's normal file browser.

---

## Before you start

Find these three values:

1. **WebDAV address** — the full folder URL, ending with `/`.
2. **Username** — your normal login name, or the one shown in the app-password screen.
3. **App password** — a generated password, not your main account password.

### Nextcloud

1. Open Nextcloud in a browser.
2. Go to **Settings → Security → App passwords**.
3. Create a password named `Efxlve` and copy it.
4. Your address is usually:

```
https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME/
```

Replace `cloud.example.com` and `YOUR_USERNAME`. Keep the trailing `/`.

### ownCloud

```
https://cloud.example.com/remote.php/dav/files/YOUR_USERNAME/
```

Create an app password in **Settings → Security**.

### Hetzner Storage Box

```
https://YOUR-ACCOUNT.your-storagebox.de/
```

Use the Storage Box username and password. Enable WebDAV for the box in the Hetzner console first.

### Box

```
https://dav.box.com/dav/
```

Use your Box email and an app password created in Box settings.

### A self-hosted server

Ask the administrator for the **WebDAV collection URL** and whether digest or basic authentication is used. Efxlve supports both.

---

## Step 1 — Enter the details

1. Open Efxlve Launcher.
2. Go to **Settings → Cloud**.
3. Turn on **Enable Cloud Save Backup**.
4. Choose **WebDAV / Nextcloud**.
5. Paste the **address**.
6. Enter the **username**.
7. Enter the **app password**.

Leave **Allow a self-signed certificate** off unless your server uses a certificate you created yourself. If it does, turn it on; it disables certificate verification for this provider only.

---

## Step 2 — Test and save

1. Click **Test Connection**.
   - Success: `WebDAV connection verified successfully.`
   - Wrong password: `Authentication failed: invalid username or app password.`
2. Click **Save**.

The test creates the `efxlve_saves` folder. If the account cannot create folders, ask the server administrator for write access.

---

## Step 3 — Back up a game

1. Open **Library**.
2. Open the game's **Manage** page.
3. In the cloud section, click **Backup to Cloud**.

The archive path is:

```
https://your-server/…/efxlve_saves/<game-key>/<timestamp>.tar.gz
```

You can open the server's file browser and confirm it is there. A game key looks like `Ginger`, `gog__123` or `steam__570`; that is normal.

---

## Step 4 — Restore

1. Install the launcher on the other PC.
2. Configure the same WebDAV address and app password.
3. Open the game → **Manage**.
4. Press **Sync Cloud** if the list is empty.
5. Click **Restore** on the archive you want.

The launcher snapshots the current saves before overwriting them. A wrong restore can be undone from the local `pre-restore-…` backup.

---

## Common errors

| Message | Meaning | Fix |
|---|---|---|
| `401 Unauthorized` / `Authentication failed` | Wrong username or app password | Create a new app password and paste it again |
| `404 Not Found` | Address is missing a path or the trailing `/` | Copy the exact WebDAV URL from the server's help page |
| `403 Forbidden` | Account can read but not write | Grant write access to the folder |
| `405 MKCOL` | Server does not allow creating the folder | Create `efxlve_saves` manually in the file browser |
| Certificate error | Self-signed or expired certificate | Use a valid certificate, or enable **Allow a self-signed certificate** only for your own server |
| Timeout | Wrong host, VPN required or firewall | Open the address in a browser on the same PC |

---

## Privacy

- Credentials are kept in the OS secret store: Windows DPAPI, macOS Keychain, Linux Secret Service.
- Archives are **not encrypted** by Efxlve. The server's access control and HTTPS protect them in transit and at rest.
- The app password can be revoked from the server at any time; revoke it if you stop using the launcher.

[Back to the cloud overview](CLOUD_SAVES.md) · [Folder guide](CLOUD_FOLDER_GUIDE.md) · [rclone guide](CLOUD_RCLONE_GUIDE.md) · [Google Drive guide](GOOGLE_DRIVE_SETUP_GUIDE.md)
