/**
 * Hide one or more achievement rows from the profile list.
 *
 * The stored ids are Epic sandbox ids, not library app names. Hiding a game
 * still drops that game's rows, but restoring a row does not unhide the game.
 */

import { HIDDEN_ACH_KEY, PROFILE_CARD_CHUNK } from "../../core/constants";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, isOpaqueId } from "../../core/utils";
import { epicPortrait, type ProfileGameRecord } from "../../epic";
import { t } from "../../i18n";

const selected = new Set<string>();
let filterTimer = 0;
let wired = false;

function rootEl(): HTMLElement | null {
  return document.getElementById("hide-achievements-root");
}

/** Same portrait source as the profile row: custom cover, catalog art, then the record. */
function coverUrl(g: ProfileGameRecord): string {
  const custom = S.customCovers[g.app_name];
  if (custom) return custom;
  const raw = rawOf(g.app_name);
  return (raw ? epicPortrait(raw) : null) || S.epicSummariesMap.get(g.app_name)?.cover || g.cover || "";
}

/** Achievement rows that are still on the profile list. */
function listable(): ProfileGameRecord[] {
  const games = S.playerProfileData?.games ?? [];
  const collator = new Intl.Collator(S.appLanguage || "en", { sensitivity: "base", numeric: true });
  const list: ProfileGameRecord[] = [];
  for (const g of games) {
    if (!g.sandbox_id || isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name) || S.hiddenAchievements.has(g.sandbox_id)) continue;
    list.push(g);
  }
  list.sort((a, b) => collator.compare(a.app_title, b.app_title));
  return list;
}

function rowHtml(g: ProfileGameRecord): string {
  const url = coverUrl(g);
  const thumb = url
    ? `<img class="hide-game-thumb" src="${esc(url)}" alt="" width="32" height="42" loading="lazy" decoding="async" />`
    : `<span class="hide-game-thumb placeholder">${icon("gamepad-2", 14)}</span>`;
  return `
    <label class="hide-game-row" data-hide-ach-row data-id="${esc(g.sandbox_id)}" data-title="${esc(g.app_title.toLowerCase())}">
      <input type="checkbox" class="selective-checkbox" />
      ${thumb}
      <span class="hide-game-title">${esc(g.app_title)}</span>
    </label>`;
}

function syncCount(): void {
  const countEl = document.getElementById("hide-ach-count");
  if (countEl) countEl.textContent = t("profile.hideListCount", { count: selected.size });
  const confirm = document.getElementById("hide-ach-confirm") as HTMLButtonElement | null;
  if (confirm) confirm.disabled = selected.size === 0;
}

function applyFilter(): void {
  const input = document.getElementById("hide-ach-search") as HTMLInputElement | null;
  const needle = (input?.value ?? "").trim().toLowerCase();
  const rows = document.querySelectorAll<HTMLElement>("#hide-ach-rows [data-hide-ach-row]");
  let shown = 0;
  for (const row of rows) {
    const match = !needle || (row.dataset.title ?? "").includes(needle);
    if (row.hidden !== !match) row.hidden = !match;
    if (match) shown++;
  }
  const empty = document.getElementById("hide-ach-empty");
  if (!empty) return;
  empty.hidden = shown > 0;
  empty.textContent = rows.length === 0 ? t("profile.hideListEmpty") : t("profile.hideListNoMatch");
}

function selectShown(): void {
  const rows = document.querySelectorAll<HTMLElement>("#hide-ach-rows [data-hide-ach-row]");
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
  document.querySelectorAll<HTMLInputElement>("#hide-ach-rows input").forEach((box) => {
    box.checked = false;
  });
  syncCount();
}

function onRootClick(e: Event): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  if (target.classList.contains("modal-backdrop")) {
    closeHideAchievementsModal();
    return;
  }
  const act = target.closest<HTMLElement>("[data-hide-ach]")?.dataset.hideAch;
  if (act === "close") closeHideAchievementsModal();
  else if (act === "select") selectShown();
  else if (act === "clear") clearSelection();
  else if (act === "confirm") confirmHide();
}

