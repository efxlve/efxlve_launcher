/**
 * Store-agnostic achievement math and guide links.
 *
 * Every store returns a slightly different shape: Epic has XP and partial
 * progress, Steam has global percentages, GOG has rarity without tiers, and
 * EA/Ubisoft often have neither. These helpers normalize the facts the UI can
 * actually show, so the game page and the overlay never invent a tier or a
 * progress bar the store did not provide.
 */

export type AchievementTierName = "platinum" | "gold" | "silver" | "bronze";

export interface AchievementTierLike {
  name?: string;
  hexColor?: string;
  min?: number;
  max?: number;
}

export interface AchievementRarityLike {
  percent?: number | null;
}

/** Structural subset shared by every store's achievement payload. */
export interface AchievementLike {
  name: string;
  display_name?: string;
  description?: string;
  xp?: number;
  unlocked?: boolean;
  progress?: number;
  unlock_date?: string | null;
  icon_link?: string;
  tier?: AchievementTierLike | null;
  rarity?: AchievementRarityLike | null;
  hidden?: boolean;
  is_base?: boolean;
}

/** `progress` is 0..1 for Epic/emulators and 0/100 for GOG/Steam. */
export function achievementProgress(a: AchievementLike): number {
  const raw = Number(a.progress ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const value = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, value));
}

/** An achievement is earned when the store says so or progress reached 100%. */
export function isAchievementUnlocked(a: AchievementLike): boolean {
  return Boolean(a.unlocked) || achievementProgress(a) >= 1;
}

/** Global unlock percentage, clamped to a sane 0..100 range. */
export function achievementRarity(a: AchievementLike): number | null {
  const raw = a.rarity?.percent;
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(100, value);
}

/** Tier by global unlock rate when the store ships no tier of its own. */
export function tierFromPercent(percent: number): AchievementTierName {
  if (percent <= 5) return "gold";
  if (percent <= 25) return "silver";
  return "bronze";
}

/** Tier by points for stores that expose a reward but no rarity. */
export function tierFromXp(xp: number): AchievementTierName | null {
  if (xp >= 200) return "platinum";
  if (xp >= 100) return "gold";
  if (xp >= 50) return "silver";
  if (xp > 0) return "bronze";
  return null;
}

/**
 * The tier the UI should paint. A store tier wins; otherwise rarity is the
 * best proxy; points are the last resort. `null` means the payload has no
 * tier signal at all and the caller must not show a tier pill.
 */
export function achievementTier(a: AchievementLike): AchievementTierName | null {
  const name = (a.tier?.name ?? "").toLowerCase();
  if (name.includes("plat")) return "platinum";
  if (name.includes("gold")) return "gold";
  if (name.includes("silver")) return "silver";
  if (name.includes("bronze")) return "bronze";

  const percent = achievementRarity(a);
  if (percent != null) return tierFromPercent(percent);

  const xp = Number(a.xp ?? 0);
  return Number.isFinite(xp) ? tierFromXp(xp) : null;
}

export function achievementTierKnown(a: AchievementLike): boolean {
  return achievementTier(a) != null;
}

/**
 * TA-style rarity weight, without borrowing the name: a 4.2% achievement is
 * about 4.9x, a 97% one is about 1.0x. The clamp keeps a 0.01% entry finite.
 */
export function rarityMultiplier(a: AchievementLike): number | null {
  const percent = achievementRarity(a);
  if (percent == null) return null;
  return Math.sqrt(100 / Math.max(percent, 0.1));
}

export interface AchievementStats {
  total: number;
  unlocked: number;
  remaining: number;
  percent: number;
  nearComplete: number;
  rarestUnlocked: number | null;
}

/** Counts the detail header and the next-target card share. */
export function achievementStats(items: AchievementLike[]): AchievementStats {
  const total = items.length;
  let unlocked = 0;
  let nearComplete = 0;
  let rarestUnlocked: number | null = null;

  for (const item of items) {
    const isUnlocked = isAchievementUnlocked(item);
    const progress = achievementProgress(item);
    if (isUnlocked) {
      unlocked += 1;
      const percent = achievementRarity(item);
      if (percent != null && (rarestUnlocked == null || percent < rarestUnlocked)) {
        rarestUnlocked = percent;
      }
    } else if (progress >= 0.5 && progress < 1) {
      nearComplete += 1;
    }
  }

  return {
    total,
    unlocked,
    remaining: Math.max(0, total - unlocked),
    percent: total > 0 ? Math.round((unlocked / total) * 100) : 0,
    nearComplete,
    rarestUnlocked,
  };
}

