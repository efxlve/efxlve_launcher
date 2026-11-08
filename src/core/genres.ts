/**
 * Canonical library genre normalization, IGDB theme promotion, primary-genre
 * ranking, and localized display labels.
 *
 * Store catalogs and IGDB use overlapping names for the same genre ("Simulator"
 * vs "Simulation", "Role-playing (RPG)" vs "RPG", "Sport" vs "Sports"), and IGDB
 * records "Action", "Horror", "Survival", "Stealth" and "Open world" as themes
 * rather than genres. Normalizing into stable canonical IDs prevents split
 * shelves while keeping filter state independent of the UI language.
 */

import { currentLanguage } from "../i18n";

/** IGDB theme names that players expect as playable genres in filters and shelves. */
const PROMOTED_IGDB_THEMES: ReadonlyMap<string, string> = new Map([
  ["action", "Action"],
  ["horror", "Horror"],
  ["survival", "Survival"],
  ["stealth", "Stealth"],
  ["open world", "Open World"],
  ["sandbox", "Sandbox"],
  ["science fiction", "Sci-Fi"],
  ["fantasy", "Fantasy"],
]);

/** Raw store / IGDB genre aliases mapped to canonical genre IDs. */
const GENRE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  action: ["Action"],
  "action-adventure": ["Action", "Adventure"],
  "action adventure": ["Action", "Adventure"],
  "action rpg": ["Action", "RPG"],
  "action-rpg": ["Action", "RPG"],
  adventure: ["Adventure"],
  rpg: ["RPG"],
  "role-playing (rpg)": ["RPG"],
  "role-playing": ["RPG"],
  "role playing": ["RPG"],
  "role-playing game": ["RPG"],
  jrpg: ["RPG"],
  crpg: ["RPG"],
  shooter: ["Shooter"],
  fps: ["Shooter"],
  "first-person shooter": ["Shooter"],
  "third-person shooter": ["Shooter"],
  tps: ["Shooter"],
  strategy: ["Strategy"],
  stategy: ["Strategy"],
  "real time strategy (rts)": ["Strategy", "RTS"],
  "real-time strategy": ["Strategy", "RTS"],
  rts: ["Strategy", "RTS"],
  "turn-based strategy (tbs)": ["Strategy", "Turn-Based Strategy"],
  "turn-based strategy": ["Strategy", "Turn-Based Strategy"],
  "turn-based": ["Strategy", "Turn-Based Strategy"],
  tbs: ["Strategy", "Turn-Based Strategy"],
  "4x (explore, expand, exploit, and exterminate)": ["Strategy"],
  "4x": ["Strategy"],
  "4x strategy": ["Strategy"],
  tactical: ["Tactical"],
  simulator: ["Simulation"],
  simulation: ["Simulation"],
  racing: ["Racing"],
  driving: ["Racing"],
  "driving/racing": ["Racing"],
  sport: ["Sports"],
  sports: ["Sports"],
  puzzle: ["Puzzle"],
  platform: ["Platformer"],
  platformer: ["Platformer"],
  fighting: ["Fighting"],
  "hack and slash/beat 'em up": ["Action", "Hack & Slash"],
  "hack and slash": ["Action", "Hack & Slash"],
  "hack & slash": ["Action", "Hack & Slash"],
  "beat 'em up": ["Action", "Hack & Slash"],
  "point-and-click": ["Point & Click"],
  "point & click": ["Point & Click"],
  arcade: ["Arcade"],
  horror: ["Horror"],
  survival: ["Survival"],
  stealth: ["Stealth"],
  "open world": ["Open World"],
  "open-world": ["Open World"],
  sandbox: ["Sandbox"],
  indie: ["Indie"],
  casual: ["Casual"],
  "visual novel": ["Visual Novel"],
  "card & board game": ["Card & Board"],
  "card & board": ["Card & Board"],
  "card game": ["Card & Board"],
  "board game": ["Card & Board"],
  moba: ["MOBA"],
  "massively multiplayer": ["MMO"],
  mmo: ["MMO"],
  mmorpg: ["RPG", "MMO"],
  music: ["Music & Rhythm"],
  rhythm: ["Music & Rhythm"],
  "music & rhythm": ["Music & Rhythm"],
  "quiz/trivia": ["Trivia"],
  trivia: ["Trivia"],
  pinball: ["Pinball"],
  "science fiction": ["Sci-Fi"],
  "sci-fi": ["Sci-Fi"],
  fantasy: ["Fantasy"],
  "free to play": ["Free to Play"],
  "free-to-play": ["Free to Play"],
  f2p: ["Free to Play"],
  "early access": ["Early Access"],
};

/** Non-game PICS / store category labels skipped from game genre facets. */
const IGNORED_TAGS = new Set([
  "accounting",
  "animation & modeling",
  "audio production",
  "design & illustration",
  "documentary",
  "education",
  "educational",
  "episodic",
  "game development",
  "gore",
  "movie",
  "nudity",
  "photo editing",
  "sexual content",
  "short",
  "software",
  "software training",
  "tutorial",
  "utilities",
  "video production",
  "violent",
  "web publishing",
]);

