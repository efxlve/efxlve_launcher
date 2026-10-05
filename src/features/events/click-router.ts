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
  STEAM_EXIT_AFTER_PLAY_KEY,
  PROFILE_CARD_CHUNK,
  SPEED_BITS_KEY,
  SS_COMPRESS_KEY,
  SS_FORMAT_KEY,
  SHOW_SHARED_LIBRARY_KEY,
  STORE_BADGE_KEY,
  STORE_ICONS_KEY,
  STORE_COLUMN_KEY,
  ACH_PROGRESS_KEY,
  SURFACE_KEY,
  TV_AUTO_KEY,
  CONTROLLER_BRIDGE_KEY,
  MINIMIZE_ON_GAME_KEY,
  AUTOSTART_INIT_KEY,
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
} from "../../core/nav";
import { refreshSidebarToggle, toggleSidebarDrawer } from "../../core/sidebar-layout";
import { closeAllModals, openEpicModal, render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { EpicSort, EpicViewMode, View } from "../../core/types";
import { refreshEosStatus, startEosInstall, declineEosOverlay } from "../eos/eos-install";
import { handleWindowResize, updateMaxIcon, appSetAutostart } from "../../core/window";
import { setLanguage, t as i18nT } from "../../i18n";
import {
  epicDetectEglGames,
  epicGetQueue,
  epicOpenFolderPath,
  epicSetAutoDesktopShortcut,
  epicSetGogComet,
  epicSetNetworkProfile,
  epicSetOfflineMode,
  epicSyncEglInstalled,
  controllerBridgeStart,
  controllerBridgeStop,
} from "../../epic";
import { bootEpic } from "../auth/auth-actions";
import { updateColGamesListInPlace } from "../collections/collections-view";
import { hideGameIds, openHideGamesModal, unhideGameIds } from "../library/hide-games";
import { openHideAchievementsModal, unhideAchievement } from "../profile/hide-achievements";
import {
  consumeCollectionDragClick,
  refreshLibraryForStoreFilter,
  refreshLibraryResultsInPlace,
  resetCardChunk,
  syncLibFilterUi,
  updateLibraryFilterInPlace,
} from "../library/library-view";
import { clearLibFilters, toggleLibFilter } from "../library/library-filters";
import { handleLibraryOptionAction } from "../library/library-options";
import { loadSharedLibrary } from "../library/shared-library";
import { loadCompanionLibrary } from "../library/companion-library";
import { companionGameAction, companionLink, companionOpenClient, companionSetCloseAfterPlay, companionUnlink, eaLoginOpen, xboxLoginOpen, type CompanionStore } from "../../companion";
import { applyStoreFilter } from "../library/store-filter";
import { rebuildAllGamesMap } from "../../core/selectors";
import { switchAccount } from "../auth/account-switcher";
import { switchGogAccount } from "../auth/gog-account-switcher";
import { openPalette } from "../palette/palette";
import { closeTvMode, openTvMode } from "../gamepad/tv-mode";
import { applyPresenceSettings } from "../presence/presence";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, setAppAutoUpdate } from "../updates/update-manager";
import { BATTLENET_ACCOUNT_URL, isHeaderStore, loadPlayerProfile, openProfile, openStore, openStoreUrl, scrollStoreTabs, setStoreHidden, setStoreLogosOnly, setView, UBISOFT_LOGIN_URL } from "../store/store-view";
import {
  clearNotifications,
  closeNotifPanel,
  dismissNotification,
  markAllRead,
  openNotifPanel,
  renderNotificationPanel,
} from "../notifications/notifications";
import { loadIntegrationsView, loadControllerView, loadLaunchersView, loadSettingsView, handleSettingsAction } from "../settings/settings-view";
import { resetProfileCards } from "../profile/profile-view";
import { closeChangelogModal, openChangelogModal } from "../changelog/changelog-view";
import { closeAvatarModal, closeChangeNameModal, openAvatarFilePicker, openChangeNameModal, promptAvatarAction, removeCustomAvatar, saveProfileName } from "../profile/profile-avatar";

