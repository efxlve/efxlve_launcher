import { sortedAchievementHistory, type AchievementHistoryEntry } from "../../core/achievement-history";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { StoreKind } from "./profile-view";
import { esc, fmtAchDate, fmtDecimal1 } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";

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
  renderList();
}

function renderCard(entry: AchievementHistoryEntry): string {
  const dateIso = entry.date || (entry.seenAt ? new Date(entry.seenAt).toISOString() : "");
  const date = dateIso ? fmtAchDate(dateIso) : "";
  const isUltraRare = entry.rarity != null && entry.rarity < 5;
  const rarityText = entry.rarity != null ? `%${fmtDecimal1(entry.rarity)}` : "";
  const storeMark = entry.store ? storeLogo(entry.store, 13, "profile-unlock-store-logo") : "";

  const art = entry.icon
    ? `<img class="profile-unlocks-art" src="${esc(entry.icon)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="profile-unlocks-placeholder">${icon("trophy", 20)}</span>`;

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

  const tip = [
    `${entry.title} — ${entry.game}`,
    date,
    rarityText,
    entry.description || "",
  ].filter(Boolean).join(" · ");

  return `
    <button type="button" class="profile-unlocks-item${isUltraRare ? " is-rare-item" : ""}" data-act="open-pinned-achievement" data-id="${esc(entry.appName)}" data-ach="${esc(entry.name)}" title="${esc(tip)}">
      <div class="profile-unlocks-art-wrap">
        ${art}
      </div>
      <div class="profile-unlocks-info">
        <div class="profile-unlocks-row-top">
          <span class="profile-unlocks-title">${esc(entry.title)}</span>
          ${shotIcon}
        </div>
        <div class="profile-unlocks-row-sub">
          ${storeMark}
          <span class="profile-unlocks-game">${esc(entry.game)}</span>
          ${date ? `<span class="profile-unlocks-dot">·</span><span class="profile-unlocks-date tabular-nums">${esc(date)}</span>` : ""}
        </div>
        ${entry.description ? `<p class="profile-unlocks-desc">${esc(entry.description)}</p>` : ""}
      </div>
      <div class="profile-unlocks-end">
        ${rarityBadge}
      </div>
    </button>`;
}

function appendPage(): void {
  const container = document.getElementById("profile-unlocks-list");
  if (!container) return;
  const nextSlice = filteredEntries.slice(renderedCount, renderedCount + CHUNK_SIZE);
  if (nextSlice.length === 0) return;
  const html = nextSlice.map(renderCard).join("");
  container.insertAdjacentHTML("beforeend", html);
  renderedCount += nextSlice.length;
}

function renderList(): void {
  const container = document.getElementById("profile-unlocks-list");
  if (!container) return;
  renderedCount = 0;
  if (filteredEntries.length === 0) {
    container.innerHTML = `
      <div class="profile-unlocks-empty">
        <span class="profile-unlocks-empty-icon">${icon("trophy", 28)}</span>
        <p>${esc(t("common.noResults"))}</p>
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

  cachedEntries = sortedAchievementHistory().filter((entry) => {
    if (scope !== "all" && entry.store !== scope) return false;
    if (S.hiddenGames.has(entry.appName)) return false;
    if (S.hiddenAchievements.has(entry.appName)) return false;
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
            <span class="profile-unlocks-modal-icon">${icon("trophy", 18)}</span>
            <div>
              <h3 id="unlocks-modal-title">${esc(t("profile.unlocksTitle"))}</h3>
              <p class="profile-unlocks-modal-sub tabular-nums">${totalCount.toLocaleString()} ${esc(t("ach.filterAll").toLowerCase())}</p>
            </div>
          </div>
          <div class="profile-unlocks-head-actions">
            <button type="button" class="icon-btn" data-act="clear-ach-history" title="${esc(t("profile.unlocksClear"))}" aria-label="${esc(t("profile.unlocksClear"))}">
              ${icon("trash", 15)}
            </button>
            <button type="button" class="modal-close-btn" data-act="profile-unlocks-close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">
              ${icon("x", 16)}
            </button>
          </div>
        </div>

        <div class="profile-unlocks-modal-toolbar">
          <div class="search profile-unlocks-search-box">
            ${icon("search", 15)}
            <input id="profile-unlocks-search" type="text" placeholder="${esc(t("ach.searchPlaceholder"))}" autocomplete="off" spellcheck="false" />
          </div>
          <div class="profile-unlocks-filters">
            <button type="button" class="profile-unlocks-filter-btn is-active" data-unlock-filter="all">
              ${esc(t("ach.filterAll"))} (${totalCount})
            </button>
            ${rareCount > 0 ? `
              <button type="button" class="profile-unlocks-filter-btn is-rare-pill" data-unlock-filter="rare">
                ${icon("trophy", 11)} <span>${esc(t("settings.achTierUltra"))} (${rareCount})</span>
              </button>
            ` : ""}
            ${shotCount > 0 ? `
              <button type="button" class="profile-unlocks-filter-btn" data-unlock-filter="shot">
                ${icon("camera", 11)} <span>${esc(t("profile.unlockShot"))} (${shotCount})</span>
              </button>
            ` : ""}
          </div>
        </div>

        <div id="profile-unlocks-list" class="profile-unlocks-list"></div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", modalHtml);
  renderList();

  const listEl = document.getElementById("profile-unlocks-list");
  if (listEl) {
    listEl.addEventListener("scroll", () => {
      if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 200) {
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
      const filterBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-unlock-filter]");
      if (filterBtn) {
        const filterVal = filterBtn.dataset.unlockFilter as "all" | "rare" | "shot";
        if (filterVal && filterVal !== activeFilter) {
          activeFilter = filterVal;
          modalEl.querySelectorAll("[data-unlock-filter]").forEach((b) => b.classList.remove("is-active"));
          filterBtn.classList.add("is-active");
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
