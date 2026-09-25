/**
 * Multi-game hide list opened from the library toolbar.
 *
 * Selection is local to the dialog. The write path is the same set and
 * localStorage key the single-game hide action uses, so Settings can restore
 * the same games. The grid is refreshed in place; a full library innerHTML
 * rebuild is avoided.
 */

import { HIDDEN_KEY } from "../../core/constants";
import { closeModal } from "../../core/dom";
import { icon } from "../../core/icons";
import { updateBadge, updateChrome } from "../../core/nav";
import { render } from "../../core/render";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { epicPortrait, type EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { refreshLibraryResultsInPlace } from "./library-view";

const selected = new Set<string>();
let filterTimer = 0;
let wired = false;

function rootEl(): HTMLElement | null {
  return document.getElementById("hide-games-root");
}

function coverUrl(s: EpicSummary): string {
  const custom = S.customCovers[s.appName];
  if (custom) return custom;
  const raw = rawOf(s.appName);
  return (raw ? epicPortrait(raw) : null) || s.cover || "";
}

/** Non-hidden library games, title order. One pass over summaries, then one sort. */
function listableGames(): EpicSummary[] {
  const collator = new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  const list: EpicSummary[] = [];
  for (const s of S.epicSummaries) {
    if (!S.hiddenGames.has(s.appName)) list.push(s);
  }
  list.sort((a, b) => collator.compare(a.title, b.title));
  return list;
}

function rowHtml(s: EpicSummary): string {
  const url = coverUrl(s);
  const thumb = url
    ? `<img class="hide-game-thumb" src="${esc(url)}" alt="" width="32" height="42" loading="lazy" decoding="async" />`
    : `<span class="hide-game-thumb placeholder">${icon("gamepad-2", 14)}</span>`;
  return `
    <label class="hide-game-row" data-hide-row data-id="${esc(s.appName)}" data-title="${esc(s.title.toLowerCase())}">
      <input type="checkbox" class="selective-checkbox" />
      ${thumb}
      <span class="hide-game-title">${esc(s.title)}</span>
    </label>`;
}

function syncCount(): void {
  const countEl = document.getElementById("hide-list-count");
  if (countEl) countEl.textContent = t("lib.hideListCount", { count: selected.size });
  const confirm = document.getElementById("hide-list-confirm") as HTMLButtonElement | null;
  if (confirm) confirm.disabled = selected.size === 0;
}

/** Show or hide rows already in the dialog. Does not rebuild covers. */
function applyFilter(): void {
  const input = document.getElementById("hide-list-search") as HTMLInputElement | null;
  const needle = (input?.value ?? "").trim().toLowerCase();
  const rows = document.querySelectorAll<HTMLElement>("#hide-list-rows [data-hide-row]");
  let shown = 0;
  for (const row of rows) {
    const match = !needle || (row.dataset.title ?? "").includes(needle);
    if (row.hidden !== !match) row.hidden = !match;
    if (match) shown++;
  }
  const empty = document.getElementById("hide-list-empty");
  if (!empty) return;
  empty.hidden = shown > 0;
  empty.textContent = rows.length === 0 ? t("lib.hideListEmpty") : t("lib.hideListNoMatch");
}

function selectShown(): void {
  const rows = document.querySelectorAll<HTMLElement>("#hide-list-rows [data-hide-row]");
  for (const row of rows) {
    if (row.hidden) continue;
    const id = row.dataset.id;
    const box = row.querySelector<HTMLInputElement>("input");
    if (!id || !box) continue;
    box.checked = true;
    selected.add(id);
  }
  syncCount();
}

function clearSelection(): void {
  selected.clear();
  document.querySelectorAll<HTMLInputElement>("#hide-list-rows input").forEach((box) => {
    box.checked = false;
  });
  syncCount();
}

function onRootMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  const row = (e.target as HTMLElement | null)?.closest("[data-hide-row]");
  if (!row) return;
  // A focused checkbox is scrolled back into view and fights the wheel.
  e.preventDefault();
}

function onRootClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.classList.contains("modal-backdrop")) {
    closeHideGamesModal();
    return;
  }
  const act = target.closest<HTMLElement>("[data-hide-act]")?.dataset.hideAct;
  if (act === "close") closeHideGamesModal();
  else if (act === "select") selectShown();
  else if (act === "clear") clearSelection();
  else if (act === "confirm") confirmHide();
}

