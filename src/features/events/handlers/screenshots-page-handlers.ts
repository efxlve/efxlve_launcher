/**
 * Click actions for the Screenshots page: the library-wide gallery, its
 * toolbar, its batch bar and its lightbox.
 *
 * Kept apart from the game page's handlers (`ssg-*`) because the two surfaces
 * keep their own filter and selection state; everything they share (favorites,
 * sort, density, compression) comes from `ss-settings`.
 */

import { SS_DENSITY_KEY, SS_SORT_KEY } from "../../../core/constants";
import { t } from "../../../i18n";
import { toast } from "../../../core/toast";
import { S } from "../../../core/state";
import {
  clearPageSelection,
  closeClipDialog,
  closePageLightbox,
  deletePageShot,
  dropClip,
  fitClipShareRange,
  grabClipFrame,
  isPageBatchDeleteArmed,
  loadScreenshotsPage,
  navigatePageLightbox,
  openClipFolder,
  openClipJoin,
  openClipShare,
  openClipStudio,
  openClipTrim,
  openPageLightbox,
  openPageShotFolder,
  pageLightboxShot,
  repaintScreenshotsPage,
  saveClipJoin,
  saveClipTrim,
  selectedPageShots,
  sendClipShare,
  setClipTrimIn,
  setClipTrimOut,
  setPageBatchDeleteArmed,
  setPageFilter,
  setPageSelectMode,
  setSearchQuery,
  setStudioTab,
  toggleClipPlayback,
  togglePageFavorite,
  togglePageSelection,
  type StudioTab,
} from "../../screenshots/screenshots-page";
import { clipDelete } from "../../../epic";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  openShareModal,
} from "../../screenshots/screenshots-view";
import { openScreenshotEditor } from "../../screenshots/screenshot-editor";

/** One selection flip and the repaint that follows. */
function repaint(): void {
  repaintScreenshotsPage();
}

