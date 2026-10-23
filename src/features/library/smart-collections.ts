/**
 * Smart collections are computed, never stored: the same library filters and
 * rules produce them on every render, so they cannot go stale.
 */

import { achSummaryOf, isAppPlatinum } from "../../core/game-view";
import { libraryPlaytime } from "../../core/selectors";
import { S } from "../../core/state";
import type { EpicSummary } from "../../epic";
import { t } from "../../i18n";
import { gameStatusOf } from "./game-status";

export interface SmartCollection {
  id: string;
  label: () => string;
  test: (summary: EpicSummary) => boolean;
}

const DAY = 86_400;

function achievementPercent(summary: EpicSummary): number | null {
  const ach = achSummaryOf(summary.appName);
  if (!ach?.supported || !ach.total_achievements) return null;
  return (ach.user_unlocked / ach.total_achievements) * 100;
}

export const SMART_COLLECTIONS: SmartCollection[] = [
  {
    id: "smart:installed-unplayed",
    label: () => `${t("library.installed")} · ${t("playtime.notPlayed")}`,
    test: (s) => s.installed && libraryPlaytime(s).seconds === 0,
  },
  {
    id: "smart:not-played",
    label: () => t("playtime.notPlayed"),
    test: (s) => libraryPlaytime(s).seconds === 0,
  },
  {
    id: "smart:playing",
    label: () => t("drawer.statePlaying"),
    test: (s) => gameStatusOf(s.appName) === "playing" || S.runningGames.has(s.appName),
  },
  {
    id: "smart:almost",
    label: () => t("smart.almost"),
    test: (s) => {
      const percent = achievementPercent(s);
      return percent !== null && percent >= 75 && percent < 100;
    },
  },
  {
    id: "smart:completed",
    label: () => t("drawer.stateCompleted"),
    test: (s) => {
      if (gameStatusOf(s.appName) === "completed" || isAppPlatinum(s.appName)) return true;
      const percent = achievementPercent(s);
      return percent !== null && percent >= 100;
    },
  },
  {
    id: "smart:on-hold",
    label: () => t("status.onHold"),
    test: (s) => gameStatusOf(s.appName) === "onhold",
  },
  {
    id: "smart:forgotten",
    label: () => t("smart.forgotten"),
    test: (s) => {
      const played = libraryPlaytime(s);
      return played.seconds > 0 && played.lastPlayed > 0 &&
        Date.now() / 1000 - played.lastPlayed > 365 * DAY;
    },
  },
];

export function smartCollection(id: string | null | undefined): SmartCollection | undefined {
  if (!id) return undefined;
  return SMART_COLLECTIONS.find((collection) => collection.id === id);
}

export function isSmartCollection(id: string | null | undefined): boolean {
  return smartCollection(id) !== undefined;
}

export function smartMatches(id: string, summary: EpicSummary): boolean {
  return smartCollection(id)?.test(summary) ?? false;
}
