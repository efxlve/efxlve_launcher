/**
 * Click delegation handlers for screenshot deletion, the lightbox viewer,
 * sharing and batch image compression. Capture itself is keyboard-only: the
 * hotkey is handled in the backend while the game window is focused.
 */

import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { summaryOf } from "../../../core/selectors";
import {
  epicDeleteGameScreenshot,
  epicOpenFolderPath,
  epicOpenGameScreenshotsFolder,
} from "../../../epic";
import {
  closeScreenshotDeleteConfirm,
  closeScreenshotLightbox,
  closeShareModal,
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  fetchAndRenderScreenshots,
  forgetFullShot,
  navigateScreenshotLightbox,
  openScreenshotDeleteConfirm,
  openScreenshotLightbox,
  openShareModal,
  takePendingScreenshotDelete,
} from "../../screenshots/screenshots-view";

/** True for the Steam client's own screenshots: shown read-only. */
function isSteamShots(appName: string): boolean {
  return appName.startsWith("steam::");
}

/** Opens the folder that holds the game's screenshots (Steam has its own). */
function openScreenshotFolder(appName: string, title: string): void {
  if (!isSteamShots(appName)) {
    void epicOpenGameScreenshotsFolder(appName, title);
    return;
  }
  const first = (S.loadedScreenshots.get(appName) || [])[0];
  if (!first) {
    toast(i18nT("ss.emptyTitle"), "");
    return;
  }
  const dir = first.file_path.replace(/[\\/][^\\/]*$/, "");
  void epicOpenFolderPath(dir).catch((e: unknown) => toast(String(e), "err"));
}

export function handleScreenshotAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "open-screenshots-folder":
      if (id) {
        const s = summaryOf(id);
        const title = t.dataset.title || (s ? s.title : id);
        openScreenshotFolder(id, title);
      }
      return true;

    case "delete-screenshot":
      if (id) {
        if (isSteamShots(id)) {
          toast(i18nT("ss.steamReadOnly"), "");
          return true;
        }
        const filePath = t.dataset.path;
        if (filePath) openScreenshotDeleteConfirm(id, filePath, t.dataset.lightbox === "true");
      }
      return true;

    case "ss-delete-backdrop":
      if (targetEl === t) closeScreenshotDeleteConfirm();
      return true;

    case "ss-delete-cancel":
      closeScreenshotDeleteConfirm();
      return true;

    case "ss-delete-confirm": {
      const pending = takePendingScreenshotDelete();
      if (pending) {
        epicDeleteGameScreenshot(pending.filePath)
          .then((success) => {
            if (success) {
              toast(i18nT("ss.deleted"), "ok");
              // The file is gone: drop the original held for the lightbox.
              forgetFullShot(pending.filePath);
              const s = summaryOf(pending.appName);
              const title = s ? s.title : pending.appName;
              if (pending.lightbox) closeScreenshotLightbox();
              void fetchAndRenderScreenshots(pending.appName, title, true);
            } else {
              toast(i18nT("ss.deleteFailed"), "err");
            }
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;
    }

    case "open-screenshot-lightbox":
      if (id) {
        const idx = parseInt(t.dataset.idx || "0", 10);
        openScreenshotLightbox(id, idx);
      }
      return true;

    case "close-screenshot-lightbox":
      closeScreenshotLightbox();
      return true;

    case "close-screenshot-lightbox-backdrop":
      if (targetEl === t) {
        closeScreenshotLightbox();
      }
      return true;

    case "lightbox-nav": {
      const dir = (t.dataset.dir as "prev" | "next") || "next";
      navigateScreenshotLightbox(dir);
      return true;
    }

    case "share-screenshot":
      if (id) {
        const idx = parseInt(t.dataset.idx || "0", 10);
        const list = S.loadedScreenshots.get(id) || [];
        const item = list[idx];
        if (item) {
          openShareModal(id, item);
        }
      }
      return true;

    case "close-share-modal":
      closeShareModal();
      return true;

    case "do-copy-image":
      if (S.activeShareScreenshot) {
        void copyScreenshotImageToClipboard(S.activeShareScreenshot.item, S.activeShareScreenshot.appName);
        closeShareModal();
      }
      return true;

    case "do-copy-path":
      if (S.activeShareScreenshot) {
        const path = S.activeShareScreenshot.item.file_path;
        navigator.clipboard.writeText(path).then(() => {
          toast(i18nT("ss.pathCopiedShort"), "ok");
        }).catch(() => {
          toast(path, "");
        });
        closeShareModal();
      }
      return true;

    case "do-open-folder":
      if (S.activeShareScreenshot) {
        const appName = S.activeShareScreenshot.appName;
        const s = summaryOf(appName);
        const title = s ? s.title : appName;
        openScreenshotFolder(appName, title);
        closeShareModal();
      }
      return true;

    case "do-compress-from-share":
      if (S.activeShareScreenshot) {
        const { appName, item } = S.activeShareScreenshot;
        if (isSteamShots(appName)) {
          toast(i18nT("ss.steamReadOnly"), "");
          return true;
        }
        closeShareModal();
        void compressScreenshotItem(appName, item);
      }
      return true;

    case "do-native-share":
      if (S.activeShareScreenshot && typeof navigator.share === "function") {
        const item = S.activeShareScreenshot.item;
        navigator.share({
          title: item.file_name,
          text: i18nT("ss.shareText", { file: item.file_name }),
        }).catch(() => {});
        closeShareModal();
      }
      return true;

    case "compress-screenshot":
      if (id) {
        if (isSteamShots(id)) {
          toast(i18nT("ss.steamReadOnly"), "");
          return true;
        }
        const idx = parseInt(t.dataset.idx || "0", 10);
        const list = S.loadedScreenshots.get(id) || [];
        const item = list[idx];
        if (item) {
          void compressScreenshotItem(id, item);
        }
      }
      return true;

    case "compress-all-screenshots":
      if (id) {
        if (isSteamShots(id)) {
          toast(i18nT("ss.steamReadOnly"), "");
          return true;
        }
        const list = S.loadedScreenshots.get(id) || [];
        const uncompressed = list.filter((x) => !x.file_name.endsWith(".avif") && !x.file_name.endsWith(".webp"));
        if (uncompressed.length === 0) {
          toast(i18nT("ss.allCompressed"), "ok");
        } else {
          toast(i18nT("ss.compressingCount", { count: uncompressed.length }), "");
          (async () => {
            let count = 0;
            for (const item of uncompressed) {
              const res = await compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, true);
              if (res) count++;
            }
            toast(i18nT("ss.compressedCount", { count, format: S.screenshotCompressionFormat.toUpperCase() }), "ok");
          })();
        }
      }
      return true;

    default:
      return false;
  }
}
