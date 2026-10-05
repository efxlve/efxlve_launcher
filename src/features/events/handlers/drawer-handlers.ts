/**
 * Click delegation handlers for the game drawer tabs (achievements, DLCs, specs,
 * screenshots, manage), store URLs and selective install.
 */

import { FAV_KEY } from "../../../core/constants";
import { S } from "../../../core/state";
import { openEpicModal } from "../../../core/render";
import { gameVersionsOf, isCompanionSource, sourceOfKey, summaryOf } from "../../../core/selectors";
import type { DrawerTab } from "../../../core/types";
import { refreshLibraryResultsInPlace } from "../../library/library-view";
import { rememberPreferredVersion } from "../../library/store-filter";
import { openStoreUrl, storeUrlFor } from "../../store/store-view";
import { applySelectiveInstall, closeSelectiveModal, renderSelectiveModal } from "../../dlc/selective-install";
import { epicOpenFolder, fetchAndRenderAchievements, fetchAndRenderRequirements, isCompanionApp } from "../../drawer/drawer-view";
import { renderBackupListHtml } from "../../drawer/drawer-widgets";
import { fetchAndRenderScreenshots } from "../../screenshots/screenshots-view";
import {
  epicAchievementsUrl,
  epicGetGameDlcs,
  epicListBackups,
  epicStorePageUrlForGame,
} from "../../../epic";

/** Saves the chosen store copy and shows it on the open game page and in the library. */
function selectGameVersion(appName: string): void {
  rememberPreferredVersion(appName);
  const versions = gameVersionsOf(appName);
  if (versions.some((version) => S.epicFav.has(version.appName)) && !S.epicFav.has(appName)) {
    S.epicFav.add(appName);
    localStorage.setItem(FAV_KEY, JSON.stringify([...S.epicFav]));
  }
  const open = S.currentModalAppName;
  if (open && versions.some((version) => version.appName === open)) {
    openEpicModal(appName, false);
  }
  if (S.view === "library") refreshLibraryResultsInPlace();
}

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

    case "selective-bulk": {
      // Section-wide select/clear for the optional language, extra pack and
      // add-on lists. Installed add-ons are always skipped: they are already
      // on disk and must not be queued again.
      const opts = S.selectiveInstallOptions;
      const group = t.dataset.group;
      const selectAll = t.dataset.mode === "all";
      if (!opts || !group) return true;
      if (group === "dlcs") {
        for (const dlc of opts.dlcs) {
          if (dlc.installed) continue;
          if (selectAll) S.selectedDlcAppIds.add(dlc.appId);
          else S.selectedDlcAppIds.delete(dlc.appId);
        }
      } else {
        for (const tag of opts.tags) {
          if (tag.category !== group) continue;
          if (selectAll) S.selectedInstallTags.add(tag.tag);
          else S.selectedInstallTags.delete(tag.tag);
        }
      }
      renderSelectiveModal();
      return true;
    }

    case "epic-open-folder":
      if (id) void epicOpenFolder(id);
      return true;

    case "epic-store-page":
      if (id) {
        const source = sourceOfKey(id);
        // Amazon Games has no storefront in the launcher: nothing to open.
        if (source === "amazon") return true;
        if (isCompanionSource(source)) {
          // The id is not an Epic app name: open the owning storefront in the
          // embedded store, with Ubisoft's search filtered to the title. Riot
          // has no web storefront (its shop lives in the client), so there is
          // nothing to open.
          if (source === "riot") return true;
          const s = summaryOf(id);
          const title = s ? s.title : id;
          const url = source === "ubisoft"
            ? `https://store.ubi.com/search?q=${encodeURIComponent(title)}`
            : storeUrlFor(source);
          void openStoreUrl(url, "store");
        } else if (id.startsWith("gog::")) {
          const s = summaryOf(id);
          const title = s ? s.title : id.slice(5);
          const url = `https://www.gog.com/en/games?query=${encodeURIComponent(title)}`;
          void openStoreUrl(url, "store");
        } else if (id.startsWith("steam::")) {
          // Steam is a first-class storefront in the embedded store view.
          void openStoreUrl(`https://store.steampowered.com/app/${id.slice(7)}`, "store");
        } else {
          const s = summaryOf(id);
          const title = s ? s.title : id;
          void openStoreUrl(epicStorePageUrlForGame(S.epicGamesRawMap.get(id), title), "store");
        }
      }
      return true;

    case "switch-drawer-version":
    case "prefer-version":
      S.isVersionDropdownOpen = false;
      if (id) selectGameVersion(id);
      return true;

    case "toggle-version-dropdown":
      S.isVersionDropdownOpen = !S.isVersionDropdownOpen;
      document.getElementById("version-dropdown-menu")?.classList.toggle("show", S.isVersionDropdownOpen);
      document.querySelector<HTMLElement>(".gp-version-trigger")?.setAttribute("aria-expanded", String(S.isVersionDropdownOpen));
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
          if (!isCompanionApp(S.currentModalAppName) && !S.dlcCache.has(S.currentModalAppName) && !S.dlcLoading) {
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

    case "ach-tier-filter": {
      const tier = t.dataset.tier as typeof S.achTierFilter | undefined;
      if (tier && S.currentModalAppName) {
        // Clicking the active tier clears the filter again.
        S.achTierFilter = S.achTierFilter === tier ? "all" : tier;
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
