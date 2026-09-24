/**
 * Weekly Epic free games.
 *
 * Fetched from the public store backend (no auth). Shown as a quiet library
 * filter grid — not a cinematic shelf on the default cover wall.
 */

import { isTauri } from "../../core/constants";
import { epicActionButtons, epicArt } from "../../core/game-view";
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

/** Loads the free-games list once. Only refreshes UI when that filter is open. */
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
    if (S.view === "library" && S.epicFilter === "freegames") {
      const box = document.getElementById("lib-results");
      if (box) box.innerHTML = renderFreeGamesGrid();
    }
  }
}

/** Formats an ISO date as a short local date (empty when invalid). */
function shortDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short" });
}

function ownedByNamespace(): Map<string, EpicSummary> {
  const map = new Map<string, EpicSummary>();
  for (const game of S.epicGamesRaw) {
    const ns = game.metadata?.namespace;
    if (typeof ns !== "string" || !ns) continue;
    const s = S.epicSummariesMap.get(game.app_name);
    if (s) map.set(ns, s);
  }
  return map;
}

function freeGameCard(g: FreeGame, owned: EpicSummary | null): string {
  const badge = g.upcoming
    ? `<span class="pbadge soon">${t("free.soon")}</span>`
    : `<span class="pbadge now">${t("free.now")}</span>`;
  const dateLabel = g.upcoming
    ? `${shortDate(g.start)} – ${shortDate(g.end)}`
    : t("free.ends", { date: shortDate(g.end) });
  const action = owned
    ? epicActionButtons(owned, "full", { primaryOnly: true })
    : "";
  const cover = owned
    ? epicArt(owned)
    : g.cover
      ? `<img src="${esc(g.cover)}" alt="" loading="lazy" decoding="async" />`
      : `<div class="pcover"></div>`;
  const act = owned
    ? `data-act="epic-detail" data-id="${esc(owned.appName)}"`
    : `data-act="open-free-game" data-title="${esc(g.title)}" data-slug="${esc(g.slug)}"`;

  return `
    <div class="pcard" ${act} tabindex="0" role="button" title="${esc(g.title)}">
      ${cover}
      ${badge}
      <div class="poverlay">
        <div class="bottom">
          <div class="ptitle">${esc(g.title)}</div>
          <div class="ptitle" style="font-size:12px;font-weight:500;color:#c4c5ce">${esc(dateLabel)}</div>
          ${action}
        </div>
      </div>
    </div>`;
}

/** Quiet cover grid for the Free Games filter (empty string never — shows empty state). */
export function renderFreeGamesGrid(): string {
  const data = S.freeGames;
  if (!data) {
    return `<div class="empty">${t("lib.noGames")}</div>`;
  }
  const items = [...data.current, ...data.upcoming].filter((game) => !game.mobile);
  if (items.length === 0) {
    return `<div class="empty">${t("lib.noGames")}</div>`;
  }
  const ownedMap = ownedByNamespace();
  const cards = items.map((g) => freeGameCard(g, ownedMap.get(g.namespace) ?? null)).join("");
  return `<div class="pgrid size-${S.epicCardSize}">${cards}</div>`;
}
