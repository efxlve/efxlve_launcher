/**
 * Click delegation handlers for custom cover art, hero banner,
 * and SteamGridDB key management / searching.
 */

import { toast } from "../../../core/toast";
import { t as i18nT } from "../../../i18n";
import { S } from "../../../core/state";
import { icon } from "../../../core/icons";
import { esc } from "../../../core/utils";
import { render } from "../../../core/render";
import { epicSetSteamGridKey, epicTestSteamGridKey } from "../../../epic";
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
} from "../../cover/cover-view";

export function handleCoverAction(act: string | undefined, t: HTMLElement, id?: string, targetEl?: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "open-custom-cover":
      if (id) {
        const target = (t.dataset.target as "cover" | "hero") || "cover";
        openCustomCoverModal(id, target);
      }
      return true;

    case "set-cover-target":
      if (id) {
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
      }
      return true;

    case "cover-modal-backdrop":
      if (targetEl === t) closeCustomCoverModal();
      return true;

    case "prevent-modal-close":
      // Keep the modal open when its content is clicked.
      return true;

    case "close-custom-cover":
      if (t.classList.contains("cover-overlay") && targetEl !== t) return true;
      closeCustomCoverModal();
      return true;

    case "toggle-sgdb-modal-info":
      S.showModalSgdbInfo = !S.showModalSgdbInfo;
      if (S.activeCustomCoverAppName) {
        renderCustomCoverModalContent(S.activeCustomCoverAppName);
      }
      return true;

    case "switch-cover-tab":
      if (t.dataset.tab) {
        S.customCoverActiveTab = t.dataset.tab as typeof S.customCoverActiveTab;
        document.querySelectorAll(".cover-tab-btn").forEach((btn) => {
          btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === S.customCoverActiveTab);
        });
        if (S.activeCustomCoverAppName) {
          renderCustomCoverModalContent(S.activeCustomCoverAppName);
        }
      }
      return true;

    case "sgdb-search":
      if (id) {
        const input = document.getElementById("sgdb-search-input") as HTMLInputElement | null;
        if (input) S.sgdbSearchQuery = input.value;
        void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
      }
      return true;

    case "sgdb-select-game":
      if (id && t.dataset.gameId) {
        const gId = parseInt(t.dataset.gameId, 10);
        if (!isNaN(gId)) {
          S.sgdbSelectedGameId = gId;
          void loadSteamGridCovers(id, gId);
        }
      }
      return true;

    case "sgdb-set-asset-type":
      if (id && t.dataset.type) {
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
      }
      return true;

    case "sgdb-set-style":
      if (id) {
        S.sgdbActiveStyle = t.dataset.style || "";
        if (S.sgdbSelectedGameId) {
          void loadSteamGridCovers(id, S.sgdbSelectedGameId);
        }
      }
      return true;

    case "sgdb-select-card":
      if (t.dataset.url) {
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
      }
      return true;

    case "save-inline-sgdb-key":
      if (id) {
        const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
        const key = input?.value.trim() || "";
        if (!key) {
          toast(i18nT("cover.needKey"), "err");
          return true;
        }
        epicSetSteamGridKey(key)
          .then(() => {
            S.steamGridApiKey = key;
            toast(i18nT("cover.keySaved"), "ok");
            renderCustomCoverModalContent(id);
            void searchAndLoadSteamGrid(id, S.sgdbSearchQuery);
          })
          .catch((err) => toast(String(err), "err"));
      }
      return true;

    case "save-sgdb-key": {
      const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
      const key = input?.value.trim() || "";
      epicSetSteamGridKey(key)
        .then(() => {
          S.steamGridApiKey = key || null;
          toast(key ? i18nT("cover.keySaved") : i18nT("cover.keyRemoved"), "ok");
          render();
        })
        .catch((err) => toast(String(err), "err"));
      return true;
    }

    case "test-sgdb-key": {
      const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
      const key = input?.value.trim() || S.steamGridApiKey || "";
      if (!key) {
        toast(i18nT("cover.enterTestKey"), "err");
        return true;
      }
      toast(i18nT("cover.testing"), "");
      epicTestSteamGridKey(key)
        .then(() => toast(i18nT("cover.testOk"), "ok"))
        .catch((err) => toast(i18nT("cover.testFailed", { msg: String(err) }), "err"));
      return true;
    }

    case "toggle-sgdb-key-visibility": {
      const input = document.getElementById("settings-sgdb-key-input") as HTMLInputElement | null;
      if (input) {
        S.showSettingsSgdbKey = !S.showSettingsSgdbKey;
        input.type = S.showSettingsSgdbKey ? "text" : "password";
        t.innerHTML = icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13);
      }
      return true;
    }

    case "toggle-modal-sgdb-key-visibility": {
      const input = document.getElementById("modal-sgdb-key-input") as HTMLInputElement | null;
      if (input) {
        S.showModalSgdbKey = !S.showModalSgdbKey;
        input.type = S.showModalSgdbKey ? "text" : "password";
        t.innerHTML = icon(S.showModalSgdbKey ? "eye-off" : "eye", 13);
      }
      return true;
    }

    case "preview-custom-cover-url": {
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
      return true;
    }

    case "save-custom-cover":
      if (id) {
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
      }
      return true;

    case "reset-active-target":
      if (id) {
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
      }
      return true;

    case "reset-all-art":
      if (id) {
        resetCustomCover(id);
        resetCustomHero(id);
        S.sgdbSelectedCoverUrl = "";
        toast(i18nT("cover.allReset"), "ok");
        renderCustomCoverModalFrame(id);
        renderCustomCoverModalContent(id);
      }
      return true;

    case "reset-custom-cover":
      if (id) {
        resetCustomCover(id);
        closeCustomCoverModal();
        toast(i18nT("cover.originalRestored"), "ok");
      }
      return true;

    default:
      return false;
  }
}
