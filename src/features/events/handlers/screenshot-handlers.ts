/**
 * Click delegation handlers for game screenshot capture, deletion,
 * lightbox viewer, sharing, and batch image compression.
 */

import { toast } from "../../../core/toast";
import { localizeMessage, t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import {
  epicCaptureGameScreenshot,
  epicDeleteGameScreenshot,
  epicOpenGameScreenshotsFolder,
} from "../../../epic";
import {
  closeScreenshotDeleteConfirm,
  closeScreenshotLightbox,
  closeShareModal,
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  fetchAndRenderScreenshots,
  navigateScreenshotLightbox,
  openScreenshotDeleteConfirm,
  openScreenshotLightbox,
  openShareModal,
  playScreenshotShutterSound,
  renderDrawerScreenshots,
  takePendingScreenshotDelete,
} from "../../screenshots/screenshots-view";

export function handleScreenshotAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "capture-screenshot":
      if (id) {
        if (!S.runningGames.has(id)) {
          toast(i18nT("ss.notInGame"), "");
          return true;
        }
        const s = S.epicSummaries.find((x) => x.appName === id);
        const title = t.dataset.title || (s ? s.title : id);
        playScreenshotShutterSound();
        toast(i18nT("ss.capturing"), "");
        epicCaptureGameScreenshot(id, title)
          .then((item) => {
            toast(i18nT("ss.saved", { file: item.file_name }), "ok");
            const existing = S.loadedScreenshots.get(id) || [];
            S.loadedScreenshots.set(id, [item, ...existing.filter((x) => x.file_path !== item.file_path)]);
            if (S.screenshotCompressionEnabled) {
              void compressScreenshotItem(id, item, S.screenshotCompressionFormat, S.screenshotCompressionQuality, true);
            }
            if (S.currentModalAppName === id && S.activeDrawerTab === "screenshots") {
              const contentEl = document.getElementById("drawer-tab-content");
              const cur = S.epicSummaries.find((x) => x.appName === id);
              if (contentEl && cur) contentEl.innerHTML = renderDrawerScreenshots(cur);
            }
          })
          .catch((err) => toast(localizeMessage(String(err)), "err"));
      }
      return true;

    case "open-screenshots-folder":
      if (id) {
        const s = S.epicSummaries.find((x) => x.appName === id);
        const title = t.dataset.title || (s ? s.title : id);
        void epicOpenGameScreenshotsFolder(id, title);
      }
      return true;

    case "delete-screenshot":
      if (id) {
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
              const s = S.epicSummaries.find((x) => x.appName === pending.appName);
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
        void copyScreenshotImageToClipboard(S.activeShareScreenshot.item);
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
        const s = S.epicSummaries.find((x) => x.appName === S.activeShareScreenshot?.appName);
        const title = s ? s.title : S.activeShareScreenshot.appName;
        void epicOpenGameScreenshotsFolder(S.activeShareScreenshot.appName, title);
        closeShareModal();
      }
      return true;

    case "do-compress-from-share":
      if (S.activeShareScreenshot) {
        const { appName, item } = S.activeShareScreenshot;
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
