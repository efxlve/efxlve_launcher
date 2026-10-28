/**
 * RetroAchievements mapping panel.
 *
 * The player names the RA game once per launcher entry: retro titles have no
 * store id to match against. The panel only writes the local mapping; the fetch
 * itself lives in `fetchAndRenderAchievements`, so a failed request falls back
 * to the store list instead of blanking the page.
 */

import { raGameFor } from "../../core/ra-games";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import type { EpicSummary } from "../../epic";

export function renderRaPanel(s: EpicSummary): string {
  const mapping = raGameFor(s.appName);
  const connected = S.raConfigured;
  return `
    <div class="ach-set-card" id="ra-panel">
      <div class="ach-set-head">
        <span class="ach-set-title">${icon("globe", 14)}<span>${esc(t("ach.raTitle"))}</span></span>
        <button type="button" class="icon-btn" data-act="ra-panel-close" title="${esc(t("common.close"))}">${icon("x", 12)}</button>
      </div>
      <p class="ach-set-desc">${esc(connected ? t("ach.raDescConnected", { user: S.raUsername }) : t("ach.raDescDisconnected"))}</p>
      <div class="ach-set-actions">
        <input id="ra-game-id" class="input ach-set-input" inputmode="numeric" maxlength="12" placeholder="${esc(t("ach.raGameIdPlaceholder"))}" value="${esc(mapping?.gameId ?? "")}" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn primary small" data-act="ra-save" data-id="${esc(s.appName)}">${icon("check", 12)}<span>${esc(t("ach.raSave"))}</span></button>
        ${mapping ? `<button type="button" class="btn ghost small danger" data-act="ra-clear" data-id="${esc(s.appName)}">${icon("trash", 12)}<span>${esc(t("ach.raClear"))}</span></button>` : ""}
        <button type="button" class="btn ghost small" data-act="open-external-url" data-url="https://retroachievements.org/games">${icon("search", 12)}<span>${esc(t("ach.raSearch"))}</span></button>
        ${connected ? "" : `<button type="button" class="btn ghost small" data-view="settings" data-settings-section="integrations">${icon("settings", 12)}<span>${esc(t("nav.settings"))}</span></button>`}
      </div>
      <p class="ach-set-hint">${esc(t("ach.raHint"))}</p>
    </div>`;
}
