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
import { currentLanguage, localizeMessage, t } from "../../i18n";
import { igdbEnrich, igdbExternalId, igdbImage, type IgdbGame } from "../../igdb";
import { cachedImage, warmImages } from "../../core/picture-cache";
import { canonicalGameTitle, storeKeysForTitle } from "../../core/selectors";
import { sharedSummaries } from "../library/shared-library";

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
 * True once IGDB cannot answer for this game any more — it has answered, it
 * failed, or it is not configured at all. The About box waits for this before
 * it falls back to a store description or Wikipedia, so the text does not
 * appear and then get replaced.
 */
export function igdbAboutSettled(appName: string): boolean {
  if (!S.igdbConfigured || S.offlineMode) return true;
  return cache.has(appName) || errors.has(appName);
}

const TR_IGDB_TAGS: Record<string, string> = {
  "role-playing (rpg)": "RYO (RPG)",
  "hack and slash/beat 'em up": "Hack & Slash",
  "turn-based strategy (tbs)": "Sıra Tabanlı Strateji",
  "real time strategy (rts)": "Gerçek Zamanlı Strateji",
  "point-and-click": "Tıkla ve İlerle",
  "card & board game": "Kart ve Masa Oyunu",
  "quiz/trivia": "Bilgi Yarışması",
  "visual novel": "Görsel Roman",
  "4x (explore, expand, exploit, and exterminate)": "4X Strateji",
  shooter: "Nişancı",
  adventure: "Macera",
  action: "Aksiyon",
  indie: "Bağımsız",
  strategy: "Strateji",
  simulator: "Simülasyon",
  puzzle: "Bulmaca",
  racing: "Yarış",
  sport: "Spor",
  fighting: "Dövüş",
  platform: "Platform",
  tactical: "Taktiksel",
  arcade: "Arcade",
  music: "Müzik",
  pinball: "Langırt",
  moba: "MOBA",
  "open world": "Açık Dünya",
  "science fiction": "Bilim Kurgu",
  horror: "Korku",
  survival: "Hayatta Kalma",
  stealth: "Gizlilik",
  fantasy: "Fantastik",
  historical: "Tarihsel",
  warfare: "Savaş",
  "non-fiction": "Kurgu Dışı",
  sandbox: "Sandbox",
  kids: "Çocuk",
  business: "İş Dünyası",
  drama: "Dram",
  comedy: "Komedi",
  thriller: "Gerilim",
  mystery: "Gizem",
  party: "Parti",
  romance: "Romantik",
  erotic: "Yetişkin",
  educational: "Eğitici",
};

const CLEAN_EN_TAGS: Record<string, string> = {
  "role-playing (rpg)": "RPG",
  "hack and slash/beat 'em up": "Hack & Slash",
  "turn-based strategy (tbs)": "Turn-Based Strategy",
  "real time strategy (rts)": "Real-Time Strategy",
  "4x (explore, expand, exploit, and exterminate)": "4X Strategy",
};

function localizeIgdbTag(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (currentLanguage() === "tr" && TR_IGDB_TAGS[key]) return TR_IGDB_TAGS[key];
  return CLEAN_EN_TAGS[key] ?? raw;
}

/** The genre and theme tags of a game, localized and capped at six. The features
 *  card shows them as one line, the way Steam lists a game's genres in its own
 *  sidebar; they used to sit under the About text, where they read as database
 *  output. */
export function igdbTagsFor(appName: string): string[] {
  const game = cache.get(appName);
  if (!game) return [];
  return [...game.genres, ...game.themes].slice(0, 6).map(localizeIgdbTag);
}

/**
 * Game genres from IGDB, falling back to Steam store details if IGDB has no match.
 */
export function gameGenresFor(appName: string): string[] {
  const igdb = igdbTagsFor(appName);
  if (igdb.length > 0) return igdb;
  const steam = S.steamDetails.get(appName);
  if (steam?.genres && steam.genres.length > 0) {
    return steam.genres.slice(0, 6);
  }
  return [];
}

