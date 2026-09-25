/**
 * Install location dialog (Epic-style).
 *
 * Shown before a game install starts so the user can pick the base folder and
 * decide on auto-updates and the desktop shortcut. For games with optional
 * language/extra tags or DLC the flow chains into the selective install modal
 * with the chosen folder already remembered.
 */

import { epicInstall, epicPlay } from "../../core/epic-actions";
import { installRoot } from "../../core/dom";
import { epicArt, epicDlProgress } from "../../core/game-view";
import { icon } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import {
  epicDefaultInstallDir,
  epicGetAutoDesktopShortcut,
  epicGetGameSettings,
  epicGetInstallOptions,
  epicGetSettings,
  epicInstallFolderName,
  epicSaveGameSettings,
  epicSelectFolderDialog,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
} from "../../epic";
import { openSelectiveModal } from "../dlc/selective-install";

/** Joins the base folder and the game folder using the platform separator. */
function joinPath(base: string, folder: string): string {
  const trimmed = (base || "").replace(/[\\/]+$/, "");
  if (!trimmed) return folder;
  const sep = trimmed.includes("\\") || !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${folder}`;
}

/** Default base folder: saved setting first, then the backend default. */
async function resolveDefaultDir(): Promise<string> {
  try {
    const st = await epicGetSettings();
    if (st.install_dir) return st.install_dir;
  } catch {
    // Fall through to the backend default.
  }
  try {
    return await epicDefaultInstallDir();
  } catch {
    return "";
  }
}

/** Opens the dialog and hydrates sizes, folder name and per-game preferences. */
export async function openInstallDialog(appName: string): Promise<void> {
  const s = S.epicSummariesMap.get(appName);
  if (!s || epicDlProgress(appName) !== null) return;
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  if (requiresThirdPartyLauncher(partner)) {
    void epicPlay(appName);
    return;
  }
  if (s.installed) {
    // Updates and repairs reuse the existing install path; no dialog needed.
    void epicInstall(appName);
    return;
  }

  S.installDialogAppName = appName;
  S.installDialogFolder = epicInstallFolderName(g) || s.title;
  S.installDialogDownloadSize = s.installSize;
  S.installDialogDiskSize = s.installSize;
  S.installDialogAutoUpdate = true;
  S.installDialogShortcut = true;
  S.installDialogHasOptions = false;
  S.installDialogLoading = true;
  S.installDialogDir = S.epicSettingsCache?.install_dir || S.epicDefaultDir || "";
  renderInstallDialog();

  const [dirDefault, autoShortcut] = await Promise.all([
    S.installDialogDir ? Promise.resolve(S.installDialogDir) : resolveDefaultDir(),
    epicGetAutoDesktopShortcut().catch(() => true),
  ]);
  if (S.installDialogAppName !== appName) return;
  // Never clobber a path the user typed while the defaults were loading.
  if (!S.installDialogDir) S.installDialogDir = dirDefault;
  S.installDialogShortcut = autoShortcut;

  try {
    const [opts, st] = await Promise.all([
      epicGetInstallOptions(appName),
      epicGetGameSettings(appName),
    ]);
    if (S.installDialogAppName !== appName) return;
    S.installDialogDownloadSize = opts.baseDownloadSize || opts.baseSize || S.installDialogDownloadSize;
    S.installDialogDiskSize = opts.baseSize || S.installDialogDiskSize;
    S.installDialogHasOptions = opts.hasOptions;
    S.installDialogAutoUpdate = st.autoUpdate;
  } catch {
    // Sizes and preferences are best-effort; the dialog still works with summary data.
  }
  if (S.installDialogAppName !== appName) return;
  S.installDialogLoading = false;
  renderInstallDialog();
}

/** Renders the dialog markup into #install-root. */
export function renderInstallDialog(): void {
  const appName = S.installDialogAppName;
  if (!installRoot || !appName) return;
  const s = S.epicSummariesMap.get(appName);
  if (!s) return;

  const loading = S.installDialogLoading;
  const finalPath = joinPath(S.installDialogDir, S.installDialogFolder);
  const sizeValue = (bytes: number) =>
    loading
      ? `<span class="install-size-pending" aria-hidden="true"></span>`
      : `<strong>${fmtBytes(bytes)}</strong>`;
  installRoot.innerHTML = `
    <div class="selective-overlay" data-act="install-overlay-close">
      <div class="selective-dialog install-dialog">
        <div class="selective-header">
          <h2>${t("install.title")}</h2>
          <button class="manage-head-close" data-act="install-cancel" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="install-body">
          <div class="install-game-row">
            <div class="install-cover">${epicArt(s)}</div>
            <div class="install-game-info">
              <div class="install-game-title">${esc(s.title)}</div>
              <div class="install-game-stats${loading ? " is-loading" : ""}">
                <span>${t("selective.downloadSize")}: ${sizeValue(S.installDialogDownloadSize)}</span>
                <span>${t("selective.storageSize")}: ${sizeValue(S.installDialogDiskSize)}</span>
              </div>
            </div>
          </div>

          <div class="install-field-label">${t("install.pathLabel")}</div>
          <div class="install-path-row">
            <div class="install-path-input-wrap">
              ${icon("folder", 14)}
              <input id="install-dir-input" class="install-path-input" value="${esc(S.installDialogDir)}" spellcheck="false" autocomplete="off" />
            </div>
            <button type="button" class="install-browse-btn" data-act="install-browse">${t("common.browse")}</button>
          </div>
          <div class="install-final-path">${t("install.finalPath")}: <span id="install-final-path">${esc(finalPath)}</span></div>

          <label class="install-check-row">
            <input type="checkbox" class="selective-checkbox" data-act="install-toggle-autoupdate" ${S.installDialogAutoUpdate ? "checked" : ""} />
            <span>${t("install.autoUpdate")}</span>
          </label>
          <label class="install-check-row">
            <input type="checkbox" class="selective-checkbox" data-act="install-toggle-shortcut" ${S.installDialogShortcut ? "checked" : ""} />
            <span>${t("manage.createShortcut")}</span>
          </label>
        </div>
        <div class="install-footer">
          <button type="button" class="install-cancel-btn" data-act="install-cancel">${t("common.cancel")}</button>
          <button type="button" class="install-confirm-btn" data-act="install-confirm" data-id="${esc(appName)}" ${loading ? "disabled" : ""}>
            ${icon("download", 14)} ${t("common.install")}
          </button>
        </div>
      </div>
    </div>`;
}

/** Live preview of the final folder while the user edits the path input. */
export function updateInstallFinalPath(): void {
  const input = document.getElementById("install-dir-input") as HTMLInputElement | null;
  const el = document.getElementById("install-final-path");
  if (!el) return;
  const dir = input ? input.value : S.installDialogDir;
  el.textContent = joinPath(dir, S.installDialogFolder);
}

/** Native folder picker for the base install directory. */
export async function browseInstallDir(): Promise<void> {
  const input = document.getElementById("install-dir-input") as HTMLInputElement | null;
  const current = input?.value || S.installDialogDir;
  try {
    const picked = await epicSelectFolderDialog(current || null);
    if (!picked) return;
    S.installDialogDir = picked;
    if (input) input.value = picked;
    updateInstallFinalPath();
  } catch {
    // User cancelled or the picker failed; keep the current value.
  }
}

/** Confirms the dialog: persists preferences and starts the install flow. */
export async function confirmInstall(): Promise<void> {
  const appName = S.installDialogAppName;
  if (!appName) return;
  const input = document.getElementById("install-dir-input") as HTMLInputElement | null;
  const dir = (input?.value ?? S.installDialogDir).trim() || null;
  const hasOptions = S.installDialogHasOptions;

  try {
    const st = await epicGetGameSettings(appName);
    if (st.autoUpdate !== S.installDialogAutoUpdate) {
      st.autoUpdate = S.installDialogAutoUpdate;
      await epicSaveGameSettings(st);
    }
  } catch {
    // Preferences are best-effort; never block the install.
  }
  if (S.installDialogShortcut) S.pendingShortcutApps.add(appName);
  S.selectiveInstallDir = dir;
  closeInstallDialog();
  if (hasOptions) {
    await openSelectiveModal(appName);
  } else {
    await epicInstall(appName, dir);
  }
}

/** Closes the dialog and resets its state. */
export function closeInstallDialog(): void {
  S.installDialogAppName = null;
  S.installDialogLoading = false;
  if (installRoot) installRoot.innerHTML = "";
}
