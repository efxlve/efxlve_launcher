/**
 * Launcher-only achievement state editor.
 *
 * The panel sits on the game page's achievements tab and the small bar sits
 * under one achievement's facts. Both only emit `data-act` actions; the click
 * router in `drawer-handlers` owns the writes and the repaint, so this file
 * stays a pure view of `S.loadedAchievements`.
 *
 * Every edit is launcher-local. The copy has to say that in plain words: a
 * player must never think a marked achievement reached the store account.
 */

import { storeFactsOf } from "../../core/achievement-edits";
import { icon } from "../../core/icons";
import { gameStoresLabel } from "../../core/selectors";
import { t } from "../../i18n";
import { esc, fmtAchDate } from "../../core/utils";
import type {
  EpicAchievementItem,
  EpicAchievementsData,
  EpicSummary,
} from "../../epic";

/** Store name for the copy; a custom game reads an emulator file instead. */
export function achievementStoreName(appName: string): string {
  if (appName.startsWith("custom::")) return t("ach.customStore");
  return gameStoresLabel(appName);
}

/** The achievements the user changed here, in the order they were edited. */
function editedItems(data: EpicAchievementsData): EpicAchievementItem[] {
  return data.achievements.filter((item) => Boolean(item.user_state));
}

function editRow(appName: string, item: EpicAchievementItem): string {
  const marked = item.user_state === "unlocked";
  const title = item.display_name || item.name;
  const date = item.unlock_date ? fmtAchDate(item.unlock_date) : "";
  return `
    <div class="ach-edit-row">
      <span class="ach-edit-row-icon ${marked ? "is-marked" : "is-cleared"}">${icon(marked ? "user" : "lock", 12)}</span>
      <span class="ach-edit-row-main">
        <span class="ach-edit-row-title">${esc(title)}</span>
        <span class="ach-edit-row-meta">${esc(marked ? t("ach.userMarked") : t("ach.userCleared"))}${date ? ` · ${esc(date)}` : ""}</span>
      </span>
      <button type="button" class="icon-btn ach-edit-row-undo" data-act="ach-edit-restore" data-id="${esc(appName)}" data-ach="${esc(item.name)}" title="${esc(t("ach.editRestore"))}">${icon("refresh", 12)}</button>
    </div>`;
}

/**
 * The state editor for one game. Rendered above the summary bar when the
 * header's sliders button is on, the same slot the achievement source card
 * uses for emulator files.
 */
export function renderAchievementEditorCard(s: EpicSummary, data: EpicAchievementsData): string {
  const appName = s.appName;
  const edited = editedItems(data);
  const marked = edited.filter((item) => item.user_state === "unlocked").length;
  const cleared = edited.filter((item) => item.user_state === "locked").length;
  const store = achievementStoreName(appName);
  const counts = [
    marked > 0
      ? `<span class="ach-edit-count is-marked">${icon("user", 12)}<span>${esc(t("ach.editorMarkedCount", { n: marked }))}</span></span>`
      : "",
    cleared > 0
      ? `<span class="ach-edit-count is-cleared">${icon("lock", 12)}<span>${esc(t("ach.editorClearedCount", { n: cleared }))}</span></span>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="ach-edit-card">
      <div class="ach-edit-card-head">
        <span class="ach-edit-card-title">${icon("edit", 14)}<span>${esc(t("ach.editorTitle"))}</span></span>
        <button type="button" class="icon-btn" data-act="ach-edit-close" title="${esc(t("common.close"))}">${icon("x", 12)}</button>
      </div>
      <p class="ach-edit-card-desc">${esc(t("ach.editorDesc", { store }))}</p>
      ${counts ? `<div class="ach-edit-counts">${counts}</div>` : ""}
      <div class="ach-edit-actions">
        <button type="button" class="btn ghost small" data-act="ach-edit-mark-all" data-id="${esc(appName)}">${icon("unlock", 12)}<span>${esc(t("ach.editorMarkAll"))}</span></button>
        <button type="button" class="btn ghost small" data-act="ach-edit-reset-all" data-id="${esc(appName)}">${icon("lock", 12)}<span>${esc(t("ach.editorResetAll"))}</span></button>
        <button type="button" class="btn ghost small" data-act="ach-edit-sync" data-id="${esc(appName)}">${icon("refresh", 12)}<span>${esc(t("ach.editorSync", { store }))}</span></button>
      </div>
      <div class="ach-edit-list">
        ${
          edited.length > 0
            ? `<div class="ach-edit-list-title">${esc(t("ach.editorEdited"))}</div>${edited
                .map((item) => editRow(appName, item))
                .join("")}`
            : `<div class="ach-edit-empty">${icon("info", 12)}<span>${esc(t("ach.editorClean"))}</span></div>`
        }
      </div>
    </div>`;
}

/**
 * One achievement's edit line, under its facts. A store answer and a launcher
 * answer are never mixed silently: the state word says which one is on screen,
 * and the button offers the way back to the store's own answer.
 */
export function renderAchievementEditBar(s: EpicSummary, item: EpicAchievementItem): string {
  const appName = s.appName;
  const achId = esc(item.name);
  if (item.user_state === "unlocked") {
    return `
      <div class="ach-edit-bar is-marked">
        <span class="ach-edit-bar-state" title="${esc(t("ach.userMarkedHint"))}">${icon("user", 12)}<span>${esc(t("ach.userMarked"))}</span></span>
        <span class="ach-edit-bar-note">${esc(t("ach.launcherOnly"))}</span>
        <button type="button" class="btn ghost small ach-edit-bar-btn" data-act="ach-edit-restore" data-id="${esc(appName)}" data-ach="${achId}">${icon("refresh", 12)}<span>${esc(t("ach.editRestore"))}</span></button>
      </div>`;
  }
  if (item.user_state === "locked") {
    return `
      <div class="ach-edit-bar is-cleared">
        <span class="ach-edit-bar-state" title="${esc(t("ach.userClearedHint"))}">${icon("lock", 12)}<span>${esc(t("ach.userCleared"))}</span></span>
        <span class="ach-edit-bar-note">${esc(t("ach.launcherOnly"))}</span>
        <button type="button" class="btn ghost small ach-edit-bar-btn" data-act="ach-edit-restore" data-id="${esc(appName)}" data-ach="${achId}">${icon("refresh", 12)}<span>${esc(t("ach.editRestore"))}</span></button>
      </div>`;
  }
  const earned = storeFactsOf(item).unlocked;
  return `
    <div class="ach-edit-bar">
      <span class="ach-edit-bar-note">${esc(t("ach.editHint"))}</span>
      <button type="button" class="btn ghost small ach-edit-bar-btn" data-act="${earned ? "ach-edit-clear" : "ach-edit-mark"}" data-id="${esc(appName)}" data-ach="${achId}" title="${esc(earned ? t("ach.editClearHint") : t("ach.editMarkHint"))}">
        ${icon(earned ? "lock" : "unlock", 12)}<span>${esc(earned ? t("ach.editClear") : t("ach.editMark"))}</span>
      </button>
    </div>`;
}
