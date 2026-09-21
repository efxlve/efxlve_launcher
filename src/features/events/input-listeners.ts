/**
 * Non-click global listeners: wheel zoom guard, resize, keyboard shortcuts,
 * form change/input delegation and the scroll-to-top button.
 */

import { SS_HOTKEY_KEY, SS_HOTKEY_NAME_KEY, SS_QUALITY_KEY, isTauri } from "../../core/constants";
import { closeModal, collectionRoot, playtimeRoot, viewEl } from "../../core/dom";
import { openEpicModal, render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t as i18nT } from "../../i18n";
import {
  epicCaptureGameScreenshot,
  epicInstallGame,
  epicSaveGameSettings,
  epicSetScreenshotHotkey,
  epicSetSteamGridKey,
  epicUninstallGame,
} from "../../epic";
import {
  closeCollectionModal,
  updateColPresetArrows,
} from "../collections/collections-view";
import {
  closeCustomCoverModal,
  renderCustomCoverModalContent,
  searchAndLoadSteamGrid,
} from "../cover/cover-view";
import {
  enrichAchievementsData,
  renderDrawerDlcs,
  updateDrawerTabArrows,
} from "../drawer/drawer-view";
import { renderAchievementSections } from "../drawer/drawer-widgets";
import { renderDlcRows } from "../dlc/dlc-manager";
import { closeSelectiveModal, renderSelectiveModal } from "../dlc/selective-install";
import { renderEpicItems, resetCardChunk, setupLibScrollObserver } from "../library/library-view";
import { closeMoveGameModal } from "../move-game/move-game-actions";
import { updateMoveSpaceBadgeInPlace } from "../move-game/move-game-view";
import { applyPresenceSettings } from "../presence/presence";
import { closeEditPlaytimeModal } from "../playtime/playtime-view";
import { renderProfileGameCards } from "../profile/profile-view";
import {
  closeScreenshotLightbox,
  closeShareModal,
  fetchAndRenderScreenshots,
  navigateScreenshotLightbox,
  playScreenshotShutterSound,
} from "../screenshots/screenshots-view";
document.addEventListener("wheel", (e) => {
  const scrollableBar = (e.target as HTMLElement)?.closest(".drawer-tabs, .drawer-tabs-wrapper, .ach-scope-segment, .col-quick-presets, .col-presets-track-wrapper") as HTMLElement | null;
  const targetBar = scrollableBar?.classList.contains("drawer-tabs-wrapper")
    ? (scrollableBar.querySelector(".drawer-tabs") as HTMLElement | null)
    : scrollableBar?.classList.contains("col-presets-track-wrapper")
      ? (scrollableBar.querySelector(".col-quick-presets") as HTMLElement | null)
      : scrollableBar;
  if (targetBar && e.deltaY !== 0 && targetBar.scrollWidth > targetBar.clientWidth) {
    e.preventDefault();
    targetBar.scrollLeft += e.deltaY;
    if (targetBar.id === "col-presets-scrollable") {
      updateColPresetArrows();
    } else {
      updateDrawerTabArrows();
    }
  }
}, { passive: false });

window.addEventListener("resize", () => {
  updateDrawerTabArrows();
  updateColPresetArrows();
});

