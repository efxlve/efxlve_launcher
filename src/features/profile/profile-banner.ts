/**
 * Profile banner picker modal & manager.
 * Allows users to choose any game from their library as the hero banner,
 * maintained independently per store/profile scope or account.
 */

import { CUSTOM_PROFILE_BANNERS_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { epicWideArt, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, isOpaqueId } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import { coverOf, gameStore, storeCode, type StoreKind } from "./profile-view";

export interface BannerGameCandidate {
  appName: string;
  title: string;
  art: string;
  store: StoreKind;
}

let cachedCandidates: BannerGameCandidate[] = [];
let currentModalScopeKey = "";
/** Pending banner-search grid patch; a full-library rebuild waits for a pause. */
let bannerSearchTimer = 0;

/** Resolves the best landscape or cover art for a game to use as a banner preview. */
export function getGameBannerArt(appName: string): string {
  const custom = S.customHeroes[appName];
  if (custom) return custom;
  const s = summaryOf(appName);
  const art = s ? epicWideArt(s) : null;
  if (art) return art;
  return coverOf(appName) || "";
}

/** Collect all candidate games from the library. */
function collectBannerCandidates(): BannerGameCandidate[] {
  const games: BannerGameCandidate[] = [];
  const seen = new Set<string>();

  const add = (appName: string, title: string) => {
    if (!appName || seen.has(appName) || S.hiddenGames.has(appName) || isOpaqueId(title)) return;
    seen.add(appName);
    const art = getGameBannerArt(appName);
    games.push({
      appName,
      title,
      art,
      store: gameStore(appName),
    });
  };

  for (const name of S.epicRecent) {
    const s = summaryOf(name);
    if (s) add(name, s.title);
  }
  for (const s of S.epicSummaries) add(s.appName, s.title);
  for (const g of S.steamSummaries) add(g.key, g.title);
  for (const g of S.gogSummaries) add(g.key, g.title);
  for (const a of S.amazonSummaries) add(a.key, a.title);
  for (const c of S.companionSummaries) add(c.key, c.title);

  const collator = new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  games.sort((a, b) => collator.compare(a.title, b.title));
  return games;
}

function renderBannerCard(g: BannerGameCandidate, currentApp: string, scopeKey: string): string {
  const isActive = g.appName === currentApp;
  return `
    <button type="button" class="profile-banner-item${isActive ? " is-active" : ""}" data-act="profile-banner-select" data-scope="${esc(scopeKey)}" data-app="${esc(g.appName)}" title="${esc(g.title)}">
      <span class="profile-banner-thumb-wrap">
        ${g.art ? `<img src="${esc(g.art)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-banner-thumb-ph">${icon("gamepad-2", 20)}</span>`}
        ${isActive ? `<span class="profile-banner-active-pill">${icon("check", 11)} <span>${esc(t("profile.bannerCurrent"))}</span></span>` : ""}
        <span class="profile-banner-store-pill">${storeLogo(g.store, 10)}<span>${storeCode(g.store)}</span></span>
      </span>
      <span class="profile-banner-item-name">${esc(g.title)}</span>
    </button>`;
}

function renderBannerGridHtml(games: BannerGameCandidate[], currentApp: string, scopeKey: string): string {
  if (games.length === 0) {
    return `<div class="profile-banner-empty"><p>${esc(t("profile.bannerNoGames"))}</p></div>`;
  }
  return games.map((g) => renderBannerCard(g, currentApp, scopeKey)).join("");
}

export function closeProfileBannerModal(): void {
  if (bannerSearchTimer) {
    window.clearTimeout(bannerSearchTimer);
    bannerSearchTimer = 0;
  }
  const modal = document.getElementById("profile-banner-modal");
  if (modal) modal.remove();
  cachedCandidates = [];
  currentModalScopeKey = "";
}

export function saveProfileBanner(scopeKey: string, appName: string): void {
  S.customProfileBanners[scopeKey] = appName;
  try {
    localStorage.setItem(CUSTOM_PROFILE_BANNERS_KEY, JSON.stringify(S.customProfileBanners));
  } catch (e) {
    console.error("Failed to save profile banner:", e);
  }
  closeProfileBannerModal();
  render();
  toast(t("profile.bannerUpdated"), "ok");
}

export function resetProfileBanner(scopeKey: string): void {
  delete S.customProfileBanners[scopeKey];
  try {
    localStorage.setItem(CUSTOM_PROFILE_BANNERS_KEY, JSON.stringify(S.customProfileBanners));
  } catch (e) {
    console.error("Failed to reset profile banner:", e);
  }
  closeProfileBannerModal();
  render();
  toast(t("profile.bannerResetToast"), "ok");
}

export function filterProfileBannerModal(query: string): void {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? cachedCandidates.filter((g) => g.title.toLowerCase().includes(q) || g.appName.toLowerCase().includes(q))
    : cachedCandidates;
  const currentApp = S.customProfileBanners[currentModalScopeKey] || "";
  const grid = document.getElementById("profile-banner-grid");
  if (grid) {
    grid.innerHTML = renderBannerGridHtml(filtered, currentApp, currentModalScopeKey);
  }
}

export function openProfileBannerModal(scopeKey: string, scopeLabel = ""): void {
  closeProfileBannerModal();
  currentModalScopeKey = scopeKey;
  cachedCandidates = collectBannerCandidates();

  const currentApp = S.customProfileBanners[scopeKey] || "";
  const hasCustom = Boolean(currentApp);

  const modalHtml = `
    <div id="profile-banner-modal" class="modal-backdrop fadeIn" style="z-index: 1050;">
      <div class="modal-box profile-banner-dialog" role="dialog" aria-modal="true" aria-labelledby="banner-modal-title">
        <div class="profile-banner-modal-head">
          <div class="profile-banner-modal-title-wrap">
            <span class="profile-banner-modal-icon">${icon("image", 18)}</span>
            <div>
              <h3 id="banner-modal-title">${esc(t("profile.changeBannerTitle"))}</h3>
              <p class="profile-banner-modal-sub">${scopeLabel ? `${esc(scopeLabel)} · ` : ""}${esc(t("profile.bannerModalDesc"))}</p>
            </div>
          </div>
          <button type="button" class="modal-close-btn" data-act="profile-banner-close" title="${esc(t("common.close"))}">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="profile-banner-modal-toolbar">
          <div class="search profile-banner-search-box">
            ${icon("search", 15)}
            <input id="profile-banner-search" type="text" placeholder="${esc(t("profile.bannerSearchPlaceholder"))}" autocomplete="off" spellcheck="false" />
          </div>
          ${hasCustom ? `
            <button type="button" class="btn ghost small profile-banner-reset-btn" data-act="profile-banner-reset" data-scope="${esc(scopeKey)}">
              ${icon("refresh", 13)} <span>${esc(t("profile.bannerReset"))}</span>
            </button>
          ` : ""}
        </div>

        <div id="profile-banner-grid" class="profile-banner-grid">
          ${renderBannerGridHtml(cachedCandidates, currentApp, scopeKey)}
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);

  const input = document.getElementById("profile-banner-search") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.addEventListener("input", () => {
      // The picker can hold the whole library; rebuilding every card on each
      // keystroke (and re-requesting its art) reads as the grid reloading.
      if (bannerSearchTimer) window.clearTimeout(bannerSearchTimer);
      bannerSearchTimer = window.setTimeout(() => {
        bannerSearchTimer = 0;
        filterProfileBannerModal(input.value);
      }, 140);
    });
  }

  const modalEl = document.getElementById("profile-banner-modal");
  if (modalEl) {
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) closeProfileBannerModal();
    });
  }
}
