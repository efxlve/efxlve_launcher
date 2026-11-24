import { sortedAchievementHistory, type AchievementHistoryEntry } from "../../core/achievement-history";
import { filledTrophy, icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtAchDate, fmtDecimal1 } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import { hiddenAchievementAppNames, type StoreKind } from "./profile-view";

let cachedEntries: AchievementHistoryEntry[] = [];
let filteredEntries: AchievementHistoryEntry[] = [];
let renderedCount = 0;
let searchTimer = 0;
let activeFilter: "all" | "rare" | "shot" = "all";
const CHUNK_SIZE = 30;

function filterList(query: string): void {
  const q = query.trim().toLowerCase();
  filteredEntries = cachedEntries.filter((entry) => {
    if (activeFilter === "rare" && (entry.rarity == null || entry.rarity >= 5)) return false;
    if (activeFilter === "shot" && !entry.shot) return false;
    if (!q) return true;
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.game.toLowerCase().includes(q) ||
      (entry.description && entry.description.toLowerCase().includes(q))
    );
  });
  renderGrid();
}

function renderCard(entry: AchievementHistoryEntry): string {
  const dateIso = entry.date || (entry.seenAt ? new Date(entry.seenAt).toISOString() : "");
  const date = dateIso ? fmtAchDate(dateIso) : "";
  const isUltraRare = entry.rarity != null && entry.rarity < 5;
  const rarityText = entry.rarity != null ? `%${fmtDecimal1(entry.rarity)}` : "";
  const storeMark = entry.store ? storeLogo(entry.store, 12, "profile-unlock-store-logo") : "";

  const art = entry.icon
    ? `<img src="${esc(entry.icon)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="profile-unlocks-placeholder">${icon("trophy", 18)}</span>`;

  const shotIcon = entry.shot
    ? `<span class="profile-unlocks-shot-tag" title="${esc(t("profile.unlockShot"))}">${icon("camera", 11)}</span>`
    : "";

  let rarityBadge = "";
  if (entry.rarity != null) {
    rarityBadge = isUltraRare
      ? `<span class="profile-unlocks-badge is-rare tabular-nums">${icon("trophy", 10)}<span>${rarityText}</span></span>`
      : `<span class="profile-unlocks-badge tabular-nums">${rarityText}</span>`;
  } else if (entry.manual) {
    rarityBadge = `<span class="profile-unlocks-badge is-manual">${esc(t("profile.unlockManual"))}</span>`;
  }

  return `
    <button type="button" class="profile-unlocks-card${isUltraRare ? " is-rare-card" : ""}" data-act="open-pinned-achievement" data-id="${esc(entry.appName)}" data-ach="${esc(entry.name)}">
      <div class="profile-unlocks-card-art">
        ${art}
      </div>
      <div class="profile-unlocks-card-main">
        <div class="profile-unlocks-card-header">
          <span class="profile-unlocks-card-title">${esc(entry.title)}</span>
          ${shotIcon}
          ${rarityBadge}
        </div>
        <div class="profile-unlocks-card-meta">
          ${storeMark}
          <span class="profile-unlocks-card-game">${esc(entry.game)}</span>
          ${date ? `<span class="profile-unlocks-card-dot">·</span><span class="profile-unlocks-card-date tabular-nums">${esc(date)}</span>` : ""}
        </div>
        ${entry.description ? `<p class="profile-unlocks-card-desc">${esc(entry.description)}</p>` : ""}
      </div>
    </button>`;
}

function appendPage(): void {
  const container = document.getElementById("profile-unlocks-grid");
  if (!container) return;
  const nextSlice = filteredEntries.slice(renderedCount, renderedCount + CHUNK_SIZE);
  if (nextSlice.length === 0) return;
  const html = nextSlice.map(renderCard).join("");
  container.insertAdjacentHTML("beforeend", html);
  renderedCount += nextSlice.length;
}

function renderGrid(): void {
  const container = document.getElementById("profile-unlocks-grid");
  if (!container) return;
  renderedCount = 0;
  if (filteredEntries.length === 0) {
    container.innerHTML = `
      <div class="profile-unlocks-empty">
        <span class="profile-unlocks-empty-icon">${icon("trophy", 24)}</span>
        <p class="empty-title">${esc(t("common.noResults"))}</p>
      </div>`;
    return;
  }
  container.innerHTML = "";
  appendPage();
}

export function closeUnlocksModal(): void {
  if (searchTimer) {
    window.clearTimeout(searchTimer);
    searchTimer = 0;
  }
  const modal = document.getElementById("profile-unlocks-modal");
  if (modal) modal.remove();
  cachedEntries = [];
  filteredEntries = [];
  renderedCount = 0;
}

