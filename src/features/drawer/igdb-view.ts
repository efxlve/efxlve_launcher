/**
 * The IGDB block on the game page: genres, companies, release date, rating,
 * screenshots and similar games â€” plus the attribution IGDB asks for.
 *
 * Shown only when the user configured IGDB credentials in Settings. The Rust
 * side caches each game on disk, so opening a page costs one request at most,
 * and the block stays quiet when IGDB has no convincing match.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { currentLanguage, localizeMessage, t } from "../../i18n";
import { igdbEnrich, igdbExternalId, igdbImage, type IgdbGame } from "../../igdb";

interface IgdbTarget {
  appName: string;
  title: string;
}

/** Per app name: the enriched game, or `null` when IGDB had no match. */
const cache = new Map<string, IgdbGame | null>();
/** App name â†’ a translated message, set only when IGDB could not be reached. */
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
      // The page repaints through this callback: the facts now live inside the
      // About box and the media in its own tab, so there is no container here.
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
 * True once IGDB cannot answer for this game any more â€” it has answered, it
 * failed, or it is not configured at all. The About box waits for this before
 * it falls back to a store description or Wikipedia, so the text does not
 * appear and then get replaced.
 */
export function igdbAboutSettled(appName: string): boolean {
  if (!S.igdbConfigured || S.offlineMode) return true;
  return cache.has(appName) || errors.has(appName);
}

/** The whole block; a short setup row while IGDB has not been configured. */
/**
 * The credit line that closes the About box: release date, publisher, age
 * rating, genre chips and the IGDB attribution. The facts used to live in a card
 * of their own below the description, which is where the duplication started.
 */
export function renderIgdbCredits(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (!game) {
    // Not configured, or the transport is broken: the invite stays visible. A
    // game with no IGDB match stays quiet, like every other missing fact.
    if (!S.igdbConfigured) return igdbSetupRow();
    const error = errors.get(target.appName);
    return error ? igdbSetupRow(error) : "";
  }

  const facts: string[] = [];
  // The PC release is the one that matters here; the first release is the
  // fallback for games IGDB has no PC date for.
  const releaseDate = game.pcReleaseDate || game.releaseDate;
  if (releaseDate) facts.push(`${icon("calendar", 12)} <span>${esc(releaseDate)}</span>`);
  // The developer already stands in the hero line; only the publisher is added
  // here, and only when it is a different company.
  if (game.publisher && !sameCompany(game.publisher, game.developer)) {
    facts.push(`${icon("layers", 12)} <span>${esc(game.publisher)}</span>`);
  }
  // One age rating in the row â€” the body the user's region reads first â€” and the
  // rest behind a counter. Four organisations at once read as noise.
  const rated = game.ageRatings.filter((rating) => rating.rating);
  const preferred =
    ageOrgOrder()
      .map((org) => rated.find((rating) => rating.organization === org))
      .find((rating) => rating !== undefined) ?? rated[0];
  const others = rated.filter((rating) => rating !== preferred);
  const labelOf = (rating: { organization: string; rating: string }) =>
    rating.organization ? `${rating.organization} ${rating.rating}` : rating.rating;
  const ageChips = preferred
    ? `<span class="igdb-age-chip" title="${esc(rated.map(labelOf).join(" Â· "))}">${esc(labelOf(preferred))}</span>` +
      (others.length
        ? `<span class="igdb-age-chip more" title="${esc(others.map(labelOf).join(" Â· "))}">+${others.length}</span>`
        : "")
    : "";
  const tags = [...game.genres, ...game.themes].slice(0, 6);
  if (!facts.length && !ageChips && !tags.length) return "";

  return `
    <div class="igdb-credits">
      <div class="igdb-meta">
        <div class="igdb-facts">${facts.map((fact) => `<span class="igdb-fact">${fact}</span>`).join("")}</div>
        ${ageChips ? `<div class="igdb-ages">${ageChips}</div>` : ""}
      </div>
      ${tags.length ? `<div class="gp-tags igdb-tags">${tags.map((tag) => `<span class="gp-tag">${esc(tag)}</span>`).join("")}</div>` : ""}
      <button type="button" class="igdb-attrib" data-act="open-external-url" data-url="${esc(game.url)}" title="${esc(game.name)}">${esc(t("igdb.poweredBy"))}</button>
    </div>`;
}

