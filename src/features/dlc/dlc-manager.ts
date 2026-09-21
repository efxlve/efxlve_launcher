/**
 * DLC manager page renderer.
 *
 * Renders the per-game add-on list with search and install toggles. All state
 * is read from the shared `S` object; the install toggle is handled by the
 * global `data-act="dlc-toggle-install"` router in `main.ts`.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import type { GameDlcItem } from "../../epic";

/** Render the rows of the DLC table. */
export function renderDlcRows(dlcs: GameDlcItem[]): string {
  if (dlcs.length === 0) {
    return `<div style="padding: 32px 20px; text-align: center; color: var(--muted); font-size: 13px;">
      ${t("dlc.none")}
    </div>`;
  }
  return dlcs
    .map((dlc) => {
      const isDownloadable = dlc.downloadable !== false;
      const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : (isDownloadable ? "—" : t("dlc.included"));
      const thumbHtml = dlc.image
        ? `<img class="dlc-row-thumb" src="${esc(dlc.image)}" alt="${esc(dlc.title)}" />`
        : `<div class="dlc-row-thumb"></div>`;

      const actionHtml = isDownloadable
        ? `
          <label class="toggle-switch" title="${dlc.installed ? t("common.uninstall") : t("common.install")}">
            <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(S.activeDlcAppName!)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        `
        : `
          <span class="dlc-badge-active" title="${t("dlc.activeInAccount")}">${icon("check", 12)} ${t("dlc.activeBadge")}</span>
        `;

      return `
      <div class="dlc-table-row">
        <div class="dlc-row-item">
          ${thumbHtml}
          <div class="dlc-row-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div>
        </div>
        <div class="dlc-row-size">${esc(sizeStr)}</div>
        <div class="dlc-row-toggle">
          ${actionHtml}
        </div>
      </div>
    `;
    })
    .join("");
}

/** Render the full DLC manager page for the active game. */
export function renderDlcManager(): string {
  if (!S.activeDlcAppName) {
    return `<div class="empty">${t("dlc.notSelected")}</div>`;
  }
  const summary = S.epicSummaries.find((s) => s.appName === S.activeDlcAppName);
  const title = summary?.title || S.activeDlcAppName;
  const dlcRes = S.dlcCache.get(S.activeDlcAppName);

  if (S.dlcLoading && !dlcRes) {
    return `
      <div class="dlc-manager-container">
        <div class="dlc-manager-back" data-act="dlc-back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          ${t("dlc.backToLibrary")}
        </div>
        <div style="text-align:center;padding:60px 0;">
          <div class="spinner" style="margin:0 auto 16px"></div>
          <div class="muted">${t("dlc.scanning")}</div>
        </div>
      </div>
    `;
  }

  const allDlcs = dlcRes?.dlcs || [];
  const query = S.dlcSearchQuery.trim().toLowerCase();
  const filteredDlcs = query
    ? allDlcs.filter((d) => d.title.toLowerCase().includes(query))
    : allDlcs;

  return `
    <div class="dlc-manager-container">
      <div class="dlc-manager-back" data-act="dlc-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        ${t("dlc.backToLibrary")}
      </div>

      <div class="dlc-manager-head-row">
        <h1>${esc(title)} ${t("dlc.addon")}</h1>
        <div class="dlc-search-wrapper">
          <svg class="dlc-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="dlc-search" class="dlc-search-input" placeholder="${t("dlc.searchPlaceholder")}" value="${esc(S.dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
        </div>
      </div>

      <!-- Promo banner -->
      <div class="dlc-promo-banner">
        <div class="dlc-promo-left">
          <div class="dlc-promo-icon-box">
            ${icon("layers", 20)}
          </div>
          <div class="dlc-promo-info">
            <div class="dlc-promo-title">${t("dlc.promoTitle")}</div>
            <div class="dlc-promo-desc">${t("dlc.promoDesc", { title })}</div>
          </div>
        </div>
        <button class="btn ghost small" data-act="dlc-discover-store" data-id="${esc(S.activeDlcAppName!)}">
          ${t("dlc.discover")}
        </button>
      </div>

      <!-- DLC table -->
      <div class="dlc-table-container">
        <div class="dlc-table-header">
          <div></div>
          <div class="right">${t("dlc.size")}</div>
          <div class="right">${t("dlc.installed")}</div>
        </div>
        <div id="dlc-table-body">
          ${renderDlcRows(filteredDlcs)}
        </div>
      </div>
    </div>
  `;
}
