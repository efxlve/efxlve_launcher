/**
 * Click delegation handlers for the game drawer tabs (achievements, DLCs, specs,
 * screenshots, manage), store URLs and selective install.
 */

import { S } from "../../../core/state";
import { openEpicModal } from "../../../core/render";
import { summaryOf } from "../../../core/selectors";
import type { DrawerTab } from "../../../core/types";
import { openStoreUrl } from "../../store/store-view";
import { applySelectiveInstall, closeSelectiveModal } from "../../dlc/selective-install";
import { epicOpenFolder, fetchAndRenderAchievements, fetchAndRenderRequirements } from "../../drawer/drawer-view";
import { renderBackupListHtml } from "../../drawer/drawer-widgets";
import { fetchAndRenderScreenshots } from "../../screenshots/screenshots-view";
import {
  epicAchievementsUrl,
  epicGetGameDlcs,
  epicListBackups,
  epicStorePageUrlForGame,
} from "../../../epic";

export function handleDrawerAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "selective-close":
      closeSelectiveModal();
      return true;

    case "selective-overlay-close":
      if (targetEl === t) closeSelectiveModal();
      return true;

    case "selective-apply":
      if (id) {
        const tags = Array.from(S.selectedInstallTags);
        const dlcs = Array.from(S.selectedDlcAppIds);
        void applySelectiveInstall(id, tags, dlcs);
      }
      return true;

    case "epic-open-folder":
      if (id) void epicOpenFolder(id);
      return true;

    case "epic-store-page":
      if (id) {
        if (id.startsWith("gog::")) {
          const s = summaryOf(id);
          const title = s ? s.title : id.slice(5);
          const url = `https://www.gog.com/en/games?query=${encodeURIComponent(title)}`;
          void openStoreUrl(url, "store");
        } else {
          const s = summaryOf(id);
          const title = s ? s.title : id;
          void openStoreUrl(epicStorePageUrlForGame(S.epicGamesRawMap.get(id), title), "store");
        }
      }
      return true;

    case "switch-drawer-version":
      if (id) openEpicModal(id, false);
      return true;

    case "drawer-tab": {
      const tab = t.dataset.tab as DrawerTab;
      if (tab && S.currentModalAppName) {
        if (tab === S.activeDrawerTab) return true;
        S.activeDrawerTab = tab;
        if (tab === "achievements") {
          const cached = S.loadedAchievements.get(S.currentModalAppName);
          if (!cached || cached.achievements.length === 0) {
            void fetchAndRenderAchievements(S.currentModalAppName, true);
          }
        } else if (tab === "dlcs") {
          if (!S.dlcCache.has(S.currentModalAppName) && !S.dlcLoading) {
            S.dlcLoading = true;
            epicGetGameDlcs(S.currentModalAppName)
              .then((res) => {
                S.dlcCache.set(S.currentModalAppName!, res);
                if (S.activeDrawerTab === "dlcs" && S.currentModalAppName) {
                  openEpicModal(S.currentModalAppName, false, true);
                }
              })
              .catch(() => {})
              .finally(() => {
                S.dlcLoading = false;
                if (S.activeDrawerTab === "dlcs" && S.currentModalAppName) {
                  openEpicModal(S.currentModalAppName, false, true);
                }
              });
          }
        } else if (tab === "manage") {
          if (!S.gameBackupsMap.has(S.currentModalAppName)) {
            epicListBackups(S.currentModalAppName)
              .then((b) => {
                S.gameBackupsMap.set(S.currentModalAppName!, b);
                const listEl = document.getElementById("manage-backup-list");
                if (listEl && S.currentModalAppName) {
                  listEl.innerHTML = renderBackupListHtml(S.currentModalAppName);
                }
              })
              .catch(() => {});
          }
        } else if (tab === "screenshots") {
          if (!S.loadedScreenshots.has(S.currentModalAppName)) {
            const s = summaryOf(S.currentModalAppName);
            if (s) void fetchAndRenderScreenshots(S.currentModalAppName, s.title);
          }
        } else if (tab === "specs") {
          if (!S.loadedRequirements.has(S.currentModalAppName)) {
            const s = summaryOf(S.currentModalAppName);
            if (s) void fetchAndRenderRequirements(S.currentModalAppName, s.title);
          }
        }
        openEpicModal(S.currentModalAppName, false, true);
      }
      return true;
    }

    case "sys-plat": {
      const val = t.dataset.val;
      if (val && S.currentModalAppName) {
        if (S.activeSystemPlatform === val) return true;
        S.activeSystemPlatform = val;
        openEpicModal(S.currentModalAppName, false, false);
      }
      return true;
    }

    case "req-refresh":
      if (id) {
        const s = summaryOf(id);
        if (s) void fetchAndRenderRequirements(id, s.title, true);
      }
      return true;

    case "open-store-achievements":
      if (id) {
        if (id.startsWith("gog::")) {
          const cleanId = id.slice(5);
          void openStoreUrl(`https://www.gog.com/en/game/${cleanId}`, "store");
        } else {
          const s = summaryOf(id);
          const title = s ? s.title : id;
          const url = epicAchievementsUrl(title, id);
          void openStoreUrl(url, "store");
        }
      }
      return true;

    case "clear-ach-search":
      S.achSearchQuery = "";
      if (S.currentModalAppName) {
        openEpicModal(S.currentModalAppName, false, false);
      }
      return true;

    case "ach-filter": {
      const val = t.dataset.val as "all" | "unlocked" | "locked" | "hidden";
      if (val && S.currentModalAppName) {
        if (S.activeAchFilter === val) return true;
        S.activeAchFilter = val;
        openEpicModal(S.currentModalAppName, false, false);
      }
      return true;
    }

    case "ach-reveal": {
      const achName = t.dataset.ach;
      if (achName && S.currentModalAppName) {
        const key = `${S.currentModalAppName}:${achName}`;
        if (S.revealedAchievements.has(key)) {
          S.revealedAchievements.delete(key);
        } else {
          S.revealedAchievements.add(key);
        }
        openEpicModal(S.currentModalAppName, false, false);
      }
      return true;
    }

    case "ach-refresh":
      if (id) void fetchAndRenderAchievements(id, true);
      return true;

    default:
      return false;
  }
}
