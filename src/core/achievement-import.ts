/**
 * A pasted achievement list, matched against the set the game page shows.
 *
 * EOS titles report unlocks only while the game runs, so a player who already
 * earned them has to mark them by hand. Pasting the list from the in-game
 * overlay is the fastest honest way in: nothing here unlocks anything the
 * player did not name.
 */

/** One entry per line; commas, semicolons and JSON leftovers also split. */
export function parseAchievementImport(text: string): string[] {
  return (text ?? "")
    .split(/[\r\n,;\t]+/)
    .map((value) => value.trim().replace(/^["'[\]{}]+|["'[\]{}]+$/g, "").trim())
    .filter((value) => value.length > 0);
}

export interface ImportableAchievement {
  name: string;
  display_name?: string;
}

export interface AchievementImportMatch<T extends ImportableAchievement> {
  matched: T[];
  /** Pasted entries that name nothing in this set. */
  missed: number;
}

/**
 * Matches by internal name first, then by the title on screen. Case is folded
 * without a locale, so the same paste works under every launcher language.
 */
export function matchAchievementImport<T extends ImportableAchievement>(
  tokens: string[],
  items: T[],
): AchievementImportMatch<T> {
  const byName = new Map<string, T>();
  const byTitle = new Map<string, T>();
  for (const item of items) {
    byName.set(item.name.trim().toLowerCase(), item);
    const title = (item.display_name ?? "").trim().toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, item);
  }

  const matched = new Map<string, T>();
  let missed = 0;
  for (const token of tokens) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    const item = byName.get(key) ?? byTitle.get(key);
    if (!item) {
      missed += 1;
      continue;
    }
    matched.set(item.name, item);
  }
  return { matched: [...matched.values()], missed };
}
