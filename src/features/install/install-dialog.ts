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
import { IS_WINDOWS } from "../../core/platform";
import { rawOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { toast } from "../../core/toast";
import { scheduleRender } from "../../core/render";
import { currentLanguage, localizeMessage, t } from "../../i18n";
import { gogInstallGame } from "../../gog";
import { companionGameAction, eaContentInstall, eaContentPlan, eaDefaultInstallDir, eaInstallDir, isTransientUbisoftError, ubiDefaultInstallDir, ubiDirectInstall, ubiDirectLaunchMode, ubiDirectPlan, ubiDirectProbe, ubiInstallDir } from "../../companion";
import { setView } from "../store/store-view";
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
import { companionStoreId } from "../library/companion-library";

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
  const isGog = appName.startsWith("gog::");
  const s = summaryOf(appName);
  if (!s || epicDlProgress(appName) !== null) return;

  if (appName.startsWith("ea::")) {
    await openEaInstallDialog(appName);
    return;
  }

  if (appName.startsWith("ubisoft::")) {
    await openUbiInstallDialog(appName);
    return;
  }

  if (isGog) {
    // Updates reuse the existing folder; skip the dialog (mirrors the Epic path).
    if (s.installed && s.installPath) {
      await gogInstallGame(appName, s.installPath);
      return;
    }
    S.installDialogAppName = appName;
    S.installDialogFolder = s.title.replace(/[<>:"/\\|?*]+/g, "").trim() || appName.replace("gog::", "");
    S.installDialogDownloadSize = s.installSize || 0;
    S.installDialogDiskSize = s.installSize || 0;
    S.installDialogAutoUpdate = false;
    S.installDialogShortcut = true;
    S.installDialogHasOptions = false;
    S.installDialogLoading = false;
    S.installDialogDir = S.gogInstallDir || S.gogDefaultDir || "C:\\Games\\GOG";
    renderInstallDialog();
    return;
  }

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

/** Splits a final folder path into the dialog's base and game folder. */
function splitInstallRoot(path: string): { dir: string; folder: string } {
  const clean = path.replace(/[\\/]+$/, "");
  const index = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  if (index <= 0) return { dir: "", folder: clean };
  return { dir: clean.slice(0, index), folder: clean.slice(index + 1) };
}

/** EA's installer locale names, from the launcher's language codes. */
function eaLocale(language: string): string {
  const map: Record<string, string> = {
    ar: "ar_SA",
    de: "de_DE",
    en: "en_US",
    es: "es_ES",
    fr: "fr_FR",
    hi: "hi_IN",
    it: "it_IT",
    ja: "ja_JP",
    ko: "ko_KR",
    pl: "pl_PL",
    "pt-BR": "pt_BR",
    ru: "ru_RU",
    th: "th_TH",
    tr: "tr_TR",
    "zh-Hans": "zh_CN",
    "zh-Hant": "zh_TW",
  };
  return map[language] || map[language.split("-")[0]] || "en_US";
}

/**
 * The EA direct install dialog. The content service resolves the live build and
 * the package sizes before the user commits; a title it cannot serve (pre-DiP)
 * falls back to the EA App handoff.
 */
async function openEaInstallDialog(appName: string): Promise<void> {
  const s = summaryOf(appName);
  if (!s) return;
  const gameId = appName.slice(4);
  if (S.eaContentInstalling.has(gameId)) {
    setView("downloads");
    return;
  }
  S.installDialogAppName = appName;
  S.installDialogFolder = s.title.replace(/[<>:"/\\|?*]+/g, "").trim() || gameId;
  S.installDialogDownloadSize = 0;
  S.installDialogDiskSize = 0;
  S.installDialogAutoUpdate = false;
  S.installDialogShortcut = false;
  S.installDialogHasOptions = false;
  S.installDialogLoading = true;
  S.installDialogEaOoa = false;
  S.installDialogEaLegacy = false;
  S.installDialogDir = "";
  renderInstallDialog();
  try {
    const plan = await eaContentPlan(gameId);
    if (S.installDialogAppName !== appName) return;
    if (plan.eaac) {
      closeInstallDialog();
      toast(t("ea.needClient"), "");
      void companionGameAction("ea", gameId, "install").catch(() => {});
      return;
    }
    if (plan.legacy && !plan.legacyInstallable) {
      closeInstallDialog();
      toast(t("ea.legacyPackage"), "");
      void companionGameAction("ea", gameId, "install").catch(() => {});
      return;
    }
    S.installDialogEaOoa = plan.ooa && !plan.legacy;
    S.installDialogEaLegacy = plan.legacy && plan.legacyInstallable;
    const split = splitInstallRoot(plan.root);
    S.installDialogFolder = split.folder || S.installDialogFolder;
    if (plan.installed) {
      S.installDialogDir = split.dir;
    } else {
      const saved = (await eaInstallDir().catch(() => null))?.trim() || "";
      const base = saved || (await eaDefaultInstallDir().catch(() => "")) || split.dir;
      if (S.installDialogAppName !== appName) return;
      S.installDialogDir = base;
    }
    S.installDialogDownloadSize = plan.downloadBytes;
    S.installDialogDiskSize = plan.installBytes;
    S.installDialogLoading = false;
    renderInstallDialog();
  } catch (e) {
    closeInstallDialog();
    toast(localizeMessage(String(e)), "err");
    void companionGameAction("ea", gameId, "install").catch(() => {});
  }
}

const ubiTitleKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Resolve a library row to the numeric Ubisoft product id. */
async function resolveUbiProductId(appName: string, title: string): Promise<number> {
  const stored = Number(companionStoreId(appName));
  if (stored > 0) return stored;
  if (!S.ubiDirect) S.ubiDirect = await ubiDirectProbe().catch(() => null);
  const key = ubiTitleKey(title);
  const candidates = (S.ubiDirect?.games ?? []).filter((game) => game.installable);
  const match =
    candidates.find((game) => ubiTitleKey(game.name) === key) ||
    candidates.find((game) => ubiTitleKey(game.name).includes(key)) ||
    candidates.find((game) => key.includes(ubiTitleKey(game.name)));
  return match?.productId ?? 0;
}

/**
 * The direct Ubisoft install dialog. The manifest resolves the live build and
 * the compressed download size before the user commits; anti-cheat titles hand
 * off to Ubisoft Connect instead of downloading a copy that cannot launch.
 */
async function openUbiInstallDialog(appName: string): Promise<void> {
  const s = summaryOf(appName);
  if (!s) return;
  const title = s.title;
  const productId = await resolveUbiProductId(appName, title);
  if (!productId) {
    // Catalog-only row: no CDN product came back for this account, so the
    // client's own install handler is the only path. Never leave the click on
    // a dead "no games" toast.
    closeInstallDialog();
    void companionGameAction("ubisoft", appName.slice(9), "install").catch((e: unknown) =>
      toast(localizeMessage(String(e)), "err"),
    );
    return;
  }
  // A catalog-only row has an id the store reports but no CDN row in the
  // ownership probe. Ubisoft Connect is the only install path for it. An
  // installed copy keeps its own record and is not sent away by a stale probe.
  const directGame = S.ubiDirect?.games?.find((game) => game.productId === productId);
  if (!s.installed && S.ubiDirect && !directGame?.installable) {
    closeInstallDialog();
    void companionGameAction("ubisoft", appName.slice(9), "install").catch((e: unknown) =>
      toast(localizeMessage(String(e)), "err"),
    );
    return;
  }
  // Updates reuse the existing folder. A launcher-managed install goes back
  // through the CDN; a client-managed copy stays with Ubisoft Connect.
  if (s.installed && s.installPath) {
    const mode = await ubiDirectLaunchMode(s.installPath).catch(() => null);
    if (mode !== false) {
      void companionGameAction("ubisoft", appName.slice(9), "install").catch((e: unknown) =>
        toast(String(e), "err"),
      );
      return;
    }
    if (S.ubiDirectInstalling.has(productId)) {
      setView("downloads");
      return;
    }
    S.ubiInstallProductId = productId;
    S.ubiInstallName = title;
    S.ubiDirectInstalling.add(productId);
    S.ubiDirectProgress[productId] = {
      productId,
      doneBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: 0,
      filesDone: 0,
      totalFiles: 0,
      file: "",
    };
    setView("downloads");
    void ubiDirectInstall(productId, s.installPath).catch((e: unknown) => {
      S.ubiDirectInstalling.delete(productId);
      delete S.ubiDirectProgress[productId];
      toast(localizeMessage(String(e)), "err");
      scheduleRender();
    });
    return;
  }
  S.ubiInstallProductId = productId;
  S.ubiInstallName = title;
  S.installDialogAppName = appName;
  S.installDialogFolder = title.replace(/[<>:"/\\|?*]+/g, "").trim() || String(productId);
  S.installDialogDownloadSize = 0;
  S.installDialogDiskSize = 0;
  S.installDialogAutoUpdate = false;
  S.installDialogShortcut = false;
  S.installDialogHasOptions = false;
  S.installDialogLoading = true;
  S.installDialogDir = "";
  renderInstallDialog();
  try {
    const plan = await ubiDirectPlan(productId);
    if (S.installDialogAppName !== appName) return;
    if (plan.clientOnly) {
      closeInstallDialog();
      toast(t("accounts.ubiClientDetail1"), "");
      void companionGameAction("ubisoft", appName.slice(9), "install").catch(() => {});
      return;
    }
    S.ubiInstallName = plan.name || title;
    S.installDialogFolder =
      (plan.name || title).replace(/[<>:"/\\|?*]+/g, "").trim() || S.installDialogFolder;
    S.installDialogDownloadSize = plan.downloadBytes || plan.bytes;
    S.installDialogDiskSize = plan.bytes;
    const saved = (await ubiInstallDir().catch(() => null))?.trim() || "";
    const fallback = (await ubiDefaultInstallDir().catch(() => "")) || splitInstallRoot(plan.installDir).dir;
    if (S.installDialogAppName !== appName) return;
    S.installDialogDir = saved || fallback;
    S.installDialogLoading = false;
    renderInstallDialog();
  } catch (e) {
    closeInstallDialog();
    const message = String(e);
    // The plan already retried a transient service reset. Fall back to the
    // client without putting a raw socket error in front of the user.
    if (!isTransientUbisoftError(message)) {
      toast(localizeMessage(message), "err");
    }
    void companionGameAction("ubisoft", appName.slice(9), "install").catch(() => {});
  }
}

/** Renders the dialog markup into #install-root. */
export function renderInstallDialog(): void {
  const appName = S.installDialogAppName;
  if (!installRoot || !appName) return;
  const isGog = appName.startsWith("gog::");
  const isEa = appName.startsWith("ea::");
  const isUbi = appName.startsWith("ubisoft::");
  // The direct dialog is the default, but a first-time user may want the
  // official client to own the install. Keep that path one click away.
  const clientInstall = isUbi
    ? `<button type="button" class="btn ghost small" data-act="install-client" data-id="${esc(appName)}">${icon("external", 13)} ${t("accounts.ubiClientInstall")}</button>`
    : isEa
      ? `<button type="button" class="btn ghost small" data-act="install-client" data-id="${esc(appName)}">${icon("external", 13)} ${t("accounts.eaClientInstall")}</button>`
      : "";
  const s = summaryOf(appName);
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

          ${isEa && S.installDialogEaOoa ? `<div class="install-ea-note">${icon("shield", 14)}<span>${esc(t("ea.launchNeedsClient"))}</span></div>` : ""}
          ${isEa && S.installDialogEaLegacy ? `<div class="install-ea-note is-direct">${icon("check", 14)}<span>${esc(t("ea.launchMode.directDesc"))}</span></div>` : ""}
          ${isUbi ? `<div class="install-ea-note is-direct">${icon("shield", 14)}<span>${esc(t("accounts.ubiDirectDetail5"))}</span></div>` : ""}

          <div class="install-field-label">${t("install.pathLabel")}</div>
          <div class="install-path-row">
            <div class="install-path-input-wrap">
              ${icon("folder", 14)}
              <input id="install-dir-input" class="install-path-input" value="${esc(S.installDialogDir)}" spellcheck="false" autocomplete="off" />
            </div>
            <button type="button" class="install-browse-btn" data-act="install-browse">${t("common.browse")}</button>
          </div>
          <div class="install-final-path">${t("install.finalPath")}: <span id="install-final-path">${esc(finalPath)}</span></div>

          ${isEa || isUbi ? "" : `<label class="install-check-row">
            <input type="checkbox" class="selective-checkbox" data-act="install-toggle-autoupdate" ${S.installDialogAutoUpdate ? "checked" : ""} />
            <span>${t("install.autoUpdate")}</span>
          </label>`}
          ${IS_WINDOWS && !isEa && !isUbi
            ? `<label class="install-check-row">
            <input type="checkbox" class="selective-checkbox" data-act="install-toggle-shortcut" ${S.installDialogShortcut ? "checked" : ""} />
            <span>${t("manage.createShortcut")}</span>
          </label>`
            : ""}
        </div>
        <div class="install-footer">
          ${isGog ? `<button type="button" class="btn ghost small" data-act="gog-import-existing" data-id="${esc(appName)}">${t("settings.importInstalled")}</button>` : ""}
          ${clientInstall}
          <span style="flex:1"></span>
          <button type="button" class="install-cancel-btn" data-act="install-cancel">${t("common.cancel")}</button>
          <button type="button" class="install-confirm-btn" data-act="install-confirm" data-id="${esc(appName)}" data-gp-default ${loading ? "disabled" : ""}>
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

  if (appName.startsWith("ubisoft::")) {
    const productId = S.ubiInstallProductId;
    const name = S.ubiInstallName;
    const totalBytes = S.installDialogDiskSize;
    const finalDir = dir ? joinPath(dir, S.installDialogFolder) : null;
    closeInstallDialog();
    if (!productId) return;
    if (S.ubiDirectInstalling.has(productId)) {
      setView("downloads");
      return;
    }
    S.ubiDirectInstalling.add(productId);
    S.ubiDirectProgress[productId] = {
      productId,
      doneBytes: 0,
      totalBytes,
      bytesPerSecond: 0,
      etaSeconds: 0,
      filesDone: 0,
      totalFiles: 0,
      file: "",
    };
    setView("downloads");
    try {
      await ubiDirectInstall(productId, finalDir || undefined);
    } catch (e) {
      S.ubiDirectInstalling.delete(productId);
      delete S.ubiDirectProgress[productId];
      toast(localizeMessage(`${name}: ${String(e)}`), "err");
      scheduleRender();
    }
    return;
  }

  if (appName.startsWith("ea::")) {
    const gameId = appName.slice(4);
    const s = summaryOf(appName);
    const finalDir = dir ? joinPath(dir, S.installDialogFolder) : null;
    closeInstallDialog();
    if (S.eaContentInstalling.has(gameId)) {
      setView("downloads");
      return;
    }
    S.eaContentInstalling.add(gameId);
    S.eaContentProgress[gameId] = {
      id: gameId,
      offerId: "",
      name: s?.title || gameId,
      phase: "planning",
      files: 0,
      bytes: 0,
      skipped: 0,
      skippedBytes: 0,
      doneBytes: 0,
      totalFiles: 0,
      totalBytes: 0,
    };
    setView("downloads");
    try {
      await eaContentInstall(gameId, finalDir, eaLocale(currentLanguage()));
    } catch (e) {
      S.eaContentInstalling.delete(gameId);
      delete S.eaContentProgress[gameId];
      toast(localizeMessage(String(e)), "err");
      scheduleRender();
    }
    return;
  }

  if (appName.startsWith("gog::")) {
    closeInstallDialog();
    const finalDir = dir ? joinPath(dir, S.installDialogFolder) : undefined;
    await gogInstallGame(appName, finalDir);
    return;
  }

  try {
    const st = await epicGetGameSettings(appName);
    if (st.autoUpdate !== S.installDialogAutoUpdate) {
      st.autoUpdate = S.installDialogAutoUpdate;
      await epicSaveGameSettings(st);
    }
  } catch {
    // Preferences are best-effort; never block the install.
  }
  if (IS_WINDOWS && S.installDialogShortcut) S.pendingShortcutApps.add(appName);
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