document.addEventListener("keydown", (e) => {
  if (S.isRecordingScreenshotHotkey) {
    e.preventDefault();
    e.stopPropagation();
    const code = e.keyCode || e.which;
    if (code && code > 0) {
      const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      S.screenshotHotkey = code;
      S.screenshotHotkeyName = keyName;
      localStorage.setItem(SS_HOTKEY_KEY, String(code));
      localStorage.setItem(SS_HOTKEY_NAME_KEY, keyName);
      if (isTauri) void epicSetScreenshotHotkey(code);
      S.isRecordingScreenshotHotkey = false;
      toast(i18nT("ss.hotkeyAssigned", { key: keyName, code }), "ok");
      render();
    }
    return;
  }

  if (S.activeShareScreenshot) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeShareModal();
      return;
    }
  }

  if (S.activeLightboxScreenshot) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeScreenshotLightbox();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      navigateScreenshotLightbox("prev");
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      navigateScreenshotLightbox("next");
      return;
    }
  }

  if (e.keyCode === S.screenshotHotkey || e.key === S.screenshotHotkeyName || (S.screenshotHotkey === 0x7B && e.key === "F12")) {
    if (S.currentModalAppName) {
      e.preventDefault();
      const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
      const title = s ? s.title : S.currentModalAppName;
      toast(i18nT("ss.capturing"), "");
      epicCaptureGameScreenshot(S.currentModalAppName, title)
        .then((item) => {
          toast(i18nT("ss.saved", { file: item.file_name }), "ok");
          playScreenshotShutterSound();
          void fetchAndRenderScreenshots(S.currentModalAppName!, title, true);
        })
        .catch((err) => toast(String(err), "err"));
      return;
    }
  }

  if (e.key === "Enter" || e.key === " ") {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.classList.contains("pcard") || active.classList.contains("screenshot-card")) && !active.closest("input, select, textarea")) {
      e.preventDefault();
      active.click();
      return;
    }
  }
  if (e.key === "Escape") {
    if (S.activeMoveModalAppName) {
      if (S.isMovingGame) {
        toast(i18nT("move.inProgress"), "");
      } else {
        closeMoveGameModal();
      }
      return;
    }
    const coverRoot = document.getElementById("cover-modal-root");
    if (coverRoot && coverRoot.innerHTML.trim()) {
      closeCustomCoverModal();
      return;
    }
    if (collectionRoot && collectionRoot.innerHTML.trim()) {
      closeCollectionModal();
      return;
    }
    if (playtimeRoot && playtimeRoot.innerHTML.trim()) {
      closeEditPlaytimeModal();
      return;
    }
    if (S.selectiveInstallOptions) {
      closeSelectiveModal();
      return;
    }
    closeModal();
  }
  if (e.key === "Enter") {
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl && activeEl.id === "sgdb-search-input" && S.activeCustomCoverAppName) {
      e.preventDefault();
      searchAndLoadSteamGrid(S.activeCustomCoverAppName);
      return;
    }
    if (activeEl && activeEl.id === "modal-sgdb-key-input" && S.activeCustomCoverAppName) {
      e.preventDefault();
      const key = (activeEl as HTMLInputElement).value.trim();
      if (!key) {
        toast(i18nT("cover.needKey"), "err");
        return;
      }
      epicSetSteamGridKey(key)
        .then(() => {
          S.steamGridApiKey = key;
          toast(i18nT("cover.keySaved"), "ok");
          renderCustomCoverModalContent(S.activeCustomCoverAppName);
          void searchAndLoadSteamGrid(S.activeCustomCoverAppName, S.sgdbSearchQuery);
        })
        .catch((err) => toast(String(err), "err"));
      return;
    }
    if (activeEl && activeEl.id === "custom-cover-url-input") {
      e.preventDefault();
      const val = (activeEl as HTMLInputElement).value.trim();
      if (val) {
        S.sgdbSelectedCoverUrl = val;
        const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
        if (previewWrapper) {
          previewWrapper.innerHTML = `
            <img id="cover-preview-img" src="${esc(val)}" alt="${i18nT("cover.previewAlt")}" />
            <div class="cover-preview-badge">${i18nT("cover.preview")}</div>
          `;
        }
      }
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
    const s = document.getElementById("search");
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
});

