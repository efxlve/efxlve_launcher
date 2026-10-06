/**
 * Click delegation handlers for downloads queue, installer dialogs,
 * CDN selection, cache cleanup, and storage management.
 */

import { toast } from "../../../core/toast";
import { localizeMessage, t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { closeAllModals, render } from "../../../core/render";
import { cdnShortLabel } from "../../../core/utils";
import { isCompanionKey, rawOf, sourceOfKey, summaryOf } from "../../../core/selectors";
import { isTauri } from "../../../core/constants";
import { epicOpenFolderPath } from "../../../epic-commands";
import { patchLibraryCardDom } from "../../../core/game-view";
import { pushNavHistory } from "../../../core/nav";
import { setView } from "../../store/store-view";
import { loadSettingsView } from "../../settings/settings-view";
import { epicDownload } from "../../auth/auth-actions";
import { epicCancel, epicUninstall, refreshEpicInstalled } from "../../../core/epic-actions";
import { closeManagePopup } from "../../manage/manage-view";
import { gogCancelDownload, gogImportGame, gogPauseDownload, gogResumeDownload, gogSetInstallDir } from "../../../gog";
import { amazonSetInstallDir } from "../../../nile";
import {
  browseInstallDir,
  closeInstallDialog,
  confirmInstall,
  openInstallDialog,
} from "../../install/install-dialog";
import { openMoveGameModal } from "../../move-game/move-game-actions";
import {
  clearStorageSearch,
  closeStorageManager,
  openStorageManager,
  setStorageDrive,
  setStorageStoreFilter,
  toggleStorageSort,
} from "../../storage/storage-view";
import { toggleIgnoreUpdate } from "../../downloads/downloads-view";
import {
  epicCleanupCache,
  epicImportInstalledFolder,
  epicMeasureCdns,
  epicPauseDownload,
  epicReorderQueue,
  epicResumeDownload,
  epicSelectFolderDialog,
  epicSetInstallDir,
  epicSetPreferredCdn,
  getThirdPartyLauncher,
  requiresThirdPartyLauncher,
  type EpicSettings,
} from "../../../epic";
import { uninstallAmazonGame } from "../../auth/amazon-auth-actions";
import { companionGameAction, type CompanionStore } from "../../../companion";
import { steamGameAction } from "../../../steam";

export function handleDownloadsAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "epic-download":
      void epicDownload();
      return true;

    case "epic-install":
      if (id) void openInstallDialog(id);
      return true;

    case "install-browse":
      void browseInstallDir();
      return true;

    case "install-confirm":
      if (id) void confirmInstall();
      return true;

    case "install-cancel":
      closeInstallDialog();
      return true;

    case "install-overlay-close":
      if (targetEl === t) closeInstallDialog();
      return true;

    case "gog-import-existing":
      if (id) {
        void (async () => {
          const chosen = await epicSelectFolderDialog(null, i18nT("settings.importInstalled")).catch(() => null);
          if (!chosen) return;
          try {
            const info = await gogImportGame(id, chosen);
            toast(i18nT("settings.importInstalledDone", { imported: 1, relinked: 0 }), "ok");
            closeInstallDialog();
            const cleanId = id.replace("gog::", "");
            const g = S.gogSummariesMap.get(cleanId);
            if (g) {
              g.installed = true;
              g.installPath = info.install_path;
              g.installSize = info.install_size;
              if (info.version) {
                g.version = info.version;
                g.installedVersion = info.version;
              }
            }
            const item = S.allGamesMap.get(id);
            if (item) {
              item.installed = true;
              item.installPath = info.install_path;
              item.installSize = info.install_size;
              if (info.version) {
                item.version = info.version;
                item.installedVersion = info.version;
              }
            }
            if (S.view === "library") patchLibraryCardDom(id);
          } catch (err) {
            toast(String(err), "err");
          }
        })();
      }
      return true;

    case "epic-cancel":
      if (id) {
        if (id.startsWith("gog::")) {
          void gogCancelDownload(id);
        } else {
          void epicCancel(id);
        }
      }
      return true;

    case "epic-uninstall":
      if (id) {
        closeManagePopup();
        void epicUninstall(id);
      }
      return true;

    case "dl-pause":
      if (id?.startsWith("gog::")) {
        gogPauseDownload(id)
          .then((msg) => {
            S.gogDlPaused = true;
            toast(localizeMessage(msg), "");
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
        return true;
      }
      if (id) {
        epicPauseDownload(id)
          .then((msg) => {
            S.dlQueueStatus.isPaused = true;
            toast(msg, "");
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "dl-resume":
      if (id?.startsWith("gog::")) {
        if (S.autoPausedDl === id) S.autoPausedDl = null;
        gogResumeDownload(id)
          .then((msg) => {
            S.gogDlPaused = false;
            toast(localizeMessage(msg), "");
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
        return true;
      }
      if (id) {
        if (S.autoPausedDl === id) S.autoPausedDl = null;
        epicResumeDownload(id)
          .then((msg) => {
            S.dlQueueStatus.isPaused = false;
            toast(msg, "");
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "dl-reorder-up":
      if (id) {
        epicReorderQueue(id, "up")
          .then((q) => {
            S.dlQueueStatus = q;
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "dl-reorder-down":
      if (id) {
        epicReorderQueue(id, "down")
          .then((q) => {
            S.dlQueueStatus = q;
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "dl-reorder-now":
      if (id) {
        epicReorderQueue(id, "now")
          .then((q) => {
            S.dlQueueStatus = q;
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "dl-reorder-remove":
      if (id) {
        epicReorderQueue(id, "remove")
          .then((q) => {
            S.dlQueueStatus = q;
            toast(i18nT("dl.removedFromQueue"), "");
            if (S.view === "downloads") render();
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "epic-save-install-dir": {
      const input = document.getElementById("epic-install-dir") as HTMLInputElement | null;
      const v = input?.value?.trim() ?? "";
      epicSetInstallDir(v ? v : null)
        .then((st: EpicSettings) => {
          S.epicSettingsCache = st;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        })
        .catch((e: unknown) => toast(String(e), "err"));
      return true;
    }

    case "gog-save-install-dir": {
      const input = document.getElementById("gog-install-dir") as HTMLInputElement | null;
      const v = input?.value?.trim() ?? "";
      gogSetInstallDir(v ? v : null)
        .then(() => {
          S.gogInstallDir = v;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        })
        .catch((e: unknown) => toast(String(e), "err"));
      return true;
    }

    case "dl-pick-gog-install-dir":
      void (async () => {
        const input = document.getElementById("gog-install-dir") as HTMLInputElement | null;
        const current = input?.value?.trim() || S.gogInstallDir || S.gogDefaultDir || null;
        const chosen = await epicSelectFolderDialog(current, i18nT("move.pickerTitle")).catch(() => null);
        if (!chosen) return;
        if (input) input.value = chosen;
        try {
          await gogSetInstallDir(chosen);
          S.gogInstallDir = chosen;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;

    case "amazon-save-install-dir": {
      const input = document.getElementById("amazon-install-dir") as HTMLInputElement | null;
      const v = input?.value?.trim() ?? "";
      amazonSetInstallDir(v)
        .then(() => {
          S.amazonInstallDir = v;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        })
        .catch((e: unknown) => toast(String(e), "err"));
      return true;
    }

    case "dl-pick-amazon-install-dir":
      void (async () => {
        const input = document.getElementById("amazon-install-dir") as HTMLInputElement | null;
        const current = input?.value?.trim() || S.amazonInstallDir || null;
        const chosen = await epicSelectFolderDialog(current, i18nT("move.pickerTitle")).catch(() => null);
        if (!chosen) return;
        if (input) input.value = chosen;
        try {
          await amazonSetInstallDir(chosen);
          S.amazonInstallDir = chosen;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;

    case "import-installed-folder":
      void (async () => {
        const chosen = await epicSelectFolderDialog(null, i18nT("settings.importInstalled")).catch(() => null);
        if (!chosen) return;
        toast(i18nT("settings.importInstalledScanning"), "");
        try {
          const res = await epicImportInstalledFolder(chosen);
          if (res.imported === 0 && res.relinked === 0) {
            toast(i18nT("settings.importInstalledNone"), "");
          } else {
            toast(i18nT("settings.importInstalledDone", { imported: res.imported, relinked: res.relinked }), "ok");
            await refreshEpicInstalled();
            render();
          }
        } catch (e) {
          toast(localizeMessage(String(e)), "err");
        }
      })();
      return true;

    case "dl-pick-install-dir":
      void (async () => {
        const input = document.getElementById("epic-install-dir") as HTMLInputElement | null;
        const current = input?.value?.trim() || S.epicSettingsCache?.install_dir || S.epicDefaultDir || null;
        const chosen = await epicSelectFolderDialog(current, i18nT("move.pickerTitle")).catch(() => null);
        if (!chosen) return;
        if (input) input.value = chosen;
        try {
          const st = await epicSetInstallDir(chosen);
          S.epicSettingsCache = st;
          toast(i18nT("dl.installDirSaved"), "ok");
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;

    case "dl-set-cdn": {
      const host = (t.getAttribute("data-cdn") || "").trim();
      void (async () => {
        try {
          await epicSetPreferredCdn(host || null);
          S.preferredCdn = host;
          if (host) {
            toast(i18nT("downloads.cdnSet", { host: cdnShortLabel(host) }), "ok");
          } else {
            toast(i18nT("downloads.cdnResetDone"), "ok");
          }
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;
    }

    case "dl-find-fastest-cdn":
      void (async () => {
        const urls = S.epicGamesRaw.flatMap((g) => g.base_urls || []).filter(Boolean);
        toast(i18nT("downloads.cdnTesting"), "");
        try {
          const probes = await epicMeasureCdns(urls);
          if (probes.length === 0) {
            toast(i18nT("downloads.cdnNoResult"), "err");
            return;
          }
          const best = probes[0];
          await epicSetPreferredCdn(best.host);
          S.preferredCdn = best.host;
          toast(i18nT("downloads.cdnPicked", { host: cdnShortLabel(best.host), ms: best.ms }), "ok");
          render();
        } catch (e) {
          toast(String(e), "err");
        }
      })();
      return true;

    case "dl-cleanup-cache":
      toast(i18nT("downloads.cacheClearing"), "");
      void epicCleanupCache()
        .then((msg) => {
          toast(msg, "ok");
        })
        .catch((e: unknown) => toast(String(e), "err"));
      return true;

    case "open-storage-manager":
      void openStorageManager();
      return true;

    case "close-storage-manager":
      closeStorageManager();
      return true;

    case "storage-overlay-close":
      if (targetEl === t) closeStorageManager();
      return true;

    case "storage-select-drive": {
      const drive = t.dataset.drive;
      if (drive) setStorageDrive(drive);
      return true;
    }

    case "storage-filter-store": {
      const store = t.dataset.store;
      if (store) setStorageStoreFilter(store);
      return true;
    }

    case "storage-sort-toggle":
      toggleStorageSort();
      return true;

    case "storage-clear-search":
      clearStorageSearch();
      return true;

    case "blocked-move-tp": {
      const partner = t.dataset.partner || "Ubisoft Connect / EA App";
      toast(i18nT("manage.moveThirdPartyAlert", { name: partner }), "");
      return true;
    }

    case "storage-move-game":
      if (id) {
        const raw = rawOf(id);
        const partner = getThirdPartyLauncher(raw);
        if (requiresThirdPartyLauncher(partner)) {
          toast(i18nT("manage.moveThirdPartyAlert", { name: partner!.name }), "");
          return true;
        }
        closeStorageManager();
        void openMoveGameModal(id);
      }
      return true;

    case "storage-open-folder": {
      const p = t.getAttribute("data-path") || targetEl?.getAttribute("data-path") || (id ? summaryOf(id)?.installPath : null);
      if (!p) {
        toast(i18nT("common.installPathUnknown"), "err");
        return true;
      }
      if (isTauri) {
        epicOpenFolderPath(p)
          .then((msg) => toast(msg, "ok"))
          .catch((e: unknown) => toast(String(e), "err"));
      } else {
        toast(`(demo) ${p}`, "");
      }
      return true;
    }

    case "storage-uninstall":
      if (id) {
        closeStorageManager();
        if (id.startsWith("amazon::")) {
          void uninstallAmazonGame(id.slice(8));
        } else if (id.startsWith("steam::")) {
          void steamGameAction(id.slice(7), "uninstall").catch((e: unknown) => toast(String(e), "err"));
        } else if (isCompanionKey(id)) {
          const store = sourceOfKey(id) as CompanionStore;
          void companionGameAction(store, id.slice(id.indexOf("::") + 2), "uninstall").catch((e: unknown) => toast(String(e), "err"));
        } else {
          void epicUninstall(id);
        }
      }
      return true;

    case "toggle-ignore-update":
      if (id) {
        toggleIgnoreUpdate(id);
        if (S.view === "downloads") {
          render();
        }
      }
      return true;

    case "open-download-settings":
      closeAllModals();
      S.settingsSection = "downloads";
      setView("settings");
      pushNavHistory({ view: "settings", settingsSection: "downloads" });
      render();
      void loadSettingsView();
      return true;

    default:
      return false;
  }
}
