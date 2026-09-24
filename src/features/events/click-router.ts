import { closeAvatarModal, openAvatarFilePicker, promptAvatarAction, removeCustomAvatar } from "../profile/profile-avatar";
/**
 * Global click delegation router.
 *
 * A single document-level click listener dispatches every data-act /
 * data-view interaction to the corresponding feature function. Keeping it in
 * one place avoids per-element listeners and preserves the event-delegation
 * contract documented in AGENTS.md.
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AUTO_BACKUP_KEY, AUTO_SHORTCUT_KEY, AUTO_UPDATE_KEY, DEMO_PLAT_KEY, LANG_KEY, MINIMIZE_TRAY_KEY, NAV_HISTORY_KEY, PAUSE_ON_PLAY_KEY, PROFILE_CARD_CHUNK, SPEED_BITS_KEY, SS_COMPRESS_KEY, SS_FORMAT_KEY, isTauri } from "../../core/constants";
import { scheduleAutoUpdate } from "../downloads/auto-update";
import { closeModal, viewEl } from "../../core/dom";
import { epicCancel, epicPlay, epicUninstall, refreshEpicInstalled } from "../../core/epic-actions";
import { toggleFav } from "../../core/game-view";
import { icon } from "../../core/icons";
import { navGoBack, navGoForward, pushNavHistory, updateNavHistoryUi, updateOfflineModeUi } from "../../core/nav";
import { closeAllModals, openEpicModal, render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import type { DrawerTab, EpicSort, EpicViewMode, View } from "../../core/types";
import { esc, fmtBytes, fmtCdnName, parseEnvText } from "../../core/utils";
import { handleWindowResize, updateMaxIcon } from "../../core/window";
import { currentLanguage, setLanguage, t as i18nT } from "../../i18n";
import { EPIC_LOGIN_URL, epicAchievementsUrl, epicBackupSave, epicCaptureGameScreenshot, epicCleanupCache, epicCreateDesktopShortcut, epicDeleteBackup, epicDeleteGameScreenshot, epicDetectEglGames, epicGetGameDlcs, epicGetQueue, epicImportEglCollections, epicListBackups, epicMeasureCdns, epicSetAutoDesktopShortcut, epicSetInstallDir, epicSetPreferredCdn, epicSyncEglInstalled, epicOpenBackupFolder, epicOpenGameScreenshotsFolder, epicPauseDownload, epicReorderQueue, epicRestoreBackup, epicResumeDownload, epicSaveGameSettings, epicSelectFolderDialog, epicSetNetworkProfile, epicSetOfflineMode, epicSetSteamGridKey, epicStorePageUrl, epicStorePageUrlForGame, epicSyncSaves, epicTestSteamGridKey, epicThirdPartyLaunchers, epicVerifyGame, eosOverlayStatus, epicOpenFolderPath, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSettings } from "../../epic";
import { rawOf } from "../../core/selectors";
import { bootEpic, epicDoImport, epicDoLogin, epicDoLogout, epicDownload, extractAuthCode, refreshEpic, syncEpicLibrary, } from "../auth/auth-actions";
import { cancelAddAccount, promptAddAccount, removeSavedAccount, switchAccount } from "../auth/account-switcher";
import {
  closeCollectionModal,
  deleteCollectionFromModal,
  loadEpicCollections,
  openCollectionModal,
  openGameCollectionsModal,
  saveCollectionFromModal,
  saveGameCollectionsFromModal,
  updateColGamesListInPlace,
  updateColPresetArrows,
  updateMarkerUi,
} from "../collections/collections-view";
import {
  closeCustomCoverModal,
  loadSteamGridCovers,
  openCustomCoverModal,
  renderCustomCoverModalContent,
  renderCustomCoverModalFrame,
  resetCustomCover,
  resetCustomHero,
  saveCustomCover,
  saveCustomHero,
  searchAndLoadSteamGrid,
} from "../cover/cover-view";
import { epicOpenFolder, fetchAndRenderAchievements, fetchAndRenderRequirements, updateDrawerTabArrows } from "../drawer/drawer-view";
import { renderBackupListHtml } from "../drawer/drawer-widgets";

import { applySelectiveInstall, closeSelectiveModal } from "../dlc/selective-install";
import { browseInstallDir, closeInstallDialog, confirmInstall, openInstallDialog } from "../install/install-dialog";
import { refreshLibraryResultsInPlace, resetCardChunk, updateLibraryFilterInPlace } from "../library/library-view";
import { resetVerifyInPlace, updateVerifyProgressInPlace } from "../manage/manage-view";
import { browseMoveTarget, cancelMoveGame, closeMoveGameModal, openMoveGameModal, startMoveGame, } from "../move-game/move-game-actions";
import { renderMoveGameModalFrame } from "../move-game/move-game-view";
import { applyPresenceSettings } from "../presence/presence";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate, setAppAutoUpdate } from "../updates/update-manager";
import { closeStorageManager, openStorageManager } from "../storage/storage-view";
import { closeEditPlaytimeModal, openEditPlaytimeModal, saveEditedPlaytime, } from "../playtime/playtime-view";

import {
  closeScreenshotLightbox,
  closeShareModal,
  compressScreenshotItem,
  copyScreenshotImageToClipboard,
  fetchAndRenderScreenshots,
  navigateScreenshotLightbox,
  openScreenshotLightbox,
  openShareModal,
  playScreenshotShutterSound,
} from "../screenshots/screenshots-view";
import { loadFriends, loadPlayerProfile, openProfile, openStore, openStoreUrl, setView } from "../store/store-view";
import { clearNotifications, closeNotifPanel, dismissNotification, markAllRead, openNotifPanel, renderNotificationPanel } from "../notifications/notifications";
import { loadIntegrationsView, loadSettingsView } from "../settings/settings-view";
import { resetProfileCards } from "../profile/profile-view";
document.addEventListener("click", (e) => {
  // Close the sort dropdown when clicking outside it.
  if (S.isSortDropdownOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".sort-dropdown-container")) {
      S.isSortDropdownOpen = false;
      const menu = document.getElementById("sort-dropdown-menu");
      if (menu) menu.classList.remove("show");
    }
  }

  // Marker palette closes when clicking outside it.
  if (S.isMarkerPaletteOpen) {
    const targetEl = e.target as HTMLElement;
    if (!targetEl.closest(".col-marker-picker-container")) {
      S.isMarkerPaletteOpen = false;
      const pal = document.getElementById("col-marker-palette");
      if (pal) pal.classList.remove("open");
    }
  }

  // In-modal game/collection selection.
  const gameItem = (e.target as HTMLElement).closest<HTMLElement>(".col-game-item");
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
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act], [data-view]");

  // Close the notification dropdown when clicking anywhere outside it. This only
  // repaints the small panel — never the whole view.
  if (S.notifOpen) {
    const el = e.target as HTMLElement;
    if (!el.closest("#notif-root") && !el.closest('[data-act="toggle-notifications"]')) {
      closeNotifPanel();
    }
  }

  if (!t) return;

  const isAuthed = Boolean(S.epicAccount) && S.epicPhase === "library" && !S.authLoading;
  if (!isAuthed) {
    if (t.dataset.view) return;
    const allowedAuthActs = new Set([
      "epic-open-login",
      "epic-do-login",
      "epic-import",
      "auth-paste",
      "auth-cancel",
      "epic-download",
      "win-minimize",
      "win-maximize",
      "win-close",
    ]);
    if (t.dataset.act && !allowedAuthActs.has(t.dataset.act)) {
      return;
    }
  }

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
      // Paint the page shell immediately, then hydrate in the background so a
      // slow integration scan can never make the launcher look frozen.
      render();
      void loadSettingsView();
      return;
    }
    render();
    return;
  }
  const act = t.dataset.act;
  const id = t.dataset.id;
  if (act === "close") {
    const el = e.target as HTMLElement;
    if (el === t || t.matches(".hub-back-btn, .hub-tool-btn, .drawer-close, .mclose") || el.closest(".hub-back-btn, .hub-tool-btn, .drawer-close, .mclose")) closeModal();
  } else if (act === "nav-history-back") {
    navGoBack();
    return;
  } else if (act === "nav-history-forward") {
    navGoForward();
    return;
  } else if (act === "goto-library") {
    pushNavHistory({ view: "library" });
    closeAllModals();
    setView("library");
    render();
  } else if (act === "open-free-game") {
    const title = t.dataset.title;
    const slug = t.dataset.slug;
    if (title) {
      const url = slug ? `https://store.epicgames.com/p/${slug}` : epicStorePageUrl(title);
      void openStoreUrl(url, "store");
    }
  } else if (act === "epic-download") {
    void epicDownload();
  } else if (act === "epic-open-login") {
    openUrl(EPIC_LOGIN_URL).catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "epic-do-login") {
    const input = document.getElementById("epic-code") as HTMLInputElement | null;
    void epicDoLogin(input?.value ?? "");
  } else if (act === "epic-import") {
    void epicDoImport();
  } else if (act === "auth-paste") {
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        const code = extractAuthCode(text);
        const input = document.getElementById("epic-code") as HTMLInputElement | null;
        if (input && code) {
          input.value = code;
          input.focus();
          toast(i18nT("auth.codePasted"), "ok");
        } else {
          toast(i18nT("auth.pasteFailed"), "err");
        }
      } catch {
        toast(i18nT("auth.pasteFailed"), "err");
      }
    })();
  } else if (act === "auth-cancel") {
    cancelAddAccount();
  } else if (act === "onboarding-goto") {
    const step = parseInt(t.dataset.step || "1", 10);
    if (step >= 1 && step <= 3) {
      S.onboardingStep = step;
      render();
    }
  } else if (act === "epic-logout") {
    void epicDoLogout();
  } else if (act === "epic-refresh") {
    void syncEpicLibrary(true);
  } else if (act === "epic-retry") {
    void refreshEpic();
  } else if (act === "to-top") {
    viewEl.scrollTo({ top: 0, behavior: "smooth" });
  } else if (act === "open-store") {
    pushNavHistory({ view: "store" });
    void openStore();
  } else if (act === "open-profile") {
    openProfile();
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
  } else if (act === "avatar-modal-close") { closeAvatarModal();
  } else if (act === "avatar-modal-remove" && id) { removeCustomAvatar(id);
  } else if (act === "avatar-modal-upload" && id) { openAvatarFilePicker(id);
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
  } else if (act === "account-switch" && id) {
    void switchAccount(id);
  } else if (act === "account-remove" && id) {
    void removeSavedAccount(id);
  } else if (act === "account-add") {
    promptAddAccount();
  } else if (act === "profile-filter" && t.dataset.val) {
    S.profileFilter = t.dataset.val as typeof S.profileFilter;
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
  } else if (act === "epic-filter" && t.dataset.val) {
    S.epicFilter = t.dataset.val as typeof S.epicFilter;
    if (!updateLibraryFilterInPlace()) render();
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
    } else if (tab === "freegames") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "freegames" ? "all" : "freegames";
    } else if (tab === "updates") {
      S.activeCollectionId = null;
      S.epicFilter = S.epicFilter === "updates" ? "all" : "updates";
    } else if (tab === "collections") {
      S.activeCollectionId = null;
      if (S.epicFilter === "collections" && S.activeCollectionId !== null) { S.activeCollectionId = null; } else { S.activeCollectionId = null; S.epicFilter = S.epicFilter === "collections" ? "all" : "collections"; }
    }
    S.isSortDropdownOpen = false;
    const hasCustomCol = S.activeCollectionId !== null && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav";
    if (hadCustomCol !== hasCustomCol || !updateLibraryFilterInPlace()) {
      resetCardChunk();
      render();
    }
  } else if (act === "toggle-sort-dropdown") {
    S.isSortDropdownOpen = !S.isSortDropdownOpen;
    const menu = document.getElementById("sort-dropdown-menu");
    if (menu) {
      menu.classList.toggle("show", S.isSortDropdownOpen);
    } else {
      render();
    }
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
  } else if (act === "open-collection") {
    const colId = t.dataset.colId;
    if (colId) {
      S.activeCollectionId = colId;
      S.epicFilter = "collections";
      resetCardChunk();
      render();
    }
  } else if (act === "back-to-collections") {
    S.activeCollectionId = null;
    resetCardChunk();
    render();
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
  } else if (act === "open-custom-cover" && id) {
    const target = (t.dataset.target as "cover" | "hero") || "cover";
    openCustomCoverModal(id, target);
  } else if (act === "set-cover-target" && id) {
    const target = (t.dataset.target as "cover" | "hero") || "cover";
    if (target !== S.activeCoverTarget) {
      S.activeCoverTarget = target;
      S.sgdbAssetType = target === "hero" ? "heroes" : "grids";
      S.sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
      renderCustomCoverModalContent(id);
      if (S.customCoverActiveTab === "steamgrid" && S.sgdbSelectedGameId) {
        void loadSteamGridCovers(id, S.sgdbSelectedGameId);
      }
    }
  } else if (act === "cover-modal-backdrop") {
    if (e.target === t) closeCustomCoverModal();
  } else if (act === "prevent-modal-close") {
    // Keep the modal open when its content is clicked.
  } else if (act === "close-custom-cover") {
    if (t.classList.contains("cover-overlay") && e.target !== t) return;
    closeCustomCoverModal();
  } else if (act === "toggle-sgdb-modal-info") {
    S.showModalSgdbInfo = !S.showModalSgdbInfo;
    if (S.activeCustomCoverAppName) {
      renderCustomCoverModalContent(S.activeCustomCoverAppName);
    }
  } else if ((act === "open-external-url" || act === "open-critic-url") && t.dataset.url) {
    void openUrl(t.dataset.url);
  } else if (act === "switch-cover-tab" && t.dataset.tab) {
    S.customCoverActiveTab = t.dataset.tab as typeof S.customCoverActiveTab;
    document.querySelectorAll(".cover-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === S.customCoverActiveTab);
    });
    if (S.activeCustomCoverAppName) {
      renderCustomCoverModalContent(S.activeCustomCoverAppName);
    }
  } else if (act === "sgdb-search" && id) {
    const input = document.getElementById("sgdb-search-input") as HTMLInputElement | null;
    if (input) S.sgdbSearchQuery = input.value;
    void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
  } else if (act === "sgdb-select-game" && id && t.dataset.gameId) {
    const gId = parseInt(t.dataset.gameId, 10);
    if (!isNaN(gId)) {
      S.sgdbSelectedGameId = gId;
      void loadSteamGridCovers(id, gId);
    }
  } else if (act === "sgdb-set-asset-type" && id && t.dataset.type) {
    const type = t.dataset.type as "grids" | "heroes";
    S.sgdbAssetType = type;
    const target = type === "heroes" ? "hero" : "cover";
    if (target !== S.activeCoverTarget) {
      S.activeCoverTarget = target;
      S.sgdbSelectedCoverUrl = "";
      renderCustomCoverModalFrame(id);
    }
    if (S.sgdbSelectedGameId) {
      void loadSteamGridCovers(id, S.sgdbSelectedGameId);
    }
  } else if (act === "sgdb-set-style" && id) {
    S.sgdbActiveStyle = t.dataset.style || "";
    if (S.sgdbSelectedGameId) {
      void loadSteamGridCovers(id, S.sgdbSelectedGameId);
    }
  } else if (act === "sgdb-select-card" && t.dataset.url) {
    S.sgdbSelectedCoverUrl = t.dataset.url;
    document.querySelectorAll(".sgdb-card").forEach((card) => {
      const isSel = (card as HTMLElement).dataset.url === S.sgdbSelectedCoverUrl;
      card.classList.toggle("selected", isSel);
      const check = card.querySelector(".sgdb-selected-check");
      if (isSel && !check) {
        card.insertAdjacentHTML("beforeend", `<div class="sgdb-selected-check">${icon("check", 14)}</div>`);
      } else if (!isSel && check) {
        check.remove();
      }
    });
    const previewImg = document.getElementById("cover-preview-img") as HTMLImageElement | null;
    const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
    if (previewImg && previewImg.tagName === "IMG") {
      previewImg.src = S.sgdbSelectedCoverUrl;
    } else if (previewWrapper) {
      previewWrapper.innerHTML = `
        <img id="cover-preview-img" src="${esc(S.sgdbSelectedCoverUrl)}" alt="${i18nT("cover.previewAlt")}" />
        <div class="cover-preview-badge">${i18nT("cover.selectedPreview")}</div>
      `;
    }
    const badge = previewWrapper?.querySelector(".cover-preview-badge");
    if (badge) badge.textContent = i18nT("cover.selectedPreview");
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    if (input) input.value = S.sgdbSelectedCoverUrl;
  } else if (act === "save-inline-sgdb-key" && id) {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    if (!key) {
      toast(i18nT("cover.needKey"), "err");
      return;
    }
    epicSetSteamGridKey(key)
      .then(() => {
        S.steamGridApiKey = key;
        toast(i18nT("cover.keySaved"), "ok");
        renderCustomCoverModalContent(id);
        void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "save-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || "";
    epicSetSteamGridKey(key)
      .then(() => {
        S.steamGridApiKey = key || null;
        toast(key ? i18nT("cover.keySaved") : i18nT("cover.keyRemoved"), "ok");
        render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "test-sgdb-key") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    const key = input?.value.trim() || S.steamGridApiKey || "";
    if (!key) {
      toast(i18nT("cover.enterTestKey"), "err");
      return;
    }
    toast(i18nT("cover.testing"), "");
    epicTestSteamGridKey(key)
      .then(() => toast(i18nT("cover.testOk"), "ok"))
      .catch((err) => toast(i18nT("cover.testFailed", { msg: String(err) }), "err"));
  } else if (act === "toggle-sgdb-key-visibility") {
    const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
    if (input) {
      S.showSettingsSgdbKey = !S.showSettingsSgdbKey;
      input.type = S.showSettingsSgdbKey ? "text" : "password";
      t.innerHTML = icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "toggle-modal-sgdb-key-visibility") {
    const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
    if (input) {
      S.showModalSgdbKey = !S.showModalSgdbKey;
      input.type = S.showModalSgdbKey ? "text" : "password";
      t.innerHTML = icon(S.showModalSgdbKey ? "eye-off" : "eye", 13);
    }
  } else if (act === "preview-custom-cover-url") {
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    const val = input?.value.trim();
    if (val) {
      S.sgdbSelectedCoverUrl = val;
      const previewImg = document.getElementById("cover-preview-img") as HTMLImageElement | null;
      const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
      if (previewImg && previewImg.tagName === "IMG") {
        previewImg.src = val;
      } else if (previewWrapper) {
        previewWrapper.innerHTML = `
          <img id="cover-preview-img" src="${esc(val)}" alt="${i18nT("cover.previewAlt")}" />
          <div class="cover-preview-badge">${i18nT("cover.webLink")}</div>
        `;
      }
      const badge = previewWrapper?.querySelector(".cover-preview-badge");
      if (badge) badge.textContent = i18nT("cover.webLink");
    }
  } else if (act === "save-custom-cover" && id) {
    const input = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
    const val = S.sgdbSelectedCoverUrl || input?.value.trim() || "";
    if (val) {
      if (S.activeCoverTarget === "hero") {
        saveCustomHero(id, val);
        toast(i18nT("cover.heroSaved"), "ok");
      } else {
        saveCustomCover(id, val);
        toast(i18nT("cover.portraitSaved"), "ok");
      }
      closeCustomCoverModal();
    } else {
      toast(i18nT("cover.pickFirst"), "err");
    }
  } else if (act === "reset-active-target" && id) {
    if (S.activeCoverTarget === "hero") {
      resetCustomHero(id);
      toast(i18nT("cover.heroReset"), "ok");
    } else {
      resetCustomCover(id);
      toast(i18nT("cover.portraitReset"), "ok");
    }
    S.sgdbSelectedCoverUrl = "";
    renderCustomCoverModalFrame(id);
    renderCustomCoverModalContent(id);
  } else if (act === "reset-all-art" && id) {
    resetCustomCover(id);
    resetCustomHero(id);
    S.sgdbSelectedCoverUrl = "";
    toast(i18nT("cover.allReset"), "ok");
    renderCustomCoverModalFrame(id);
    renderCustomCoverModalContent(id);
  } else if (act === "reset-custom-cover" && id) {
    resetCustomCover(id);
    closeCustomCoverModal();
    toast(i18nT("cover.originalRestored"), "ok");
  } else if (act === "epic-fav" && id) {
    toggleFav(id, t);
  } else if (act === "epic-detail" && id) {
    openEpicModal(id);
  } else if (act === "select-collection") {
    const colId = t.dataset.colId;
    if (colId === "all") {
      S.activeCollectionId = null;
      if (S.epicFilter === "fav") S.epicFilter = "all";
    } else if (colId === "fav") {
      S.activeCollectionId = "fav";
      S.epicFilter = "all";
    } else if (colId) {
      S.activeCollectionId = colId;
      if (S.epicFilter === "fav") S.epicFilter = "all";
    }
    if (S.currentModalAppName) closeModal();
    resetCardChunk();
    render();
  } else if (act === "open-new-collection-modal") {
    openCollectionModal();
  } else if (act === "edit-collection") {
    const colId = t.dataset.colId;
    if (colId) openCollectionModal(colId);
  } else if (act === "close-col-modal") {
    closeCollectionModal();
  } else if (act === "col-modal-backdrop") {
    if (e.target === t) closeCollectionModal();
  } else if (act === "toggle-col-marker-palette") {
    S.isMarkerPaletteOpen = !S.isMarkerPaletteOpen;
    const pal = document.getElementById("col-marker-palette");
    if (pal) pal.classList.toggle("open", S.isMarkerPaletteOpen);
  } else if (act === "pick-col-marker") {
    const marker = t.dataset.icon;
    if (marker) {
      S.colModalMarker = marker;
      S.isMarkerPaletteOpen = false;
      updateMarkerUi();
    }
  } else if (act === "clear-col-marker") {
    S.colModalMarker = "";
    S.isMarkerPaletteOpen = false;
    updateMarkerUi();
  } else if (act === "quick-col-preset") {
    const presetMarker = t.dataset.icon;
    const presetName = t.dataset.name;
    if (presetMarker) {
      S.colModalMarker = presetMarker;
      updateMarkerUi();
    }
    const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
    if (nameInput && presetName) {
      nameInput.value = presetName;
      nameInput.focus();
    }
  } else if (act === "col-presets-scroll") {
    const dir = t.dataset.dir;
    const container = document.getElementById("col-presets-scrollable");
    if (container) {
      container.scrollBy({ left: dir === "left" ? -240 : 240, behavior: "smooth" });
      setTimeout(updateColPresetArrows, 250);
    }
  } else if (act === "col-tab-filter") {
    const filter = t.dataset.filter as "all" | "selected" | "installed";
    if (filter) {
      S.colModalTabFilter = filter;
      document.querySelectorAll(".col-filter-tab").forEach((tab) => {
        tab.classList.toggle("active", (tab as HTMLElement).dataset.filter === filter);
      });
      updateColGamesListInPlace();
    }
  } else if (act === "col-search-clear") {
    S.colModalSearchQuery = "";
    const sInput = document.getElementById("col-search-input") as HTMLInputElement | null;
    if (sInput) {
      sInput.value = "";
      sInput.focus();
    }
    updateColGamesListInPlace();
  } else if (act === "col-toggle-game") {
    const app = t.dataset.app || (t.closest(".col-game-item") as HTMLElement)?.dataset.app;
    if (app) {
      if (S.colModalSelectedApps.has(app)) {
        S.colModalSelectedApps.delete(app);
      } else {
        S.colModalSelectedApps.add(app);
      }
      const itemEl = (t.classList.contains("col-game-item") ? t : t.closest(".col-game-item")) as HTMLElement | null;
      const isChecked = S.colModalSelectedApps.has(app);
      const cb = itemEl?.querySelector(".col-game-cb") as HTMLInputElement | null;
      if (cb) cb.checked = isChecked;
      if (itemEl) itemEl.classList.toggle("selected", isChecked);

      const selCountEl = document.getElementById("col-tab-selected-cnt");
      if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

      if (S.colModalTabFilter === "selected") {
        updateColGamesListInPlace();
      }
    }
  } else if (act === "col-select-all") {
    const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
    let matches = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
    if (S.colModalTabFilter === "installed") {
      matches = matches.filter((s) => s.installed);
    }
    matches.forEach((s) => S.colModalSelectedApps.add(s.appName));
    updateColGamesListInPlace();
  } else if (act === "col-deselect-all") {
    if (S.colModalTabFilter === "all" && !S.colModalSearchQuery.trim()) {
      S.colModalSelectedApps.clear();
    } else {
      const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
      let matches = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
      if (S.colModalTabFilter === "installed") {
        matches = matches.filter((s) => s.installed);
      }
      matches.forEach((s) => S.colModalSelectedApps.delete(s.appName));
    }
    updateColGamesListInPlace();
  } else if (act === "col-save-btn") {
    void saveCollectionFromModal();
  } else if (act === "col-delete-btn") {
    const colId = t.dataset.colId;
    if (colId) void deleteCollectionFromModal(colId);
  } else if (act === "manage-game-collections" && id) {
    openGameCollectionsModal(id);
  } else if (act === "save-game-col-btn") {
    void saveGameCollectionsFromModal();
  } else if (act === "import-egl-collections") {
    toast(i18nT("col.scanningEgl"), "");
    void epicImportEglCollections()
      .then((cols) => {
        toast(i18nT("col.importedCount", { count: cols.length }), "ok");
        void loadEpicCollections();
        if (S.view === "settings") void loadSettingsView();
      })
      .catch((err) => {
        toast(i18nT("col.importFailed", { msg: String(err) }), "err");
      });
  } else if (act === "epic-play" && id) {
    void epicPlay(id);
  } else if (act === "epic-install" && id) {
    void openInstallDialog(id);
  } else if (act === "install-browse") {
    void browseInstallDir();
  } else if (act === "install-confirm" && id) {
    void confirmInstall();
  } else if (act === "install-cancel") {
    closeInstallDialog();
  } else if (act === "install-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeInstallDialog();
  } else if (act === "epic-cancel" && id) {
    void epicCancel(id);
  } else if (act === "epic-uninstall" && id) {
    void epicUninstall(id);
  } else if (act === "open-dlc-manager" && id) {
    S.activeDrawerTab = "dlcs";
    if (!S.dlcCache.has(id) && !S.dlcLoading) {
      S.dlcLoading = true;
      epicGetGameDlcs(id)
        .then((res) => {
          S.dlcCache.set(id, res);
          if (S.activeDrawerTab === "dlcs" && S.currentModalAppName === id) {
            openEpicModal(id, false);
          }
        })
        .catch(() => {})
        .finally(() => {
          S.dlcLoading = false;
          if (S.activeDrawerTab === "dlcs" && S.currentModalAppName === id) {
            openEpicModal(id, false);
          }
        });
    }
    openEpicModal(id, false);
  } else if (act === "dlc-back") {
    setView("library");
    render();
  } else if (act === "dlc-discover-store" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    void openStoreUrl(epicStorePageUrl(title), "store");
  } else if (act === "selective-close") {
    closeSelectiveModal();
  } else if (act === "selective-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeSelectiveModal();
  } else if (act === "open-edit-playtime" && id) {
    openEditPlaytimeModal(id);
  } else if (act === "close-edit-playtime") {
    closeEditPlaytimeModal();
  } else if (act === "playtime-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t) closeEditPlaytimeModal();
  } else if (act === "pt-quick-add") {
    const addHours = parseInt(t.dataset.hours || "0", 10);
    const input = document.getElementById("pt-hours-input") as HTMLInputElement | null;
    if (input) {
      const cur = parseInt(input.value || "0", 10) || 0;
      input.value = String(Math.max(0, cur + addHours));
    }
    const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
    if (lpSelect && !lpSelect.value) {
      lpSelect.value = "Daha önce oynandı (Epic Games)";
    }
  } else if (act === "pt-reset") {
    const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
    const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
    const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
    if (hInput) hInput.value = "0";
    if (mInput) mInput.value = "0";
    if (lpSelect) lpSelect.value = "";
  } else if (act === "save-playtime" && id) {
    void saveEditedPlaytime(id);
  } else if (act === "selective-apply" && id) {
    const tags = Array.from(S.selectedInstallTags);
    const dlcs = Array.from(S.selectedDlcAppIds);
    void applySelectiveInstall(id, tags, dlcs);
  } else if (act === "epic-save-install-dir") {
    const input = document.getElementById("epic-install-dir") as HTMLInputElement | null;
    const v = input?.value?.trim() ?? "";
    epicSetInstallDir(v ? v : null)
      .then((st: EpicSettings) => {
        S.epicSettingsCache = st;
        toast(i18nT("dl.installDirSaved"), "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "dl-save-install-dir") {
    const input = document.getElementById("dl-install-dir") as HTMLInputElement | null;
    const v = input?.value?.trim() ?? "";
    epicSetInstallDir(v ? v : null)
      .then((st: EpicSettings) => {
        S.epicSettingsCache = st;
        toast(i18nT("dl.installDirSaved"), "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "dl-pick-install-dir") {
    void (async () => {
      const input = document.getElementById("dl-install-dir") as HTMLInputElement | null;
      const current = input?.value?.trim() || S.epicDefaultDir || null;
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
  } else if (act === "dl-set-cdn") {
    const host = (t.getAttribute("data-cdn") || "").trim();
    void (async () => {
      try {
        await epicSetPreferredCdn(host || null);
        S.preferredCdn = host;
        if (host) {
          toast(i18nT("downloads.cdnSet", { host: fmtCdnName(host) }), "ok");
        } else {
          toast(i18nT("downloads.cdnResetDone"), "ok");
        }
        render();
      } catch (e) {
        toast(String(e), "err");
      }
    })();
  } else if (act === "dl-find-fastest-cdn") {
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
        toast(i18nT("downloads.cdnPicked", { host: fmtCdnName(best.host), ms: best.ms }), "ok");
        render();
      } catch (e) {
        toast(String(e), "err");
      }
    })();
  } else if (act === "dl-reset-cdn") {
    void epicSetPreferredCdn(null)
      .then(() => {
        S.preferredCdn = "";
        toast(i18nT("downloads.cdnResetDone"), "ok");
        render();
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "dl-cleanup-cache") {
    toast(i18nT("downloads.cacheClearing"), "");
    void epicCleanupCache()
      .then((msg) => {
        toast(msg, "ok");
      })
      .catch((e: unknown) => toast(String(e), "err"));
  } else if (act === "open-storage-manager") {
    void openStorageManager();
  } else if (act === "close-storage-manager") {
    closeStorageManager();
  } else if (act === "storage-overlay-close") {
    if (e.target === t) closeStorageManager();
  } else if (act === "blocked-move-tp") {
    const partner = t.dataset.partner || "Ubisoft Connect / EA App";
    toast(i18nT("manage.moveThirdPartyAlert", { name: partner }), "");
  } else if (act === "storage-move-game" && id) {
    const raw = rawOf(id);
    const partner = getThirdPartyLauncher(raw);
    if (requiresThirdPartyLauncher(partner)) {
      toast(i18nT("manage.moveThirdPartyAlert", { name: partner!.name }), "");
      return;
    }
    closeStorageManager();
    void openMoveGameModal(id);
  } else if (act === "storage-uninstall" && id) {
    closeStorageManager();
    void epicUninstall(id);
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
  } else if (act === "manage-game" && id) {
    S.activeDrawerTab = "manage";
    openEpicModal(id, false);
  } else if (act === "open-move-game-modal" && id) {
    const raw = rawOf(id);
    const partner = getThirdPartyLauncher(raw);
    if (requiresThirdPartyLauncher(partner)) {
      toast(i18nT("manage.moveThirdPartyAlert", { name: partner!.name }), "");
      return;
    }
    void openMoveGameModal(id);
  } else if (act === "close-move-modal") {
    closeMoveGameModal();
  } else if (act === "move-overlay-close") {
    const el = e.target as HTMLElement;
    if (el === t && !S.isMovingGame) closeMoveGameModal();
  } else if (act === "select-move-drive") {
    const drv = t.dataset.drive;
    if (drv && !S.isMovingGame) {
      S.selectedMoveDriveLetter = drv.toUpperCase();
      const curPath = S.selectedMoveTargetPath.replace(/^[a-zA-Z]:[\\/]/, "");
      S.selectedMoveTargetPath = `${S.selectedMoveDriveLetter}:\\${curPath || "Games"}`;
      renderMoveGameModalFrame();
    }
  } else if (act === "browse-move-target") {
    void browseMoveTarget();
  } else if (act === "start-move-game" && id) {
    void startMoveGame(id);
  } else if (act === "cancel-move-game" && id) {
    void cancelMoveGame(id);
  } else if (act === "manage-verify" && id) {
    updateVerifyProgressInPlace(id, 0, 100, 0, i18nT("dl.starting"), i18nT("dl.starting"));
    epicVerifyGame(id).catch((err) => {
      resetVerifyInPlace(id);
      toast(i18nT("manage.verifyStartFailed", { msg: String(err) }), "err");
    });
  } else if (act === "manage-sync-saves" && id && !S.manageSyncingSaves) {
    S.manageSyncingSaves = true;
    const syncBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-sync-saves"]');
    const cloudSub = document.getElementById("manage-cloud-subtitle");
    if (syncBtn) syncBtn.disabled = true;
    if (cloudSub) cloudSub.textContent = i18nT("manage.syncing");
    epicSyncSaves(id)
      .then((msg) => {
        toast(msg, "ok");
        const now = new Date().toLocaleString(currentLanguage());
        if (S.activeManageSettings && S.activeManageSettings.appName === id) {
          S.activeManageSettings.lastCloudSync = now;
        }
        if (cloudSub) cloudSub.textContent = i18nT("manage.lastSync", { time: now });
      })
      .catch((err) => {
        toast(i18nT("manage.syncFailed", { msg: String(err) }), "err");
        if (cloudSub && S.activeManageSettings) {
          cloudSub.textContent = S.activeManageSettings.lastCloudSync
            ? i18nT("manage.lastSync", { time: esc(S.activeManageSettings.lastCloudSync) })
            : i18nT("manage.cloudDesc");
        }
      })
      .finally(() => {
        S.manageSyncingSaves = false;
        if (syncBtn) syncBtn.disabled = false;
      });
  } else if (act === "manage-create-shortcut" && id) {
    epicCreateDesktopShortcut(id)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(i18nT("manage.shortcutFailed", { msg: String(err) }), "err"));
  } else if (act === "manage-create-backup" && id && !S.isBackingUp) {
    S.isBackingUp = true;
    const createBtn = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
    if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Yedekleniyor…"; }
    toast(i18nT("backup.backingUp"), "");
    epicBackupSave(id)
      .then((b) => {
        toast(i18nT("backup.created", { size: fmtBytes(b.size_bytes), count: b.file_count }), "ok");
        const cur = S.gameBackupsMap.get(id) || [];
        S.gameBackupsMap.set(id, [b, ...cur.filter((x) => x.id !== b.id)]);
        const listEl = document.getElementById("manage-backup-list");
        if (listEl) listEl.innerHTML = renderBackupListHtml(id);
      })
      .catch((err) => toast(i18nT("backup.failed", { msg: String(err) }), "err"))
      .finally(() => {
        S.isBackingUp = false;
        const btnAfter = document.querySelector<HTMLButtonElement>('[data-act="manage-create-backup"]');
        if (btnAfter) { btnAfter.disabled = false; btnAfter.textContent = "Yedek Al"; }
      });
  } else if (act === "manage-restore-backup" && id) {
    const bid = t.dataset.bid;
    if (bid) {
      toast(i18nT("backup.restoring"), "");
      epicRestoreBackup(id, bid)
        .then((msg) => toast(msg, "ok"))
        .catch((err) => toast(i18nT("backup.restoreFailed", { msg: String(err) }), "err"));
    }
  } else if (act === "manage-delete-backup" && id) {
    const bid = t.dataset.bid;
    if (bid) {
      epicDeleteBackup(id, bid)
        .then(() => {
          toast(i18nT("backup.deleted"), "");
          const cur = S.gameBackupsMap.get(id) || [];
          S.gameBackupsMap.set(id, cur.filter((x) => x.id !== bid));
          const listEl = document.getElementById("manage-backup-list");
          if (listEl) listEl.innerHTML = renderBackupListHtml(id);
        })
        .catch((err) => toast(i18nT("backup.deleteFailed", { msg: String(err) }), "err"));
    }
  } else if (act === "manage-open-backup-folder" && id) {
    epicOpenBackupFolder(id)
      .then((msg) => toast(msg, "ok"))
      .catch((err) => toast(String(err), "err"));
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
      localStorage.setItem(LANG_KEY, lang);
      void setLanguage(lang).then(() => {
        updateOfflineModeUi();
        if (isTauri) {
          void invoke("app_set_tray_labels", { show: i18nT("tray.show"), quit: i18nT("tray.quit") }).catch(() => {});
        }
        toast(i18nT("settings.langSet"), "ok");
        render();
      });
    }
  } else if (act === "manage-save-args" && id && S.activeManageSettings) {
    const input = document.getElementById("manage-args-input") as HTMLInputElement | null;
    const val = input?.value?.trim() ?? "";
    S.activeManageSettings.launchParameters = val;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(i18nT("manage.argsSaved"), "ok"))
      .catch((err) => toast(i18nT("manage.argsSaveFailed", { msg: String(err) }), "err"));
  } else if (act === "manage-save-launch-extras" && id && S.activeManageSettings) {
    const wrapperEl = document.getElementById("manage-wrapper-input") as HTMLInputElement | null;
    const envEl = document.getElementById("manage-env-input") as HTMLTextAreaElement | null;
    S.activeManageSettings.wrapper = wrapperEl?.value?.trim() ?? "";
    S.activeManageSettings.envVars = parseEnvText(envEl?.value ?? "");
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(i18nT("manage.launchExtrasSaved"), "ok"))
      .catch((err) => toast(i18nT("manage.argsSaveFailed", { msg: String(err) }), "err"));
  } else if (act === "dl-pause" && id) {
    epicPauseDownload(id)
      .then((msg) => {
        S.dlQueueStatus.isPaused = true;
        toast(msg, "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-resume" && id) {
    if (S.autoPausedDl === id) S.autoPausedDl = null;
    epicResumeDownload(id)
      .then((msg) => {
        S.dlQueueStatus.isPaused = false;
        toast(msg, "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-up" && id) {
    epicReorderQueue(id, "up")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-down" && id) {
    epicReorderQueue(id, "down")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-now" && id) {
    epicReorderQueue(id, "now")
      .then((q) => {
        S.dlQueueStatus = q;
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "dl-reorder-remove" && id) {
    epicReorderQueue(id, "remove")
      .then((q) => {
        S.dlQueueStatus = q;
        toast(i18nT("dl.removedFromQueue"), "");
        if (S.view === "downloads") render();
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "epic-open-folder" && id) {
    void epicOpenFolder(id);
  } else if (act === "epic-store-page" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    void openStoreUrl(epicStorePageUrlForGame(S.epicGamesRawMap.get(id), title), "store");
  } else if (act === "drawer-tab") {
    const tab = t.dataset.tab as DrawerTab;
    if (tab && S.currentModalAppName) {
      if (tab === S.activeDrawerTab) return;
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
          const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
          if (s) void fetchAndRenderScreenshots(S.currentModalAppName, s.title);
        }
      } else if (tab === "specs") {
        if (!S.loadedRequirements.has(S.currentModalAppName)) {
          const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
          if (s) void fetchAndRenderRequirements(S.currentModalAppName, s.title);
        }
      }
      openEpicModal(S.currentModalAppName, false, true);
    }
  } else if (act === "drawer-tabs-scroll") {
    const dir = t.dataset.dir;
    const container = document.getElementById("drawer-tabs-scrollable");
    if (container) {
      container.scrollBy({ left: dir === "left" ? -140 : 140, behavior: "smooth" });
      setTimeout(updateDrawerTabArrows, 180);
      setTimeout(updateDrawerTabArrows, 360);
    }
  } else if (act === "sys-plat") {
    const val = t.dataset.val;
    if (val && S.currentModalAppName) {
      if (S.activeSystemPlatform === val) return;
      S.activeSystemPlatform = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "req-refresh" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    if (s) void fetchAndRenderRequirements(id, s.title, true);
  } else if (act === "open-store-achievements" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = s ? s.title : id;
    const url = epicAchievementsUrl(title, id);
    void openStoreUrl(url, "store");
  } else if (act === "clear-ach-search") {
    S.achSearchQuery = "";
    if (S.currentModalAppName) {
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-filter") {
    const val = t.dataset.val as "all" | "unlocked" | "locked" | "hidden";
    if (val && S.currentModalAppName) {
      if (S.activeAchFilter === val) return;
      S.activeAchFilter = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-scope") {
    const val = t.dataset.val as "all" | "base" | "dlc";
    if (val && S.currentModalAppName) {
      if (S.activeAchScope === val) return;
      S.activeAchScope = val;
      openEpicModal(S.currentModalAppName, false, false);
    }
  } else if (act === "ach-reveal") {
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
  } else if (act === "toggle-demo-platinum" && id) {
    if (S.demoPlatinumApps.has(id)) {
      S.demoPlatinumApps.delete(id);
      toast(i18nT("platinum.removed"), "");
    } else {
      S.demoPlatinumApps.add(id);
      toast(i18nT("platinum.added"), "ok");
    }
    localStorage.setItem(DEMO_PLAT_KEY, JSON.stringify([...S.demoPlatinumApps]));
    if (S.view === "library") render();
    if (S.currentModalAppName === id) openEpicModal(id, false, false);
  } else if (act === "ach-refresh" && id) {
    void fetchAndRenderAchievements(id, true);
  } else if (act === "capture-screenshot" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = t.dataset.title || (s ? s.title : id);
    playScreenshotShutterSound();
    toast(i18nT("ss.capturing"), "");
    epicCaptureGameScreenshot(id, title)
      .then((item) => {
        toast(i18nT("ss.saved", { file: item.file_name }), "ok");
        void fetchAndRenderScreenshots(id, title, true);
      })
      .catch((err) => toast(String(err), "err"));
  } else if (act === "open-screenshots-folder" && id) {
    const s = S.epicSummaries.find((x) => x.appName === id);
    const title = t.dataset.title || (s ? s.title : id);
    void epicOpenGameScreenshotsFolder(id, title);
  } else if (act === "delete-screenshot" && id) {
    const filePath = t.dataset.path;
    const isLightbox = t.dataset.lightbox === "true";
    if (filePath) {
      if (confirm(i18nT("ss.deleteConfirm"))) {
        epicDeleteGameScreenshot(filePath)
          .then((success) => {
            if (success) {
              toast(i18nT("ss.deleted"), "ok");
              const s = S.epicSummaries.find((x) => x.appName === id);
              const title = s ? s.title : id;
              if (isLightbox) closeScreenshotLightbox();
              void fetchAndRenderScreenshots(id, title, true);
            } else {
              toast(i18nT("ss.deleteFailed"), "err");
            }
          })
          .catch((err) => toast(String(err), "err"));
      }
    }
  } else if (act === "open-screenshot-lightbox" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    openScreenshotLightbox(id, idx);
  } else if (act === "close-screenshot-lightbox") {
    closeScreenshotLightbox();
  } else if (act === "close-screenshot-lightbox-backdrop") {
    if (e.target === t) {
      closeScreenshotLightbox();
    }
  } else if (act === "lightbox-nav") {
    const dir = (t.dataset.dir as "prev" | "next") || "next";
    navigateScreenshotLightbox(dir);
  } else if (act === "share-screenshot" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    const list = S.loadedScreenshots.get(id) || [];
    const item = list[idx];
    if (item) {
      openShareModal(id, item);
    }
  } else if (act === "close-share-modal") {
    closeShareModal();
  } else if (act === "do-copy-image") {
    if (S.activeShareScreenshot) {
      void copyScreenshotImageToClipboard(S.activeShareScreenshot.item);
      closeShareModal();
    }
  } else if (act === "do-copy-path") {
    if (S.activeShareScreenshot) {
      const path = S.activeShareScreenshot.item.file_path;
      navigator.clipboard.writeText(path).then(() => {
        toast(i18nT("ss.pathCopiedShort"), "ok");
      }).catch(() => {
        toast(path, "");
      });
      closeShareModal();
    }
  } else if (act === "do-open-folder") {
    if (S.activeShareScreenshot) {
      const s = S.epicSummaries.find((x) => x.appName === S.activeShareScreenshot?.appName);
      const title = s ? s.title : S.activeShareScreenshot.appName;
      void epicOpenGameScreenshotsFolder(S.activeShareScreenshot.appName, title);
      closeShareModal();
    }
  } else if (act === "do-compress-from-share") {
    if (S.activeShareScreenshot) {
      const { appName, item } = S.activeShareScreenshot;
      closeShareModal();
      void compressScreenshotItem(appName, item);
    }
  } else if (act === "do-native-share") {
    if (S.activeShareScreenshot && typeof navigator.share === "function") {
      const item = S.activeShareScreenshot.item;
      navigator.share({
        title: item.file_name,
        text: i18nT("ss.shareText", { file: item.file_name }),
      }).catch(() => {});
      closeShareModal();
    }
  } else if (act === "compress-screenshot" && id) {
    const idx = parseInt(t.dataset.idx || "0", 10);
    const list = S.loadedScreenshots.get(id) || [];
    const item = list[idx];
    if (item) {
      void compressScreenshotItem(id, item);
    }
  } else if (act === "compress-all-screenshots" && id) {
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
  } else if (act === "toggle-presence") {
    S.presenceEnabled = !S.presenceEnabled;
    applyPresenceSettings();
    render();
  } else if (act === "refresh-eos") {
    void (async () => {
      S.eosOverlay = await eosOverlayStatus().catch(() => null);
      render();
    })();
  } else if (act === "open-eos-folder") {
    if (S.eosOverlay?.installed && S.eosOverlay.path) {
      void epicOpenFolderPath(S.eosOverlay.path).catch((e: unknown) => toast(String(e), "err"));
    }
  } else if (act === "toggle-downloads-settings") {
    S.downloadsSettingsOpen = !S.downloadsSettingsOpen;
    render();
  } else if (act === "toggle-speed-bits") {
    S.speedInBits = !S.speedInBits;
    localStorage.setItem(SPEED_BITS_KEY, String(S.speedInBits));
    render();
  } else if (act === "settings-section" && t.dataset.section) {
    S.settingsSection = t.dataset.section as typeof S.settingsSection;
    render();
    if (S.settingsSection === "integrations") void loadIntegrationsView();
  } else if (act === "toggle-nav-history-buttons") {
    S.showNavHistoryButtons = !S.showNavHistoryButtons;
    localStorage.setItem(NAV_HISTORY_KEY, String(S.showNavHistoryButtons));
    updateNavHistoryUi();
    render();
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

// Mouse-wheel support for horizontally scrollable tab strips.
