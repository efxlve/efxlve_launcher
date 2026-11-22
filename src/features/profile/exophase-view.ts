/**
 * Exophase tab: the read-only cross-platform mirror of the profile.
 *
 * The launcher profile stays authoritative for Steam/Epic; this tab only reads
 * the public Exophase profile, never feeds its totals back into the local
 * profile and never writes to Exophase. The service explains that Exophase is
 * an independent third-party service in the note at the bottom.
 */

import { emptyState, epicPlatinumIcon, icon, type IconName } from "../../core/icons";
import { rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { cachedSteamCover, steamCdnPortrait } from "../../core/steam-art-cache";
import { esc, fmtDecimal1, fmtPlaytime } from "../../core/utils";
import { epicPortrait } from "../../epic-model";
import { currentLanguage, t } from "../../i18n";
import { storeLogo } from "../store/store-logos";
import { EXOPHASE_SITE, type ExophaseAward, type ExophaseData, type ExophaseGame, type ExophaseSummary } from "../../exophase";

function fmtCount(value: number): string {
  return value.toLocaleString();
}

function fmtExoDate(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(currentLanguage(), {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts * 1000);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notif.justNow");
  if (mins < 60) return t("notif.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notif.hoursAgo", { n: hours });
  return t("notif.daysAgo", { n: Math.floor(hours / 24) });
}

/** `Nov 18, 2026, 4:35 pm` drops its time so the game name keeps the room. */
function shortEarned(value: string): string {
  return value.replace(/,\s*\d{1,2}:\d{2}(?:\s*(?:am|pm))?\s*$/i, "");
}

function errorText(code: string): string {
  const raw = code.toLowerCase();
  if (raw.includes("not_configured")) return t("profile.exophaseErrNotConfigured");
  if (raw.includes("blocked")) return t("profile.exophaseErrBlocked");
  if (raw.includes("not_found")) return t("profile.exophaseErrNotFound");
  if (raw.includes("network")) return t("profile.exophaseErrNetwork");
  return t("profile.exophaseErrGeneric");
}

/** A numeric player id has no username page; the site home is the honest link. */
function profileUrlFor(username: string): string {
  const trimmed = username.trim();
  return /^\d+$/.test(trimmed)
    ? EXOPHASE_SITE
    : `${EXOPHASE_SITE}user/${encodeURIComponent(trimmed)}/`;
}

function platformLogo(slug: string): string {
  const norm = (slug || "").toLowerCase().trim();
  if (norm === "origin" || norm === "ea" || norm === "electronicarts" || norm === "electronic-arts") return storeLogo("ea", 14, "profile-store-chip-logo");
  if (norm === "steam") return storeLogo("steam", 14, "profile-store-chip-logo");
  if (norm === "epic") return storeLogo("epic", 14, "profile-store-chip-logo");
  if (norm === "xbox" || norm === "xboxnetwork" || norm === "xboxlive") return storeLogo("xbox", 14, "profile-store-chip-logo");
  if (norm === "gog") return storeLogo("gog", 14, "profile-store-chip-logo");
  if (norm === "uplay" || norm === "ubisoft") return storeLogo("ubisoft", 14, "profile-store-chip-logo");
  if (norm === "battlenet" || norm === "blizzard") return storeLogo("battlenet", 14, "profile-store-chip-logo");
  if (norm === "psn" || norm === "playstation") return icon("globe", 14, "profile-store-chip-logo");
  if (norm === "nintendo" || norm === "switch") return icon("gamepad-2", 14, "profile-store-chip-logo");
  return icon("globe", 14, "profile-store-chip-logo");
}

function heroServiceLabel(slug: string, rawLabel: string): string {
  const norm = (slug || "").toLowerCase().trim();
  if (norm === "origin" || norm === "ea") return "EA";
  if (norm === "steam") return "Steam";
  if (norm === "epic") return "Epic Games";
  if (norm === "psn" || norm === "playstation") return "PlayStation";
  if (norm === "xbox") return "Xbox";
  if (norm === "gog") return "GOG";
  if (norm === "ubisoft" || norm === "uplay") return "Ubisoft";
  if (norm === "battlenet" || norm === "blizzard") return "Battle.net";
  if (norm === "nintendo" || norm === "switch") return "Nintendo";
  return rawLabel || slug;
}

function exophaseStoreChip(slug: string): string {
  const norm = (slug || "").toLowerCase().trim();
  let storeId = norm;
  let code = norm.slice(0, 5).toUpperCase();
  if (norm === "steam") {
    storeId = "steam";
    code = "STEAM";
  } else if (norm === "epic") {
    storeId = "epic";
    code = "EPIC";
  } else if (norm === "origin" || norm === "ea" || norm === "electronicarts" || norm === "electronic-arts") {
    storeId = "ea";
    code = "EA";
  } else if (norm === "xbox" || norm === "xboxnetwork" || norm === "xboxlive") {
    storeId = "xbox";
    code = "XBOX";
  } else if (norm === "gog") {
    storeId = "gog";
    code = "GOG";
  } else if (norm === "ubisoft" || norm === "uplay") {
    storeId = "ubisoft";
    code = "UBI";
  } else if (norm === "battlenet" || norm === "blizzard") {
    storeId = "battlenet";
    code = "BNET";
  } else if (norm === "psn" || norm === "playstation") {
    return `<span class="profile-store-chip">${icon("globe", 12)}<span>PSN</span></span>`;
  } else if (norm === "nintendo" || norm === "switch") {
    return `<span class="profile-store-chip">${icon("gamepad-2", 12)}<span>SWTCH</span></span>`;
  }
  return `<span class="profile-store-chip">${storeLogo(storeId, 12)}<span>${code}</span></span>`;
}

interface LocalCoverInfo {
  cover: string;
  isSteam: boolean;
  appId?: string;
}

function coverForApp(appName: string, fallback = ""): string {
  const custom = S.customCovers[appName];
  if (custom) return custom;
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    if (/^\d+$/.test(appId)) {
      const cached = cachedSteamCover(appId);
      return cached || steamCdnPortrait(appId);
    }
  }
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
}

function findLocalGameKey(title: string): string | null {
  if (!title) return null;
  const cleanTitle = title.trim().toLowerCase();
  for (const [key, item] of S.allGamesMap.entries()) {
    if (item.title && item.title.trim().toLowerCase() === cleanTitle) {
      return key;
    }
  }
  const normTitle = cleanTitle.replace(/[\u2122\u00ae\u00a9]/g, "").replace(/\s+/g, " ");
  for (const [key, item] of S.allGamesMap.entries()) {
    if (item.title) {
      const norm = item.title.toLowerCase().replace(/[\u2122\u00ae\u00a9]/g, "").replace(/\s+/g, " ");
      if (norm === normTitle) return key;
    }
  }
  return null;
}

function findLocalPortraitCover(game: ExophaseGame): LocalCoverInfo {
  const localKey = findLocalGameKey(game.title);
  if (localKey) {
    const isSteam = localKey.startsWith("steam::");
    const appId = isSteam ? localKey.slice(7) : undefined;
    const cov = coverForApp(localKey);
    if (cov) {
      return { cover: cov, isSteam, appId };
    }
  }
  return { cover: game.cover || game.hero || "", isSteam: false };
}

function stat(glyph: string, label: string, value: string, sub = "", platinum = false): string {
  return `<div class="profile-stat${platinum ? " is-plat-stat" : ""}">
    <span class="profile-stat-icon" aria-hidden="true">${glyph}</span>
    <span class="profile-stat-text">
      <span class="profile-stat-label">${esc(label)}</span>
      <span class="profile-stat-val tabular-nums"><span>${esc(value)}</span>${sub ? `<span class="profile-stat-sub">${esc(sub)}</span>` : ""}</span>
    </span>
  </div>`;
}

function note(): string {
  return `<div class="profile-exophase-note">
    <p>${esc(t("profile.exophaseDisclaimer"))}</p>
  </div>`;
}

function point(name: IconName, label: string): string {
  return `<div class="profile-exophase-point">${icon(name, 15)}<span>${esc(label)}</span></div>`;
}

function points(): string {
  return `<div class="profile-exophase-points">
    ${point("globe", "PlayStation · Xbox · Switch · GOG")}
    ${point("trophy", t("profile.exophasePointProgress"))}
    ${point("clock", t("profile.unlocksTitle"))}
  </div>`;
}

/** The unconfigured state: a compact hero, the connect row, what you get and the note. */
function connectView(): string {
  return `
    <section class="card profile-hero profile-exophase-hero">
      <div class="profile-exophase-hero-stage is-plain">
        <div class="profile-hero-bottom">
          <div class="profile-avatar-wrap">
            <span class="profile-avatar profile-avatar-lg profile-exophase-avatar" aria-hidden="true">${icon("globe", 32)}</span>
          </div>
          <div class="profile-hero-identity">
            <div class="profile-hero-title-group">
              <div class="profile-name-row">
                <h1 class="profile-name">Exophase</h1>
                <span class="profile-exophase-pill"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t("accounts.notConnected"))}</span>
              </div>
              <p class="profile-exophase-sub">${esc(t("profile.exophaseSubtitle"))}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="profile-exophase-hero-body">
        <div class="profile-exophase-connect-copy">
          <h2 class="profile-exophase-connect-title">${esc(t("profile.exophaseConnectTitle"))}</h2>
          <p class="profile-exophase-connect-desc">${esc(t("profile.exophaseConnectDesc"))}</p>
        </div>
        <button type="button" class="btn primary" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>
      </div>
    </section>
    ${points()}
    ${note()}`;
}

function profileHero(
  name: string,
  username: string,
  avatar: string,
  hero: string,
  stats: string,
  loading: boolean,
  profileUrl: string,
  connected: boolean,
  summary?: ExophaseSummary,
  selectedService = "all",
): string {
  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" loading="lazy" decoding="async" />`
    : icon("globe", 32);
  const handle = username ? `@${username}` : "Exophase";
  const art = hero
    ? `<div class="profile-exophase-hero-backdrop" style="background-image:url('${esc(hero)}')" aria-hidden="true"></div>
       <div class="profile-exophase-hero-art" style="background-image:url('${esc(hero)}')" aria-hidden="true"></div>
       <div class="profile-exophase-hero-scrim" aria-hidden="true"></div>`
    : "";

  const storesHtml = summary?.services?.filter((s) => s.games > 0)
    ? `<div class="profile-hero-stores">
        <button type="button" class="profile-hero-store-chip${selectedService === "all" ? " selected" : ""}" data-act="exophase-service" data-val="all" title="${esc(t("profile.filterAll"))}">
          ${icon("layers", 13, "profile-store-chip-logo")}
          <span class="profile-hero-chip-name">${esc(t("profile.filterAll"))}</span>
          <span class="profile-hero-chip-count tabular-nums">${fmtCount(summary.totalGames)}</span>
        </button>
        ${summary.services
          .filter((s) => s.games > 0)
          .map(
            (s) => `
            <button type="button" class="profile-hero-store-chip${selectedService === s.slug ? " selected" : ""}" data-act="exophase-service" data-val="${esc(s.slug)}" title="${esc(heroServiceLabel(s.slug, s.label))}">
              ${platformLogo(s.slug)}
              <span class="profile-hero-chip-name">${esc(heroServiceLabel(s.slug, s.label))}</span>
              <span class="profile-hero-chip-count tabular-nums">${fmtCount(s.games)}</span>
            </button>`,
          )
          .join("")}
       </div>`
    : "";

  return `<section class="card profile-hero profile-exophase-hero">
    <div class="profile-exophase-hero-stage${hero ? " has-art" : " is-plain"}">
      ${art}
      <div class="profile-hero-top-bar">
        <div class="profile-hero-actions">
          <button type="button" class="btn small profile-hero-tool profile-exophase-refresh${loading ? " is-busy" : ""}" data-act="exophase-refresh" title="${esc(t("profile.exophaseRefresh"))}" aria-label="${esc(t("profile.exophaseRefresh"))}">${icon("refresh", 13)}<span>${esc(t("profile.retry"))}</span></button>
          <button type="button" class="btn small profile-hero-tool" data-act="open-external-url" data-url="${esc(profileUrl)}">${icon("external", 12)}<span>Exophase</span></button>
        </div>
      </div>
      <div class="profile-hero-bottom">
        <div class="profile-avatar-wrap">
          <span class="profile-avatar profile-avatar-lg profile-exophase-avatar" aria-hidden="true">${avatarHtml}</span>
        </div>
        <div class="profile-hero-identity">
          <div class="profile-hero-title-group">
            <div class="profile-name-row">
              <h1 class="profile-name">${esc(name)}</h1>
              <span class="profile-exophase-pill${connected ? " is-connected" : ""}"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t(connected ? "settings.connected" : "accounts.notConnected"))}</span>
            </div>
            <p class="profile-exophase-sub">${esc(handle)}</p>
          </div>
          ${storesHtml ? `<div class="profile-scope-bar">${storesHtml}</div>` : ""}
        </div>
      </div>
    </div>
    ${stats ? `<div class="profile-stats profile-exophase-stats">${stats}</div>` : ""}
  </section>`;
}

function metaLine(summary: ExophaseSummary): string {
  const syncDate = summary.lastSync ? fmtExoDate(summary.lastSync) : "";
  const sync = syncDate ? `${t("profile.exophaseSync")}: ${syncDate}` : "";
  const updated = summary.fetchedAt
    ? t("profile.exophaseUpdated", { when: relativeTime(summary.fetchedAt) })
    : "";
  return `<div class="profile-exophase-meta-card">
    <div class="profile-exophase-meta-left">
      ${sync ? `<span class="profile-exophase-meta-item">${icon("calendar", 13)}<span>${esc(sync)}</span></span>` : ""}
      <span class="profile-exophase-hint">(${esc(t("profile.exophaseSyncHint"))})</span>
    </div>
    <div class="profile-exophase-meta-right">
      ${updated ? `<span class="profile-exophase-meta-item">${icon("clock", 13)}<span class="profile-exophase-updated">${esc(updated)}</span></span>` : ""}
    </div>
  </div>`;
}

function gameCard(game: ExophaseGame): string {
  const percent = Math.round(game.percent);
  const total = game.totalAwards;
  const earned = game.earnedAwards;
  const count = total > 0 ? `${earned} / ${total}` : `${earned}`;
  const playtime = game.playtimeMinutes > 0 ? fmtPlaytime(game.playtimeMinutes * 60) : "";
  const isComplete = percent >= 100 || (total > 0 && earned >= total);
  const tip = `${game.title} · ${game.platform} · ${percent}%${playtime ? ` · ${playtime}` : ""}`;
  const action = game.url
    ? ` data-act="open-external-url" data-url="${esc(game.url)}"`
    : "";

  const { cover, isSteam, appId } = findLocalPortraitCover(game);
  const steamAttrs = isSteam && appId && /^\d+$/.test(appId)
    ? ` data-steam-app="${appId}" data-art-step="${cachedSteamCover(appId) ? "resolved" : "0"}"`
    : "";

  return `
    <div class="profile-ach-card profile-exophase-card${isComplete ? " is-plat" : ""}" role="button" tabindex="0"${action} title="${esc(tip)}">
      <div class="profile-ach-art">
        ${cover
          ? `<img${steamAttrs} src="${esc(cover)}" alt="" loading="lazy" decoding="async" />`
          : `<span class="profile-ach-ph">${icon("gamepad-2", 24)}</span>`
        }
        ${isComplete
          ? `<span class="profile-ach-badge plat" title="${t("profile.filterPlatinum")}">${epicPlatinumIcon(13)}<span>100%</span></span>`
          : total > 0 && percent > 0
            ? `<span class="profile-ach-badge pct tabular-nums">${percent}%</span>`
            : ""
        }
        <span class="profile-ach-badge store">${exophaseStoreChip(game.platformSlug)}</span>
      </div>
      ${total > 0
        ? `<div class="profile-ach-bar${isComplete ? " is-plat-bar" : ""}"><span style="width:${Math.min(100, Math.max(0, percent))}%"></span></div>`
        : `<div class="profile-ach-bar is-empty"></div>`
      }
      <div class="profile-ach-info">
        <div class="profile-ach-title-line">
          <span class="profile-ach-title">${esc(game.title)}</span>
        </div>
        <div class="profile-ach-meta-row tabular-nums">
          <span class="profile-ach-count">${icon("trophy", 11)}<span>${esc(count)}</span></span>
          ${playtime ? `<span class="profile-ach-sub-right">${esc(playtime)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

export function getExophaseGamesGridHtml(data: ExophaseData, selected: string): { count: string; html: string } {
  const q = (S.exophaseSearchQuery || "").trim().toLowerCase();
  const sort = S.exophaseSort || "recent";

  let list = selected === "all" ? data.games : data.games.filter((game) => game.platformSlug === selected);

  if (q) {
    list = list.filter((g) => g.title.toLowerCase().includes(q) || g.platform.toLowerCase().includes(q));
  }

  const sorted = [...list].sort((a, b) => {
    if (sort === "progress") {
      return b.percent !== a.percent ? b.percent - a.percent : b.lastPlayed - a.lastPlayed;
    }
    if (sort === "trophies") {
      return b.earnedAwards !== a.earnedAwards ? b.earnedAwards - a.earnedAwards : b.percent - a.percent;
    }
    if (sort === "playtime") {
      return b.playtimeMinutes !== a.playtimeMinutes ? b.playtimeMinutes - a.playtimeMinutes : b.lastPlayed - a.lastPlayed;
    }
    if (sort === "alpha") {
      return S.trCollator.compare(a.title, b.title);
    }
    // "recent" (default)
    return b.lastPlayed - a.lastPlayed;
  });

  const shown = sorted.slice(0, S.exophaseGameCount || 60);
  const more = sorted.length > shown.length
    ? `<div class="row profile-more"><button type="button" class="btn ghost small" data-act="exophase-show-more">${t("profile.showMore")} (${fmtCount(sorted.length - shown.length)})</button></div>`
    : "";
  const body = shown.length > 0
    ? `<div class="profile-ach-list profile-exophase-grid">${shown.map(gameCard).join("")}${more}</div>`
    : emptyState("gamepad-2", t("profile.exophaseEmptyFilter"));

  return {
    count: fmtCount(sorted.length),
    html: body,
  };
}

export function patchExophaseGamesGrid(): void {
  if (!S.exophaseData) return;
  const summary = S.exophaseData.summary;
  const serviceAvailable = summary.services.some((service) => service.slug === S.exophaseService);
  const selected = serviceAvailable ? S.exophaseService : "all";
  const { count, html } = getExophaseGamesGridHtml(S.exophaseData, selected);
  const countEl = document.getElementById("exophase-games-count");
  if (countEl) countEl.textContent = count;
  const wrap = document.getElementById("exophase-games-grid-wrap");
  if (wrap) {
    wrap.innerHTML = html;
  }
}

function gamesSection(data: ExophaseData, selected: string): string {
  const sort = S.exophaseSort || "recent";
  const { count, html } = getExophaseGamesGridHtml(data, selected);

  return `<section class="profile-row profile-exophase-games">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.games"))}</h3>
        <span id="exophase-games-count" class="profile-row-count tabular-nums">${count}</span>
      </div>
      <div class="profile-exophase-controls">
        <label class="search gp-search profile-exophase-search">
          ${icon("search", 14)}
          <input type="text" id="exophase-search" placeholder="${esc(t("profile.bannerSearchPlaceholder"))}" aria-label="${esc(t("profile.bannerSearchPlaceholder"))}" value="${esc(S.exophaseSearchQuery || "")}" spellcheck="false" autocomplete="off" />
          <button type="button" id="exophase-search-clear-btn" class="profile-search-clear-btn" data-act="exophase-search-clear" title="${esc(t("lib.clearSearch"))}" aria-label="${esc(t("lib.clearSearch"))}"${S.exophaseSearchQuery ? "" : " hidden"}>${icon("x", 12)}</button>
        </label>
        <div class="profile-sort-wrap">
          <select id="exophase-sort-select" class="profile-sort-select" aria-label="${esc(t("ach.sortTitle"))}">
            <option value="recent"${sort === "recent" ? " selected" : ""}>${esc(t("lib.sortRecent"))}</option>
            <option value="progress"${sort === "progress" ? " selected" : ""}>${esc(t("profile.sortProgress"))}</option>
            <option value="trophies"${sort === "trophies" ? " selected" : ""}>${esc(t("profile.trophies"))}</option>
            <option value="playtime"${sort === "playtime" ? " selected" : ""}>${esc(t("profile.sortPlaytime"))}</option>
            <option value="alpha"${sort === "alpha" ? " selected" : ""}>${esc(t("profile.sortAlpha"))}</option>
          </select>
        </div>
      </div>
    </div>
    <div id="exophase-games-grid-wrap">
      ${html}
    </div>
  </section>`;
}

function awardCard(award: ExophaseAward): string {
  const isRare = award.rarity != null && award.rarity < 5;
  const rarityText = award.rarity != null
    ? (currentLanguage() === "tr" ? `%${fmtDecimal1(award.rarity)}` : `${fmtDecimal1(award.rarity)}%`)
    : "";
  const action = award.url
    ? ` data-act="open-external-url" data-url="${esc(award.url)}"`
    : "";
  const art = award.icon
    ? `<img class="profile-unlock-art" src="${esc(award.icon)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="profile-unlock-placeholder">${icon("trophy", 18)}</span>`;
  const rarityBadge = rarityText
    ? `<span class="profile-unlock-badge${isRare ? " is-rare" : ""} tabular-nums">${isRare ? icon("trophy", 10) : ""}<span>${rarityText}</span></span>`
    : "";
  const tip = [award.name, award.game, award.earned, rarityText, award.description]
    .filter(Boolean)
    .join(" · ");
  const earned = shortEarned(award.earned);

  return `<button type="button" class="profile-unlock-card${isRare ? " is-rare-card" : ""}"${action} title="${esc(tip)}">
    <div class="profile-unlock-art-wrap">${art}</div>
    <div class="profile-unlock-main">
      <div class="profile-unlock-top">
        <span class="profile-unlock-title">${esc(award.name)}</span>
      </div>
      <div class="profile-unlock-sub">
        <span class="profile-unlock-game">${esc(award.game)}</span>
        ${earned ? `<span class="profile-unlock-dot" aria-hidden="true">·</span><span class="profile-unlock-date tabular-nums">${esc(earned)}</span>` : ""}
      </div>
    </div>
    ${rarityBadge}
  </button>`;
}

function awardsSection(data: ExophaseData): string {
  if (data.awards.length === 0) return "";
  return `<section class="profile-row profile-exophase-awards">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.unlocksTitle"))}</h3>
        <span class="profile-row-count tabular-nums">${data.awards.length}</span>
      </div>
    </div>
    <div class="profile-unlock-row">${data.awards.map(awardCard).join("")}</div>
  </section>`;
}

function loadedView(data: ExophaseData): string {
  const summary = data.summary;
  const platRatio = summary.totalGames > 0
    ? `${Math.round((summary.completedGames / summary.totalGames) * 100)}% (${summary.completedGames}/${summary.totalGames})`
    : "";
  const stats = [
    stat(icon("gamepad-2", 21), t("profile.games"), fmtCount(summary.totalGames)),
    stat(icon("trophy", 21), t("profile.trophies"), fmtCount(summary.totalAwards)),
    stat(icon("clock", 21), t("profile.played"), summary.playtimeMinutes > 0 ? fmtPlaytime(summary.playtimeMinutes * 60) : "—"),
    stat(epicPlatinumIcon(22), t("profile.statCompleted"), fmtCount(summary.completedGames), platRatio, true),
    ...(summary.rank > 0 ? [stat(icon("globe", 21), t("profile.exophaseRank"), `#${fmtCount(summary.rank)}`)] : []),
  ].join("");

  const serviceAvailable = summary.services.some((service) => service.slug === S.exophaseService);
  const selected = serviceAvailable ? S.exophaseService : "all";
  const lead = [...data.games].sort((left, right) => right.lastPlayed - left.lastPlayed)[0];
  const heroArt = lead?.hero || lead?.cover || "";

  return `
    ${profileHero(summary.displayName || summary.username, summary.username, summary.avatar, heroArt, stats, S.exophaseLoading, summary.profileUrl, true, summary, selected)}
    ${metaLine(summary)}
    ${note()}
    ${awardsSection(data)}
    ${gamesSection(data, selected)}`;
}

function loadingView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", "", true, profileUrlFor(S.exophaseUsername), true)}
    <div class="profile-exophase-loading"><span class="spinner"></span><p>${esc(t("profile.exophaseLoading"))}</p></div>`;
}

function errorView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", "", false, profileUrlFor(S.exophaseUsername), false)}
    ${emptyState(
      "info",
      t("profile.errorTitle"),
      errorText(S.exophaseError),
      `<button type="button" class="btn primary" data-act="exophase-refresh">${esc(t("profile.retry"))}</button>
       <button type="button" class="btn ghost small" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>`,
    )}
    ${note()}`;
}

export function renderExophaseTab(): string {
  if (!S.exophaseConfigured) return connectView();
  if (!S.exophaseData) {
    if (S.exophaseLoading) return loadingView();
    if (S.exophaseError) return errorView();
    return loadingView();
  }
  return loadedView(S.exophaseData);
}
