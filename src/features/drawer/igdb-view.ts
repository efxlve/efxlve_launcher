/**
 * The IGDB block on the game page: genres, companies, release date, rating,
 * screenshots and similar games — plus the attribution IGDB asks for.
 *
 * Shown only when the user configured IGDB credentials in Settings. The Rust
 * side caches each game on disk, so opening a page costs one request at most,
 * and the block stays quiet when IGDB has no convincing match.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { igdbEnrich, igdbExternalId, igdbImage, type IgdbGame } from "../../igdb";

interface IgdbTarget {
  appName: string;
  title: string;
}

/** Per app name: the enriched game, or `null` when IGDB had no match. */
const cache = new Map<string, IgdbGame | null>();
const loading = new Set<string>();

/** Fetches once per game and repaints the block when the answer lands. */
export function ensureIgdbOverview(target: IgdbTarget, year: number | null): void {
  if (!S.igdbConfigured || S.offlineMode || cache.has(target.appName) || loading.has(target.appName)) return;
  loading.add(target.appName);
  void igdbEnrich(target.title, year, igdbExternalId(target.appName))
    .then((game) => {
      cache.set(target.appName, game ?? null);
    })
    .catch(() => {
      // A missing key, a rate limit or a network hiccup: stay quiet, the rest
      // of the page does not depend on this.
      cache.set(target.appName, null);
    })
    .finally(() => {
      loading.delete(target.appName);
      const host = document.getElementById("drawer-igdb-container");
      if (host && S.currentModalAppName === target.appName) {
        host.innerHTML = igdbInnerHtml(target);
      }
    });
}

/** The whole block; empty when IGDB is not configured. */
export function renderIgdbSection(target: IgdbTarget): string {
  if (!S.igdbConfigured) return "";
  return `<div id="drawer-igdb-container">${igdbInnerHtml(target)}</div>`;
}

function igdbInnerHtml(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (game === undefined) {
    return `<section class="gp-section igdb-card">
      <h3 class="gp-section-title">${icon("sparkles", 14)} ${esc(t("igdb.cardTitle"))}</h3>
      <div class="hub-desc-loading"><span class="spinner"></span><span>${esc(t("igdb.loading"))}</span></div>
    </section>`;
  }
  if (game === null) return "";
  return igdbCardHtml(game);
}

function igdbCardHtml(game: IgdbGame): string {
  const tags = [...game.genres, ...game.themes].slice(0, 6);
  const facts: string[] = [];
  if (game.releaseDate) facts.push(`${icon("calendar", 12)} <span>${esc(game.releaseDate)}</span>`);
  if (game.developer) facts.push(`${icon("users", 12)} <span>${esc(game.developer)}</span>`);
  if (game.publisher && game.publisher !== game.developer) {
    facts.push(`${icon("layers", 12)} <span>${esc(game.publisher)}</span>`);
  }
  const ageChips = game.ageRatings
    .filter((rating) => rating.rating)
    .map(
      (rating) =>
        `<span class="igdb-age-chip" title="${esc(rating.organization)}">${esc(rating.organization ? `${rating.organization} ${rating.rating}` : rating.rating)}</span>`,
    )
    .join("");

  return `
    <section class="gp-section igdb-card">
      <div class="igdb-head">
        <h3 class="gp-section-title">${icon("sparkles", 14)} ${esc(t("igdb.cardTitle"))}</h3>
        <button type="button" class="igdb-attrib" data-act="open-external-url" data-url="${esc(game.url)}" title="${esc(game.name)}">${esc(t("igdb.poweredBy"))}</button>
      </div>
      <div class="igdb-meta">
        ${game.rating != null ? `<span class="igdb-rating" title="${esc(t("critic.igdbCommunity"))}">${Math.round(game.rating)}</span>` : ""}
        <div class="igdb-facts">${facts.map((fact) => `<span class="igdb-fact">${fact}</span>`).join("")}</div>
        ${ageChips ? `<div class="igdb-ages">${ageChips}</div>` : ""}
      </div>
      ${tags.length ? `<div class="gp-tags igdb-tags">${tags.map((tag) => `<span class="gp-tag">${esc(tag)}</span>`).join("")}</div>` : ""}
      ${
        game.screenshots.length
          ? `<div class="igdb-shots">${game.screenshots
              .map(
                (id) =>
                  `<button type="button" class="igdb-shot" data-act="open-external-url" data-url="${esc(game.url)}" title="${esc(game.name)}"><img src="${esc(igdbImage(id, "screenshot_big"))}" alt="" loading="lazy" /></button>`,
              )
              .join("")}</div>`
          : ""
      }
      ${
        game.similar.length
          ? `<div class="igdb-similar-title">${esc(t("igdb.similarTitle"))}</div>
             <div class="igdb-similar">${game.similar
               .map(
                 (hit) => `
                 <button type="button" class="igdb-similar-item" data-act="open-external-url" data-url="https://www.igdb.com/games/${hit.id}">
                   ${
                     hit.coverId
                       ? `<img src="${esc(igdbImage(hit.coverId, "cover_big"))}" alt="" loading="lazy" />`
                       : `<span class="igdb-similar-ph">${icon("gamepad-2", 16)}</span>`
                   }
                   <span class="igdb-similar-name">${esc(hit.name)}</span>
                   ${hit.year ? `<span class="igdb-similar-year">${hit.year}</span>` : ""}
                 </button>`,
               )
               .join("")}</div>`
          : ""
      }
    </section>`;
}