function onRootChange(e: Event): void {
  const box = e.target as HTMLInputElement | null;
  if (!box || box.type !== "checkbox") return;
  const id = box.closest<HTMLElement>("[data-hide-row]")?.dataset.id;
  if (!id) return;
  if (box.checked) selected.add(id);
  else selected.delete(id);
  syncCount();
}

function onRootInput(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el || el.id !== "hide-list-search") return;
  if (filterTimer) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    filterTimer = 0;
    applyFilter();
  }, 120);
}

function wire(root: HTMLElement): void {
  if (wired) return;
  wired = true;
  root.addEventListener("mousedown", onRootMouseDown);
  root.addEventListener("click", onRootClick);
  root.addEventListener("change", onRootChange);
  root.addEventListener("input", onRootInput);
}

export function closeHideGamesModal(): void {
  if (filterTimer) {
    window.clearTimeout(filterTimer);
    filterTimer = 0;
  }
  selected.clear();
  const root = rootEl();
  if (root) root.innerHTML = "";
}

export function openHideGamesModal(): void {
  const root = rootEl();
  if (!root) return;
  wire(root);
  selected.clear();
  const games = listableGames();
  const emptyHidden = games.length > 0;
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box hide-list-dialog" role="dialog" aria-modal="true" aria-labelledby="hide-list-title">
        <div class="manage-head">
          <h2 id="hide-list-title">${t("lib.hideListTitle")}</h2>
          <button type="button" class="manage-head-close" data-hide-act="close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </div>
        <div class="hide-list-body">
          <div class="search">
            ${icon("search", 15)}
            <input id="hide-list-search" type="text" placeholder="${esc(t("lib.hideListSearch"))}" autocomplete="off" spellcheck="false" />
          </div>
          <div class="hide-list-actions">
            <button type="button" class="btn ghost small" data-hide-act="select">${t("lib.hideListSelect")}</button>
            <button type="button" class="btn ghost small" data-hide-act="clear">${t("lib.hideListClear")}</button>
          </div>
          <div id="hide-list-rows" class="hide-list-rows">
            <p id="hide-list-empty" class="hide-list-empty"${emptyHidden ? " hidden" : ""}>${t("lib.hideListEmpty")}</p>
            ${games.map(rowHtml).join("")}
          </div>
        </div>
        <div class="selective-footer">
          <span id="hide-list-count" class="hide-list-count">${t("lib.hideListCount", { count: 0 })}</span>
          <button type="button" class="btn ghost" data-hide-act="close">${t("common.cancelShort")}</button>
          <button type="button" class="btn primary" id="hide-list-confirm" data-hide-act="confirm" disabled>${t("lib.hideListAction")}</button>
        </div>
      </div>
    </div>`;
  document.getElementById("hide-list-search")?.focus();
}

function confirmHide(): void {
  if (selected.size === 0) return;
  const ids = [...selected];
  closeHideGamesModal();
  hideGameIds(ids);
}

/**
 * Hide one or more games with the existing hidden-game set.
 * An empty list does nothing. The library grid is patched in place.
 */
export function hideGameIds(ids: readonly string[]): void {
  let added = 0;
  for (const id of ids) {
    if (!id || S.hiddenGames.has(id)) continue;
    S.hiddenGames.add(id);
    added++;
  }
  if (added === 0) return;
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...S.hiddenGames]));
  if (S.currentModalAppName && S.hiddenGames.has(S.currentModalAppName)) closeModal();
  toast(added === 1 ? t("lib.hidden") : t("lib.hiddenMany", { count: added }), "");
  refreshLibraryResultsInPlace();
  updateChrome();
  updateBadge();
}

/**
 * Put hidden games back on the library. An empty list does nothing.
 * This is the same write the per-row Show button uses.
 */
export function unhideGameIds(ids: readonly string[]): void {
  if (ids.length === 0) return;
  let removed = 0;
  for (const id of ids) {
    if (!id || !S.hiddenGames.delete(id)) continue;
    removed++;
  }
  if (removed === 0) return;
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...S.hiddenGames]));
  render();
}
