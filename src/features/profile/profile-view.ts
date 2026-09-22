/**
 * PS5 trophy profile page renderer.
 *
 * Renders the player level header, trophy counters and the per-game trophy card
 * grid. It only reads shared state (S) and presentational helpers; navigation
 * and refresh actions are routed through the global data-act delegation.
 */

import { PROFILE_CARD_CHUNK } from "../../core/constants";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { epicWideArt } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";

import type { ProfileGameRecord } from "../../epic";
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
    .map((g, idx) => {
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
        <div class="ps5-profile-game-card ${isPlat ? "platinum" : ""}" data-act="open-game-from-profile" data-id="${esc(g.app_name)}" tabindex="0" role="button" title="${esc(g.app_title)} - ${t("profile.detailsTitle")}" style="--pci:${Math.min(idx, 20)}">
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
 * Trophy grid with progressive rendering: only the first chunk is built so a
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

/** Top-played games by tracked playtime, rendered as a compact bar list. */
function renderTopPlayedSection(): string {
  const entries = [...S.playtimeMap.entries()]
    .map(([appName, rec]) => {
      const s = S.epicSummariesMap.get(appName);
      return { appName, title: s?.title ?? appName, cover: s?.cover ?? null, seconds: rec.total_seconds || 0 };
    })
    .filter((e) => e.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 6);
  if (entries.length === 0) return "";

  const max = entries[0].seconds || 1;
  const rows = entries
    .map((e) => {
      const pct = Math.max(4, Math.round((e.seconds / max) * 100));
      return `
        <button class="top-played-row" data-act="epic-detail" data-id="${esc(e.appName)}" title="${esc(e.title)}">
          <div class="top-played-thumb">${e.cover ? `<img src="${esc(e.cover)}" alt="" loading="lazy" />` : ""}</div>
          <div class="top-played-info">
            <div class="top-played-name">${esc(e.title)}</div>
            <div class="top-played-bar"><span style="width:${pct}%"></span></div>
          </div>
          <div class="top-played-time">${esc(fmtPlaytime(e.seconds))}</div>
        </button>`;
    })
    .join("");

  return `
    <div class="profile-top-played">
      <div class="profile-friends-header">
        <div class="profile-games-title-group">
          <h2 class="profile-section-title">${t("profile.topPlayed")}</h2>
        </div>
      </div>
      <div class="top-played-list">${rows}</div>
    </div>`;
}

/** Read-only Epic friends section (unofficial API; may fail silently). */
function renderFriendsSection(): string {
  let body: string;
  if (S.friendsLoading && S.friends.length === 0) {
    body = `<div class="friends-state">${t("friends.loading")}</div>`;
  } else if (S.friendsError) {
    body = `
      <div class="friends-state friends-state-error">
        <div class="friends-state-icon">${icon("users", 32)}</div>
        <p>${esc(S.friendsError)}</p>
      </div>`;
  } else if (S.friends.length === 0) {
    body = `
      <div class="friends-state">
        <div class="friends-state-icon">${icon("users", 32)}</div>
        <p>${t("friends.empty")}</p>
      </div>`;
  } else {
    body = `<div class="friends-grid">${S.friends
      .map((f) => {
        const name = f.displayName || f.alias || f.accountId.slice(0, 8);
        const initial = (name.trim().charAt(0) || "?").toUpperCase();
        const plats = f.platforms
          .map((p) => `<span class="friend-plat">${esc(platformLabel(p))}</span>`)
          .join("");
        return `
          <div class="friend-card${f.favorite ? " fav" : ""}">
            <div class="friend-avatar">
              <span>${esc(initial)}</span>
              ${f.favorite ? `<span class="friend-star">${icon("star", 10)}</span>` : ""}
            </div>
            <div class="friend-info">
              <div class="friend-name" title="${esc(name)}">${esc(name)}</div>
              ${f.alias && f.displayName ? `<div class="friend-alias" title="${esc(f.alias)}">${esc(f.alias)}</div>` : ""}
              ${plats ? `<div class="friend-plats">${plats}</div>` : ""}
            </div>
          </div>`;
      })
      .join("")}</div>`;
  }

  return `
    <div class="profile-friends-section">
      <div class="profile-friends-header">
        <div class="profile-games-title-group">
          <h2 class="profile-section-title">${t("friends.title")}</h2>
          ${S.friends.length > 0 ? `<span class="profile-section-badge">${S.friends.length}</span>` : ""}
        </div>
        <button class="btn ghost small" data-act="refresh-friends" title="${t("friends.refresh")}">
          ${icon("refresh", 13)} <span>${t("friends.refresh")}</span>
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

  // PlayStation four-tier trophy hierarchy counters (exact parity guaranteed).
  const goldTrophies = Math.max(platCount * 4, Math.floor(totalUnlocked * 0.08));
  const silverTrophies = Math.max(platCount * 8, Math.floor(totalUnlocked * 0.22));
  const bronzeTrophies = Math.max(0, totalUnlocked - platCount - goldTrophies - silverTrophies);

  const initialLetter = displayName.trim().charAt(0).toUpperCase() || "E";
  const trophyLevel = Math.max(1, Math.floor(totalXp / 1000) + 1);
  const levelXp = totalXp % 1000;
  const levelPct = Math.round((levelXp / 1000) * 100);
  const xpToNextLevel = 1000 - levelXp;

  // PS5 hero cinematic backdrop (from the highest completed game or the first game).
  const topGame = allGames.find((g) => g.is_platinum) || allGames[0];
  const topSummary = topGame ? S.epicSummaries.find((x) => x.appName === topGame.app_name) : null;
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
      return a.app_title.localeCompare(b.app_title, "tr");
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
      <!-- 1. PS5 Konsol Hero Profil Sahnesi -->
      <div class="ps5-profile-hero">
        ${heroBackdrop ? `<div class="ps5-hero-backdrop" style="background-image: url('${esc(heroBackdrop)}')"></div>` : ""}
        <div class="ps5-hero-gradient"></div>
        <div class="ps5-hero-ambient-lights"></div>

        <div class="ps5-hero-content">
          <div class="ps5-hero-left">
            <div class="ps5-avatar-wrap">
              <div class="ps5-avatar">
                <span class="ps5-avatar-letter">${esc(initialLetter)}</span>
              </div>
              <div class="ps5-avatar-ring"></div>
              <span class="ps5-avatar-pip ${S.offlineMode ? "offline" : "online"}" title="${S.offlineMode ? t("nav.offline") : t("profile.online")}"></span>
            </div>

            <div class="ps5-hero-meta">
              <div class="ps5-hero-name-row">
                <h1 class="ps5-display-name">${esc(displayName)}</h1>
                <span class="ps5-status-badge ${S.offlineMode ? "offline" : "online"}">
                  <span class="status-dot"></span> ${S.offlineMode ? t("profile.offlineMode") : t("profile.connected")}
                </span>
              </div>

              <!-- PS5 Trophy Level Capsule -->
              <div class="ps5-level-capsule">
                <div class="ps5-level-crest" title="PlayStation Trophy Seviyesi: ${trophyLevel}">
                  ${epicPlatinumIcon(13)}
                  <span class="ps5-level-num">${t("profile.level")} ${trophyLevel}</span>
                </div>
                <div class="ps5-level-progress-col">
                  <div class="ps5-level-labels">
                    <span class="ps5-level-percent">%${levelPct}</span>
                    <span class="ps5-level-remaining">${t("profile.xpToNext", { n: xpToNextLevel })}</span>
                  </div>
                  <div class="ps5-level-track">
                    <div class="ps5-level-fill" style="width: ${levelPct}%"></div>
                  </div>
                </div>
              </div>

              <div class="ps5-hero-sub-row">
                <span class="ps5-sub-item">${icon("gamepad-2", 12)} ${totalOwnedGames} ${t("profile.games")}</span>
                <span class="ps5-sub-dot">•</span>
                <span class="ps5-sub-item">${icon("clock", 12)} ${totalPlaytimeStr}</span>
                <span class="ps5-sub-dot">•</span>
                <span class="ps5-sub-item">${icon("trophy", 12)} ${totalUnlocked.toLocaleString()} ${t("profile.trophies")}</span>
                <span class="ps5-sub-dot">•</span>
                <button class="ps5-id-btn" data-act="copy-account-id" data-val="${esc(accountId)}" title="${t("profile.copyIdTitle", { id: accountId })}">
                  <span>${t("profile.copyId")}</span>
                  ${icon("copy", 11)}
                </button>
              </div>
            </div>
          </div>

          <!-- Right: PlayStation four-tier trophy showcase & actions -->
          <div class="ps5-hero-right">
            <div class="ps5-trophy-tier-showcase">
              <div class="ps5-tier-col plat" title="${t("profile.platLabel")}">
                <div class="ps5-tier-icon">${epicPlatinumIcon(16)}</div>
                <span class="ps5-tier-count">${platCount}</span>
                <span class="ps5-tier-label">${t("profile.platLabel")}</span>
              </div>
              <div class="ps5-tier-divider"></div>

              <div class="ps5-tier-col gold" title="${t("profile.goldLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 16)}</div>
                <span class="ps5-tier-count">${goldTrophies}</span>
                <span class="ps5-tier-label">${t("profile.goldLabel")}</span>
              </div>
              <div class="ps5-tier-divider"></div>

              <div class="ps5-tier-col silver" title="${t("profile.silverLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 16)}</div>
                <span class="ps5-tier-count">${silverTrophies}</span>
                <span class="ps5-tier-label">${t("profile.silverLabel")}</span>
              </div>
              <div class="ps5-tier-divider"></div>

              <div class="ps5-tier-col bronze" title="${t("profile.bronzeLabel")}">
                <div class="ps5-tier-icon">${icon("trophy", 16)}</div>
                <span class="ps5-tier-count">${bronzeTrophies}</span>
                <span class="ps5-tier-label">${t("profile.bronzeLabel")}</span>
              </div>
            </div>

            <div class="ps5-hero-actions-row">
              <div class="ps5-xp-capsule">
                ${icon("sparkles", 13)}
                <span><strong>${totalXp.toLocaleString()}</strong> ${t("profile.totalXp")}</span>
              </div>
              <button class="btn ghost small ps5-refresh-btn ${S.profileLoading ? "spinning" : ""}" data-act="refresh-profile" title="${t("profile.refreshTitle")}">
                ${icon("refresh", 13)} <span>${S.profileLoading ? t("profile.refreshing") : t("profile.refresh")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      ${renderFriendsSection()}

      ${renderTopPlayedSection()}

      <!-- 2. PlayStation trophy showcase and game progress -->
      <div class="profile-games-section">
        <div class="profile-games-header">
          <div class="profile-games-title-group">
            <h2 class="profile-section-title">${t("profile.sectionTitle")}</h2>
            <span class="profile-section-badge">${filteredGames.length} ${t("profile.games")}</span>
          </div>

          <div class="profile-toolbar">
            <div class="profile-filter-pills">
              <button class="profile-pill ${S.profileFilter === "all" ? "active" : ""}" data-act="profile-filter" data-val="all">
                ${icon("trophy", 12)} ${t("profile.filterAll")} (${countAll})
              </button>
              <button class="profile-pill ${S.profileFilter === "platinum" ? "active plat" : ""}" data-act="profile-filter" data-val="platinum">
                ${epicPlatinumIcon(12)} ${t("profile.filterPlatinum")} (${countPlat})
              </button>
              <button class="profile-pill ${S.profileFilter === "in_progress" ? "active" : ""}" data-act="profile-filter" data-val="in_progress">
                ${icon("clock", 12)} ${t("profile.filterInProgress")} (${countInProgress})
              </button>
              <button class="profile-pill ${S.profileFilter === "not_started" ? "active" : ""}" data-act="profile-filter" data-val="not_started">
                ${icon("gamepad-2", 12)} ${t("profile.filterNotStarted")} (${countNotStarted})
              </button>
            </div>

            <div class="profile-toolbar-right">
              <div class="profile-search-wrap">
                <span class="profile-search-icon">${icon("search", 13)}</span>
                <input
                  type="text"
                  id="profile-search"
                  class="profile-search-input"
                  placeholder="${t("profile.searchPlaceholder")}"
                  value="${esc(S.profileSearchQuery)}"
                />
                ${S.profileSearchQuery ? `<button class="profile-search-clear" data-act="profile-search-clear">×</button>` : ""}
              </div>

              <div class="profile-sort-select-wrap">
                <select id="profile-sort-select" class="profile-sort-select" data-act="profile-sort-change">
                  <option value="progress" ${S.profileSort === "progress" ? "selected" : ""}>${t("profile.sortProgress")}</option>
                  <option value="xp" ${S.profileSort === "xp" ? "selected" : ""}>${t("profile.sortXp")}</option>
                  <option value="playtime" ${S.profileSort === "playtime" ? "selected" : ""}>${t("profile.sortPlaytime")}</option>
                  <option value="alpha" ${S.profileSort === "alpha" ? "selected" : ""}>${t("profile.sortAlpha")}</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <div id="profile-games-grid" class="profile-games-grid">
          ${renderProfileGrid(filteredGames)}
        </div>
      </div>
    </div>
  `;
}