/**
 * Best next targets: partial progress first, then the more common achievements
 * (easier), then the bigger reward. Hidden achievements are not recommended
 * because the player cannot see what they are chasing.
 */
export function nextAchievements(items: AchievementLike[], limit = 3): AchievementLike[] {
  const scored = items
    .filter((item) => !isAchievementUnlocked(item) && !item.hidden)
    .map((item) => {
      const progress = achievementProgress(item);
      const percent = achievementRarity(item);
      const xp = Number(item.xp ?? 0);
      let score = 0;
      if (progress > 0) score += 2 + progress * 3;
      if (percent != null) score += percent / 100;
      if (xp > 0) score += Math.min(xp / 200, 1);
      if (item.is_base) score += 0.05;
      return { item, score, signal: progress > 0 || percent != null || xp > 0 };
    });

  if (!scored.some((entry) => entry.signal)) return [];
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

/**
 * Remaining hours at the player's own pace, falling back to HLTB only when
 * there is not enough personal history. Deliberately rough; the UI labels it.
 */
export function estimateRemainingHours(
  stats: AchievementStats,
  playtimeSeconds: number,
  hltbCompletionist: number | null | undefined,
): number | null {
  if (stats.remaining <= 0) return null;
  const playedHours = Math.max(0, playtimeSeconds) / 3600;
  if (stats.unlocked >= 3 && playedHours >= 1) {
    const pace = playedHours / stats.unlocked;
    return Math.max(0.5, pace * stats.remaining);
  }
  if (hltbCompletionist != null && Number.isFinite(hltbCompletionist) && hltbCompletionist > 0) {
    return Math.max(0.5, hltbCompletionist - playedHours);
  }
  return null;
}

/** Site slugs are best effort; the caller always offers a search fallback. */
export function achievementSiteSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2122\u00ae\u00a9]/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface AchievementGuideTarget {
  title: string;
  achievement: string;
  store?: string;
  steamAppId?: string | null;
}

export interface AchievementGuideLinks {
  video: string;
  web: string;
  steamDiscussions?: string;
  steamGuides?: string;
  steamAchievements?: string;
  trueSteamAchievements?: string;
  trueAchievements?: string;
}

/**
 * The launchpad the detail view renders. Guide pages are opened, never copied:
 * TA/TSA and Steam are user-generated content and their sites set their own
 * access rules.
 */
export function achievementGuideLinks(target: AchievementGuideTarget): AchievementGuideLinks {
  const game = target.title.trim() || target.achievement;
  const achievement = target.achievement.trim();
  const query = `${game} ${achievement}`.trim();
  const links: AchievementGuideLinks = {
    video: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${query} achievement guide`)}`,
    web: `https://www.google.com/search?q=${encodeURIComponent(`"${game}" "${achievement}" achievement guide`)}`,
  };

  if (target.steamAppId) {
    const id = target.steamAppId;
    links.steamDiscussions = `https://steamcommunity.com/app/${id}/discussions/search/?q=${encodeURIComponent(achievement)}`;
    links.steamGuides = `https://steamcommunity.com/app/${id}/guides/?searchText=${encodeURIComponent(achievement)}&browsefilter=trend&browsesort=textsearch`;
    links.steamAchievements = `https://steamcommunity.com/stats/${id}/achievements`;
  }

  const slug = achievementSiteSlug(game);
  if (slug) {
    const fragment = `#:~:text=${encodeURIComponent(achievement)}`;
    if (target.store === "steam" || target.steamAppId) {
      links.trueSteamAchievements = `https://truesteamachievements.com/game/${slug}/achievements${fragment}`;
    }
    if (target.store === "xbox") {
      links.trueAchievements = `https://www.trueachievements.com/game/${slug}/achievements${fragment}`;
    }
  }

  return links;
}

/** Only user-facing, browser-openable URLs reach `openUrl`. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