document.addEventListener("change", (e) => {
  const target = e.target as HTMLInputElement;
  if (target && target.id === "custom-cover-file-input" && target.files && target.files[0]) {
    const file = target.files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      S.sgdbSelectedCoverUrl = result;
      const urlInput = document.getElementById("custom-cover-url-input") as HTMLInputElement | null;
      const previewWrapper = document.querySelector(".cover-preview-card") as HTMLElement | null;
      if (urlInput) urlInput.value = result;
      if (previewWrapper) {
        previewWrapper.innerHTML = `
          <img id="cover-preview-img" src="${result}" alt="${i18nT("cover.previewAlt")}" />
          <div class="cover-preview-badge">${i18nT("cover.localFile")}</div>
        `;
      }
    };
    reader.readAsDataURL(file);
  }
  if (target && target.id === "presence-client-id") {
    S.presenceClientId = target.value.trim();
    applyPresenceSettings();
    return;
  }
  if (target && (target as HTMLElement).id === "ach-sort-select") {
    S.achSortOrder = (target as unknown as HTMLSelectElement).value as any;
    if (S.currentModalAppName) {
      openEpicModal(S.currentModalAppName, false, false);
    }
    return;
  }
  if (target && target.id === "ss-hotkey-select") {
    const code = parseInt(target.value, 10);
    if (code && code > 0) {
      S.screenshotHotkey = code;
      const found = S.PRESET_HOTKEYS.find((k) => k.code === code);
      const name = found ? found.name.split(" ")[0] : `Key_${code}`;
      S.screenshotHotkeyName = name;
      localStorage.setItem(SS_HOTKEY_KEY, String(code));
      localStorage.setItem(SS_HOTKEY_NAME_KEY, name);
      if (isTauri) void epicSetScreenshotHotkey(code);
      toast(i18nT("ss.hotkeyUpdated", { key: name }), "ok");
      render();
    }
    return;
  }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t && t.id === "ss-quality-slider") {
    const val = parseFloat((t as HTMLInputElement).value);
    S.screenshotCompressionQuality = val;
    localStorage.setItem(SS_QUALITY_KEY, String(val));
    const label = document.getElementById("ss-quality-val");
    if (label) label.textContent = `%${Math.round(val * 100)}`;
    return;
  }
  if (t.id === "ach-search-input" && S.currentModalAppName) {
    S.achSearchQuery = (t as HTMLInputElement).value;
    const container = document.getElementById("ach-list-container");
    if (container) {
      const data = S.loadedAchievements.get(S.currentModalAppName);
      const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
      if (data && s) {
        enrichAchievementsData(s.appName, data);
        const query = S.achSearchQuery.trim().toLowerCase();
        const isDemo = S.demoPlatinumApps.has(s.appName);
        const filteredItems = data.achievements.filter((a) => {
          const isUnlocked = a.unlocked || isDemo;
          if (S.activeAchFilter === "unlocked" && !isUnlocked) return false;
          if (S.activeAchFilter === "locked" && isUnlocked) return false;
          if (S.activeAchFilter === "hidden" && !a.hidden) return false;
          if (query) {
            const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
            const matchDesc = (a.description || "").toLowerCase().includes(query);
            if (!matchTitle && !matchDesc) return false;
          }
          return true;
        });
        const sortedItems = [...filteredItems].sort((a, b) => {
          if (S.achSortOrder === "rarity") {
            const ra = a.rarity?.percent ?? 100;
            const rb = b.rarity?.percent ?? 100;
            return ra - rb;
          }
          if (S.achSortOrder === "xp") return b.xp - a.xp;
          if (S.achSortOrder === "date") {
            const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
            const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
            return db - da;
          }
          return 0;
        });
        const hasDlc = data.achievements.some((a) => !a.is_base);
        container.innerHTML = renderAchievementSections(sortedItems, s, hasDlc, data.achievements);
      }
    }
    return;
  }
  if (t.id === "pt-hours-input" || t.id === "pt-minutes-input") {
    const h = parseInt((document.getElementById("pt-hours-input") as HTMLInputElement)?.value || "0", 10) || 0;
    const m = parseInt((document.getElementById("pt-minutes-input") as HTMLInputElement)?.value || "0", 10) || 0;
    const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;
    if (lpSelect) {
      if (h > 0 || m > 0) {
        if (!lpSelect.value) {
          lpSelect.value = "Daha önce oynandı (Epic Games)";
        }
      } else {
        if (lpSelect.value === "Daha önce oynandı (Epic Games)") {
          lpSelect.value = "";
        }
      }
    }
    return;
  }
  if (t.id === "sgdb-search-input") {
    S.sgdbSearchQuery = (t as HTMLInputElement).value;
    return;
  }
  if (t.id === "search") {
    const val = (t as HTMLInputElement).value;
    if (S.libSearchTimer !== null) {
      window.clearTimeout(S.libSearchTimer);
    }
    S.libSearchTimer = window.setTimeout(() => {
      S.libSearchTimer = null;
      S.query = val;
      resetCardChunk();
      const box = document.getElementById("lib-results");
      if (box) {
        box.innerHTML = renderEpicItems();
        setupLibScrollObserver();
      }
    }, 120);
    return;
  }
  if (t.id === "dlc-search") {
    S.dlcSearchQuery = (t as HTMLInputElement).value;
    const bodyEl = document.getElementById("dlc-table-body");
    if (bodyEl && S.activeDlcAppName) {
      const dlcRes = S.dlcCache.get(S.activeDlcAppName);
      const allDlcs = dlcRes?.dlcs || [];
      const q = S.dlcSearchQuery.trim().toLowerCase();
      const filtered = q
        ? allDlcs.filter((d) => d.title.toLowerCase().includes(q))
        : allDlcs;
      bodyEl.innerHTML = renderDlcRows(filtered);
    }
    return;
  }
  if (t.id === "dlc-drawer-search" && S.currentModalAppName) {
    S.dlcSearchQuery = (t as HTMLInputElement).value;
    const s = S.epicSummaries.find((x) => x.appName === S.currentModalAppName);
    const contentEl = document.getElementById("drawer-tab-content");
    if (s && contentEl && S.activeDrawerTab === "dlcs") {
      contentEl.innerHTML = renderDrawerDlcs(s);
      const searchInput = document.getElementById("dlc-drawer-search") as HTMLInputElement | null;
      if (searchInput) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }
    }
    return;
  }
  if (t.id === "profile-search") {
    S.profileSearchQuery = (t as HTMLInputElement).value;
    const grid = document.getElementById("profile-games-grid");
    if (grid && S.playerProfileData) {
      const all = S.playerProfileData.games || [];
      let filtered = all.filter((g) => {
        if (S.profileFilter === "platinum") return g.is_platinum || g.unlocked_percent >= 100;
        if (S.profileFilter === "in_progress") return g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum;
        if (S.profileFilter === "not_started") return g.unlocked_percent === 0;
        return true;
      });
      if (S.profileSearchQuery.trim()) {
        const q = S.profileSearchQuery.trim().toLowerCase();
        filtered = filtered.filter(
          (g) => g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q),
        );
      }
      filtered.sort((a, b) => {
        if (S.profileSort === "progress") {
          return b.is_platinum !== a.is_platinum
            ? (b.is_platinum ? 1 : -1)
            : b.unlocked_percent !== a.unlocked_percent
              ? b.unlocked_percent - a.unlocked_percent
              : b.total_xp - a.total_xp;
        }
        if (S.profileSort === "xp") return b.total_xp - a.total_xp;
        if (S.profileSort === "playtime") {
          const ptA = S.playtimeMap.get(a.app_name)?.total_seconds || 0;
          const ptB = S.playtimeMap.get(b.app_name)?.total_seconds || 0;
          return ptB - ptA;
        }
        if (S.profileSort === "alpha") return a.app_title.localeCompare(b.app_title, "tr");
        return 0;
      });
      grid.innerHTML = renderProfileGameCards(filtered);
    }
    return;
  }
  if (t.id === "move-target-input") {
    const val = (t as HTMLInputElement).value;
    S.selectedMoveTargetPath = val;
    const trimmed = val.trim();
    if (trimmed.length >= 2 && trimmed[1] === ":") {
      const letter = trimmed[0].toUpperCase();
      if (letter !== S.selectedMoveDriveLetter.toUpperCase()) {
        S.selectedMoveDriveLetter = letter;
        const cards = document.querySelectorAll(".move-drive-card");
        cards.forEach((c) => {
          const el = c as HTMLElement;
          if (el.dataset.drive?.toUpperCase() === letter) {
            el.classList.add("selected");
          } else {
            el.classList.remove("selected");
          }
        });
      }
    }
    updateMoveSpaceBadgeInPlace();
    return;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "profile-sort-select") {
    S.profileSort = (t as HTMLSelectElement).value as typeof S.profileSort;
    render();
    return;
  }
  if (t.id === "epic-sort") {
    S.epicSort = (t as HTMLSelectElement).value as typeof S.epicSort;
    render();
    return;
  }
  const act = t.dataset.act;
  if (act === "manage-toggle-autoupdate" && S.activeManageSettings) {
    S.activeManageSettings.autoUpdate = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(i18nT(S.activeManageSettings?.autoUpdate ? "manage.autoUpdateOn" : "manage.autoUpdateOff"), ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-priority" && S.activeManageSettings) {
    S.activeManageSettings.highPriority = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(i18nT(S.activeManageSettings?.highPriority ? "manage.priorityOn" : "manage.priorityOff"), ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "manage-toggle-cloud" && S.activeManageSettings) {
    S.activeManageSettings.cloudSavesEnabled = (t as HTMLInputElement).checked;
    epicSaveGameSettings(S.activeManageSettings)
      .then(() => toast(i18nT(S.activeManageSettings?.cloudSavesEnabled ? "manage.cloudOn" : "manage.cloudOff"), ""))
      .catch((err) => toast(String(err), "err"));
  } else if (act === "selective-toggle-tag") {
    const tag = t.dataset.tag;
    if (tag) {
      if ((t as HTMLInputElement).checked) {
        S.selectedInstallTags.add(tag);
      } else {
        S.selectedInstallTags.delete(tag);
      }
      renderSelectiveModal();
    }
  } else if (act === "selective-toggle-dlc") {
    const dlc = t.dataset.dlc;
    if (dlc) {
      if ((t as HTMLInputElement).checked) {
        S.selectedDlcAppIds.add(dlc);
      } else {
        S.selectedDlcAppIds.delete(dlc);
      }
      renderSelectiveModal();
    }
  } else if (act === "dlc-toggle-install") {
    const app = t.dataset.app;
    const dlcId = t.dataset.dlc;
    const isChecked = (t as HTMLInputElement).checked;
    if (app && dlcId) {
      if (isChecked) {
        toast("Eklenti kuruluyor…", "");
        epicInstallGame(dlcId)
          .then(() => {
            toast(i18nT("dl.dlcQueued"), "ok");
            const cached = S.dlcCache.get(app);
            if (cached) {
              const item = cached.dlcs.find((d) => d.appId === dlcId);
              if (item) item.installed = true;
            }
          })
          .catch((err) => {
            (t as HTMLInputElement).checked = false;
            toast(i18nT("dl.dlcInstallFailed", { msg: String(err) }), "err");
          });
      } else {
        toast(i18nT("dl.dlcRemoving"), "");
        epicUninstallGame(dlcId)
          .then(() => {
            toast(i18nT("dl.dlcRemoved"), "ok");
            const cached = S.dlcCache.get(app);
            if (cached) {
              const item = cached.dlcs.find((d) => d.appId === dlcId);
              if (item) item.installed = false;
            }
          })
          .catch((err) => {
            (t as HTMLInputElement).checked = true;
            toast(i18nT("dl.dlcRemoveFailed", { msg: String(err) }), "err");
          });
      }
    }
  }
});

viewEl.addEventListener("scroll", () => {
  const totop = document.getElementById("totop");
  if (totop) totop.classList.toggle("show", viewEl.scrollTop > 600);
}, { passive: true });
