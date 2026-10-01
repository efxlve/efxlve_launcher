# Google Drive Cloud Save Backup Setup Guide

Efxlve Launcher allows you to back up your game save files automatically or with a single click to your personal **Google Drive** storage, and restore them anytime on any machine.

This guide provides a step-by-step walkthrough for **Community** members to obtain their own free Google Drive API credentials and configure the integration in under two minutes.

---

## 🌟 Why Bring Your Own Credentials? (BYOC Model)

Efxlve Launcher is an **independent, open-source** gaming hub. Following trusted open-source utilities like Rclone, KeePassXC, and Obsidian Remotely Save, it adopts the **"Bring Your Own Credentials" (BYOC)** pattern:

1. **Zero Quota Limits & Instant Access:** Google imposes a 100-user cap and requires lengthy corporate verification for centralized, multi-tenant unverified applications. By creating your own free Google Cloud project, this cap is completely bypassed; your quota belongs exclusively to you forever.
2. **100% Data Privacy:** Your game saves never pass through intermediary proxies or developer-hosted servers. Transfers take place directly between your local PC and Google Drive via end-to-end encrypted TLS connections.
3. **Restricted Sandbox Scope (`drive.appdata`):** Efxlve Launcher **cannot read or touch** your personal documents, photos, or general Drive files. It requests only the isolated `appDataFolder` scope, which confines access strictly to the launcher's own hidden save archives.
4. **Completely Free:** Personal Google Cloud projects and Google Drive API quotas for personal save games fall well within Google's free tier.

---

## 🛠️ Step-by-Step Setup Guide

### 1. Create a Google Cloud Project
1. Open the [Google Cloud Console](https://console.cloud.google.com/) and sign in with your Google account.
2. Click the project dropdown at the top of the page and select **New Project**.
3. Name your project (e.g. `Efxlve Launcher`) and click **Create**.
4. In the top search bar, type `Google Drive API`, navigate to its marketplace page, and click **Enable**.

---

### 2. Configure OAuth Consent Screen
1. In the left navigation sidebar, go to **APIs & Services > OAuth consent screen**.
2. Select **External** as the User Type and click **Create**.
3. Fill in the required fields:
   - **App name:** `Efxlve Launcher`
   - **User support email:** Select your Gmail address
   - **Developer contact information:** Enter your Gmail address
4. Scroll to the bottom and click **Save and Continue**.

---

### 3. Configure Scopes
1. On the **Scopes** page, click **Add or Remove Scopes**.
2. In the filter box, search for `drive.appdata` or locate the following scope in the list:
   ```text
   .../auth/drive.appdata  (See, create, and delete its own configuration data in Google Drive)
   ```
3. Check the checkbox next to `.../auth/drive.appdata`, click **Update**, and then click **Save and Continue**.

---

### 4. Add Yourself as a Test User
> **Important:** Adding your Gmail address as a test user allows you to use your application indefinitely without undergoing Google's public verification process.

1. On the **Test users** step, click **+ Add Users**.
2. Enter the **Gmail address** you want to back up saves to and click **Add**.
3. Click **Save and Continue** at the bottom to complete the summary.

---

### 5. Create Desktop Credentials
1. In the left navigation menu, go to **Credentials**.
2. Click **+ Create Credentials > OAuth client ID** from the top action bar.
3. Configure the credential settings:
   - **Application type:** `Desktop app`
   - **Name:** `Efxlve Desktop`
4. Click **Create**.

---

### 6. Copy Client ID and Client Secret
1. A dialog will appear displaying your new OAuth credentials:
   - **Client ID:** `xxxxxxxxxxxx-xxxxxxxxxxxxxxxx.apps.googleusercontent.com`
   - **Client Secret:** `GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx`
2. Copy both values.

---

### 7. Configure in Efxlve Launcher & Connect
1. Open Efxlve Launcher and navigate to **Settings > Integrations > Cloud Save Backup**.
2. Toggle on **Enable Cloud Save Backup** and select **Google Drive** as your provider.
3. Paste your **Client ID** and **Client Secret** into the respective fields and click **Save**.
4. Click **Connect with Google**.
5. In the browser tab that opens, choose the Google account you added as a test user, and click **Continue / Allow** on the authorization screen.
6. Once the browser displays `Google Drive connection successful!`, return to Efxlve Launcher; your account is now connected and ready.

---

## 🎮 How to Use

### Game Manage Drawer (Manual Backup & Restore)
1. In your library, right-click any game or open its action menu and select **Manage**.
2. Scroll to the **Save Files & Cloud** section:
   - **Backup to Cloud:** Compresses your current local save files and uploads a timestamped archive to Google Drive.
   - **Restore:** Downloads any cloud backup and extracts it directly into the local save directory (protects against save corruption or system wipes).
   - **Multi-Version History:** Each backup preserves a distinct timestamp and file size. The newest backup is tagged with a green **Latest** chip.
   - **Delete / Delete All:** Remove individual older backups or wipe all cloud saves for that game.

### Automated Cloud Sync (Auto-Sync)
- Enable **Auto-Sync on Game Exit** in Settings to automatically create and upload a fresh save archive whenever you finish playing a supported game.

---

## ❓ Frequently Asked Questions (FAQ)

#### I don't see my save files in my main Google Drive folder. Where are they?
To prevent hundreds of save archives from cluttering your root Drive folder, backups are stored in Google's secure, dedicated **Hidden App Data (`appDataFolder`)** sandbox. To inspect your stored data:
1. Open [Google Drive on the web](https://drive.google.com/).
2. Click the **Gear icon (Settings) > Settings** in the top right.
3. Select **Manage Apps** from the left sidebar.
4. Locate **Efxlve Launcher** to view `Hidden app data: ~XX MB`.

#### Are my Client ID and Client Secret secure?
Yes. Your credentials and tokens are stored solely on your local computer (`%USERPROFILE%\.config\legendary\cloud_backup_settings.json`). They are never transmitted to third parties, telemetry endpoints, or developer servers.

#### Is WebDAV also supported?
Yes! If you prefer self-hosting with Nextcloud, ownCloud, or a local NAS, choose **WebDAV** as your provider in Settings and provide your server URL and credentials for identical functionality.
