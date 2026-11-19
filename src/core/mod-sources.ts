/**
 * Where a game's mods live.
 *
 * A source opens the game's own page only when this table knows the id.
 * Everything else falls back to that site's index, which always opens, because
 * a wrong game page is worse than a list. Ids are checked against the live site
 * before they land here and are never derived from the title: a slug that
 * happens to look right ("riskofrain2") returns 404 while a guessed one on a
 * different site silently opens another game.
 *
 * Nothing here fetches. The card that renders these rows is a link list, so it
 * costs no network call on the store page.
 */

/** A game as the library already knows it. */
export interface ModSourceGame {
  title: string;
  /** Steam app id, digits only, when the library has one. */
  steamAppId?: string | null;
}

export type ModSourceKey = "workshop" | "nexus" | "thunderstore";

/** One row of the mod card. */
export interface ModSourceLink {
  key: ModSourceKey;
  /** Proper noun: a site name, not a translated string. */
  label: string;
  url: string;
  /** The row opens this game's page, not that site's index. */
  exact: boolean;
}

interface SourceRow {
  /** Steam app id this row also answers to. */
  steam?: string;
  /** Normalised titles this row answers to. */
  titles: string[];
  /** Nexus slug, as it appears after `nexusmods.com/games/`. */
  nexus?: string;
  /** Thunderstore community slug, as it appears after `thunderstore.io/c/`. */
  thunderstore?: string;
}

/** One row per game. A missing field only costs an exact page, never a row. */
const ROWS: SourceRow[] = [
  { steam: "292030", titles: ["the witcher 3 wild hunt"], nexus: "witcher3" },
  { steam: "1091500", titles: ["cyberpunk 2077"], nexus: "cyberpunk2077" },
  { steam: "489830", titles: ["skyrim special edition"], nexus: "skyrimspecialedition" },
  { steam: "377160", titles: ["fallout 4"], nexus: "fallout4" },
  { steam: "1086940", titles: ["baldurs gate 3"], nexus: "baldursgate3" },
  { steam: "413150", titles: ["stardew valley"], nexus: "stardewvalley" },
  { steam: "892970", titles: ["valheim"], nexus: "valheim", thunderstore: "valheim" },
  { steam: "1966720", titles: ["lethal company"], nexus: "lethalcompany", thunderstore: "lethal-company" },
  { steam: "632360", titles: ["risk of rain 2"], thunderstore: "riskofrain2" },
  { steam: "367520", titles: ["hollow knight"], nexus: "hollowknight" },
  { steam: "1623730", titles: ["palworld"], thunderstore: "palworld" },
];

/**
 * Lowercase, fold accents, drop punctuation. "Baldur's Gate 3" and
 * "Baldurs Gate 3" are the same game; "The Witcher 3: Wild Hunt" and
 * "The Witcher 3: Wild Hunt - Complete Edition" are not, and the second one
 * falls back to a list instead of opening the wrong page.
 */
function normalise(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const bySteam = new Map<string, SourceRow>();
const byTitle = new Map<string, SourceRow>();
for (const row of ROWS) {
  if (row.steam) bySteam.set(row.steam, row);
  for (const title of row.titles) {
    // The first row wins a duplicated title, so the table order is the tiebreak.
    if (!byTitle.has(title)) byTitle.set(title, row);
  }
}

function digits(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

function rowFor(game: ModSourceGame): SourceRow | undefined {
  const steam = digits(game.steamAppId);
  const byId = steam ? bySteam.get(steam) : undefined;
  return byId ?? byTitle.get(normalise(game.title));
}

/**
 * The card's rows, in display order.
 *
 * The Steam Workshop row needs an app id and nothing else, which is why it is
 * the one exact row a game gets for free.
 */
export function modSourceLinks(game: ModSourceGame): ModSourceLink[] {
  const row = rowFor(game);
  const steam = digits(game.steamAppId);
  const links: ModSourceLink[] = [];

  if (steam) {
    links.push({
      key: "workshop",
      label: "Steam Workshop",
      url: `https://steamcommunity.com/app/${steam}/workshop/`,
      exact: true,
    });
  }

  links.push(
    row?.nexus
      ? {
          key: "nexus",
          label: "Nexus Mods",
          url: `https://www.nexusmods.com/games/${row.nexus}`,
          exact: true,
        }
      : {
          key: "nexus",
          label: "Nexus Mods",
          url: "https://www.nexusmods.com/games",
          exact: false,
        },
  );

  links.push(
    row?.thunderstore
      ? {
          key: "thunderstore",
          label: "Thunderstore",
          url: `https://thunderstore.io/c/${row.thunderstore}/`,
          exact: true,
        }
      : {
          key: "thunderstore",
          label: "Thunderstore",
          url: "https://thunderstore.io/communities/",
          exact: false,
        },
  );

  return links;
}
