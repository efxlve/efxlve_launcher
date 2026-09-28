/**
 * Global click delegation router.
 *
 * A single document-level click listener dispatches every data-act /
 * data-view interaction to the corresponding feature handler. Keeping it
 * clean and modular avoids per-element listeners while strictly adhering
 * to the <1500 line rule.
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AUTO_BACKUP_KEY,
  AUTO_SHORTCUT_KEY,
  AUTO_UPDATE_KEY,
  COVER_STATS_KEY,
  HIGHLIGHT_INSTALLED_KEY,
  DIM_UNINSTALLED_KEY,
  CONTRAST_TITLES_KEY,
  INSTALLED_ICON_KEY,
  LANG_KEY,
  MINIMIZE_TRAY_KEY,
  PAUSE_ON_PLAY_KEY,
  PROFILE_CARD_CHUNK,
  SPEED_BITS_KEY,
  SS_COMPRESS_KEY,
  SS_FORMAT_KEY,
  STORE_BADGE_KEY,
  SURFACE_KEY,
  isTauri,
} from "../../core/constants";
import { scheduleAutoUpdate } from "../downloads/auto-update";
import { closeModal, viewEl } from "../../core/dom";
import { epicPlay, epicStop, refreshEpicInstalled } from "../../core/epic-actions";
import { toggleFav } from "../../core/game-view";
import {
  navGoBack,
  pushNavHistory,
  updateNavHistoryUi,
  updateOfflineModeUi,
  updatePageHeader,
  updateSidebarAccountSwitcher,
} from "../../core/nav";
import { closeAllModals, openEpicModal, render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { EpicSort, EpicViewMode, SourceFilter, View } from "../../core/types";
import { refreshEosStatus, startEosInstall } from "../eos/eos-install";
import { handleWindowResize, updateMaxIcon } from "../../core/window";
import { setLanguage, t as i18nT } from "../../i18n";
import {
  epicDetectEglGames,
  epicGetQueue,
  epicOpenFolderPath,
  epicSetAutoDesktopShortcut,
  epicSetNetworkProfile,
  epicSetOfflineMode,
  epicSyncEglInstalled,
  epicThirdPartyLaunchers,
} from "../../epic";
import { bootEpic } from "../auth/auth-actions";
import { updateColGamesListInPlace } from "../collections/collections-view";
import { hideGameIds, openHideGamesModal, unhideGameIds } from "../library/hide-games";
import { openHideAchievementsModal, unhideAchievement } from "../profile/hide-achievements";
import {
  consumeCollectionDragClick,
  refreshLibraryResultsInPlace,
  resetCardChunk,
  updateLibraryFilterInPlace,
} from "../library/library-view";
import { handleLibraryOptionAction } from "../library/library-options";
import { openPalette } from "../palette/palette";
import { closeTvMode, openTvMode } from "../gamepad/tv-mode";
import { applyPresenceSettings } from "../presence/presence";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, setAppAutoUpdate } from "../updates/update-manager";
import { loadFriends, loadPlayerProfile, openProfile, openStore, setView } from "../store/store-view";
import {
  clearNotifications,
  closeNotifPanel,
  dismissNotification,
  markAllRead,
  openNotifPanel,
  renderNotificationPanel,
} from "../notifications/notifications";
import { loadIntegrationsView, loadSettingsView, handleSettingsAction } from "../settings/settings-view";
import { resetProfileCards } from "../profile/profile-view";
import { closeChangelogModal, openChangelogModal } from "../changelog/changelog-view";
import { closeAvatarModal, openAvatarFilePicker, promptAvatarAction, removeCustomAvatar } from "../profile/profile-avatar";

// Feature action handlers
import { handleAuthAction } from "./handlers/auth-handlers";
import { handleCloudBackupAction } from "./handlers/cloud-backup-handlers";
import { handleCollectionAction } from "./handlers/collection-handlers";
import { handleCoverAction } from "./handlers/cover-handlers";
import { handleDownloadsAction } from "./handlers/downloads-handlers";
import { handleDrawerAction } from "./handlers/drawer-handlers";
import { handleManageAction } from "./handlers/manage-handlers";
import { handleScreenshotAction } from "./handlers/screenshot-handlers";

document.addEventListener("click", (e) => {
  const targetEl = e.target as HTMLElement;

  // Close the sort dropdown when clicking outside it.
  if (S.isSortDropdownOpen && !targetEl.closest(".sort-dropdown-container")) {
    S.isSortDropdownOpen = false;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) menu.classList.remove("show");
  }

  // Close the store dropdown when clicking outside it.
  if (S.isStoreDropdownOpen && !targetEl.closest(".store-dropdown-container")) {
    S.isStoreDropdownOpen = false;
    const menu = document.getElementById("store-dropdown-menu");
    if (menu) menu.classList.remove("show");
  }

  // Close the collection dropdown when clicking outside it.
  if (S.isColDropdownOpen && !targetEl.closest(".col-dropdown-container")) {
    S.isColDropdownOpen = false;
    const menu = document.getElementById("col-dropdown-menu");
    if (menu) menu.classList.remove("show");
  }

  // Close the sidebar account switcher when clicking outside it.
  if (S.isAccountSwitcherOpen && !targetEl.closest("#sb-account-host")) {
    S.isAccountSwitcherOpen = false;
    updateSidebarAccountSwitcher();
  }

  // Marker palette closes when clicking outside it.
  if (S.isMarkerPaletteOpen && !targetEl.closest(".col-marker-picker-container")) {
    S.isMarkerPaletteOpen = false;
    const pal = document.getElementById("col-marker-palette");
    if (pal) pal.classList.remove("open");
  }

  // In-modal game/collection selection.
  const gameItem = targetEl.closest<HTMLElement>(".col-game-item");
  if (gameItem) {
    const appName = gameItem.dataset.app;
    const colId = gameItem.dataset.colId;

    if (appName) {
      const nowChecked = !S.colModalSelectedApps.has(appName);
      if (nowChecked) S.colModalSelectedApps.add(appName);
      else S.colModalSelectedApps.delete(appName);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);

      const cntEl = document.getElementById("col-tab-selected-cnt") || document.getElementById("col-selected-count");
      if (cntEl) cntEl.textContent = String(S.colModalSelectedApps.size);

      const headerBadge = document.getElementById("col-header-selected-badge");
      if (headerBadge) headerBadge.textContent = i18nT("col.selectedCount", { count: S.colModalSelectedApps.size });

      const footerCnt = document.getElementById("col-footer-count");
      if (footerCnt) footerCnt.textContent = String(S.colModalSelectedApps.size);

      if (S.colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
      return;
    } else if (colId) {
      const nowChecked = !S.gameColModalSelectedCols.has(colId);
      if (nowChecked) S.gameColModalSelectedCols.add(colId);
      else S.gameColModalSelectedCols.delete(colId);

      gameItem.classList.toggle("selected", nowChecked);
      const customCb = gameItem.querySelector(".col-custom-cb");
      if (customCb) customCb.classList.toggle("checked", nowChecked);
      return;
    }
  }

  // Capture the target before any re-render detaches it from the DOM.
  const t = targetEl.closest<HTMLElement>("[data-act], [data-view]");

  // Close the notification dropdown when clicking anywhere outside it.
  if (S.notifOpen && !targetEl.closest("#notif-root") && !targetEl.closest('[data-act="toggle-notifications"]')) {
    closeNotifPanel();
  }

  if (!t) return;

  if (t.dataset.view) {
    closeAllModals();
    const targetView = t.dataset.view as View;
    setView(targetView);
    pushNavHistory({ view: targetView });
    if (S.view === "library") void bootEpic();
    if (S.view === "profile") {
      if (!S.playerProfileData && !S.profileLoading) void loadPlayerProfile();
      if (S.friends.length === 0 && !S.friendsLoading) void loadFriends();
      render();
      return;
    }
    if (S.view === "downloads") {
      render();
      void epicGetQueue().then((q) => {
        S.dlQueueStatus = q;
        render();
      }).catch(() => {});
      return;
    }
    if (S.view === "settings") {
      S.settingsSection = "account";
      render();
      void loadSettingsView();
      return;
    }
    render();
    return;
  }

  const act = t.dataset.act;
  const id = t.dataset.id;

  // Dialog containers carry this marker so a click on their body never closes
  // the modal they live in. Handle it before any domain handler.
  if (act === "prevent-modal-close") return;

  // Delegate to domain action handlers
  if (handleLibraryOptionAction(act, t)) return;
  if (handleSettingsAction(act, t)) return;
  if (handleAuthAction(act, t, id)) return;
  if (handleCloudBackupAction(act, t, id, targetEl)) return;
  if (handleCoverAction(act, t, id, targetEl)) return;
  if (handleCollectionAction(act, t, id, targetEl)) return;
  if (handleDownloadsAction(act, t, id, targetEl)) return;
  if (handleManageAction(act, t, id, targetEl)) return;
  if (handleDrawerAction(act, t, id, targetEl)) return;
  if (handleScreenshotAction(act, t, id, targetEl)) return;

  // Global Navigation & Modal Controls
  if (act === "close") {
    if (targetEl === t || t.matches(".hub-back-btn, .drawer-close, .mclose") || targetEl.closest(".hub-back-btn, .drawer-close, .mclose")) {
      closeModal();
    }
  } else if (act === "page-back") {
    if (S.currentModalAppName) {
      closeModal();
      updateNavHistoryUi();
    } else {
      navGoBack();
    }
  } else if (act === "goto-library") {
    pushNavHistory({ view: "library" });
    closeAllModals();
    setView("library");
    render();
  } else if (act === "to-top") {
    viewEl.scrollTo({ top: 0, behavior: "smooth" });
  } else if (act === "open-store") {
    const store = (t.dataset.store as "epic" | "gog") || S.activeStore || "epic";
    if (S.activeStore !== store) {
      S.activeStore = store;
      updatePageHeader();
    }
    pushNavHistory({ view: "store" });
    void openStore(store);
  } else if (act === "open-profile") {
    openProfile();
  } else if (act === "open-changelog") {
    openChangelogModal();
  } else if (act === "close-changelog-modal") {
    closeChangelogModal();
  } else if (act === "changelog-backdrop") {
    if (targetEl === t) closeChangelogModal();
  } else if (act === "toggle-notifications") {
    if (S.notifOpen) closeNotifPanel();
    else openNotifPanel();
  } else if (act === "notif-clear") {
    clearNotifications();
    renderNotificationPanel();
  } else if (act === "notif-read-all") {
    markAllRead();
    renderNotificationPanel();
  } else if (act === "notif-dismiss" && id) {
    dismissNotification(id);
    renderNotificationPanel();
  } else if (act === "notif-open" && id) {
    closeNotifPanel();
    openEpicModal(id);
  } else if (act === "profile-change-avatar") {
    promptAvatarAction();
  } else if (act === "avatar-modal-close") {
    closeAvatarModal();
  } else if (act === "avatar-modal-remove" && id) {
    removeCustomAvatar(id);
  } else if (act === "avatar-modal-upload" && id) {
    openAvatarFilePicker(id);
  } else if (act === "refresh-profile") {
    void loadPlayerProfile(true);
    void loadFriends(true);
  } else if (act === "refresh-friends") {
    void loadFriends(true);
  } else if (act === "copy-account-id") {
    const val = t.dataset.val;
    if (val) {
      navigator.clipboard.writeText(val).then(() => {
        toast(i18nT("profile.accountIdCopied"), "ok");
      }).catch(() => {
        toast(val, "");
      });
    }
  } else if (act === "open-hide-achievements") {
    openHideAchievementsModal();
  } else if (act === "profile-toggle-hidden") {
    S.profileShowHidden = !S.profileShowHidden;
    resetProfileCards();
    render();
  } else if (act === "unhide-achievement" && id) {
    unhideAchievement(id);
  } else if (act === "profile-filter" && t.dataset.val) {
    S.profileFilter = t.dataset.val as typeof S.profileFilter;
    S.profileShowHidden = false;
    resetProfileCards();
    render();
  } else if (act === "profile-show-more") {
    S.profileCardCount += PROFILE_CARD_CHUNK;
    render();
  } else if (act === "profile-search-clear") {
    S.profileSearchQuery = "";
    resetProfileCards();
    render();
  } else if (act === "open-game-from-profile") {
    const appId = t.dataset.id || (t.closest("[data-id]") as HTMLElement)?.dataset.id;
    if (appId) {
      openEpicModal(appId, true);
    }
  } else if (act === "toggle-store-dropdown") {
    S.isStoreDropdownOpen = !S.isStoreDropdownOpen;
    S.isSortDropdownOpen = false;
    S.isColDropdownOpen = false;
    const sortMenu = document.getElementById("sort-dropdown-menu");
    if (sortMenu) sortMenu.classList.remove("show");
    const colMenu = document.getElementById("col-dropdown-menu");
    if (colMenu) colMenu.classList.remove("show");
    const menu = document.getElementById("store-dropdown-menu");
    if (menu) menu.classList.toggle("show", S.isStoreDropdownOpen);
    else render();
  } else if (act === "source-filter" && t.dataset.val) {
    const val = t.dataset.val as SourceFilter;
    if (val === "all" || val === "epic" || val === "gog") {
      S.sourceFilter = val;
      S.isStoreDropdownOpen = false;
      const menu = document.getElementById("store-dropdown-menu");
      if (menu) menu.classList.remove("show");
      resetCardChunk();
      render();
    }
  } else if (act === "toggle-col-dropdown") {
    S.isColDropdownOpen = !S.isColDropdownOpen;
    S.isSortDropdownOpen = false;
    S.isStoreDropdownOpen = false;
    const sortMenu = document.getElementById("sort-dropdown-menu");
    if (sortMenu) sortMenu.classList.remove("show");
    const storeMenu = document.getElementById("store-dropdown-menu");
    if (storeMenu) storeMenu.classList.remove("show");
    const menu = document.getElementById("col-dropdown-menu");
    if (menu) menu.classList.toggle("show", S.isColDropdownOpen);
    else render();
  } else if (act === "select-col-filter") {
    if (consumeCollectionDragClick()) return;
    const colId = t.dataset.colId;
    S.isColDropdownOpen = false;
    const menu = document.getElementById("col-dropdown-menu");
    if (menu) menu.classList.remove("show");
    S.activeCollectionId = (!colId || colId === "none") ? null : colId;
    S.epicFilter = "all";
    if (!updateLibraryFilterInPlace()) {
      resetCardChunk();
      render();
    }
  } else if (act === "quick-tab" && t.dataset.tab) {
    const tab = t.dataset.tab;
    const hadCustomCol = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    if (tab === "all") {
      S.activeCollectionId = null;
      S.epicFilter = "all";
    } else if (tab === "installed") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "installed" ? "all" : "installed";
    } else if (tab === "fav") {
      S.activeCollectionId = "fav";
      S.epicFilter = "all";
    } else if (tab === "platinum") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "platinum" ? "all" : "platinum";
    } else if (tab === "collection") {
      if (consumeCollectionDragClick()) return;
      const colId = t.dataset.colId;
      if (!colId) return;
      S.activeCollectionId = colId;
      S.epicFilter = "all";
    }
    S.isSortDropdownOpen = false;
    S.isStoreDropdownOpen = false;
    S.isColDropdownOpen = false;
    const sortMenu = document.getElementById("sort-dropdown-menu");
    if (sortMenu) sortMenu.classList.remove("show");
    const storeMenu = document.getElementById("store-dropdown-menu");
    if (storeMenu) storeMenu.classList.remove("show");
    const colMenu = document.getElementById("col-dropdown-menu");
    if (colMenu) colMenu.classList.remove("show");
    const hasCustomCol = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    if (hadCustomCol !== hasCustomCol || !updateLibraryFilterInPlace()) {
      resetCardChunk();
      render();
    }
  } else if (act === "toggle-sort-dropdown") {
    S.isSortDropdownOpen = !S.isSortDropdownOpen;
    S.isStoreDropdownOpen = false;
    S.isColDropdownOpen = false;
    const storeMenu = document.getElementById("store-dropdown-menu");
    if (storeMenu) storeMenu.classList.remove("show");
    const colMenu = document.getElementById("col-dropdown-menu");
    if (colMenu) colMenu.classList.remove("show");
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) menu.classList.toggle("show", S.isSortDropdownOpen);
    else render();
  } else if (act === "select-sort") {
    const sortVal = t.dataset.sort as EpicSort;
    S.isSortDropdownOpen = false;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) menu.classList.remove("show");
    if (sortVal && sortVal !== S.epicSort) {
      S.epicSort = sortVal;
      localStorage.setItem("efxlve-sort", S.epicSort);
      resetCardChunk();
      render();
    }
  } else if (act === "open-palette") {
    openPalette();
  } else if (act === "open-tv-mode") {
    openTvMode();
  } else if (act === "close-tv-mode") {
    closeTvMode();
  } else if (act === "lib-clear-search") {
    S.query = "";
    const input = document.getElementById("search") as HTMLInputElement | null;
    if (input) input.value = "";
    if (!refreshLibraryResultsInPlace()) render();
  } else if (act === "lib-view-mode") {
    const mode = t.dataset.val as EpicViewMode;
    if ((mode === "grid" || mode === "list") && mode !== S.epicViewMode) {
      S.epicViewMode = mode;
      localStorage.setItem("efxlve-view-mode", mode);
      document.querySelectorAll<HTMLElement>("[data-act='lib-view-mode']").forEach((b) => {
        b.classList.toggle("active", b.dataset.val === mode);
      });
      if (!refreshLibraryResultsInPlace()) render();
    }
  } else if (act === "open-hide-games") {
    openHideGamesModal();
  } else if ((act === "open-external-url" || act === "open-critic-url") && t.dataset.url) {
    void openUrl(t.dataset.url);
  } else if (act === "hide-game" && id) {
    hideGameIds([id]);
  } else if (act === "unhide-game" && id) {
    unhideGameIds([id]);
  } else if (act === "unhide-selected") {
    const ids: string[] = [];
    document.querySelectorAll<HTMLInputElement>(".settings-hidden-list .selective-checkbox:checked").forEach((box) => {
      const rowId = box.closest<HTMLElement>("[data-hidden-row]")?.dataset.id;
      if (rowId) ids.push(rowId);
    });
    unhideGameIds(ids);
  } else if (act === "epic-fav" && id) {
    toggleFav(id);
  } else if (act === "epic-detail" && id) {
    openEpicModal(id);
  } else if (act === "epic-play" && id) {
    void epicPlay(id);
  } else if (act === "epic-stop" && id) {
    void epicStop(id);
  } else if (act === "epic-sync-egl") {
    if (S.eglSyncing) return;
    S.eglSyncing = true;
    render();
    epicSyncEglInstalled()
      .then(async (synced) => {
        await refreshEpicInstalled();
        S.eglDetectedList = await epicDetectEglGames().catch(() => []);
        toast(synced > 0 ? i18nT("dl.syncedCount", { count: synced }) : i18nT("dl.allSynced"), "ok");
      })
      .catch((e: unknown) => toast(i18nT("dl.syncFailed", { msg: String(e) }), "err"))
      .finally(() => {
        S.eglSyncing = false;
        render();
      });
  } else if (act === "epic-refresh-egl") {
    void loadIntegrationsView(true);
  } else if (act === "third-party-refresh") {
    epicThirdPartyLaunchers()
      .then((list) => {
        S.thirdPartyLaunchers = list;
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "toggle-auto-desktop-shortcut") {
    S.autoDesktopShortcut = !S.autoDesktopShortcut;
    localStorage.setItem(AUTO_SHORTCUT_KEY, String(S.autoDesktopShortcut));
    void epicSetAutoDesktopShortcut(S.autoDesktopShortcut);
    render();
  } else if (act === "toggle-offline-mode") {
    S.offlineMode = !S.offlineMode;
    updateOfflineModeUi();
    void epicSetOfflineMode(S.offlineMode);
    toast(i18nT(S.offlineMode ? "net.offlineOn" : "net.offlineOff"), "ok");
    render();
  } else if (act === "set-net-profile") {
    const prof = t.dataset.profile;
    if (prof) {
      S.networkProfile = prof;
      void epicSetNetworkProfile(prof);
      const label = prof === "max" ? i18nT("settings.netMax") : prof === "low" ? i18nT("settings.netLow") : i18nT("settings.netBalanced");
      toast(i18nT("net.profileToast", { label }), "ok");
      render();
    }
  } else if (act === "set-app-language") {
    const lang = t.dataset.lang;
    if (lang && lang !== S.appLanguage) {
      S.appLanguage = lang;
      S.trCollator = new Intl.Collator(lang, { sensitivity: "base", numeric: true });
      localStorage.setItem(LANG_KEY, lang);
      void setLanguage(lang).then(() => {
        updateOfflineModeUi();
        if (isTauri) {
          void invoke("app_set_tray_labels", { show: i18nT("tray.show"), quit: i18nT("tray.quit") }).catch(() => {});
        }
        toast(i18nT("settings.langSet"), "ok");
        render();
        if (S.currentModalAppName) openEpicModal(S.currentModalAppName, false);
      });
    }
  } else if (act === "toggle-presence") {
    S.presenceEnabled = !S.presenceEnabled;
    applyPresenceSettings();
    render();
  } else if (act === "refresh-eos") {
    void refreshEosStatus();
  } else if (act === "install-eos") {
    void startEosInstall();
  } else if (act === "open-eos-folder") {
    if (S.eosOverlay?.installed && S.eosOverlay.path) {
      void epicOpenFolderPath(S.eosOverlay.path).catch((e: unknown) => toast(String(e), "err"));
    }
  } else if (act === "toggle-speed-bits") {
    S.speedInBits = !S.speedInBits;
    localStorage.setItem(SPEED_BITS_KEY, String(S.speedInBits));
    render();
  } else if (act === "settings-section" && t.dataset.section) {
    S.settingsSection = t.dataset.section as typeof S.settingsSection;
    render();
    if (S.settingsSection === "integrations") void loadIntegrationsView();
  } else if (act === "set-surface") {
    const surface = t.dataset.surface === "epic" ? "epic" : "black";
    S.surface = surface;
    localStorage.setItem(SURFACE_KEY, surface);
    if (surface === "epic") document.documentElement.dataset.surface = "epic";
    else delete document.documentElement.dataset.surface;
    render();
  } else if (act === "toggle-cover-stats") {
    S.showCoverStats = !S.showCoverStats;
    localStorage.setItem(COVER_STATS_KEY, String(S.showCoverStats));
    render();
  } else if (act === "toggle-store-badge") {
    S.showStoreBadge = !S.showStoreBadge;
    localStorage.setItem(STORE_BADGE_KEY, String(S.showStoreBadge));
    scheduleRender();
  } else if (act === "toggle-installed-icon") {
    S.showInstalledIcon = !S.showInstalledIcon;
    localStorage.setItem(INSTALLED_ICON_KEY, String(S.showInstalledIcon));
    scheduleRender();
  } else if (act === "toggle-highlight-installed" || act === "toggle-dim-uninstalled" || act === "toggle-contrast-titles") {
    S.highlightInstalled = !S.highlightInstalled;
    S.dimUninstalled = S.highlightInstalled;
    S.contrastTitles = S.highlightInstalled;
    localStorage.setItem(HIGHLIGHT_INSTALLED_KEY, String(S.highlightInstalled));
    localStorage.setItem(DIM_UNINSTALLED_KEY, String(S.highlightInstalled));
    localStorage.setItem(CONTRAST_TITLES_KEY, String(S.highlightInstalled));
    scheduleRender();
  } else if (act === "toggle-minimize-tray") {
    S.minimizeToTray = !S.minimizeToTray;
    localStorage.setItem(MINIMIZE_TRAY_KEY, String(S.minimizeToTray));
    if (isTauri) {
      void invoke("app_set_minimize_to_tray", { enabled: S.minimizeToTray }).catch(() => {});
    }
    render();
  } else if (act === "toggle-auto-backup") {
    S.autoBackupOnExit = !S.autoBackupOnExit;
    localStorage.setItem(AUTO_BACKUP_KEY, String(S.autoBackupOnExit));
    render();
  } else if (act === "toggle-auto-update") {
    S.autoUpdateEnabled = !S.autoUpdateEnabled;
    localStorage.setItem(AUTO_UPDATE_KEY, String(S.autoUpdateEnabled));
    scheduleAutoUpdate();
    render();
  } else if (act === "app-update-check") {
    void checkForAppUpdate(true);
  } else if (act === "app-update-download") {
    void downloadAppUpdate();
  } else if (act === "app-update-install") {
    void installAppUpdate();
  } else if (act === "toggle-app-auto-update") {
    setAppAutoUpdate(!S.appAutoUpdate);
    render();
  } else if (act === "toggle-pause-on-play") {
    S.pauseOnPlay = !S.pauseOnPlay;
    localStorage.setItem(PAUSE_ON_PLAY_KEY, String(S.pauseOnPlay));
    render();
  } else if (act === "toggle-screenshot-compression") {
    S.screenshotCompressionEnabled = !S.screenshotCompressionEnabled;
    localStorage.setItem(SS_COMPRESS_KEY, String(S.screenshotCompressionEnabled));
    toast(i18nT(S.screenshotCompressionEnabled ? "ss.compressionOn" : "ss.compressionOff"), "ok");
    render();
  } else if (act === "set-ss-format" && t.dataset.format) {
    const fmt = t.dataset.format as "avif" | "webp" | "jpg";
    S.screenshotCompressionFormat = fmt;
    localStorage.setItem(SS_FORMAT_KEY, fmt);
    toast(i18nT("ss.formatSet", { format: fmt.toUpperCase() }), "ok");
    render();
  } else if (act === "record-screenshot-hotkey") {
    S.isRecordingScreenshotHotkey = !S.isRecordingScreenshotHotkey;
    if (S.isRecordingScreenshotHotkey) {
      toast(i18nT("settings.pressKeyToast"), "");
    }
    render();
  } else if (act === "win-minimize") {
    if (isTauri) void invoke("app_minimize");
  } else if (act === "win-maximize") {
    if (isTauri) {
      void invoke<boolean>("app_toggle_maximize").then((isMax) => {
        updateMaxIcon(isMax);
        handleWindowResize();
        window.setTimeout(handleWindowResize, 100);
        window.setTimeout(handleWindowResize, 250);
        window.setTimeout(handleWindowResize, 500);
      });
    }
  } else if (act === "win-close") {
    if (isTauri) void invoke("app_close");
  }
});
