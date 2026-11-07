/**
 * Per-game custom sorting title ("Sort As").
 *
 * Lets players order franchises like "Tomb Raider", "Rise of the Tomb Raider",
 * and "Shadow of the Tomb Raider" (`Tomb Raider 1`, `Tomb Raider 2`, `Tomb Raider 3`)
 * or "Assassin's Creed" (`Assassin's Creed 01`, `02`, `03`) without changing
 * the visible title shown on cards or game pages.
 */

import { CUSTOM_SORT_NAMES_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { notify, scheduleRender } from "../../core/render";
import { storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

function persistCustomSortNames(): void {
  try {
    const entries = Object.entries(S.customSortNames).filter(([, v]) => typeof v === "string" && v.trim().length > 0);
    if (entries.length === 0) {
      localStorage.removeItem(CUSTOM_SORT_NAMES_KEY);
    } else {
      localStorage.setItem(CUSTOM_SORT_NAMES_KEY, JSON.stringify(Object.fromEntries(entries)));
    }
  } catch {
    // Storage quota/errors leave session state intact.
  }
}

/** Custom sort title set on `appName` (or a merged sibling store copy), empty when unset. */
export function customSortNameOf(appName: string, title?: string): string {
  const direct = S.customSortNames[appName]?.trim();
  if (direct) return direct;
  if (!S.separateCopies) {
    const resolvedTitle = title ?? summaryOf(appName)?.title ?? "";
    if (resolvedTitle) {
      for (const sibling of storeKeysForTitle(resolvedTitle)) {
        const val = S.customSortNames[sibling]?.trim();
        if (val) return val;
      }
    }
  }
  return "";
}

/** Effective title used by alphabetical, series and alphabet-rail ordering. */
export function effectiveSortTitle(item: { appName: string; title: string }): string {
  return customSortNameOf(item.appName, item.title) || item.title;
}

/** Saves or clears a custom sort title and refreshes the library order. */
export function setCustomSortName(appName: string, rawValue: string): void {
  if (!appName) return;
  const trimmed = rawValue.trim();
  const gameTitle = summaryOf(appName)?.title ?? "";
  if (!trimmed || trimmed === gameTitle.trim()) {
    delete S.customSortNames[appName];
    if (!S.separateCopies && gameTitle) {
      for (const sibling of storeKeysForTitle(gameTitle)) {
        delete S.customSortNames[sibling];
      }
    }
  } else {
    S.customSortNames[appName] = trimmed;
  }
  persistCustomSortNames();
  const manageDesc = document.getElementById("manage-sort-name-desc");
  if (manageDesc && manageDesc.dataset.app === appName) {
    const active = customSortNameOf(appName, gameTitle);
    manageDesc.innerHTML = active
      ? `${esc(t("manage.sortNameActive"))}: <strong>${esc(active)}</strong>`
      : t("manage.sortNameDesc");
  }
  S.libraryDataRev++;
  scheduleRender();
}

export function closeSortNameModal(): void {
  S.sortNameModalAppName = null;
  const root = document.getElementById("sort-name-root");
  if (root) root.innerHTML = "";
}

export function openSortNameModal(appName: string): void {
  if (!appName) return;
  S.sortNameModalAppName = appName;
  renderSortNameModal();
}

export function saveSortNameModal(): void {
  const appName = S.sortNameModalAppName;
  if (!appName) return;
  const input = document.getElementById("sort-name-modal-input") as HTMLInputElement | null;
  const nextVal = input ? input.value : "";
  setCustomSortName(appName, nextVal);
  closeSortNameModal();
  notify({ kind: "info", title: t("lib.sortNameSaved"), appName });
}

export function resetSortNameModal(): void {
  const appName = S.sortNameModalAppName;
  if (!appName) return;
  setCustomSortName(appName, "");
  closeSortNameModal();
  notify({ kind: "info", title: t("lib.sortNameResetDone"), appName });
}

export function renderSortNameModal(): void {
  const root = document.getElementById("sort-name-root");
  const appName = S.sortNameModalAppName;
  if (!root || !appName) {
    if (root) root.innerHTML = "";
    return;
  }
  const summary = summaryOf(appName);
  const gameTitle = summary?.title || appName;
  const currentSort = customSortNameOf(appName, gameTitle);

  root.innerHTML = `
    <div class="playtime-overlay" data-act="close-sort-name-backdrop">
      <div class="playtime-dialog" role="dialog" aria-modal="true" aria-labelledby="sort-name-dialog-title">
        <div class="playtime-header">
          <div class="playtime-header-title">
            <span class="playtime-header-icon">${icon("arrow-down-a-z", 18)}</span>
            <div style="min-width:0">
              <h2 id="sort-name-dialog-title">${esc(t("lib.sortNameTitle"))}</h2>
              <div class="playtime-header-sub">${esc(gameTitle)}</div>
            </div>
          </div>
          <button type="button" class="icon-btn" data-act="close-sort-name-modal" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="playtime-body">
          <p style="margin:0;font-size:13px;line-height:1.5;color:var(--text-2)">
            ${esc(t("lib.sortNameDesc"))}
          </p>
          <div style="display:flex;flex-direction:column;gap:6px">
            <label for="sort-name-modal-input" style="font-size:12px;font-weight:600;color:var(--text-2)">
              ${esc(t("lib.sortNameLabel"))}
            </label>
            <input
              id="sort-name-modal-input"
              type="text"
              class="input"
              value="${esc(currentSort || gameTitle)}"
              placeholder="${esc(gameTitle)}"
              autocomplete="off"
              spellcheck="false"
            />
            <div style="font-size:11.5px;color:var(--text-3);line-height:1.45">
              ${esc(t("lib.sortNameHint"))}
            </div>
          </div>
        </div>
        <div class="playtime-footer" style="justify-content:space-between">
          <div>
            ${
              currentSort
                ? `<button type="button" class="btn ghost" data-act="reset-sort-name-modal">${icon("refresh", 14)}<span>${esc(t("common.reset"))}</span></button>`
                : ""
            }
          </div>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn ghost" data-act="close-sort-name-modal">${esc(t("common.cancel"))}</button>
            <button type="button" class="btn primary" data-act="save-sort-name-modal">${icon("check", 14)}<span>${esc(t("common.save"))}</span></button>
          </div>
        </div>
      </div>
    </div>
  `;

  const input = document.getElementById("sort-name-modal-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        saveSortNameModal();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeSortNameModal();
      }
    });
  }
}