export function openUnlocksModal(scope: "all" | StoreKind = S.profileStore || "all"): void {
  closeUnlocksModal();
  activeFilter = "all";

  const hidden = hiddenAchievementAppNames(scope);
  cachedEntries = sortedAchievementHistory().filter((entry) => {
    if (scope !== "all" && entry.store !== scope) return false;
    if (S.hiddenGames.has(entry.appName)) return false;
    if (hidden.has(entry.appName) || S.hiddenAchievements.has(entry.appName)) return false;
    return true;
  });
  filteredEntries = cachedEntries;

  const totalCount = cachedEntries.length;
  const rareCount = cachedEntries.filter((e) => e.rarity != null && e.rarity < 5).length;
  const shotCount = cachedEntries.filter((e) => Boolean(e.shot)).length;

  const modalHtml = `
    <div id="profile-unlocks-modal" class="modal-backdrop fadeIn" style="z-index: 1050;">
      <div class="modal-box profile-unlocks-dialog" role="dialog" aria-modal="true" aria-labelledby="unlocks-modal-title">
        <div class="profile-unlocks-modal-head">
          <div class="profile-unlocks-modal-title-wrap">
            <span class="profile-unlocks-modal-icon">${filledTrophy(18)}</span>
            <div>
              <h3 id="unlocks-modal-title">${esc(t("profile.unlocksTitle"))}</h3>
              <p class="profile-unlocks-modal-sub tabular-nums">${totalCount.toLocaleString()} ${esc(t("ach.filterAll").toLowerCase())}</p>
            </div>
          </div>
          <div class="profile-unlocks-head-actions">
            <button type="button" class="btn ghost small" data-act="clear-ach-history" title="${esc(t("profile.unlocksClear"))}">
              ${icon("trash", 13)} <span>${esc(t("profile.unlocksClear"))}</span>
            </button>
            <button type="button" class="modal-close-btn" data-act="profile-unlocks-close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">
              ${icon("x", 16)}
            </button>
          </div>
        </div>

        <div class="profile-unlocks-toolbar">
          <div class="tabs profile-unlocks-tabs">
            <button type="button" class="tab active" data-unlock-filter="all">
              ${icon("layers", 12)}
              <span>${esc(t("ach.filterAll"))}</span>
              <span class="count">(${totalCount})</span>
            </button>
            ${rareCount > 0 ? `
              <button type="button" class="tab" data-unlock-filter="rare">
                ${filledTrophy(12)}
                <span>${esc(t("settings.achTierUltra"))}</span>
                <span class="count">(${rareCount})</span>
              </button>
            ` : ""}
            ${shotCount > 0 ? `
              <button type="button" class="tab" data-unlock-filter="shot">
                ${icon("camera", 12)}
                <span>${esc(t("profile.unlockShot"))}</span>
                <span class="count">(${shotCount})</span>
              </button>
            ` : ""}
          </div>
          <div class="search profile-unlocks-search">
            ${icon("search", 14)}
            <input id="profile-unlocks-search" type="text" placeholder="${esc(t("ach.searchPlaceholder"))}" autocomplete="off" spellcheck="false" />
          </div>
        </div>

        <div id="profile-unlocks-grid" class="profile-unlocks-grid"></div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  renderGrid();

  const gridEl = document.getElementById("profile-unlocks-grid");
  if (gridEl) {
    gridEl.addEventListener("scroll", () => {
      if (gridEl.scrollTop + gridEl.clientHeight >= gridEl.scrollHeight - 200) {
        appendPage();
      }
    });
  }

  const searchInput = document.getElementById("profile-unlocks-search") as HTMLInputElement | null;
  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener("input", () => {
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        searchTimer = 0;
        filterList(searchInput.value);
      }, 120);
    });
  }

  const modalEl = document.getElementById("profile-unlocks-modal");
  if (modalEl) {
    modalEl.addEventListener("click", (e) => {
      if (e.target === modalEl) {
        closeUnlocksModal();
        return;
      }
      const tabBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-unlock-filter]");
      if (tabBtn) {
        const filterVal = tabBtn.dataset.unlockFilter as "all" | "rare" | "shot";
        if (filterVal && filterVal !== activeFilter) {
          activeFilter = filterVal;
          modalEl.querySelectorAll("[data-unlock-filter]").forEach((b) => b.classList.remove("active"));
          tabBtn.classList.add("active");
          filterList(searchInput?.value || "");
        }
      }
    });

    modalEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeUnlocksModal();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = modalEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }
}
