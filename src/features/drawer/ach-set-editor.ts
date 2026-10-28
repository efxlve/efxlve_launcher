/**
 * Local achievement set editor.
 *
 * A game with no store set gets a page of its own definitions. The panel is a
 * plain list of title/description rows: the draft is read back from the DOM on
 * every add or remove, so typing is never thrown away, and one Save writes the
 * whole set. Earned marks stay in the shared edit overlay, which is why this
 * module only owns the definitions.
 */

import { localAchievementSet, type LocalAchievementRow } from "../../core/achievement-sets";
import { icon } from "../../core/icons";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";

/** In-progress rows for the open editor; storage is the fallback. */
let scratch: { appName: string; rows: LocalAchievementRow[] } | null = null;

export function setAchievementSetScratch(appName: string, rows: LocalAchievementRow[]): void {
  scratch = { appName, rows };
}

export function clearAchievementSetScratch(): void {
  scratch = null;
}

function rowsFor(appName: string): LocalAchievementRow[] {
  if (scratch && scratch.appName === appName) return scratch.rows;
  const set = localAchievementSet(appName);
  if (!set) return [];
  return set.achievements.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
  }));
}

function rowHtml(row: LocalAchievementRow, index: number): string {
  return `
    <div class="ach-set-row" data-set-row data-id="${esc(row.id || "")}">
      <span class="ach-set-row-index tabular-nums">${index + 1}</span>
      <input class="input ach-set-input" data-set-title maxlength="200" placeholder="${esc(t("ach.setTitlePlaceholder"))}" value="${esc(row.title)}" autocomplete="off" />
      <input class="input ach-set-input" data-set-desc maxlength="500" placeholder="${esc(t("ach.setDescPlaceholder"))}" value="${esc(row.description)}" autocomplete="off" />
      <button type="button" class="icon-btn ach-set-remove" data-act="ach-set-remove" data-index="${index}" title="${esc(t("common.delete"))}" aria-label="${esc(t("common.delete"))}">${icon("trash", 13)}</button>
    </div>`;
}

/** The editor card; rendered above the summary while it is open. */
export function renderAchievementSetPanel(s: EpicSummary): string {
  const rows = rowsFor(s.appName);
  const stored = localAchievementSet(s.appName);
  const body = rows.length
    ? rows.map(rowHtml).join("")
    : `<div class="ach-set-empty">${icon("info", 12)}<span>${esc(t("ach.setEmpty"))}</span></div>`;
  return `
    <div class="ach-set-card" id="ach-set-panel">
      <div class="ach-set-head">
        <span class="ach-set-title">${icon("list", 14)}<span>${esc(t("ach.setTitle"))}</span></span>
        <button type="button" class="icon-btn" data-act="ach-set-close" title="${esc(t("common.close"))}">${icon("x", 12)}</button>
      </div>
      <p class="ach-set-desc">${esc(t("ach.setDesc"))}</p>
      <div class="ach-set-rows" id="ach-set-rows">${body}</div>
      <div class="ach-set-actions">
        <button type="button" class="btn ghost small" data-act="ach-set-add">${icon("plus", 12)}<span>${esc(t("ach.setAdd"))}</span></button>
        <span class="ach-set-count tabular-nums">${esc(t("ach.setCount", { n: rows.length }))}</span>
        <button type="button" class="btn primary small" data-act="ach-set-save" data-id="${esc(s.appName)}">${icon("check", 12)}<span>${esc(t("ach.setSave"))}</span></button>
        ${
          stored
            ? `<button type="button" class="btn ghost small danger" data-act="ach-set-delete" data-id="${esc(s.appName)}">${icon("trash", 12)}<span>${esc(t("ach.setDelete"))}</span></button>`
            : ""
        }
      </div>
    </div>`;
}

/** Current editor values, in DOM order. Rows without a title are dropped on save. */
export function readAchievementSetRows(): LocalAchievementRow[] {
  const rows = document.querySelectorAll<HTMLElement>("#ach-set-rows [data-set-row]");
  const out: LocalAchievementRow[] = [];
  rows.forEach((row) => {
    out.push({
      id: row.dataset.id || "",
      title: row.querySelector<HTMLInputElement>("[data-set-title]")?.value ?? "",
      description: row.querySelector<HTMLInputElement>("[data-set-desc]")?.value ?? "",
    });
  });
  return out;
}

/**
 * Re-paints only the editor card after an add/remove, keeping the list and its
 * scroll position. The rows are captured first so nothing typed is lost.
 */
export function repaintAchievementSetPanel(
  appName: string,
  summary: EpicSummary,
): void {
  const current = document.getElementById("ach-set-panel");
  if (!current) return;
  setAchievementSetScratch(appName, readAchievementSetRows());
  current.outerHTML = renderAchievementSetPanel(summary);
}
