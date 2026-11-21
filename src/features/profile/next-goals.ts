/**
 * Next achievement goals: surfaces tracked games that are closest to 100%
 * completion so the player can jump straight to their remaining trophies.
 *
 * Only games with a known total (`total_achievements > 0`), at least one
 * unlocked trophy, and either <= 5 remaining achievements or >= 65% progress
 * qualify. Hidden games and hidden achievement sets are excluded.
 */

import { icon } from "../../core/icons";
import { rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { cachedSteamCover, steamCdnPortrait } from "../../core/steam-art-cache";
import { esc, isOpaqueId } from "../../core/utils";
import { epicPortrait, type ProfileGameRecord } from "../../epic";
import { t } from "../../i18n";
import { storeLogo } from "../store/store-logos";

function isCompleted(g: ProfileGameRecord): boolean {
  return g.is_platinum || (g.total_achievements > 0 && g.total_unlocked >= g.total_achievements);
}

function userHidAchievement(g: ProfileGameRecord): boolean {
  return S.hiddenAchievements.has(g.app_name) || (Boolean(g.sandbox_id) && S.hiddenAchievements.has(g.sandbox_id));
}

function goalCoverOf(g: ProfileGameRecord): string {
  const appName = g.app_name;
  const custom = S.customCovers[appName];
  if (custom) return custom;
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    if (/^\d+$/.test(appId)) {
      return cachedSteamCover(appId) || steamCdnPortrait(appId);
    }
  }
  const s = S.epicSummariesMap.get(appName) || summaryOf(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || g.cover || "";
}

function goalSteamArtAttrs(appName: string): string {
  if (S.customCovers[appName] || !appName.startsWith("steam::")) return "";
  const appId = appName.slice(7);
  if (!/^\d+$/.test(appId)) return "";
  return ` data-steam-app="${appId}" data-art-step="${cachedSteamCover(appId) ? "resolved" : "0"}"`;
}

export function renderNextGoals(games: ProfileGameRecord[], showStore: boolean): string {
  const candidates = games.filter((g) => {
    if (isOpaqueId(g.app_title) || S.hiddenGames.has(g.app_name) || userHidAchievement(g)) return false;
    if (g.total_achievements <= 0 || g.total_unlocked <= 0) return false;
    if (isCompleted(g)) return false;
    const remaining = g.total_achievements - g.total_unlocked;
    return remaining <= 5 || g.unlocked_percent >= 65;
  });

  if (candidates.length === 0) return "";

  candidates.sort((a, b) => {
    const remA = a.total_achievements - a.total_unlocked;
    const remB = b.total_achievements - b.total_unlocked;
    if (remA !== remB) return remA - remB;
    if (b.unlocked_percent !== a.unlocked_percent) return b.unlocked_percent - a.unlocked_percent;
    const ptA = S.playtimeMap.get(a.app_name)?.total_seconds || 0;
    const ptB = S.playtimeMap.get(b.app_name)?.total_seconds || 0;
    return ptB - ptA;
  });

  const top = candidates.slice(0, 4);
  const cards = top
    .map((g) => {
      const remaining = g.total_achievements - g.total_unlocked;
      const remLabel = t("profile.goalsRemaining", { n: remaining });
      const cover = goalCoverOf(g);
      const store = sourceOfKey(g.app_name);
      const storeMark = showStore ? storeLogo(store, 11, "profile-unlock-store-logo") : "";
      const barWidth = Math.min(99, Math.max(4, g.unlocked_percent));
      const tip = `${g.app_title} — ${g.total_unlocked} / ${g.total_achievements} (${g.unlocked_percent}%) · ${remLabel}`;
      return `
        <button type="button" class="profile-goal-card" data-act="open-goal-game" data-id="${esc(g.app_name)}" title="${esc(tip)}">
          <span class="profile-goal-thumb-wrap">
            ${cover ? `<img class="profile-goal-thumb"${goalSteamArtAttrs(g.app_name)} src="${esc(cover)}" alt="" loading="lazy" decoding="async" />` : `<span class="profile-goal-thumb placeholder">${icon("trophy", 16)}</span>`}
          </span>
          <span class="profile-goal-body">
            <span class="profile-goal-title-row">${storeMark}<span class="profile-goal-title">${esc(g.app_title)}</span></span>
            <span class="profile-goal-meta">
              <span class="profile-goal-rem tabular-nums">${icon("trophy", 11)}<span>${esc(remLabel)}</span></span>
              <span class="profile-goal-frac tabular-nums">${g.total_unlocked}/${g.total_achievements} · ${g.unlocked_percent}%</span>
            </span>
            <span class="profile-goal-bar"><span style="width:${barWidth}%"></span></span>
          </span>
        </button>`;
    })
    .join("");

  return `
    <section class="profile-row profile-goals">
      <div class="profile-row-head">
        <div class="profile-row-title-group">
          <h3 class="profile-row-title">${esc(t("profile.goalsTitle"))}</h3>
          <span class="profile-section-count tabular-nums">${candidates.length}</span>
        </div>
        <span class="profile-unlock-stats">${esc(t("profile.goalsSub"))}</span>
      </div>
      <div class="profile-goals-grid">${cards}</div>
    </section>`;
}
