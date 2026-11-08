/**
 * Controller search: a real text field for a keyboard, a large on-screen
 * keyboard for a pad, and a live result shelf underneath.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageCoverMarkup } from "./stage-art";
import { stageLibraryList } from "./stage-model";

const LETTER_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
] as const;

function keyboardRow(keys: readonly string[], offset = 0): string {
  return `<div class="stage-keyboard-row" style="--stage-key-offset:${offset}">
    ${keys.map((key) => `<button type="button" class="stage-key" data-stage-act="search-key" data-key="${key.toLowerCase()}" data-gp-item data-gp-key="search:key:${key.toLowerCase()}">${key}</button>`).join("")}
  </div>`;
}

/** Live results; called both by the first render and by the in-place patch. */
export function stageSearchResultsHtml(): string {
  const list = stageLibraryList().slice(0, 24);
  if (list.length === 0) {
    return `<div class="stage-search-empty">${icon("search", 28)}<strong>${esc(t("stage.noResults"))}</strong><span>${esc(t("stage.noResultsHint"))}</span></div>`;
  }
  return `<div class="stage-search-grid">${list.map((s) => `<button type="button" class="stage-search-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="search:game:${esc(s.appName)}">
    <span class="stage-search-art">${stageCoverMarkup(s)}</span>
    <span class="stage-search-title">${esc(s.title)}</span>
    <span class="stage-search-sub">${esc(s.installed ? t("stage.installed") : t("stage.notInstalled"))}</span>
  </button>`).join("")}</div>`;
}

/** The whole overlay. The active layer is marked by the shell. */
export function renderStageSearch(): string {
  const query = S.stage.query;
  return `<div class="stage-search">
    <div class="stage-search-panel" role="dialog" aria-modal="true" aria-label="${esc(t("stage.search"))}">
      <div class="stage-search-head">
        <span class="stage-search-icon">${icon("search", 20)}</span>
        <input id="stage-search-input" class="stage-search-input" type="text" value="${esc(query)}" placeholder="${esc(t("stage.searchPlaceholder"))}" autocomplete="off" spellcheck="false" data-gp-item data-gp-key="search:input" />
        <span id="stage-search-count" class="stage-search-count">${stageLibraryList().length}</span>
        <button type="button" class="stage-icon-btn" data-stage-act="search-close" data-gp-item data-gp-key="search:close" aria-label="${esc(t("common.close"))}">${icon("x", 20)}</button>
      </div>
      <div class="stage-keyboard">
        ${LETTER_ROWS.map((row, index) => keyboardRow(row, index)).join("")}
        <div class="stage-keyboard-row stage-keyboard-row-bottom">
          <button type="button" class="stage-key stage-key-wide" data-stage-act="search-key" data-key="space" data-gp-item data-gp-key="search:key:space">${esc(t("stage.space"))}</button>
          <button type="button" class="stage-key" data-stage-act="search-key" data-key="backspace" data-gp-item data-gp-key="search:key:backspace" aria-label="${esc(t("stage.backspace"))}">${icon("arrow-left", 18)}</button>
          <button type="button" class="stage-key" data-stage-act="search-key" data-key="clear" data-gp-item data-gp-key="search:key:clear">${esc(t("stage.clear"))}</button>
          <button type="button" class="stage-key stage-key-accent" data-stage-act="search-submit" data-gp-item data-gp-key="search:done">${esc(t("stage.done"))}</button>
        </div>
      </div>
      <div id="stage-search-results" class="stage-search-results">${stageSearchResultsHtml()}</div>
      <div class="stage-search-hint">${esc(t("stage.searchHint"))}</div>
    </div>
  </div>`;
}