export function handleScreenshotsPageAction(
  act: string | undefined,
  el: HTMLElement,
  targetEl?: HTMLElement,
): boolean {
  switch (act) {
    case "ssp-tab": {
      const tab = el.dataset.tab as StudioTab | undefined;
      if (tab) {
        setStudioTab(tab);
        repaint();
      }
      return true;
    }

    case "ssp-search-clear":
      setSearchQuery("");
      repaint();
      return true;

    case "ssp-filter": {
      const value = el.dataset.filter;
      if (value === "all" || value === "favorites" || value === "raw" || value === "compressed") {
        setPageFilter(value);
        repaint();
      }
      return true;
    }

    case "ssp-sort": {
      const value = el.dataset.sort;
      if (value === "newest" || value === "oldest" || value === "name" || value === "size") {
        localStorage.setItem(SS_SORT_KEY, value);
        repaint();
      }
      return true;
    }

    case "ssp-density": {
      const value = el.dataset.density;
      if (value === "s" || value === "m" || value === "l") {
        localStorage.setItem(SS_DENSITY_KEY, value);
        repaint();
      }
      return true;
    }

    case "ssp-select":
      setPageSelectMode(!el.classList.contains("active"));
      repaint();
      return true;

    case "ssp-toggle-select": {
      const path = el.dataset.path;
      if (path) {
        togglePageSelection(path);
        repaint();
      }
      return true;
    }

    case "ssp-favorite": {
      const path = el.dataset.path;
      if (path) {
        const favorite = togglePageFavorite(path);
        toast(t(favorite ? "ss.favorited" : "ss.unfavorited"), "ok");
      }
      return true;
    }

    case "ssp-open": {
      const index = Number(el.dataset.index ?? "-1");
      if (index >= 0) openPageLightbox(index);
      return true;
    }

    case "ssp-refresh":
      loadScreenshotsPage(true);
      return true;

    case "ssp-batch-clear":
      clearPageSelection();
      repaint();
      return true;

    case "ssp-batch-copy": {
      const paths = selectedPageShots().map((item) => item.file_path);
      if (paths.length === 0) return true;
      navigator.clipboard
        .writeText(paths.join("\n"))
        .then(() => toast(t("ss.pathsCopied", { count: String(paths.length) }), "ok"))
        .catch(() => toast(paths.join(", "), ""));
      return true;
    }

    case "ssp-batch-compress": {
      const items = selectedPageShots().filter(
        (item) => !item.file_name.endsWith(".avif") && !item.file_name.endsWith(".webp"),
      );
      if (items.length === 0) return true;
      toast(t("ss.compressingCount", { count: String(items.length) }), "");
      void (async () => {
        for (const item of items) {
          await compressScreenshotItem(
            "",
            item,
            S.screenshotCompressionFormat,
            S.screenshotCompressionQuality,
            true,
          ).catch(() => undefined);
        }
        clearPageSelection();
        toast(t("ss.compressedCount", { count: String(items.length) }), "ok");
        loadScreenshotsPage(true);
      })();
      return true;
    }

    case "ssp-batch-delete": {
      const items = selectedPageShots();
      if (items.length === 0) return true;
      if (!isPageBatchDeleteArmed()) {
        setPageBatchDeleteArmed(true);
        repaint();
        return true;
      }
      setPageBatchDeleteArmed(false);
      void (async () => {
        let removed = 0;
        for (const item of items) {
          if (await deletePageShot(item)) removed += 1;
        }
        clearPageSelection();
        toast(t("ss.batchDeleted", { count: String(removed) }), "ok");
        loadScreenshotsPage(true);
      })();
      return true;
    }

    /* ---------- Lightbox ---------- */

    case "ssp-clip-studio":
    case "ssp-clip-play": {
      const path = el.dataset.path ?? "";
      if (path) void openClipStudio(path);
      return true;
    }

    case "clip-open-external": {
      const path = el.dataset.path ?? "";
      if (path) void openPath(path).catch(() => toast(path, ""));
      return true;
    }

    case "clip-toggle-play":
      toggleClipPlayback();
      return true;

    case "clip-set-in":
      setClipTrimIn();
      return true;

    case "clip-set-out":
      setClipTrimOut();
      return true;

    case "clip-frame-grab":
      void grabClipFrame();
      return true;

    case "ssp-clip-folder": {
      const path = el.dataset.path ?? "";
      if (path) openClipFolder(path);
      return true;
    }

    case "ssp-clip-delete": {
      const path = el.dataset.path ?? "";
      if (!path) return true;
      void clipDelete(path)
        .then((ok) => {
          if (ok) {
            dropClip(path);
            toast(t("ss.clipDeleted"), "ok");
          }
        })
        .catch((error) => toast(String(error), "err"));
      return true;
    }

    case "clip-trim": {
      const path = el.dataset.path ?? "";
      if (path) void openClipTrim(path);
      return true;
    }

    case "clip-trim-save":
      void saveClipTrim();
      return true;

    case "clip-share": {
      const path = el.dataset.path ?? "";
      if (path) void openClipShare(path);
      return true;
    }

    case "clip-share-fit":
      fitClipShareRange();
      return true;

    case "clip-share-send":
      void sendClipShare(el.dataset.webhookId ?? "");
      return true;

    case "clip-join":
      openClipJoin();
      return true;

    case "clip-join-save":
      void saveClipJoin();
      return true;

    case "clip-dialog-close":
      closeClipDialog();
      return true;

    case "clip-dialog-backdrop":
      // Only the backdrop itself closes; a click inside the card must not.
      if (targetEl === el) closeClipDialog();
      return true;

    case "ssp-lightbox-close":
      closePageLightbox();
      repaint();
      return true;

    case "ssp-lightbox-backdrop":
      if (targetEl === el) {
        closePageLightbox();
        repaint();
      }
      return true;

    case "ssp-lightbox-stage":
      // A click on the empty stage closes; the image and arrows are inside it.
      if (targetEl === el) {
        closePageLightbox();
        repaint();
      }
      return true;

    case "ssp-lightbox-prev":
      navigatePageLightbox(-1);
      return true;

    case "ssp-lightbox-next":
      navigatePageLightbox(1);
      return true;

    case "ssp-lightbox-favorite": {
      const shot = pageLightboxShot();
      if (shot) {
        const favorite = togglePageFavorite(shot.file_path);
        toast(t(favorite ? "ss.favorited" : "ss.unfavorited"), "ok");
      }
      return true;
    }

    case "ssp-lightbox-edit": {
      const shot = pageLightboxShot();
      if (shot) {
        closePageLightbox();
        repaint();
        openScreenshotEditor(shot);
      }
      return true;
    }

    case "ssp-lightbox-share": {
      const shot = pageLightboxShot();
      if (shot) openShareModal("", shot);
      return true;
    }

    case "ssp-lightbox-copy": {
      const shot = pageLightboxShot();
      if (shot) {
        void copyScreenshotImageToClipboard(shot).then((ok) => {
          toast(t(ok ? "ss.copied" : "ss.copyFailed"), ok ? "ok" : "err");
        });
      }
      return true;
    }

    case "ssp-lightbox-compress": {
      const shot = pageLightboxShot();
      if (!shot) return true;
      void compressScreenshotItem(
        "",
        shot,
        S.screenshotCompressionFormat,
        S.screenshotCompressionQuality,
        false,
      )
        .then(() => {
          toast(t("ss.compressed"), "ok");
          closePageLightbox();
          loadScreenshotsPage(true);
        })
        .catch((error) => toast(String(error), "err"));
      return true;
    }

    case "ssp-lightbox-delete": {
      const shot = pageLightboxShot();
      if (!shot) return true;
      void deletePageShot(shot).then((ok) => {
        toast(t(ok ? "ss.deleted" : "ss.deleteFailed"), ok ? "ok" : "err");
      });
      return true;
    }

    case "ssp-lightbox-folder": {
      const shot = pageLightboxShot();
      if (shot) openPageShotFolder(shot);
      return true;
    }

    default:
      return false;
  }
}
