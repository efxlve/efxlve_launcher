/**
 * Main profile plus one card per store, in the launcher's own layout.
 *
 * Live stores (Epic, GOG, Steam) use the numbers the profile already has.
 * Xbox, Battle.net, Ubisoft and EA are slots for the next update: they stay
 * hidden until the profile setting turns them on, and they never invent stats.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import {
  libraryCount,
  overviewStores,
  playtimeFor,
  profileGamesFor,
  sumStats,
  type StoreKind,
} from "./profile-view";
import type { ProfileGameRecord } from "../../epic";

const UPCOMING_KEY = "efxlve-profile-upcoming";

/** Stores the profile knows about. `live` ones have data today. */
const PLATFORMS: { id: StoreKind | "xbox" | "battlenet" | "ubisoft" | "ea"; live: boolean; label: string }[] = [
  { id: "epic", live: true, label: "Epic Games" },
  { id: "gog", live: true, label: "GOG" },
  { id: "steam", live: true, label: "Steam" },
  { id: "xbox", live: false, label: "Xbox" },
  { id: "battlenet", live: false, label: "Battle.net" },
  { id: "ubisoft", live: false, label: "Ubisoft" },
  { id: "ea", live: false, label: "EA" },
];

let showUpcoming = false;
let settingsOpen = false;

try {
  showUpcoming = localStorage.getItem(UPCOMING_KEY) === "1";
} catch {
  showUpcoming = false;
}

export function toggleProfileSettings(): void {
  settingsOpen = !settingsOpen;
}

export function toggleProfileUpcoming(): void {
  showUpcoming = !showUpcoming;
  try {
    localStorage.setItem(UPCOMING_KEY, showUpcoming ? "1" : "0");
  } catch {
    // The strip still toggles for this session.
  }
}

/** Unlocked achievements divided by the catalog, one decimal, or null. */
export function completionOf(games: ProfileGameRecord[]): number | null {
  let unlocked = 0;
  let total = 0;
  for (const g of games) {
    if (g.total_achievements <= 0) continue;
    unlocked += g.total_unlocked;
    total += g.total_achievements;
  }
  if (total <= 0) return null;
  return Math.round((unlocked / total) * 1000) / 10;
}

function selectedStore(): "all" | StoreKind {
  const store = S.profileStore;
  if (store === "epic" || store === "gog" || store === "steam") {
    return overviewStores().includes(store) ? store : "all";
  }
  return "all";
}

function liveCard(id: StoreKind, selected: boolean): string {
  const games = profileGamesFor(id);
  const stats = sumStats(games);
  const pct = completionOf(games);
  const hours = fmtPlaytime(playtimeFor(id));
  return `
    <button type="button" class="profile-platform${selected ? " is-on" : ""}" data-act="profile-store" data-val="${id}" aria-pressed="${selected}">
      <span class="profile-platform-mark">${storeLogo(id, 18)}</span>
      <span class="profile-platform-name">${esc(id === "gog" ? "GOG" : id === "epic" ? "Epic Games" : "Steam")}</span>
      <span class="profile-platform-pct tabular-nums">${pct === null ? "—" : `${pct.toFixed(1)}%`}</span>
      <span class="profile-platform-meta tabular-nums">${libraryCount(id)} ${t("profile.games")} · ${esc(hours)} · ${stats.unlocked.toLocaleString()} ${t("profile.trophies")}</span>
    </button>`;
}

function soonCard(label: string): string {
  return `
    <div class="profile-platform is-soon" aria-disabled="true">
      <span class="profile-platform-name">${esc(label)}</span>
      <span class="profile-platform-pct tabular-nums">—</span>
      <span class="profile-platform-meta">${esc(t("profile.comingSoon"))}</span>
    </div>`;
}

/** Store cards under the main profile. Combined view only. */
export function renderProfilePlatforms(): string {
  const current = selectedStore();
  const live = overviewStores();
  const allGames = profileGamesFor("all");
  const allPct = completionOf(allGames);
  const allStats = sumStats(allGames);
  const cards = [
    `<button type="button" class="profile-platform${current === "all" ? " is-on" : ""}" data-act="profile-store" data-val="all" aria-pressed="${current === "all"}">
      <span class="profile-platform-name">${esc(t("profile.overview"))}</span>
      <span class="profile-platform-pct tabular-nums">${allPct === null ? "—" : `${allPct.toFixed(1)}%`}</span>
      <span class="profile-platform-meta tabular-nums">${libraryCount("all")} ${t("profile.games")} · ${esc(fmtPlaytime(playtimeFor("all")))} · ${allStats.unlocked.toLocaleString()} ${t("profile.trophies")}</span>
    </button>`,
  ];
  for (const platform of PLATFORMS) {
    if (platform.live) {
      if (!live.includes(platform.id as StoreKind)) continue;
      cards.push(liveCard(platform.id as StoreKind, current === platform.id));
    } else if (showUpcoming) {
      cards.push(soonCard(platform.label));
    }
  }
  return `
    <section class="profile-platforms">
      <div class="profile-platforms-head">
        <button type="button" class="icon-btn" data-act="profile-settings" title="${esc(t("profile.settings"))}" aria-expanded="${settingsOpen}">${icon("settings", 14)}</button>
      </div>
      <div class="profile-platforms-row">${cards.join("")}</div>
      ${settingsOpen ? `
        <div class="profile-platforms-settings">
          <button type="button" class="btn ghost small" data-act="profile-upcoming" aria-pressed="${showUpcoming}">
            ${icon(showUpcoming ? "eye" : "eye-off", 14)}
            <span>${esc(t("profile.showUpcoming"))}</span>
          </button>
        </div>` : ""}
    </section>`;
}
