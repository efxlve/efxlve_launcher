/**
 * Gamer profile page renderer (inspired by Xbox PC App and Steam Profile).
 *
 * Implements a 2-column master-detail layout:
 * - Minimalist Hero Banner: Avatar, gamer tag, level crest, 4-tier trophy showcase, refresh.
 * - Left Column: Featured Game Showcase (Steam style) + Achievements & Games Progress list (Xbox style).
 * - Right Sidebar: 3x3 Recently Played grid (Xbox style) + Compact Friends Lounge.
 *
 * Follows zero-emoji policy, PS5 obsidian & lavender token rules, and tabular numbers.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { epicWideArt } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import type { ProfileGameRecord } from "../../epic";

/**
 * Xbox-style achievement game cards.
 * Rendered as clean, horizontal rows with game poster, title, tags, trophy counts,
 * XP progress bar, and percentage/platinum badges.
 */
function renderProfileGameCards(cardGames: ProfileGameRecord[]): string {
  if (cardGames.length === 0) {
    return `
      <div class="profile-empty-games">
        <div class="profile-empty-icon">${icon("gamepad-2", 40)}</div>
        <h4>${t("profile.emptyTitle")}</h4>
        <p>${t("profile.emptyDesc")}</p>
      </div>
    `;
  }

  return cardGames
    .map((g) => {
      const isPlat = g.is_platinum || g.unlocked_percent >= 100;
      const pt = S.playtimeMap.get(g.app_name);
      const playtimeStr = pt && pt.total_seconds > 0 ? fmtPlaytime(pt.total_seconds) : null;
      // O(1) map lookup instead of a linear scan per card.
      const s = S.epicSummariesMap.get(g.app_name);
      const isInstalled = s?.installed ?? false;

      const coverUrl = S.customCovers[g.app_name] || g.cover || s?.cover || "";
      const bannerUrl = s ? (epicWideArt(s) || s.cover) : (g.cover || "");
      const fillPercent = Math.min(100, Math.max(0, g.unlocked_percent));

      return `
        <div class="ps5-profile-game-card ${isPlat ? "platinum" : ""}" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button" title="${esc(g.app_title)} - ${t("profile.detailsTitle")}">
          ${bannerUrl ? `<img class="ps5-card-backdrop" src="${esc(bannerUrl)}" alt="" loading="lazy" decoding="async" />` : ""}
          <div class="ps5-card-backdrop-overlay"></div>

          <div class="ps5-card-inner">
            <div class="ps5-card-poster-wrap">
              ${
                coverUrl
                  ? `<img class="ps5-card-poster" src="${esc(coverUrl)}" alt="${esc(g.app_title)}" loading="lazy" />`
                  : `<div class="ps5-card-poster-empty">${icon("gamepad-2", 28)}</div>`
              }
              ${
                isPlat
                  ? `<div class="ps5-card-plat-badge" title="${t("profile.platinumComplete")}">${epicPlatinumIcon(15)}</div>`
                  : ""
              }
            </div>

            <div class="ps5-card-info">
              <div class="ps5-card-header-row">
                <div class="ps5-card-title-col">
                  <h3 class="ps5-card-title" title="${esc(g.app_title)}">${esc(g.app_title)}</h3>
                  <div class="ps5-card-tags">
                    ${isInstalled ? `<span class="profile-game-tag installed">${icon("check", 10)} ${t("profile.installed")}</span>` : ""}
                    ${playtimeStr ? `<span class="profile-game-tag playtime">${icon("clock", 10)} ${playtimeStr}</span>` : ""}
                  </div>
                </div>
              </div>

              <div class="ps5-card-progress-section">
                <div class="ps5-card-progress-labels">
                  <span class="ps5-card-progress-left">
                    ${isPlat ? epicPlatinumIcon(12) : icon("trophy", 12)}
                    <strong>${g.total_unlocked}</strong> / ${g.total_achievements} ${t("profile.trophies")}
                  </span>
                  <span class="ps5-card-xp">
                    ${icon("sparkles", 11)}
                    <strong>${g.total_xp.toLocaleString()}</strong> / ${g.total_product_xp.toLocaleString()} XP
                  </span>
                </div>
                <div class="ps5-card-progress-track">
                  <div
                    class="ps5-card-progress-fill ${isPlat ? "plat" : ""}"
                    style="width: ${fillPercent}%"
                  ></div>
                </div>
              </div>
            </div>

            <div class="ps5-card-right">
              <div class="ps5-card-percent-badge ${isPlat ? "plat" : ""}">
                <span class="ps5-card-percent">%${g.unlocked_percent}</span>
                <span class="ps5-card-percent-sub">${isPlat ? t("profile.completed") : t("profile.progress")}</span>
              </div>
              <div class="ps5-card-chevron">${icon("chevron-right", 16)}</div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

/** Resets the profile grid back to the first chunk (on filter/sort/search change). */
export function resetProfileCards(): void {
  S.profileCardCount = PROFILE_CARD_CHUNK;
}

/**
 * Trophy list with progressive rendering: only the first chunk is built so a
 * large profile never turns into thousands of DOM nodes at once.
 */
export function renderProfileGrid(cardGames: ProfileGameRecord[]): string {
  const shown = cardGames.slice(0, S.profileCardCount);
  const more =
    cardGames.length > shown.length
      ? `<div class="profile-grid-more">
           <button class="btn ghost" data-act="profile-show-more">${t("profile.showMore")} (${cardGames.length - shown.length})</button>
         </div>`
      : "";
  return renderProfileGameCards(shown) + more;
}

/** Human label for an Epic external auth provider key. */
function platformLabel(key: string): string {
  const map: Record<string, string> = {
    steam: "Steam",
    psn: "PSN",
    xbl: "Xbox",
    nintendo: "Switch",
    epic: "Epic",
  };
  return map[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Steam-style "Favorite / Featured Game" showcase.
 * Highlights the player's #1 most played or completed game.
 */
function renderFeaturedGameShowcase(): string {
  let topAppName: string | null = null;
  let topSeconds = 0;
  for (const [appName, rec] of S.playtimeMap.entries()) {
    if ((rec.total_seconds || 0) > topSeconds) {
      topSeconds = rec.total_seconds;
      topAppName = appName;
    }
  }

  if (!topAppName && S.playerProfileData?.games?.length) {
    const sorted = [...S.playerProfileData.games].sort((a, b) => b.unlocked_percent - a.unlocked_percent);
    topAppName = sorted[0]?.app_name || null;
  }

  if (!topAppName && S.epicSummaries.length > 0) {
    topAppName = S.epicSummaries[0].appName;
  }

  if (!topAppName) return "";

  const s = S.epicSummariesMap.get(topAppName);
  const title = s?.title || topAppName;
  const coverUrl = S.customCovers[topAppName] || s?.cover || "";
  const bannerUrl = s ? (epicWideArt(s) || s.cover) : coverUrl;
  const gameRec = S.playerProfileData?.games.find((g) => g.app_name === topAppName);

  const totalUnlocked = gameRec?.total_unlocked || 0;
  const totalAch = gameRec?.total_achievements || 0;
  const pct = gameRec ? Math.min(100, Math.max(0, gameRec.unlocked_percent)) : 0;
  const isPlat = gameRec?.is_platinum || pct >= 100;
  const playtimeStr = topSeconds > 0 ? fmtPlaytime(topSeconds) : null;
  const isInstalled = s?.installed ?? false;

  return `
    <div class="profile-featured-showcase ${isPlat ? "platinum" : ""}" data-act="open-game-from-profile" data-id="${esc(topAppName)}" role="button" tabindex="0" title="${esc(title)} - ${t("profile.detailsTitle")}">
      ${bannerUrl ? `<img class="featured-backdrop" src="${esc(bannerUrl)}" alt="" loading="lazy" />` : ""}
      <div class="featured-backdrop-overlay"></div>

      <div class="featured-content">
        <div class="featured-badge-row">
          <span class="featured-pill-badge">${icon("star", 11)} ${t("profile.favoriteGame")}</span>
          ${isPlat ? `<span class="featured-plat-badge">${epicPlatinumIcon(12)} ${t("profile.platLabel")}</span>` : ""}
          ${isInstalled ? `<span class="featured-installed-badge">${icon("check", 10)} ${t("profile.installed")}</span>` : ""}
        </div>

        <div class="featured-main-row">
          <div class="featured-poster-wrap">
            ${coverUrl ? `<img class="featured-poster" src="${esc(coverUrl)}" alt="${esc(title)}" />` : `<div class="featured-poster-fallback">${icon("gamepad-2", 24)}</div>`}
          </div>

          <div class="featured-info-col">
            <h3 class="featured-title">${esc(title)}</h3>

            <div class="featured-stats-row">
              ${playtimeStr ? `<span class="featured-stat-item">${icon("clock", 12)} <strong>${playtimeStr}</strong> ${t("profile.played")}</span>` : ""}
              ${totalAch > 0 ? `<span class="featured-stat-item">${icon("trophy", 12)} <strong>${totalUnlocked} / ${totalAch}</strong> ${t("profile.trophies")}</span>` : ""}
              ${gameRec?.total_xp ? `<span class="featured-stat-item">${icon("sparkles", 11)} <strong>${gameRec.total_xp.toLocaleString()}</strong> XP</span>` : ""}
            </div>

            ${
              totalAch > 0
                ? `
              <div class="featured-progress-row">
                <div class="featured-progress-track">
                  <div class="featured-progress-fill ${isPlat ? "plat" : ""}" style="width: ${pct}%"></div>
                </div>
                <span class="featured-progress-pct ${isPlat ? "plat" : ""}">%${pct}</span>
              </div>
            `
                : ""
            }
          </div>

          <div class="featured-action-col">
            <button class="apple-pill-btn secondary small" data-act="epic-detail" data-id="${esc(topAppName)}">
              ${icon("info", 12)} <span>${t("common.details")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Xbox-style 3x3 Recently Played games grid.
 */
function renderXboxRecentGrid(): string {
  const recentAppNames: string[] = [];

  // 1. From S.epicRecent (recent launched)
  for (const name of S.epicRecent) {
    if (!recentAppNames.includes(name) && S.epicSummariesMap.has(name)) {
      recentAppNames.push(name);
    }
  }

  // 2. From playtime map sorted by last_played_timestamp descending
  const played = [...S.playtimeMap.entries()]
    .filter(([name, r]) => (r.total_seconds || 0) > 0 && !recentAppNames.includes(name) && S.epicSummariesMap.has(name))
    .sort((a, b) => (b[1].last_played_timestamp || 0) - (a[1].last_played_timestamp || 0));
  for (const [name] of played) {
    if (recentAppNames.length >= 9) break;
    recentAppNames.push(name);
  }

  // 3. Fallback to installed games
  if (recentAppNames.length < 9) {
    for (const s of S.epicSummaries) {
      if (recentAppNames.length >= 9) break;
      if (s.installed && !recentAppNames.includes(s.appName)) {
        recentAppNames.push(s.appName);
      }
    }
  }

  // 4. Fallback to any library games
  if (recentAppNames.length < 9) {
    for (const s of S.epicSummaries) {
      if (recentAppNames.length >= 9) break;
      if (!recentAppNames.includes(s.appName)) {
        recentAppNames.push(s.appName);
      }
    }
  }

  const items = recentAppNames
    .map((appName) => {
      const s = S.epicSummariesMap.get(appName);
      const title = s?.title || appName;
      const cover = S.customCovers[appName] || s?.cover || "";
      return `
        <div class="xbox-recent-item clickable" data-act="epic-detail" data-id="${esc(appName)}" title="${esc(title)}">
          ${cover ? `<img src="${esc(cover)}" alt="${esc(title)}" loading="lazy" />` : `<div class="xbox-recent-fallback">${icon("gamepad-2", 18)}</div>`}
          <div class="xbox-recent-overlay">
            <span class="xbox-recent-name">${esc(title)}</span>
          </div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="profile-sidebar-card xbox-recent-card">
      <div class="profile-sidebar-header">
        <div class="profile-sidebar-title">
          ${icon("clock", 13)}
          <h3>${t("profile.recentGamesTitle")}</h3>
        </div>
        <button class="profile-sidebar-link" data-view="library">${t("profile.showAll")}</button>
      </div>
      <div class="xbox-recent-grid">
        ${items || `<div class="sidebar-empty">${t("profile.noRecentGames")}</div>`}
      </div>
    </div>
  `;
}

/** Read-only Epic friends compact sidebar lounge. */
function renderFriendsSection(): string {
  let body: string;
  if (S.friendsLoading && S.friends.length === 0) {
    body = `
      <div class="friends-compact-list skeleton-wrap">
        ${Array.from({ length: 4 })
          .map(
            () => `
          <div class="friend-compact-row skeleton">
            <div class="friend-avatar-compact skeleton-shimmer"></div>
            <div class="friend-info-compact">
              <div class="friend-name-skeleton skeleton-shimmer"></div>
              <div class="friend-plat-skeleton skeleton-shimmer"></div>
            </div>
          </div>`,
          )
          .join("")}
      </div>`;
  } else if (S.friendsError) {
    body = `
      <div class="friends-state friends-state-error compact">
        <p>${esc(S.friendsError)}</p>
        <button class="apple-pill-btn secondary small" data-act="refresh-friends">${icon("refresh", 11)} <span>${t("profile.retry")}</span></button>
      </div>`;
  } else if (S.friends.length === 0) {
    body = `
      <div class="friends-state compact">
        <div class="friends-state-icon">${icon("users", 24)}</div>
        <p>${t("friends.empty")}</p>
      </div>`;
  } else {
    // Sort favorites first
    const sorted = [...S.friends].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    body = `
      <div class="friends-compact-list">
        ${sorted
          .map((f) => {
            const name = f.displayName || f.alias || f.accountId.slice(0, 8);
            const initial = (name.trim().charAt(0) || "?").toUpperCase();
            const plats = f.platforms
              .map((p) => `<span class="friend-plat ${esc(p)}">${esc(platformLabel(p))}</span>`)
              .join("");
            return `
              <div class="friend-compact-row${f.favorite ? " fav" : ""}">
                <div class="friend-avatar-compact">
                  <span class="friend-avatar-letter">${esc(initial)}</span>
                  ${f.favorite ? `<span class="friend-star-mini">${icon("star", 9)}</span>` : ""}
                </div>
                <div class="friend-info-compact">
                  <span class="friend-name-compact" title="${esc(name)}">${esc(name)}</span>
                  ${f.alias && f.displayName ? `<span class="friend-alias-compact" title="${esc(f.alias)}">${esc(f.alias)}</span>` : ""}
                </div>
                ${plats ? `<div class="friend-plat-badges">${plats}</div>` : ""}
              </div>`;
          })
          .join("")}
      </div>`;
  }

  return `
    <div class="profile-sidebar-card profile-friends-card">
      <div class="profile-sidebar-header">
        <div class="profile-sidebar-title">
          ${icon("users", 13)}
          <h3>${t("friends.title")}</h3>
          ${S.friends.length > 0 ? `<span class="sidebar-badge">${S.friends.length}</span>` : ""}
        </div>
        <button class="apple-pill-btn secondary small ps5-friends-refresh ${S.friendsLoading ? "spinning" : ""}" data-act="refresh-friends" title="${t("friends.refresh")}">
          ${icon("refresh", 11)} <span>${S.friendsLoading ? t("profile.refreshing") : t("friends.refresh")}</span>
        </button>
      </div>
      ${body}
    </div>`;
}

export function renderProfile(): string {
  if (S.profileLoading && !S.playerProfileData) {
    return `
      <div class="profile-container">
        <div class="profile-loading-box">
          <div class="profile-spinner"></div>
          <h3>${t("profile.loadingTitle")}</h3>
          <p>${t("profile.loadingDesc")}</p>
        </div>
      </div>
    `;
  }

  if (S.profileError && !S.playerProfileData) {
    return `
      <div class="profile-container">
        <div class="profile-error-box">
          <div class="profile-error-icon">${icon("info", 32)}</div>
          <h3>${t("profile.errorTitle")}</h3>
          <p>${esc(S.profileError)}</p>
          <button class="btn primary" data-act="refresh-profile">${icon("refresh", 14)} ${t("profile.retry")}</button>
        </div>
      </div>
    `;
  }

  const prof = S.playerProfileData;
  const displayName = prof?.display_name || S.epicAccount || t("profile.player");
  const accountId = prof?.account_id || S.epicAccountId || "";
  const totalXp = prof?.total_xp || 0;
  const totalUnlocked = prof?.total_unlocked || 0;
  const platCount = prof?.platinum_count || 0;

  let totalPlaytimeSec = 0;
  for (const r of S.playtimeMap.values()) {
    totalPlaytimeSec += r.total_seconds || 0;
  }
  const totalPlaytimeStr = fmtPlaytime(totalPlaytimeSec);
  const totalOwnedGames = S.epicSummaries.length;

  const allGames = prof?.games || [];

  // PlayStation four-tier trophy hierarchy counters.
  const goldTrophies = Math.max(platCount * 4, Math.floor(totalUnlocked * 0.08));
  const silverTrophies = Math.max(platCount * 8, Math.floor(totalUnlocked * 0.22));
  const bronzeTrophies = Math.max(0, totalUnlocked - platCount - goldTrophies - silverTrophies);

  const initialLetter = displayName.trim().charAt(0).toUpperCase() || "E";
  const trophyLevel = Math.max(1, Math.floor(totalXp / 1000) + 1);
  const levelXp = totalXp % 1000;
  const levelPct = Math.round((levelXp / 1000) * 100);

  // Cinematic gamer backdrop: top played or platinum game.
  const topPlayed = [...S.playtimeMap.entries()].sort((a, b) => (b[1].total_seconds || 0) - (a[1].total_seconds || 0))[0];
  const topApp = topPlayed?.[0] || allGames.find((g) => g.is_platinum)?.app_name || allGames[0]?.app_name;
  const topSummary = topApp ? S.epicSummariesMap.get(topApp) : null;
  const heroBackdrop = topSummary ? (epicWideArt(topSummary) || topSummary.cover) : "";

  let filteredGames = allGames.filter((g) => {
    if (S.profileFilter === "platinum") {
      return g.is_platinum || g.unlocked_percent >= 100;
    }
    if (S.profileFilter === "in_progress") {
      return g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum;
    }
    if (S.profileFilter === "not_started") {
      return g.unlocked_percent === 0;
    }
    return true;
  });

  if (S.profileSearchQuery.trim()) {
    const q = S.profileSearchQuery.trim().toLowerCase();
    filteredGames = filteredGames.filter(
      (g) => g.app_title.toLowerCase().includes(q) || g.app_name.toLowerCase().includes(q),
    );
  }

  filteredGames.sort((a, b) => {
    if (S.profileSort === "progress") {
      return b.is_platinum !== a.is_platinum
        ? (b.is_platinum ? 1 : -1)
        : b.unlocked_percent !== a.unlocked_percent
          ? b.unlocked_percent - a.unlocked_percent
          : b.total_xp - a.total_xp;
    }
    if (S.profileSort === "xp") {
      return b.total_xp - a.total_xp;
    }
    if (S.profileSort === "playtime") {
      const ptA = S.playtimeMap.get(a.app_name)?.total_seconds || 0;
      const ptB = S.playtimeMap.get(b.app_name)?.total_seconds || 0;
      return ptB - ptA;
    }
    if (S.profileSort === "alpha") {
      return S.trCollator.compare(a.app_title, b.app_title);
    }
    return 0;
  });

  const countAll = allGames.length;
  const countPlat = allGames.filter((g) => g.is_platinum || g.unlocked_percent >= 100).length;
  const countInProgress = allGames.filter(
    (g) => g.unlocked_percent > 0 && g.unlocked_percent < 100 && !g.is_platinum,
  ).length;
  const countNotStarted = allGames.filter((g) => g.unlocked_percent === 0).length;

  return `
    <div class="profile-container ps5-profile-page">
      <!-- 1. Minimalist PS5 Console Hero Stage -->
      <div class="ps5-profile-hero">
        ${heroBackdrop ? `<div class="ps5-hero-backdrop" style="background-image: url('${esc(heroBackdrop)}')"></div>` : ""}
        <div class="ps5-hero-gradient"></div>

        <div class="ps5-hero-content">
          <!-- Left: Gamer Identity -->
          <div class="ps5-hero-left">
            <div class="ps5-avatar-wrap">
              <div class="ps5-avatar">
                <span class="ps5-avatar-letter">${esc(initialLetter)}</span>
              </div>
              <span class="ps5-avatar-pip ${S.offlineMode ? "offline" : "online"}" title="${S.offlineMode ? t("nav.offline") : t("profile.online")}"></span>
            </div>

            <div class="ps5-hero-meta">
              <div class="ps5-hero-name-row">
                <h1 class="ps5-display-name">${esc(displayName)}</h1>
                <span class="ps5-status-badge ${S.offlineMode ? "offline" : "online"}">
                  <span class="status-dot"></span> ${S.offlineMode ? t("profile.offlineMode") : t("profile.connected")}
                </span>
              </div>

              <div class="ps5-hero-sub-row">
                <span class="ps5-sub-item">${icon("gamepad-2", 12)} ${totalOwnedGames} ${t("profile.games")}</span>
                <span class="ps5-sub-dot">•</span>
                <span class="ps5-sub-item">${icon("clock", 12)} ${totalPlaytimeStr}</span>
                <span class="ps5-sub-dot">•</span>
                <button class="ps5-id-btn" data-act="copy-account-id" data-val="${esc(accountId)}" title="${t("profile.copyIdTitle", { id: accountId })}">
                  <span>ID</span>
                  ${icon("copy", 11)}
                </button>
              </div>
            </div>
          </div>

          <!-- Center: Trophy Level Rail -->
          <div class="ps5-hero-center">
            <div class="ps5-level-crest" title="Trophy Level: ${trophyLevel}">
              ${epicPlatinumIcon(13)}
              <span class="ps5-level-num">${t("profile.level")} ${trophyLevel}</span>
              <span class="ps5-level-percent">%${levelPct}</span>
            </div>
            <div class="ps5-level-track">
              <div class="ps5-level-fill" style="width: ${levelPct}%"></div>
            </div>
          </div>

          <!-- Right: 4-Tier Trophy Tiers & Minimal Action -->
          <div class="ps5-hero-right">
            <div class="ps5-trophy-tier-showcase">
              <div class="ps5-tier-col plat" title="${t("profile.platLabel")}">
                <div class="ps5-tier-icon">${epicPlatinumIcon(14)}</div>
                <span class="ps5-tier-count">${platCount}</span>
              </div>

              <div class="ps5-tier-col gold" title="${t("profile.goldLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 14)}</div>
                <span class="ps5-tier-count">${goldTrophies}</span>
              </div>

              <div class="ps5-tier-col silver" title="${t("profile.silverLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 14)}</div>
                <span class="ps5-tier-count">${silverTrophies}</span>
              </div>

              <div class="ps5-tier-col bronze" title="${t("profile.bronzeLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 14)}</div>
                <span class="ps5-tier-count">${bronzeTrophies}</span>
              </div>
            </div>

            <button class="apple-pill-btn secondary small ps5-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${t("profile.refreshTitle")}">
              ${icon("refresh", 12)} <span>${S.profileLoading ? t("profile.refreshing") : t("profile.refresh")}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 2. Two-Column Master Layout (Xbox & Steam Style) -->
      <div class="profile-body-split">
        <!-- Left Main Column (~68%) -->
        <div class="profile-main-col">
          ${renderFeaturedGameShowcase()}

          <!-- Xbox-style Achievements & Games Progress Section -->
          <div class="profile-games-section">
            <div class="profile-games-header">
              <div class="profile-games-title-group">
                <div class="profile-title-left">
                  <h2 class="profile-section-title">${t("profile.sectionTitle")}</h2>
                  <span class="profile-section-badge">${filteredGames.length} ${t("profile.games")}</span>
                </div>
              </div>

              <div class="profile-toolbar">
                <div class="apple-segmented-rail profile-seg-rail">
                  <button class="apple-segment ${S.profileFilter === "all" ? "active" : ""}" data-act="profile-filter" data-val="all">
                    <span>${t("profile.filterAll")}</span> <span class="segment-cnt">${countAll}</span>
                  </button>
                  <button class="apple-segment ${S.profileFilter === "platinum" ? "active plat" : ""}" data-act="profile-filter" data-val="platinum">
                    ${epicPlatinumIcon(11)} <span>${t("profile.filterPlatinum")}</span> <span class="segment-cnt">${countPlat}</span>
                  </button>
                  <button class="apple-segment ${S.profileFilter === "in_progress" ? "active" : ""}" data-act="profile-filter" data-val="in_progress">
                    <span>${t("profile.filterInProgress")}</span> <span class="segment-cnt">${countInProgress}</span>
                  </button>
                  <button class="apple-segment ${S.profileFilter === "not_started" ? "active" : ""}" data-act="profile-filter" data-val="not_started">
                    <span>${t("profile.filterNotStarted")}</span> <span class="segment-cnt">${countNotStarted}</span>
                  </button>
                </div>

                <div class="profile-toolbar-right">
                  <div class="apple-search-box profile-search-box">
                    <span class="profile-search-icon">${icon("search", 13)}</span>
                    <input
                      type="text"
                      id="profile-search"
                      class="profile-search-input"
                      placeholder="${t("profile.searchPlaceholder")}"
                      value="${esc(S.profileSearchQuery)}"
                    />
                    ${S.profileSearchQuery ? `<button class="apple-search-clear" data-act="profile-search-clear">${icon("x", 12)}</button>` : ""}
                  </div>

                  <div class="profile-sort-capsule">
                    <select id="profile-sort-select" class="apple-select" data-act="profile-sort-change">
                      <option value="progress" ${S.profileSort === "progress" ? "selected" : ""}>${t("profile.sortProgress")}</option>
                      <option value="xp" ${S.profileSort === "xp" ? "selected" : ""}>${t("profile.sortXp")}</option>
                      <option value="playtime" ${S.profileSort === "playtime" ? "selected" : ""}>${t("profile.sortPlaytime")}</option>
                      <option value="alpha" ${S.profileSort === "alpha" ? "selected" : ""}>${t("profile.sortAlpha")}</option>
                    </select>
                    <span class="profile-sort-arrow">${icon("chevron-down", 11)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div id="profile-games-grid" class="profile-games-list xbox-games-list">
              ${renderProfileGrid(filteredGames)}
            </div>
          </div>
        </div>

        <!-- Right Sidebar Column (~32%) -->
        <div class="profile-sidebar-col">
          ${renderXboxRecentGrid()}
          ${renderFriendsSection()}
        </div>
      </div>
    </div>
  `;
}