/** IGDB's own screenshots, for the Media tab. */
export function renderIgdbMedia(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (!game || game.screenshots.length === 0) return "";
  return `
    <section class="gp-section">
      <h3 class="gp-section-title">${icon("sparkles", 14)} ${esc(t("igdb.cardTitle"))}</h3>
      <div class="igdb-shots">${game.screenshots
        .map((id) => {
          const url = igdbImage(id, "screenshot_big");
          // A click opens the picture here, not the IGDB page in a browser.
          return `<button type="button" class="igdb-shot" data-act="open-store-shot" data-src="${esc(url)}" data-title="${esc(game.name)}"><img src="${esc(url)}" alt="" loading="lazy" /></button>`;
        })
        .join("")}</div>
    </section>`;
}

/** IGDB's own page for a hit. The numeric id lands on an empty search page, so a
 * hit without a slug falls back to searching by name. */
function igdbGameUrl(hit: { id: number; name: string; slug?: string }): string {
  return hit.slug
    ? `https://www.igdb.com/games/${hit.slug}`
    : `https://www.igdb.com/search?type=1&q=${encodeURIComponent(hit.name)}`;
}

/** The similar-games card that closes the overview. */
export function renderIgdbSimilar(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (!game || game.similar.length === 0) return "";
  return `
    <section class="gp-section igdb-card">
      <h3 class="gp-section-title">${icon("gamepad-2", 14)} ${esc(t("igdb.similarTitle"))}</h3>
      <div class="igdb-similar">${game.similar
        .map(
          (hit) => `
                 <button type="button" class="igdb-similar-item" data-act="open-external-url" data-url="${esc(igdbGameUrl(hit))}">
                   ${
                     hit.coverId
                       ? (() => {
                           const url = igdbImage(hit.coverId, "cover_big");
                           return `<img src="${esc(url)}" alt="" loading="lazy" />`;
                         })()
                       : `<span class="igdb-similar-ph">${icon("gamepad-2", 16)}</span>`
                   }
                   <span class="igdb-similar-name">${esc(hit.name)}</span>
                   ${hit.year ? `<span class="igdb-similar-year">${hit.year}</span>` : ""}
                 </button>`,
        )
        .join("")}</div>
    </section>`;
}

/** Only "IGDB is not reachable at all" deserves a card on the game page. */
function igdbTransportError(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const key = text.startsWith("@t:") ? text.slice(3) : "";
  return key === "igdb.proxyMissing" || key === "igdb.badCredentials" || key === "igdb.notConfigured" || key === "igdb.auth"
    ? localizeMessage(text)
    : "";
}
/** Loose equality for company names: IGDB writes "Behaviour Interactive Inc."
 * where the hero shows the shorter name, and printing both reads as two
 * different companies. */
function sameCompany(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

/** The age-rating bodies in the order this language reads them: the region's own
 * first, then the widely known ones. A game rated only by GRAC still shows a
 * number instead of nothing, but a Turkish user sees PEGI or ESRB first. */
function ageOrgOrder(): string[] {
  const lang = currentLanguage();
  if (lang === "de") return ["USK", "PEGI", "ESRB", "ACB", "CERO", "GRAC", "CLASS_IND"];
  if (lang === "ja") return ["CERO", "PEGI", "ESRB", "USK", "ACB", "GRAC", "CLASS_IND"];
  if (lang === "ko") return ["GRAC", "PEGI", "ESRB", "USK", "CERO", "ACB", "CLASS_IND"];
  if (lang === "pt" || lang === "pt-BR") return ["CLASS_IND", "PEGI", "ESRB", "USK", "ACB", "CERO", "GRAC"];
  if (lang === "en") return ["ESRB", "PEGI", "USK", "ACB", "CERO", "GRAC", "CLASS_IND"];
  return ["PEGI", "ESRB", "USK", "ACB", "CERO", "GRAC", "CLASS_IND"];
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