/** Tier 1: specific gameplay genres preferred when choosing a single shelf. */
const TIER_1_GENRES = new Set([
  "Racing",
  "Sports",
  "Simulation",
  "Strategy",
  "RPG",
  "Shooter",
  "Fighting",
  "Puzzle",
  "Platformer",
  "Horror",
  "Survival",
  "Stealth",
  "Tactical",
  "Visual Novel",
  "Card & Board",
  "Point & Click",
  "MOBA",
  "MMO",
  "Music & Rhythm",
  "Arcade",
  "Trivia",
  "Pinball",
]);

/** Tier 3: distribution/model tags used as primary shelf only when no gameplay genre exists. */
const META_GENRES = new Set(["Indie", "Casual", "Free to Play", "Early Access"]);

const TR_GENRE_LABELS: Readonly<Record<string, string>> = {
  Action: "Aksiyon",
  Adventure: "Macera",
  RPG: "RYO (RPG)",
  Shooter: "Nişancı",
  Strategy: "Strateji",
  RTS: "Gerçek Zamanlı Strateji",
  "Turn-Based Strategy": "Sıra Tabanlı Strateji",
  Tactical: "Taktiksel",
  Simulation: "Simülasyon",
  Racing: "Yarış",
  Sports: "Spor",
  Puzzle: "Bulmaca",
  Platformer: "Platform",
  Fighting: "Dövüş",
  "Hack & Slash": "Hack & Slash",
  Horror: "Korku",
  Survival: "Hayatta Kalma",
  Stealth: "Gizlilik",
  "Open World": "Açık Dünya",
  Sandbox: "Sandbox",
  "Point & Click": "Tıkla ve İlerle",
  Arcade: "Arcade",
  "Visual Novel": "Görsel Roman",
  "Card & Board": "Kart ve Masa Oyunu",
  MOBA: "MOBA",
  MMO: "MMO",
  "Music & Rhythm": "Müzik ve Ritim",
  Trivia: "Bilgi Yarışması",
  Pinball: "Langırt",
  "Sci-Fi": "Bilim Kurgu",
  Fantasy: "Fantastik",
  Indie: "Bağımsız",
  Casual: "Basit Eğlence",
  "Free to Play": "Ücretsiz",
  "Early Access": "Erken Erişim",
};

const EXTRA_SEARCH_SYNONYMS: Readonly<Record<string, string>> = {
  Simulation: "simulator sim",
  RPG: "role-playing role playing crpg jrpg",
  Strategy: "stategy rts tbs",
  Platformer: "platform",
  Sports: "sport",
  MMO: "massively multiplayer",
};

/** Expands one raw genre string into zero or more canonical genre IDs. */
export function canonicalGenresFromTag(raw: string): string[] {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  if (!cleaned || /^\d+$/.test(cleaned)) return [];
  const lower = cleaned.toLowerCase();
  if (IGNORED_TAGS.has(lower)) return [];
  const mapped = GENRE_ALIASES[lower];
  if (mapped) return [...mapped];
  return [cleaned];
}

/** Deduplicated canonical genre list preserving input priority. */
export function normalizeGenreList(rawList: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    if (!raw) continue;
    for (const canon of canonicalGenresFromTag(raw)) {
      const key = canon.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(canon);
      }
    }
  }
  return out;
}

/** Combines IGDB `genres` with gameplay-relevant IGDB `themes` (such as `"Action"`). */
export function mergeIgdbGenresAndThemes(
  genres?: readonly string[] | null,
  themes?: readonly string[] | null,
): string[] {
  const combined: string[] = [];
  if (genres) {
    for (const g of genres) {
      if (g) combined.push(g);
    }
  }
  if (themes) {
    for (const theme of themes) {
      if (!theme) continue;
      const promoted = PROMOTED_IGDB_THEMES.get(theme.trim().toLowerCase());
      if (promoted) combined.push(promoted);
    }
  }
  return normalizeGenreList(combined);
}

/**
 * Picks the single most representative genre for `Sort by: Genre` and
 * `Group by: Genre`, preferring specific gameplay genres over broad pillars,
 * `"Action"` over `"Adventure"` for action-adventure titles, and core genres
 * over meta tags (`Indie`, `Casual`, `Free to Play`, `Early Access`).
 */
export function choosePrimaryGenre(genres: readonly string[]): string {
  if (genres.length === 0) return "";
  for (const g of genres) {
    if (TIER_1_GENRES.has(g)) return g;
  }
  if (genres.includes("Action")) return "Action";
  for (const g of genres) {
    if (!META_GENRES.has(g)) return g;
  }
  return genres[0] ?? "";
}

/** Localized display label for a canonical genre ID. */
export function formatGenreLabel(canonical: string): string {
  if (!canonical) return "";
  if (currentLanguage() === "tr") {
    return TR_GENRE_LABELS[canonical] ?? canonical;
  }
  return canonical;
}

/** Lowercase search haystack for a genre facet row (localized + English + aliases). */
export function genreSearchTokens(canonical: string): string {
  const label = formatGenreLabel(canonical).toLowerCase();
  const base = canonical.toLowerCase();
  const extra = EXTRA_SEARCH_SYNONYMS[canonical] ?? "";
  return `${label} ${base} ${extra}`.trim();
}