// Feature action handlers
import { handleAuthAction } from "./handlers/auth-handlers";
import { handleCloudBackupAction } from "./handlers/cloud-backup-handlers";
import { handleCollectionAction } from "./handlers/collection-handlers";
import { handleCoverAction } from "./handlers/cover-handlers";
import { handleDownloadsAction } from "./handlers/downloads-handlers";
import { handleDrawerAction } from "./handlers/drawer-handlers";
import { handleManageAction } from "./handlers/manage-handlers";
import { handleScreenshotAction } from "./handlers/screenshot-handlers";
import { handleSteamAction } from "./handlers/steam-handlers";

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

  // Close the game page store dropdown when clicking outside it.
  if (S.isVersionDropdownOpen && !targetEl.closest(".gp-version-dropdown")) {
    S.isVersionDropdownOpen = false;
    document.getElementById("version-dropdown-menu")?.classList.remove("show");
    document.querySelector<HTMLElement>(".gp-version-trigger")?.setAttribute("aria-expanded", "false");
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
    // Re-clicking Library while the grid is already on screen must not rebuild
    // it: a full render re-requests every cover and drops the scroll position.
    if (targetView === "library" && S.view === "library") return;
    setView(targetView);
    pushNavHistory({ view: targetView });
    if (S.view === "library") void bootEpic();
    if (S.view === "profile") {
      if (!S.playerProfileData && !S.profileLoading) void loadPlayerProfile();
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
      const section = t.dataset.settingsSection as import("../../core/types").SettingsSection | undefined;
      S.settingsSection = section || "account";
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
  if (handleSteamAction(act, t, id)) return;

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
  } else if (act === "toggle-sidebar") {
    toggleSidebarDrawer();
  } else if (act === "to-top") {
    viewEl.scrollTo({ top: 0, behavior: "smooth" });
  } else if (act === "open-store") {
    let store = (t.dataset.store as "epic" | "gog" | "steam" | "battlenet" | "ubisoft" | "ea" | "xbox" | "luna") || S.activeStore || "epic";
    if (!t.dataset.store && !isHeaderStore(store)) store = "epic";
    if (S.activeStore !== store) {
      S.activeStore = store;
      updatePageHeader();
    }
    pushNavHistory({ view: "store" });
    void openStore(store);
  } else if (act === "store-tabs-scroll") {
    const dir = Number(t.dataset.dir) || 1;
    scrollStoreTabs(dir);
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
    if (S.notifications.some((n) => n.action === "install-eos")) declineEosOverlay();
    clearNotifications();
    renderNotificationPanel();
  } else if (act === "notif-read-all") {
    markAllRead();
    renderNotificationPanel();
  } else if (act === "notif-dismiss" && id) {
    const note = S.notifications.find((n) => n.id === id);
    if (note?.action === "install-eos") declineEosOverlay();
    dismissNotification(id);
    renderNotificationPanel();
  } else if (act === "notif-open" && id) {
    closeNotifPanel();
    openEpicModal(id);
  } else if (act === "profile-change-avatar") {
    // The header avatar edits the selected profile's own photo (combined = global).
    promptAvatarAction(t.dataset.key || undefined, t.dataset.name || undefined);
  } else if (act === "profile-change-name") {
    openChangeNameModal();
  } else if (act === "profile-name-modal-close") {
    closeChangeNameModal();
  } else if (act === "profile-name-modal-save") {
    const input = document.getElementById("profile-name-input") as HTMLInputElement | null;
    saveProfileName(input ? input.value : "");
  } else if (act === "avatar-modal-close") {
    closeAvatarModal();
  } else if (act === "avatar-modal-remove" && id) {
    removeCustomAvatar(id);
  } else if (act === "avatar-modal-upload" && id) {
    openAvatarFilePicker(id);
  } else if (act === "refresh-profile") {
    void loadPlayerProfile(true);
  } else if (act === "open-hide-achievements") {
    openHideAchievementsModal();
  } else if (act === "profile-toggle-hidden") {
    S.profileShowHidden = !S.profileShowHidden;
    resetProfileCards();
    render();
  } else if (act === "unhide-achievement" && id) {
    unhideAchievement(id);
  } else if (act === "profile-account" && t.dataset.key) {
    // Profile header account selector: switch which account's stats are shown.
    S.profileAccount = t.dataset.key;
    resetProfileCards();
    render();
  } else if (act === "profile-filter" && t.dataset.val) {
    S.profileFilter = t.dataset.val as typeof S.profileFilter;
    S.profileShowHidden = false;
    resetProfileCards();
    render();
  } else if (act === "profile-store" && t.dataset.val) {
    const store = t.dataset.val;
    if (store === "all" || isHeaderStore(store) || store === "riot") {
      S.profileStore = store as typeof S.profileStore;
      S.profileAccount = "overview";
      S.profileFilter = "all";
      resetProfileCards();
      render();
    }
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
    if (applyStoreFilter(t.dataset.val) && !refreshLibraryForStoreFilter()) render();
  } else if (act === "toggle-lib-filters") {
    S.isFilterPanelOpen = !S.isFilterPanelOpen;
    S.isStoreDropdownOpen = false;
    S.isSortDropdownOpen = false;
    S.isColDropdownOpen = false;
    render();
  } else if (act === "lib-filter-close") {
    if (S.isFilterPanelOpen) {
      S.isFilterPanelOpen = false;
      render();
    }
  } else if (act === "lib-filter-clear") {
    clearLibFilters();
    if (!refreshLibraryForStoreFilter()) render();
    syncLibFilterUi();
  } else if (act === "lib-filter-toggle") {
    const group = t.dataset.group as keyof typeof S.libFilters | undefined;
    const value = t.dataset.value;
    if (group && value && toggleLibFilter(group, value)) {
      if (!refreshLibraryForStoreFilter()) render();
      syncLibFilterUi();
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
  } else if (act === "companion-open" && id) {
    const store = id as CompanionStore;
    void companionOpenClient(store).catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "companion-signin" || (act === "companion-link" && id === "battlenet")) {
    if (id === "ea" || id === "xbox") {
      // These stores sign in through their own OAuth window; it closes itself
      // once the redirect comes back.
      const open = id === "ea" ? eaLoginOpen : xboxLoginOpen;
      const failure = id === "ea" ? "@t:accounts.eaLoginFailed" : "@t:accounts.xboxLoginFailed";
      void open().catch((e: unknown) => {
        const raw = String(e);
        toast(raw.startsWith("@t:") ? i18nT(raw.slice(3)) : raw || i18nT(failure.slice(3)), "err");
      });
    } else {
      const store = id === "ubisoft" ? "ubisoft" : "battlenet";
      // The login page is used once; the tab itself stays a store page.
      const loginUrl = store === "ubisoft" ? UBISOFT_LOGIN_URL : BATTLENET_ACCOUNT_URL;
      void invoke("companion_hide_login").catch(() => {});
      S.activeStore = store;
      pushNavHistory({ view: "store" });
      void invoke("destroy_store_view")
        .catch(() => {})
        .then(() => openStoreUrl(loginUrl, "store"));
    }
  } else if (act === "companion-link" && id) {
    const store = id as CompanionStore;
    if (S.companionBusy) return;
    S.companionBusy = store;
    render();
    void companionLink(store)
      .then(() => loadCompanionLibrary())
      .catch((e: unknown) => {
        const raw = String(e);
        toast(raw.startsWith("@t:") ? i18nT(raw.slice(3)) : raw, "err");
      })
      .finally(() => {
        S.companionBusy = "";
        render();
      });
  } else if (act === "companion-unlink" && id) {
    const store = id as CompanionStore;
    void companionUnlink(store)
      .then(() => loadCompanionLibrary())
      .then(() => render())
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "companion-rescan") {
    // Re-reads the client's own files (installed set) and the imported catalog.
    void loadCompanionLibrary().then(() => {
      if (S.view === "settings") render();
    });
  } else if (act === "companion-install" && id) {
    const store = (t.dataset.store as CompanionStore) || "ubisoft";
    // The protocol opens the client's own install prompt; the client downloads.
    void companionGameAction(store, id, "install").catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "companion-uninstall" && id) {
    const store = (t.dataset.store as CompanionStore) || "ubisoft";
    void companionGameAction(store, id, "uninstall").catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "epic-play" && id) {    void epicPlay(id);
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
  } else if (act === "coming-soon") {
    // Playful teaser for the sidebar integrations that are not wired up yet.
    toast(i18nT(t.dataset.app === "discord" ? "coming.discord" : "coming.spotify"), "ok");
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
        // The drawer label is not a data-i18n node; without this it keeps the
        // previous language until the next resize or drawer toggle.
        refreshSidebarToggle();
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
  } else if (act === "toggle-gog-comet") {
    S.gogCometEnabled = !S.gogCometEnabled;
    void epicSetGogComet(S.gogCometEnabled).catch(() => {});
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
    if (S.settingsSection === "controller") void loadControllerView(true);
    if (S.settingsSection === "launchers") void loadLaunchersView();
  } else if (act === "controller-refresh") {
    void loadControllerView(true);
  } else if (act === "toggle-controller-bridge") {
    const enabled = !(S.controllerBridge?.bridgeRunning ?? false);
    localStorage.setItem(CONTROLLER_BRIDGE_KEY, String(enabled));
    void (enabled ? controllerBridgeStart() : controllerBridgeStop())
      .then((bridge) => {
        if (S.controllerBridge) {
          S.controllerBridge.bridgeRunning = bridge.running;
          S.controllerBridge.bridgeDevice = bridge.device;
        }
        render();
      })
      .catch((e: unknown) => {
        localStorage.setItem(CONTROLLER_BRIDGE_KEY, "false");
        toast(String(e), "err");
        void loadControllerView(true);
      });
  } else if (act === "controller-open-settings") {
    S.view = "settings";
    S.settingsSection = "controller";
    void loadSettingsView();
  } else if (act === "set-surface") {
    const surface = t.dataset.surface === "soft" ? "soft" : "black";
    S.surface = surface;
    localStorage.setItem(SURFACE_KEY, surface);
    if (surface === "soft") document.documentElement.dataset.surface = "soft";
    else delete document.documentElement.dataset.surface;
    render();
  } else if (act === "toggle-cover-stats") {
    S.showCoverStats = !S.showCoverStats;
    localStorage.setItem(COVER_STATS_KEY, String(S.showCoverStats));
    render();
  } else if (act === "toggle-store-visible") {
    const id = t.dataset.store;
    if (id) {
      setStoreHidden(id, !S.hiddenStores.has(id));
      scheduleRender();
    }
  } else if (act === "toggle-store-logos-only") {
    setStoreLogosOnly(!S.storeLogosOnly);
    scheduleRender();
  } else if (act === "toggle-store-badge") {
    S.showStoreBadge = !S.showStoreBadge;
    localStorage.setItem(STORE_BADGE_KEY, String(S.showStoreBadge));
    // Card markup changes need the full grid rebuild, not the in-place patch.
    if (!refreshLibraryResultsInPlace()) scheduleRender();
  } else if (act === "toggle-store-icons") {
    S.showStoreIcons = !S.showStoreIcons;
    localStorage.setItem(STORE_ICONS_KEY, String(S.showStoreIcons));
    if (!refreshLibraryResultsInPlace()) scheduleRender();
  } else if (act === "toggle-store-column") {
    S.showStoreColumn = !S.showStoreColumn;
    localStorage.setItem(STORE_COLUMN_KEY, String(S.showStoreColumn));
    if (!refreshLibraryResultsInPlace()) scheduleRender();
  } else if (act === "toggle-ach-progress") {
    S.showAchProgress = !S.showAchProgress;
    localStorage.setItem(ACH_PROGRESS_KEY, String(S.showAchProgress));
    if (!refreshLibraryResultsInPlace()) scheduleRender();
  } else if (act === "toggle-tv-auto") {
    S.tvAutoEnter = !S.tvAutoEnter;
    localStorage.setItem(TV_AUTO_KEY, String(S.tvAutoEnter));
    render();
  } else if (act === "toggle-shared-library") {
    S.showSharedLibrary = !S.showSharedLibrary;
    localStorage.setItem(SHOW_SHARED_LIBRARY_KEY, String(S.showSharedLibrary));
    if (S.showSharedLibrary) void loadSharedLibrary();
    // The unified lookup map follows the setting so no shared entry lingers.
    rebuildAllGamesMap();
    S.libraryDataRev++;
    scheduleRender();
  } else if (act === "shared-switch" && id) {
    // `epic:<accountId>` / `gog:<userId>` — the switch functions reload the
    // shared index themselves so the entry stops being "someone else's".
    const [store, ownerId] = id.split(":");
    if (ownerId) {
      if (store === "epic") void switchAccount(ownerId);
      else if (store === "gog") void switchGogAccount(ownerId);
    }
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
  } else if (act === "toggle-autostart") {
    const enabled = !S.startWithWindows;
    S.startWithWindows = enabled;
    void appSetAutostart(enabled)
      .then(() => {
        localStorage.setItem(AUTOSTART_INIT_KEY, "true");
        render();
      })
      .catch((e: unknown) => {
        S.startWithWindows = !enabled;
        toast(String(e), "err");
        render();
      });
  } else if (act === "toggle-minimize-on-game") {
    S.minimizeOnGame = !S.minimizeOnGame;
    localStorage.setItem(MINIMIZE_ON_GAME_KEY, String(S.minimizeOnGame));
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
  } else if (act === "toggle-steam-exit-after-play") {
    S.steamExitAfterPlay = !S.steamExitAfterPlay;
    localStorage.setItem(STEAM_EXIT_AFTER_PLAY_KEY, String(S.steamExitAfterPlay));
    render();
  } else if (act === "toggle-client-exit") {
    // Companion clients: the Rust watcher reads this from its settings file.
    const store = t.dataset.store as CompanionStore | undefined;
    const enabled = (t as HTMLInputElement).checked;
    if (store) {
      S.companionCloseAfterPlay = { ...S.companionCloseAfterPlay, [store]: enabled };
      void companionSetCloseAfterPlay(store, enabled).catch((e: unknown) => toast(String(e), "err"));
    }
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