/**
 * The credit line that closes the About box: genre chips, community channels
 * and the IGDB attribution. Release date, publisher and age rating live in the
 * hero's single meta line.
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

  const links = game.links ?? [];
  if (!links.length) return "";

  const labelOfLink = (kind: string): string =>
    kind === "official"
      ? t("drawer.officialSite")
      : kind === "wikipedia"
        ? "Wikipedia"
        : kind === "twitter"
          ? "X"
          : kind === "reddit"
            ? "Reddit"
            : "Discord";
  const linksHtml = links.length
    ? `<div class="gp-links-row">${links
        .map(
          (link) =>
            `<button type="button" class="gp-tag gp-link-chip" data-act="open-external-url" data-url="${esc(link.url)}" title="${esc(link.url)}">${esc(labelOfLink(link.kind))} ${icon("external", 11)}</button>`,
        )
        .join("")}</div>`
    : "";

  return `
    <div class="igdb-credits">
      <div class="igdb-credits-foot">
        ${linksHtml}
        <button type="button" class="igdb-attrib" data-act="open-external-url" data-url="${esc(game.url)}" title="${esc(game.name)}">${esc(t("igdb.poweredBy"))}</button>
      </div>
    </div>`;
}

/** IGDB's own screenshots, for the Media tab. */
export function renderIgdbMedia(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (!game || game.screenshots.length === 0) return "";
  // The pictures are asked for in one batch; the ones already on disk paint from
  // their cached copy, the rest keep their URL until the answer lands.
  warmImages(game.screenshots.map((id) => igdbImage(id, "screenshot_big")));
  return `
    <div class="gp-about-shots">
      <div class="gp-about-shots-title">${icon("image", 13)} <span>${esc(t("igdb.cardTitle"))}</span></div>
      <div class="igdb-shots">${game.screenshots
        .map((id) => {
          const url = igdbImage(id, "screenshot_big");
          // A click opens the picture here, not the IGDB page in a browser.
          return `<button type="button" class="igdb-shot" data-act="open-store-shot" data-src="${esc(url)}" data-title="${esc(game.name)}"><img src="${esc(cachedImage(url))}" data-img-url="${esc(url)}" alt="" loading="lazy" /></button>`;
        })
        .join("")}</div>
    </div>`;
}

/** IGDB's own page for a hit. The numeric id lands on an empty search page, so a
 * hit without a slug falls back to searching by name. */
function igdbGameUrl(hit: { id: number; name: string; slug?: string }): string {
  return hit.slug
    ? `https://www.igdb.com/games/${hit.slug}`
    : `https://www.igdb.com/search?type=1&q=${encodeURIComponent(hit.name)}`;
}

/**
 * The library's copy of a title, matched on the canonical name.
 *
 * The canonical map is filled while the library is built, so a game page opened
 * straight from Home would find nothing in it; the plain scan below is the
 * fallback, and it only ever adds a match.
 */
function ownedAppFor(title: string): string {
  const canon = canonicalGameTitle(title);
  if (!canon) return "";
  const byKey = storeKeysForTitle(title)[0];
  if (byKey) return byKey;
  const entries: Array<{ title: string; appName?: string; key?: string }> = [
    ...S.epicSummaries,
    ...S.gogSummaries,
    ...S.steamSummaries,
    ...S.companionSummaries,
    ...sharedSummaries(),
  ];
  const hit = entries.find((entry) => entry.title && canonicalGameTitle(entry.title) === canon);
  return hit?.appName ?? hit?.key ?? "";
}

/** The similar-games card that closes the overview. */
export function renderIgdbSimilar(target: IgdbTarget): string {
  const game = cache.get(target.appName);
  if (!game || game.similar.length === 0) return "";
  const resolved = game.similar.map((hit) => ({ hit, owned: ownedAppFor(hit.name) }));
  // Titles already in the player's library lead the strip so they are spotted first.
  resolved.sort((a, b) => Number(Boolean(b.owned)) - Number(Boolean(a.owned)));
  warmImages(resolved.map(({ hit }) => (hit.coverId ? igdbImage(hit.coverId, "cover_big") : "")));
  return `
    <section class="gp-section igdb-card">
      <h3 class="gp-section-title">${icon("gamepad-2", 14)} ${esc(t("igdb.similarTitle"))}</h3>
      <div class="igdb-similar">${resolved
        .map(({ hit, owned }) => {
          // A similar game the player already owns belongs in the launcher, not in
          // a browser tab: the match runs through the canonical title, so a "GOTY
          // Edition" here still finds the library's copy.
          const action = owned ? "epic-detail" : "open-external-url";
          const payload = owned
            ? `data-id="${esc(owned)}"`
            : `data-url="${esc(igdbGameUrl(hit))}"`;
          return `
                 <button type="button" class="igdb-similar-item${owned ? " is-owned" : ""}" data-act="${action}" ${payload} title="${owned ? `${esc(hit.name)} · ${esc(t("drawer.inLibrary"))}` : esc(igdbGameUrl(hit))}">
                   ${
                     hit.coverId
                       ? (() => {
                           const url = igdbImage(hit.coverId, "cover_big");
                           return `<img src="${esc(cachedImage(url))}" data-img-url="${esc(url)}" alt="" loading="lazy" />`;
                         })()
                       : `<span class="igdb-similar-ph">${icon("gamepad-2", 16)}</span>`
                   }
                   <span class="igdb-similar-name">${esc(hit.name)}</span>
                   ${hit.year ? `<span class="igdb-similar-year">${hit.year}</span>` : ""}
                   ${owned ? `<span class="igdb-similar-owned">${icon("check", 11)}</span>` : ""}
                 </button>`;
        })
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
/** The age-rating bodies in the order this language reads them: the region's own
 * first, then the widely known ones. A game rated only by GRAC still shows a
 * number instead of nothing, but a Turkish user sees PEGI or ESRB first. */
export function ageOrgOrder(): string[] {
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

