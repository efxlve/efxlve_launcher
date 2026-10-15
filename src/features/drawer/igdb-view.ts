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
import { localizeMessage, t } from "../../i18n";
import { igdbEnrich, igdbExternalId, igdbImage, type IgdbGame } from "../../igdb";

interface IgdbTarget {
  appName: string;
  title: string;
}

/** Per app name: the enriched game, or `null` when IGDB had no match. */
const cache = new Map<string, IgdbGame | null>();
/** App name → a translated message, set only when IGDB could not be reached. */
const errors = new Map<string, string>();
const loading = new Set<string>();

/** Fetches once per game and repaints the block when the answer lands. */
export function ensureIgdbOverview(target: IgdbTarget, year: number | null, onArrive?: () => void): void {
  if (!S.igdbConfigured || S.offlineMode || cache.has(target.appName) || loading.has(target.appName)) return;
  loading.add(target.appName);
  void igdbEnrich(target.title, year, igdbExternalId(target.appName))
    .then((game) => {
      cache.set(target.appName, game ?? null);
      errors.delete(target.appName);
    })
    .catch((raw: unknown) => {
      // A rate limit or a single bad answer: stay quiet, the rest of the page
      // does not depend on this. A dead transport is worth saying out loud,
      // and those failures are not cached, so fixing it takes effect at once.
      const message = igdbTransportError(raw);
      if (message) errors.set(target.appName, message);
      else cache.set(target.appName, null);
    })
    .finally(() => {
      loading.delete(target.appName);
      const host = document.getElementById("drawer-igdb-container");
      if (host && S.currentModalAppName === target.appName) {
        host.innerHTML = igdbInnerHtml(target);
      }
      onArrive?.();
    });
}

/**
 * The enriched game for an app name, for the parts of the page that prefer IGDB
 * over the store data: `undefined` until the call settles, `null` when IGDB had
 * no convincing match.
 */
export function igdbGameFor(appName: string): IgdbGame | null | undefined {
  return cache.get(appName);
}

/**
 * True once IGDB cannot answer for this game any more — it has answered, it
 * failed, or it is not configured at all. The About box waits for this before
 * it falls back to a store description or Wikipedia, so the text does not
 * appear and then get replaced.
 */
export function igdbAboutSettled(appName: string): boolean {
  if (!S.igdbConfigured || S.offlineMode) return true;
  return cache.has(appName) || errors.has(appName);
}

/** The whole block; a short setup row while IGDB has not been configured. */
export function renderIgdbSection(target: IgdbTarget): string {
  if (!S.igdbConfigured) return `<div id="drawer-igdb-container">${igdbSetupRow()}</div>`;
  return `<div id="drawer-igdb-container">${igdbInnerHtml(target)}</div>`;
}

/** Only "IGDB is not reachable at all" deserves a card on the game page. */
function igdbTransportError(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const key = text.startsWith("@t:") ? text.slice(3) : "";
  return key === "igdb.proxyMissing" || key === "igdb.badCredentials" || key === "igdb.notConfigured" || key === "igdb.auth"
    ? localizeMessage(text)
    : "";
}

/** One line that says what IGDB adds, with the way to turn it on. */
function igdbSetupRow(hint = ""): string {
  if (S.offlineMode) return "";
  return `
    <section class="gp-section igdb-card igdb-setup">
      <div class="igdb-head">
        <h3 class="gp-section-title">${icon("sparkles", 14)} ${esc(t("igdb.cardTitle"))}</h3>
        <button type="button" class="btn ghost small" data-view="settings" data-settings-section="integrations">
          ${icon("settings", 13)} <span>${esc(t("cover.igdbOpenSettings"))}</span>
        </button>
      </div>
      <p class="igdb-setup-desc">${esc(hint || t("igdb.setupHint"))}</p>
    </section>`;
}

function igdbInnerHtml(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (game === undefined) {
    const error = errors.get(target.appName);
    if (error) return igdbSetupRow(error);
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
