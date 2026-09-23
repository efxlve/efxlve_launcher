/**
 * Weekly Epic free games.
 *
 * Fetched from the public store backend (no auth) and shown as a shelf on the
 * library page. Only loaded once per session, lazily on library boot.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { epicFreeGames, type EpicSummary, type FreeGame } from "../../epic";
import { currentLanguage, t } from "../../i18n";

/** Maps the UI language to an Epic store locale + country pair. */
function epicLocale(): { locale: string; country: string } {
  const map: Record<string, [string, string]> = {
    tr: ["tr", "TR"],
    en: ["en-US", "US"],
    de: ["de", "DE"],
    es: ["es-ES", "ES"],
    fr: ["fr", "FR"],
    it: ["it", "IT"],
    ja: ["ja", "JP"],
    ko: ["ko", "KR"],
    pl: ["pl", "PL"],
    "pt-BR": ["pt-BR", "BR"],
    ru: ["ru", "RU"],
    th: ["th", "TH"],
    "zh-Hans": ["zh-CN", "CN"],
    "zh-Hant": ["zh-TW", "TW"],
    ar: ["ar", "SA"],
  };
  const [locale, country] = map[currentLanguage()] ?? ["en-US", "US"];
  return { locale, country };
}

/** Loads the free-games list once (re-renders the library when it arrives). */
export async function loadFreeGames(force = false): Promise<void> {
  if (!isTauri || S.freeGamesLoading) return;
  if (!force && S.freeGames) return;
  S.freeGamesLoading = true;
  try {
    const { locale, country } = epicLocale();
    S.freeGames = await epicFreeGames(locale, country);
  } catch {
    S.freeGames = { current: [], upcoming: [] };
  } finally {
    S.freeGamesLoading = false;
    if (S.view === "library") scheduleRender();
  }
}

/** Formats an ISO date as a short local date (empty when invalid). */
function shortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short" });
}

function ownedSummary(g: FreeGame): EpicSummary | null {
  const raw = S.epicGamesRaw.find((game) => game.metadata.namespace === g.namespace);
  return raw ? S.epicSummariesMap.get(raw.app_name) ?? null : null;
}

function freeGameCard(g: FreeGame): string {
  const owned = ownedSummary(g);
  const dateLabel = g.upcoming
    ? `${shortDate(g.start)} – ${shortDate(g.end)}`
    : t("free.ends", { date: shortDate(g.end) });
  const actionLabel = owned
    ? (owned.installed ? t("common.play") : t("common.install"))
    : "";
  const actions = owned
    ? `<div class="free-card-actions">
         <button class="btn ${owned.installed ? "play" : "install"} small" data-act="${owned.installed ? "epic-play" : "epic-install"}" data-id="${esc(owned.appName)}">${actionLabel}</button>
         <button class="btn ghost small icon-only" data-act="epic-detail" data-id="${esc(owned.appName)}" title="${t("lib.details")}">${icon("info", 13)}</button>
       </div>`
    : "";
  return `
    <div class="free-card" data-act="open-free-game" data-title="${esc(g.title)}" data-slug="${esc(g.slug)}" title="${esc(g.title)}">
      <div class="free-card-media">
        ${g.cover ? `<img src="${esc(g.cover)}" alt="" loading="lazy" decoding="async" />` : `<div class="free-card-ph"></div>`}
        <div class="free-card-gradient"></div>
        <span class="free-card-tag ${g.upcoming ? "soon" : "now"}">${g.upcoming ? t("free.soon") : t("free.now")}</span>
      </div>
      <div class="free-card-overlay">
        <div class="free-card-info">
          <div class="free-card-title">${esc(g.title)}</div>
          <div class="free-card-date">${esc(dateLabel)}</div>
        </div>
        ${actions}
      </div>
    </div>`;
}

/** Renders the free-games shelf (empty string when there is nothing to show). */
export function renderFreeGamesShelf(): string {
  const data = S.freeGames;
  if (!data) return "";
  const items = [...data.current, ...data.upcoming].filter((game) => !game.mobile);
  if (items.length === 0) return "";

  return `
    <div class="shelf-section free-shelf">
      <div class="shelf-header">
        <div class="shelf-title-group">
          <span class="shelf-icon">${icon("sparkles", 15)}</span>
          <h3 class="shelf-title">${t("free.title")}</h3>
          ${data.current.length > 0 ? `<span class="shelf-badge">${data.current.length}</span>` : ""}
        </div>
        <button class="shelf-nav-btn" data-act="open-external-url" data-url="https://store.epicgames.com/free-games" title="${t("free.openStore")}">
          ${icon("external", 14)}
        </button>
      </div>
      <div class="free-row">${items.map(freeGameCard).join("")}</div>
    </div>`;
}