function onRootChange(e: Event): void {
  const box = e.target as HTMLInputElement | null;
  if (!box || box.type !== "checkbox") return;
  const id = box.closest<HTMLElement>("[data-hide-ach-row]")?.dataset.id;
  if (!id) return;
  if (box.checked) selected.add(id);
  else selected.delete(id);
  syncCount();
}

function onRootInput(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el || el.id !== "hide-ach-search") return;
  if (filterTimer) window.clearTimeout(filterTimer);
  filterTimer = window.setTimeout(() => {
    filterTimer = 0;
    applyFilter();
  }, 120);
}

function wire(root: HTMLElement): void {
  if (wired) return;
  wired = true;
  root.addEventListener("click", onRootClick);
  root.addEventListener("change", onRootChange);
  root.addEventListener("input", onRootInput);
}

export function closeHideAchievementsModal(): void {
  if (filterTimer) {
    window.clearTimeout(filterTimer);
    filterTimer = 0;
  }
  selected.clear();
  const root = rootEl();
  if (root) root.innerHTML = "";
}

export function openHideAchievementsModal(): void {
  const root = rootEl();
  if (!root) return;
  wire(root);
  selected.clear();
  const rows = listable();
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal-box hide-list-dialog" role="dialog" aria-modal="true" aria-labelledby="hide-ach-title">
        <div class="manage-head">
          <h2 id="hide-ach-title">${t("profile.hideListTitle")}</h2>
          <button type="button" class="manage-head-close" data-hide-ach="close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </div>
        <div class="hide-list-body">
          <div class="search">
            ${icon("search", 15)}
            <input id="hide-ach-search" type="text" placeholder="${esc(t("profile.hideListSearch"))}" autocomplete="off" spellcheck="false" />
          </div>
          <div class="hide-list-actions">
            <button type="button" class="btn ghost small" data-hide-ach="select">${t("profile.hideListSelect")}</button>
            <button type="button" class="btn ghost small" data-hide-ach="clear">${t("profile.hideListClear")}</button>
          </div>
          <div id="hide-ach-rows" class="hide-list-rows">
            <p id="hide-ach-empty" class="hide-list-empty"${rows.length > 0 ? " hidden" : ""}>${t("profile.hideListEmpty")}</p>
            ${rows.map(rowHtml).join("")}
          </div>
        </div>
        <div class="selective-footer">
          <span id="hide-ach-count" class="hide-list-count">${t("profile.hideListCount", { count: 0 })}</span>
          <button type="button" class="btn ghost" data-hide-ach="close">${t("common.cancelShort")}</button>
          <button type="button" class="btn primary" id="hide-ach-confirm" data-hide-ach="confirm" disabled>${t("profile.hideListAction")}</button>
        </div>
      </div>
    </div>`;
  document.getElementById("hide-ach-search")?.focus();
}

function confirmHide(): void {
  if (selected.size === 0) return;
  const ids = [...selected];
  closeHideAchievementsModal();
  hideAchievementIds(ids);
}

function saveHidden(): void {
  localStorage.setItem(HIDDEN_ACH_KEY, JSON.stringify([...S.hiddenAchievements]));
}

function refreshProfileList(): void {
  S.profileCardCount = PROFILE_CARD_CHUNK;
  render();
}

/** Hide achievement rows by sandbox id. An empty list does nothing. */
export function hideAchievementIds(ids: readonly string[]): void {
  let added = 0;
  for (const id of ids) {
    if (!id || S.hiddenAchievements.has(id)) continue;
    S.hiddenAchievements.add(id);
    added++;
  }
  if (added === 0) return;
  saveHidden();
  toast(added === 1 ? t("profile.hiddenOne") : t("profile.hiddenMany", { count: added }), "");
  refreshProfileList();
}

/** Put one hidden achievement row back on the list. */
export function unhideAchievement(id: string): void {
  if (!id || !S.hiddenAchievements.delete(id)) return;
  saveHidden();
  if (S.hiddenAchievements.size === 0) S.profileShowHidden = false;
  toast(t("profile.unhidden"), "");
  refreshProfileList();
}
