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
  epicSetScreenshotDisabledGames,
  screenshotShareDiscord,
} from "../../../epic";
import { openEpicModal } from "../../../core/render";
import { openScreenshotEditor } from "../../screenshots/screenshot-editor";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SS_WEBHOOK_KEY } from "../../../core/constants";

/** The full-resolution PNG of a shot, for services that cannot take AVIF. */
async function sharePngDataUrl(appName: string, item: GameScreenshotItem): Promise<string | null> {
  const src = await ensureFullShot(appName, item);
  if (!src) return null;
  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = () => resolve(undefined);
    image.onerror = () => reject(new Error("image"));
    image.src = src;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}
import {
  closeScreenshotDeleteConfirm,
  closeScreenshotLightbox,
  closeShareModal,
  clearGallerySelection,
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  ensureFullShot,
  fetchAndRenderScreenshots,
  forgetFullShot,
  gallerySelectedItems,
  isBatchDeleteArmed,
  navigateScreenshotLightbox,
  openScreenshotDeleteConfirm,
  openScreenshotLightbox,
  openShareModal,
  repaintDrawerShots,
  setBatchDeleteArmed,
  setGalleryFilter,
  setGallerySelectMode,
  takePendingScreenshotDelete,
  toggleGallerySelection,
} from "../../screenshots/screenshots-view";
import type { GameScreenshotItem } from "../../../epic";
import { ssToggleFavorite } from "../../screenshots/ss-settings";
import { SS_DENSITY_KEY, SS_SORT_KEY } from "../../../core/constants";

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
    case "edit-screenshot": {
      const appKey = t.dataset.id ?? id ?? "";
      const list = S.loadedScreenshots.get(appKey) || [];
      const shot = list[Number(t.dataset.idx ?? "-1")];
      if (shot) openScreenshotEditor(shot);
      return true;
    }

    case "ssg-filter": {
      const filter = t.dataset.filter;
      if (filter === "all" || filter === "raw" || filter === "compressed" || filter === "favorites") {
        setGalleryFilter(filter);
        repaintDrawerShots();
      }
      return true;
    }

    case "ssg-sort": {
      const sort = t.dataset.sort;
      if (sort === "newest" || sort === "oldest" || sort === "name" || sort === "size") {
        localStorage.setItem(SS_SORT_KEY, sort);
        repaintDrawerShots();
      }
      return true;
    }

    case "ssg-density": {
      const density = t.dataset.density;
      if (density === "s" || density === "m" || density === "l") {
        localStorage.setItem(SS_DENSITY_KEY, density);
        repaintDrawerShots();
      }
      return true;
    }

    case "ssg-select": {
      const active = t.classList.contains("active");
      setGallerySelectMode(!active);
      repaintDrawerShots();
      return true;
    }

    case "ssg-toggle-select": {
      const path = t.dataset.path;
      if (path) {
        toggleGallerySelection(path);
        repaintDrawerShots();
      }
      return true;
    }

    case "ssg-favorite": {
      const path = t.dataset.path;
      if (path) {
        const favorite = ssToggleFavorite(path);
        toast(i18nT(favorite ? "ss.favorited" : "ss.unfavorited"), "ok");
        repaintDrawerShots();
      }
      return true;
    }

    case "ssg-batch-clear":
      clearGallerySelection();
      repaintDrawerShots();
      return true;

    case "ssg-batch-copy": {
      const paths = gallerySelectedItems().map((entry) => entry.item.file_path);
      if (paths.length === 0) return true;
      navigator.clipboard
        .writeText(paths.join("\n"))
        .then(() => toast(i18nT("ss.pathsCopied", { count: String(paths.length) }), "ok"))
        .catch(() => toast(paths.join(", "), ""));
      return true;
    }

    case "ssg-batch-compress": {
      const entries = gallerySelectedItems().filter((entry) => {
        const name = entry.item.file_name;
        return !name.endsWith(".avif") && !name.endsWith(".webp") && !isSteamShots(entry.appName);
      });
      if (entries.length === 0) return true;
      toast(i18nT("ss.compressingCount", { count: String(entries.length) }), "");
      void (async () => {
        for (const entry of entries) {
          await compressScreenshotItem(
            entry.appName,
            entry.item,
            S.screenshotCompressionFormat,
            S.screenshotCompressionQuality,
            true,
          ).catch(() => undefined);
        }
        clearGallerySelection();
        toast(i18nT("ss.compressedCount", { count: String(entries.length) }), "ok");
        repaintDrawerShots();
      })();
      return true;
    }

    case "ssg-batch-delete": {
      const entries = gallerySelectedItems();
      if (entries.length === 0) return true;
      if (!isBatchDeleteArmed()) {
        setBatchDeleteArmed(true);
        repaintDrawerShots();
        return true;
      }
      setBatchDeleteArmed(false);
      void (async () => {
        let removed = 0;
        for (const entry of entries) {
          try {
            if (await epicDeleteGameScreenshot(entry.item.file_path)) {
              forgetFullShot(entry.item.file_path);
              removed += 1;
            }
          } catch {
            // One locked file must not stop the rest.
          }
        }
        clearGallerySelection();
        toast(i18nT("ss.batchDeleted", { count: String(removed) }), "ok");
        const appName = S.currentModalAppName;
        if (appName) void fetchAndRenderScreenshots(appName, summaryOf(appName)?.title || appName, true);
        repaintDrawerShots();
      })();
      return true;
    }

    case "toggle-game-capture": {
      const key = t.dataset.id ?? id ?? "";
      if (!key) return true;
      const current = S.epicSettingsCache?.screenshot_disabled_games ?? [];
      const off = current.includes(key);
      const next = off ? current.filter((item) => item !== key) : [...current, key];
      epicSetScreenshotDisabledGames(next)
        .then(() => {
          if (S.epicSettingsCache) S.epicSettingsCache.screenshot_disabled_games = next;
          toast(i18nT(off ? "ss.gameCaptureOnToast" : "ss.gameCaptureOffToast"), "ok");
          if (S.currentModalAppName === key) openEpicModal(key, false);
        })
        .catch((error) => toast(String(error), "err"));
      return true;
    }

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

    case "do-share-discord": {
      const active = S.activeShareScreenshot;
      if (!active) return true;
      const webhook = (localStorage.getItem(SS_WEBHOOK_KEY) ?? "").trim();
      if (!webhook) {
        toast(i18nT("ss.shareDiscordSetup"), "err");
        closeShareModal();
        return true;
      }
      const game = summaryOf(active.appName)?.title || active.item.game_title || "";
      void (async () => {
        toast(i18nT("ss.shareSending"), "");
        try {
          // Discord cannot render AVIF: those go up as a PNG built here.
          const needsPng = active.item.file_name.toLowerCase().endsWith(".avif");
          const dataUrl = needsPng ? await sharePngDataUrl(active.appName, active.item) : null;
          await screenshotShareDiscord({
            webhook,
            filePath: needsPng ? null : active.item.file_path,
            dataUrl,
            fileName: active.item.file_name,
            message: i18nT("ss.shareMessage", { game }),
          });
          toast(i18nT("ss.shareSent"), "ok");
          closeShareModal();
        } catch (error) {
          toast(String(error), "err");
        }
      })();
      return true;
    }

    case "do-share-x": {
      const active = S.activeShareScreenshot;
      if (!active) return true;
      const game = summaryOf(active.appName)?.title || active.item.game_title || "";
      void (async () => {
        const copied = await copyScreenshotImageToClipboard(active.item, active.appName).catch(() => false);
        toast(i18nT(copied ? "ss.shareCopiedPaste" : "ss.copyFailed"), copied ? "ok" : "err");
        void openUrl(`https://twitter.com/intent/tweet?text=${encodeURIComponent(i18nT("ss.shareMessage", { game }))}`).catch(() => undefined);
        closeShareModal();
      })();
      return true;
    }

    case "do-share-reddit": {
      const active = S.activeShareScreenshot;
      if (!active) return true;
      const game = summaryOf(active.appName)?.title || active.item.game_title || "";
      void (async () => {
        const copied = await copyScreenshotImageToClipboard(active.item, active.appName).catch(() => false);
        toast(i18nT(copied ? "ss.shareCopiedPaste" : "ss.copyFailed"), copied ? "ok" : "err");
        void openUrl(`https://www.reddit.com/submit?title=${encodeURIComponent(i18nT("ss.shareMessage", { game }))}`).catch(() => undefined);
        closeShareModal();
      })();
      return true;
    }

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
