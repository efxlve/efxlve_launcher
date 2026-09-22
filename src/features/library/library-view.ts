/**
 * Library view: hero spotlight, shelves, portrait/row cards and filtering.
 *
 * Renders the main library page and its progressive chunking observer. Reads
 * shared state (S) and shared game presentation helpers from core; all actions
 * are routed through the global data-act delegation in main.ts.
 */

import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { INITIAL_CARD_CHUNK, MORE_CARD_CHUNK, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { epicWideArt, rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { cleanDisplayVersion, esc, fmtBytes, fmtPlaytime } from "../../core/utils";

import { getThirdPartyLauncher, type EpicSummary } from "../../epic";
import type { EpicFilter, EpicSort } from "../../core/types";
import { t } from "../../i18n";
import { renderFreeGamesShelf } from "../freegames/freegames";
import { renderOnboarding } from "../onboarding/onboarding-view";

/** Sort options shown in the library sort dropdown. */
const sortOptions: {
  id: EpicSort;
  label: string;
  icon: "clock" | "arrow-down-a-z" | "check-circle" | "trophy" | "refresh";
}[] = [
  { id: "recent", label: t("lib.sortRecent"), icon: "clock" },
  { id: "alpha", label: t("lib.sortAlpha"), icon: "arrow-down-a-z" },
  { id: "installed", label: t("lib.sortInstalled"), icon: "check-circle" },
  { id: "platinum", label: t("lib.sortPlatinum"), icon: "trophy" },
  { id: "updates", label: t("lib.sortUpdates"), icon: "refresh" },
];
/** Studio/publisher name for a game (empty when unknown). */
export function studioOf(s: EpicSummary): string {
  const g = rawOf(s.appName);
  const d = g?.metadata?.developer;
  return typeof d === "string" ? d.trim() : "";
}

/** Unique studios with game counts, sorted for the filter dropdown. */
let studiosCache: { key: EpicSummary[]; value: { name: string; count: number }[] } | null = null;
export function epicStudios(): { name: string; count: number }[] {
  // `setEpicSummaries` swaps the array reference, so this invalidates naturally.
  if (studiosCache && studiosCache.key === S.epicSummaries) return studiosCache.value;
  const counts = new Map<string, number>();
  for (const s of S.epicSummaries) {
    const d = studioOf(s);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const value = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => S.trCollator.compare(a.name, b.name));
  studiosCache = { key: S.epicSummaries, value };
  return value;
}

/**
 * Parses the search box into plain terms plus `key:value` operators:
 * `dev:<studio>` and `is:installed|notinstalled|fav|update`.
 */
function parseQuery(q: string): {
  terms: string[];
  dev: string;
  installed: boolean;
  notInstalled: boolean;
  fav: boolean;
  update: boolean;
} {
  const out = { terms: [] as string[], dev: "", installed: false, notInstalled: false, fav: false, update: false };
  for (const tk of q.split(/\s+/)) {
    if (!tk) continue;
    if (tk.startsWith("dev:") || tk.startsWith("studio:")) out.dev = tk.slice(tk.indexOf(":") + 1);
    else if (tk === "is:installed") out.installed = true;
    else if (tk === "is:notinstalled") out.notInstalled = true;
    else if (tk === "is:fav" || tk === "is:favorite") out.fav = true;
    else if (tk === "is:update" || tk === "is:updates") out.update = true;
    else out.terms.push(tk);
  }
  return out;
}

export function epicVisibleSummaries(): EpicSummary[] {
  const q = S.query.trim().toLocaleLowerCase("tr");
  const query = parseQuery(q);
  const activeCol =
    S.activeCollectionId && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav"
      ? S.epicCollections.find((c) => c.id === S.activeCollectionId)
      : null;
  const colSet = activeCol
    ? new Set(activeCol.app_names.map((n) => n.toLowerCase()))
    : null;

  const list = S.epicSummaries.filter((s) => {
    if (S.activeCollectionId === "fav") {
      if (!S.epicFav.has(s.appName)) return false;
    } else if (colSet) {
      if (!colSet.has(s.appName.toLowerCase())) return false;
    }

    if (S.epicFilter === "installed" && !s.installed) return false;
    if (S.epicFilter === "fav" && !S.epicFav.has(s.appName)) return false;
    if (S.epicFilter === "updates" && !s.updateAvailable && !S.availableUpdates.has(s.appName)) return false;
    if (S.epicFilter === "platinum" && !isAppPlatinum(s.appName)) return false;

    const studio = studioOf(s).toLocaleLowerCase("tr");
    if (S.studioFilter && studio !== S.studioFilter.toLocaleLowerCase("tr")) return false;
    if (query.installed && !s.installed) return false;
    if (query.notInstalled && s.installed) return false;
    if (query.fav && !S.epicFav.has(s.appName)) return false;
    if (query.update && !s.updateAvailable && !S.availableUpdates.has(s.appName)) return false;
    if (query.dev && !studio.includes(query.dev)) return false;
    // Plain terms match the title or the studio/publisher.
    const title = s.title.toLocaleLowerCase("tr");
    for (const term of query.terms) {
      if (!title.includes(term) && !studio.includes(term)) return false;
    }
    return true;
  });

  const byTitle = (a: EpicSummary, b: EpicSummary) => S.trCollator.compare(a.title, b.title);

  switch (S.epicSort) {
    case "alpha":
      return [...list].sort(byTitle);
    case "installed":
      return [...list].sort((a, b) => Number(b.installed) - Number(a.installed) || byTitle(a, b));
    case "updates":
      return [...list].sort(
        (a, b) =>
          Number(b.updateAvailable || S.availableUpdates.has(b.appName)) -
            Number(a.updateAvailable || S.availableUpdates.has(a.appName)) ||
          byTitle(a, b),
      );
    case "platinum":
      return [...list].sort(
        (a, b) => Number(isAppPlatinum(b.appName)) - Number(isAppPlatinum(a.appName)) || byTitle(a, b),
      );
    default: {
      const recentIdxMap = new Map<string, number>();
      for (let i = 0; i < S.epicRecent.length; i++) {
        recentIdxMap.set(S.epicRecent[i], i);
      }
      const rank = (s: EpicSummary): number => {
        if (!s.installed) return 999999;
        return recentIdxMap.get(s.appName) ?? 999999;
      };
      return [...list].sort((a, b) => rank(a) - rank(b) || byTitle(a, b));
    }
  }
}

export function getDailyGame(list: EpicSummary[]): EpicSummary | undefined {
  if (list.length === 0) return undefined;
  // Prefer games with wide art so the showcase banner looks cinematic.
  const candidateList = list.filter((s) => !!(epicWideArt(s) || s.cover));
  const pool = candidateList.length > 0 ? candidateList : list;

  const now = new Date();
  const seedStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const index = hash % pool.length;
  return pool[index];
}

/**
 * Warms the LCP hero image(s) before the (potentially large) library DOM string
 * is built, so the download overlaps with rendering instead of starting after it.
 */
export function preloadLibraryHero(): void {
  const urls = new Set<string>();
  const recentInstalled = S.epicRecent
    .map((id) => S.epicSummariesMap.get(id))
    .find((s) => s?.installed);
  if (recentInstalled) {
    const u = epicWideArt(recentInstalled) || recentInstalled.cover;
    if (u) urls.add(u);
  }
  if (S.epicViewMode !== "shelves") {
    const daily = getDailyGame(S.epicSummaries);
    if (daily) {
      const u = epicWideArt(daily) || daily.cover;
      if (u) urls.add(u);
    }
  }
  for (const u of urls) {
    const img = new Image();
    img.decoding = "async";
    img.fetchPriority = "high";
    img.src = u;
  }
}

export function renderHeroSpotlight(): string {
  if (S.epicSummaries.length === 0 || S.isHeroCollapsed || S.epicViewMode === "shelves") return "";

  // Priority 1: recently played and currently installed.
  const recentPlayed = S.epicRecent.find((id) =>
    S.epicSummaries.some((s) => s.appName === id && s.installed),
  );

  let targetName = "";
  let isRecent = false;
  let isDaily = false;

  if (recentPlayed) {
    targetName = recentPlayed;
    isRecent = true;
  } else {
    // Priority 2: installed favorite.
    const installedFav = S.epicSummaries.find((s) => s.installed && S.epicFav.has(s.appName))?.appName;
    if (installedFav) {
      targetName = installedFav;
    } else {
      // Priority 3: Game of the Day (a game picked specially each day).
      const daily = getDailyGame(S.epicSummaries);
      if (daily) {
        targetName = daily.appName;
        isDaily = true;
      } else {
        targetName = S.epicSummaries[0]?.appName;
      }
    }
  }

  const s = S.epicSummaries.find((x) => x.appName === targetName);
  if (!s) return "";

  const wideImg = epicWideArt(s) || s.cover;
  const g = rawOf(s.appName);
  const devRaw = g?.metadata?.developer;
  const dev = typeof devRaw === "string" ? devRaw : "Epic Games";

  const p = epicDlProgress(s.appName);
  const partner = getThirdPartyLauncher(g);
  const isRunning = S.runningGames.has(s.appName);
  const pt = S.playtimeMap.get(s.appName);
  const primaryBtn =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`
      : isRunning
        ? `<button class="btn primary running" data-id="${s.appName}"><span class="running-dot"></span> ${t("common.playing")}</button>`
        : s.installed
          ? s.updateAvailable || S.availableUpdates.has(s.appName)
            ? `<button class="btn update" data-act="epic-install" data-id="${s.appName}">${icon("download", 15)} ${t("common.update")}</button>`
            : `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 15)} ${t("common.playNow")}</button>`
          : partner
            ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 15)} ${t("common.launchWith", { name: esc(partner.name) })}</button>`
            : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 15)} ${t("common.install")}</button>`;

  const heroBadge = isRecent
    ? `${icon("play", 11)} ${t("lib.recent")}`
    : isDaily
      ? `${icon("sparkles", 11)} ${t("lib.gameOfDay")}`
      : s.installed
        ? `${icon("gamepad-2", 11)} ${t("lib.installedGame")}`
        : S.epicFav.has(s.appName)
          ? `${icon("heart", 11)} ${t("lib.favorite")}`
          : `${icon("star", 11)} ${t("lib.featured")}`;

  return `
    <div class="hero-spotlight">
      ${wideImg ? `<img class="hero-bg" src="${esc(wideImg)}" alt="" decoding="async" fetchpriority="high" />` : ""}
      <div class="hero-gradient"></div>
      <div class="hero-content">
        <div class="hero-main">
          <div class="hero-badge">
            ${heroBadge}
          </div>
          <h1 class="hero-title">${esc(s.title)}</h1>
          <div class="hero-meta">
            <span class="hero-dev">${esc(dev)}</span>
            <span class="hero-meta-sep">•</span>
            <span class="hero-ver">v${esc(s.version)}</span>
            ${s.installed && s.installSize ? `<span class="hero-meta-sep">•</span><span class="hero-size">${fmtBytes(s.installSize)}</span>` : ""}
            ${pt && pt.total_seconds > 0 ? `<span class="hero-meta-sep">•</span><span class="hero-playtime">${icon("clock", 12)} ${fmtPlaytime(pt.total_seconds)}</span>` : ""}
          </div>
          <div class="hero-actions">
            ${primaryBtn}
            <button class="btn ghost hero-detail-btn" data-act="epic-detail" data-id="${s.appName}">${icon("dots", 14)} ${t("lib.details")}</button>
          </div>
        </div>
        ${s.cover ? `
        <div class="hero-showcase-card" data-act="epic-detail" data-id="${s.appName}" title="${t("lib.detailsTip", { name: esc(s.title) })}">
          <img class="hero-showcase-poster" src="${esc(s.cover)}" alt="${esc(s.title)}" loading="lazy" decoding="async" />
          <div class="hero-showcase-overlay">
            <span class="hero-showcase-btn">${icon("dots", 12)} ${t("lib.inspect")}</span>
          </div>
        </div>` : ""}
      </div>
    </div>`;
}

export function epicCardPortrait(s: EpicSummary): string {
  const faved = S.epicFav.has(s.appName);
  const p = epicDlProgress(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
  const isRunning = S.runningGames.has(s.appName);
  const pt = S.playtimeMap.get(s.appName);
  const badge = isRunning
    ? `<span class="pbadge ready" style="background:rgba(16,185,129,0.2);color:#34d399;border-color:rgba(16,185,129,0.5)"><span class="running-dot"></span>${t("lib.running")}</span>`
    : hasUpdate
      ? `<span class="pbadge update"><span class="dot"></span>${t("lib.updateBadge")}</span>`
      : s.installed
        ? `<span class="pbadge ready"><span class="dot"></span>${t("common.installed")}</span>`
        : "";
  const ribbon = isPlat
    ? `<div class="platinum-badge" title="${t("lib.platinumTitle", { name: esc(s.title) })}">${epicPlatinumIcon(18)}</div>`
    : "";
  const dlBar =
    p !== null
      ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${s.appName}" style="width:${p}%"></div></div>`
      : "";

  const microChips: string[] = [];
  if (pt && pt.total_seconds > 0) {
    microChips.push(`<span class="micro-chip playtime">${icon("clock", 10)} ${fmtPlaytime(pt.total_seconds)}</span>`);
  }
  const achSum = S.epicAchSummaries[s.appName];
  if (isPlat) {
    microChips.push(`<span class="micro-chip plat" style="background:rgba(168,85,247,0.18);border-color:rgba(168,85,247,0.38);color:#e9d5ff">${epicPlatinumIcon(11)} ${t("lib.platinum")}</span>`);
  } else if (achSum && achSum.total_achievements > 0) {
    const pct = Math.round((achSum.user_unlocked / achSum.total_achievements) * 100);
    microChips.push(`<span class="micro-chip ach">${icon("trophy", 10)} %${pct}</span>`);
  }

  return `
    <div class="pcard ${isPlat ? "platinum" : ""}" data-act="epic-detail" data-id="${s.appName}" tabindex="0" role="button">
      ${epicArt(s)}
      ${badge}
      ${ribbon}
      <div class="shade"></div>
      <div class="poverlay">
        <div class="top">
          <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("lib.favorite")}">${icon("heart", 14)}</button>
          <button class="iconbtn" data-act="open-custom-cover" data-id="${s.appName}" title="${t("lib.customizeCover")}">${icon("image", 14)}</button>
          <button class="iconbtn" data-act="epic-detail" data-id="${s.appName}" title="${t("lib.detail")}">${icon("dots", 14)}</button>
        </div>
        <div class="bottom">
          <div class="ptitle">${esc(s.title)}</div>
          ${microChips.length > 0 ? `<div class="pcard-micro-hud">${microChips.join("")}</div>` : ""}
          ${epicActionButtons(s, "full")}
        </div>
      </div>
      ${dlBar}
    </div>`;
}

export function epicRowHtml(s: EpicSummary): string {
  const faved = S.epicFav.has(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const achSum = S.epicAchSummaries[s.appName];
  const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
  const isRunning = S.runningGames.has(s.appName);
  const pt = S.playtimeMap.get(s.appName);
  const runTag = isRunning
    ? ` • <span style="color:#34d399;font-weight:700;display:inline-flex;align-items:center;gap:3px"><span class="running-dot"></span> ${t("lib.running")}</span>`
    : "";
  const ptMeta = pt && pt.total_seconds > 0
    ? ` • <span style="color:#38bdf8;display:inline-flex;align-items:center;gap:3px">${icon("clock", 12)} ${fmtPlaytime(pt.total_seconds)}</span>`
    : "";
  const achMeta = isPlat
    ? ` • <span style="color:#c084fc;font-weight:700;display:inline-flex;align-items:center;gap:3px">${epicPlatinumIcon(12)} ${t("lib.platinum")}</span>`
    : achSum && achSum.total_achievements > 0
      ? ` • <span style="color:#a1a1aa;display:inline-flex;align-items:center;gap:3px">${icon("trophy", 12)} ${achSum.user_unlocked}/${achSum.total_achievements}</span>`
      : "";

  return `
    <div class="prow" data-act="epic-detail" data-id="${s.appName}">
      ${epicArt(s)}
      <div class="grow">
        <h4>${esc(s.title)}</h4>
        <div class="meta">v${esc(s.version)}${s.installedVersion ? ` • ${t("lib.installedVersion", { v: esc(cleanDisplayVersion(s.installedVersion).display || s.installedVersion) })}` : ""}${hasUpdate ? ` • <span class="upd">${t("lib.updateBadge")}</span>` : ""}${runTag}${ptMeta}${achMeta}</div>
      </div>
      <button class="iconbtn ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("lib.favorite")}">${icon("heart", 15)}</button>
      ${epicActionButtons(s, "small")}
    </div>`;
}


export function renderShelfHeroCard(s: EpicSummary): string {
  const wideImg = epicWideArt(s) || s.cover;
  const g = rawOf(s.appName);
  const devRaw = g?.metadata?.developer;
  const dev = typeof devRaw === "string" ? devRaw : "Epic Games";
  const p = epicDlProgress(s.appName);
  const partner = getThirdPartyLauncher(g);
  const isRunning = S.runningGames.has(s.appName);
  const pt = S.playtimeMap.get(s.appName);

  const primaryBtn =
    p !== null
      ? `<button class="btn primary small" disabled data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`
      : isRunning
        ? `<button class="btn primary small running" data-id="${s.appName}"><span class="running-dot"></span> ${t("common.playing")}</button>`
        : s.installed
          ? s.updateAvailable || S.availableUpdates.has(s.appName)
            ? `<button class="btn update small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} ${t("common.update")}</button>`
            : `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("play", 13)} ${t("common.play")}</button>`
          : partner
            ? `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${t("lib.launch")}</button>`
            : `<button class="btn primary small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} ${t("common.install")}</button>`;

  return `
    <div class="shelf-hero-card" data-act="epic-detail" data-id="${s.appName}">
      ${wideImg ? `<img class="shelf-hero-bg" src="${esc(wideImg)}" alt="" decoding="async" fetchpriority="high" />` : ""}
      <div class="shelf-hero-gradient"></div>
      <div class="shelf-hero-body">
        <div class="shelf-hero-tag">${icon("play", 10)} ${t("lib.recent")}</div>
        <div class="shelf-hero-title">${esc(s.title)}</div>
        <div class="shelf-hero-meta">
          <span>${esc(dev)}</span>
          ${pt && pt.total_seconds > 0 ? `<span>•</span><span style="color:#38bdf8">${icon("clock", 10)} ${fmtPlaytime(pt.total_seconds)}</span>` : ""}
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px">
          ${primaryBtn}
          <button class="btn ghost small" data-act="epic-detail" data-id="${s.appName}">${icon("dots", 13)} ${t("lib.details")}</button>
        </div>
      </div>
    </div>
  `;
}

/** How many cards a shelf renders before offering "see all". */
const SHELF_PREVIEW = 18;

export function renderShelfSection(
  markerIcon: string,
  title: string,
  items: EpicSummary[],
  opts: { featuredFirst?: boolean; filter?: EpicFilter; collectionId?: string } = {},
): string {
  if (items.length === 0) return "";
  const total = items.length;
  // Cap the DOM: a 500-game shelf would otherwise build thousands of nodes.
  const preview = total > SHELF_PREVIEW ? items.slice(0, SHELF_PREVIEW) : items;
  const firstItem = opts.featuredFirst ? preview[0] : null;
  const restItems = opts.featuredFirst ? preview.slice(1) : preview;

  const seeAll =
    total > SHELF_PREVIEW
      ? `<button class="shelf-see-all" data-act="shelf-see-all" ${opts.filter ? `data-filter="${opts.filter}"` : ""} ${opts.collectionId ? `data-col-id="${esc(opts.collectionId)}"` : ""}>${t("lib.seeAll")} (${total}) ${icon("chevron-right", 12)}</button>`
      : "";

  return `
    <div class="shelf-section">
      <div class="shelf-header">
        <div class="shelf-title-group">
          <span class="shelf-icon">${icon(isCollectionIcon(markerIcon) ? markerIcon : "folder", 15)}</span>
          <h3 class="shelf-title">${esc(title)}</h3>
          <span class="shelf-badge">${total}</span>
        </div>
        <div class="shelf-nav">
          ${seeAll}
          <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="left" title="${t("lib.scrollLeft")}">${icon("chevron-left", 14)}</button>
          <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="right" title="${t("lib.scrollRight")}">${icon("chevron-right", 14)}</button>
        </div>
      </div>
      <div class="shelf-featured-wrap">
        ${firstItem ? renderShelfHeroCard(firstItem) : ""}
        <div class="shelf-row-track">
          ${restItems.map((s) => epicCardPortrait(s)).join("")}
        </div>
      </div>
    </div>
  `;
}

export function renderEpicShelves(): string {
  const visible = epicVisibleSummaries();
  // If search query is active or a single collection/filter is chosen, show focused shelf
  if (S.query.trim() || S.epicFilter !== "all" || (S.activeCollectionId && S.activeCollectionId !== "all")) {
    const activeCol = S.activeCollectionId ? S.epicCollections.find((c) => c.id === S.activeCollectionId) : null;
    const title = S.query.trim()
      ? t("lib.searchResults", { q: S.query.trim() })
      : S.epicFilter === "installed"
        ? t("lib.installedGames")
        : S.epicFilter === "fav"
          ? t("lib.favoritesShelf")
          : S.epicFilter === "platinum"
            ? t("lib.platinumTrophies")
            : S.epicFilter === "updates"
              ? t("lib.updates")
              : activeCol
                ? activeCol.name
                : t("lib.games");

    return `
      <div class="shelf-section">
        <div class="shelf-header">
          <div class="shelf-title-group">
            <span class="shelf-icon">${isCollectionIcon(activeCol?.emoji) ? collectionMarker(activeCol!.emoji, 15) : icon("rows", 15)}</span>
            <h3 class="shelf-title">${esc(title)}</h3>
            <span class="shelf-badge">${visible.length}</span>
          </div>
        </div>
        <div class="pgrid size-${S.epicCardSize}">
          ${visible.map((s) => epicCardPortrait(s)).join("") || `<div class="empty">${t("lib.noGames")}</div>`}
        </div>
      </div>
    `;
  }

  // Steam-Style Standard Shelves
  const sections: string[] = [];

  // 0. Weekly Epic free games
  const freeShelf = renderFreeGamesShelf();
  if (freeShelf) sections.push(freeShelf);

  // 1. Recent shelf
  const recentGames = S.epicRecent
    .map((id) => S.epicSummaries.find((s) => s.appName === id && s.installed))
    .filter((s): s is EpicSummary => !!s);

  if (recentGames.length > 0) {
    sections.push(renderShelfSection("clock", t("lib.recentGames"), recentGames, { featuredFirst: true }));
  }

  // 2. Installed shelf
  const installedGames = S.epicSummaries.filter((s) => s.installed);
  if (installedGames.length > 0) {
    sections.push(renderShelfSection("gamepad-2", t("lib.installedGames"), installedGames, { filter: "installed" }));
  }

  // 3. Favorites shelf
  const favGames = S.epicSummaries.filter((s) => S.epicFav.has(s.appName));
  if (favGames.length > 0) {
    sections.push(renderShelfSection("heart", t("lib.favoritesShelf"), favGames, { filter: "fav" }));
  }

  // 4. Platinum shelf
  const platGames = S.epicSummaries.filter((s) => isAppPlatinum(s.appName));
  if (platGames.length > 0) {
    sections.push(renderShelfSection("trophy", t("lib.platinumGames"), platGames, { filter: "platinum" }));
  }

  // 5. User collections (Set lookup instead of O(N×M) per collection)
  for (const col of S.epicCollections) {
    const colSet = new Set(col.app_names.map((n) => n.toLowerCase()));
    const colGames = S.epicSummaries.filter((s) => colSet.has(s.appName.toLowerCase()));
    if (colGames.length > 0) {
      sections.push(
        renderShelfSection(isCollectionIcon(col.emoji) ? col.emoji : "folder", col.name, colGames, {
          collectionId: col.id,
        }),
      );
    }
  }

  // Fallback if no shelves have content
  if (sections.length === 0) {
    sections.push(renderShelfSection("layout-grid", t("lib.allGames"), S.epicSummaries.slice(0, 30)));
  }

  return `<div class="shelves-container">${sections.join("")}</div>`;
}

export function resetCardChunk(): void {
  S.renderedCardCount = INITIAL_CARD_CHUNK;
}

export function renderEpicItems(): string {
  if (S.epicViewMode === "shelves") {
    return renderEpicShelves();
  }
  const visible = epicVisibleSummaries();
  if (visible.length === 0) {
    return `<div class="empty">${t("lib.noGames")}</div>`;
  }

  const chunk = visible.slice(0, S.renderedCardCount);
  const cardsHtml = chunk.map((s) =>
    S.epicViewMode === "grid" ? epicCardPortrait(s) : epicRowHtml(s)
  ).join("");

  const hasMore = S.renderedCardCount < visible.length;
  const sentinelHtml = hasMore
    ? `<div id="lib-scroll-sentinel" style="height:24px;grid-column:1/-1;width:100%;pointer-events:none;"></div>`
    : "";

  return cardsHtml + sentinelHtml;
}

export function setupLibScrollObserver(): void {
  if (S.libScrollObserver) {
    S.libScrollObserver.disconnect();
    S.libScrollObserver = null;
  }
  if (S.epicViewMode === "shelves") return;

  const sentinel = document.getElementById("lib-scroll-sentinel");
  if (!sentinel) return;

  S.libScrollObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (!entry || !entry.isIntersecting) return;

    const visible = epicVisibleSummaries();
    if (S.renderedCardCount >= visible.length) {
      sentinel.remove();
      S.libScrollObserver?.disconnect();
      S.libScrollObserver = null;
      return;
    }

    const nextSlice = visible.slice(S.renderedCardCount, S.renderedCardCount + MORE_CARD_CHUNK);
    S.renderedCardCount += nextSlice.length;

    const newCardsHtml = nextSlice
      .map((s) => (S.epicViewMode === "grid" ? epicCardPortrait(s) : epicRowHtml(s)))
      .join("");

    sentinel.insertAdjacentHTML("beforebegin", newCardsHtml);

    if (S.renderedCardCount >= visible.length) {
      sentinel.remove();
      S.libScrollObserver?.disconnect();
      S.libScrollObserver = null;
    }
  }, {
    root: viewEl,
    rootMargin: "450px",
  });

  S.libScrollObserver.observe(sentinel);
}

export function renderSkeletonLibrary(): string {
  const skelCards = Array.from({ length: 12 })
    .map(
      () => `
      <div class="pcard skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-badge"></div>
        <div class="skeleton-overlay">
          <div class="skeleton-line skeleton-title"></div>
          <div class="skeleton-line skeleton-sub"></div>
        </div>
      </div>`
    )
    .join("");

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">${t("nav.library")}</h1>
        <div class="skeleton-pill" style="width:120px;height:24px;border-radius:20px;"></div>
      </div>
      <div class="lib-top-actions">
        <div class="skeleton-pill" style="width:75px;height:36px;border-radius:10px;"></div>
        <div class="skeleton-circle" style="width:36px;height:36px;border-radius:10px;"></div>
      </div>
    </div>
    ${!S.isHeroCollapsed ? `
    <div class="skeleton-hero" style="height:240px;margin-bottom:20px;">
      <div class="skeleton-hero-badge"></div>
      <div class="skeleton-hero-title"></div>
      <div class="skeleton-hero-meta"></div>
      <div class="skeleton-hero-actions">
        <div class="skeleton-pill" style="width:110px;height:32px;border-radius:8px;"></div>
        <div class="skeleton-pill" style="width:85px;height:32px;border-radius:8px;"></div>
      </div>
    </div>` : ""}
    <div class="lib-unified-toolbar" style="margin-bottom:18px;">
      <div class="unified-toolbar-left">
        <div class="skeleton-pill" style="width:75px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:85px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:95px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:80px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:110px;height:32px;border-radius:9px;"></div>
      </div>
      <div class="unified-toolbar-right">
        <div class="skeleton-pill" style="width:180px;height:32px;border-radius:9px;"></div>
        <div class="skeleton-pill" style="width:105px;height:32px;border-radius:9px;"></div>
      </div>
    </div>
    <div class="pgrid size-${S.epicCardSize}">${skelCards}</div>`;
}

export function renderEpic(): string {
  if (!isTauri) {
    return `<h2>${icon("zap", 18)} Epic</h2><p class="subtitle">${t("lib.epicIntegration")}</p><div class="empty">${t("lib.desktopOnly")}</div>`;
  }
  if (S.epicPhase === "checking" || (S.epicPhase === "library" && S.epicSummaries.length === 0)) {
    return renderSkeletonLibrary();
  }
  if (S.epicPhase === "setup" || S.epicPhase === "login") {
    return renderOnboarding();
  }
  if (S.epicPhase === "error") {
    return `
      <h2>${t("nav.library")}</h2><p class="subtitle">${t("lib.problem")}</p>
      <div class="settings-box">
        <p><code>${esc(S.epicError)}</code></p>
        <p style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn ghost" data-act="epic-retry">${t("lib.retry")}</button>
          <button class="btn danger" data-act="epic-logout">${t("lib.logoutEpic")}</button>
        </p>
        <p class="muted">${t("lib.logoutHint")}</p>
      </div>`;
  }

  preloadLibraryHero();

  // One pass over the library instead of six separate filter/reduce passes.
  const selectedCol =
    S.activeCollectionId && S.activeCollectionId !== "all" && S.activeCollectionId !== "fav"
      ? S.epicCollections.find((c) => c.id === S.activeCollectionId)
      : null;
  const colSet = selectedCol ? new Set(selectedCol.app_names.map((n) => n.toLowerCase())) : null;
  const favOnly = S.activeCollectionId === "fav";

  let favTotalCount = 0;
  let allInstalledCount = 0;
  let totalInstalledSize = 0;
  let allUpdatesCount = 0;
  let totalColCount = 0;
  let platCount = 0;
  for (const s of S.epicSummaries) {
    if (S.epicFav.has(s.appName)) favTotalCount++;
    if (s.installed) {
      allInstalledCount++;
      totalInstalledSize += s.installSize || 0;
    }
    if (s.updateAvailable || S.availableUpdates.has(s.appName)) allUpdatesCount++;
    if (colSet ? colSet.has(s.appName.toLowerCase()) : favOnly ? S.epicFav.has(s.appName) : true) {
      totalColCount++;
      if (isAppPlatinum(s.appName)) platCount++;
    }
  }

  const isUpdateNewlyAdded = S.prevRenderedUpdatesCount === 0 && allUpdatesCount > 0;
  const isColNewlyChanged = S.prevRenderedColId !== undefined && S.prevRenderedColId !== S.activeCollectionId;
  S.prevRenderedUpdatesCount = allUpdatesCount;
  S.prevRenderedColId = S.activeCollectionId;

  return `
    <div class="lib-top-bar">
      <div class="lib-title-group">
        <h1 class="lib-heading">${t("nav.library")}</h1>
        <div class="lib-heading-stats">
          <span class="stat-dot"></span>
          <span>${t("lib.gameCount", { count: S.epicSummaries.length })}</span>
          <span class="stat-sep">•</span>
          <span style="color:#10b981;font-weight:700">${t("lib.installedCount", { count: allInstalledCount })}</span>
          <span class="stat-sep">•</span>
          <span>${fmtBytes(totalInstalledSize)}</span>
        </div>
      </div>
      <div class="lib-top-actions">
        <button class="lib-toggle-hero-btn ${S.isHeroCollapsed ? "active" : ""}" data-act="toggle-hero-spotlight" title="${S.isHeroCollapsed ? t("lib.heroShowTip") : t("lib.heroHideTip")}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <span>${S.isHeroCollapsed ? t("lib.heroOpen") : t("lib.hero")}</span>
        </button>
        <button class="lib-refresh-btn ${S.epicSyncing ? "spinning" : ""}" data-act="epic-refresh" title="${t("lib.refreshTip")}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
            <path d="M16 21h5v-5"/>
          </svg>
        </button>
      </div>
    </div>

    ${renderHeroSpotlight()}

    <div class="lib-unified-toolbar">
      <div class="unified-toolbar-left">
        <button class="unified-pill ${S.activeCollectionId === null && S.epicFilter === "all" ? "active" : ""}" data-act="quick-tab" data-tab="all">
          <span>${t("library.all")}</span>
          <span class="pill-cnt">${S.epicSummaries.length}</span>
        </button>
        <button class="unified-pill ${S.epicFilter === "installed" ? "active" : ""}" data-act="quick-tab" data-tab="installed">
          <span class="pill-dot installed"></span>
          <span>${t("library.installed")}</span>
          <span class="pill-cnt">${allInstalledCount}</span>
        </button>
        <button class="unified-pill ${S.activeCollectionId === "fav" || S.epicFilter === "fav" ? "active" : ""}" data-act="quick-tab" data-tab="fav">
          <span class="pill-icon">${icon("heart", 13)}</span>
          <span>${t("library.favorites")}</span>
          <span class="pill-cnt">${favTotalCount}</span>
        </button>
        <button class="unified-pill ${S.epicFilter === "platinum" ? "active" : ""}" data-act="quick-tab" data-tab="platinum">
          <span class="pill-icon">${epicPlatinumIcon(13)}</span>
          <span>${t("library.platinum")}</span>
          <span class="pill-cnt">${platCount}</span>
        </button>
        ${allUpdatesCount > 0 ? `
        <button class="unified-pill ${isUpdateNewlyAdded ? "pill-dynamic" : ""} ${S.epicFilter === "updates" ? "active" : ""}" data-act="quick-tab" data-tab="updates">
          <span class="pill-icon">${icon("zap", 13)}</span>
          <span>${t("library.updates")}</span>
          <span class="pill-cnt">${allUpdatesCount}</span>
        </button>` : ""}

        <div class="col-dropdown-container">
          ${selectedCol ? `
          <button class="unified-pill col-btn active ${isColNewlyChanged ? "pill-dynamic" : ""}" data-act="toggle-col-dropdown" title="${t("lib.collectionSelected", { name: esc(selectedCol.name) })}">
            ${isCollectionIcon(selectedCol.emoji) ? `<span class="col-pill-marker">${collectionMarker(selectedCol.emoji, 13)}</span>` : icon("folder", 13)}
            <span class="col-btn-name">${esc(selectedCol.name)}</span>
            <span class="pill-cnt">${totalColCount}</span>
            <span class="col-clear-btn" data-act="clear-collection" title="${t("lib.clearCollection")}">${icon("x", 11)}</span>
          </button>` : `
          <button class="unified-pill col-btn ${isColNewlyChanged ? "pill-dynamic" : ""}" data-act="toggle-col-dropdown" title="${t("lib.collections")}">
            ${icon("folder", 13)}
            <span>${t("lib.collections")}</span>
            ${S.epicCollections.length > 0 ? `<span class="pill-cnt">${S.epicCollections.length}</span>` : ""}
            <span class="dropdown-chevron">${icon("chevron-down", 12)}</span>
          </button>`}

          <div id="col-dropdown-menu" class="col-dropdown-menu ${S.isColDropdownOpen ? "show" : ""}">
            <div class="col-menu-header">${t("lib.collections")}</div>
            <div class="col-menu-list">
              ${S.epicCollections.length === 0 ? `<div style="padding:10px;font-size:12px;color:var(--muted);text-align:center">${t("lib.noCollections")}</div>` : ""}
              ${S.epicCollections.map((col) => {
                const colSet = new Set(col.app_names.map((n) => n.toLowerCase()));
                const count = S.epicSummaries.reduce((n, s) => n + (colSet.has(s.appName.toLowerCase()) ? 1 : 0), 0);
                const isAct = S.activeCollectionId === col.id;
                return `
                <div class="col-menu-item-row ${isAct ? "selected" : ""}">
                  <button class="col-menu-item-btn" data-act="select-collection" data-col-id="${esc(col.id)}">
                    ${isCollectionIcon(col.emoji) ? `<span class="col-menu-marker">${collectionMarker(col.emoji, 13)}</span>` : `<span class="col-menu-dot"></span>`}
                    <span class="col-menu-name">${esc(col.name)}</span>
                    <span class="col-menu-count">${count}</span>
                  </button>
                  <button class="col-menu-edit-btn" data-act="edit-collection" data-col-id="${esc(col.id)}" title="${t("lib.editCollection", { name: esc(col.name) })}">
                    ${icon("edit", 12)}
                  </button>
                </div>`;
              }).join("")}
            </div>
            <div class="col-menu-footer">
              <button class="col-menu-action-btn" data-act="open-new-collection-modal">
                ${icon("folder", 13)}
                <span>${t("lib.newCollection")}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="unified-toolbar-right">
        ${(() => {
          const studios = epicStudios();
          if (studios.length === 0) return "";
          return `
        <div class="studio-filter-wrap" title="${t("lib.studioFilterTip")}">
          <span class="studio-filter-icon">${icon("users", 13)}</span>
          <select id="studio-filter" class="studio-filter-select">
            <option value="">${t("lib.allStudios")}</option>
            ${studios
              .map(
                (st) =>
                  `<option value="${esc(st.name)}" ${S.studioFilter === st.name ? "selected" : ""}>${esc(st.name)} (${st.count})</option>`,
              )
              .join("")}
          </select>
        </div>`;
        })()}
        <label class="unified-search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="search" type="search" placeholder="${t("lib.searchPlaceholder")}" value="${esc(S.query)}" autocomplete="off" spellcheck="false" />
          <span class="search-shortcut">Ctrl+F</span>
        </label>
        ${(() => {
          const currentSortOpt = sortOptions.find((o) => o.id === S.epicSort) || sortOptions[0];
          return `
        <div class="sort-dropdown-container">
          <button class="unified-pill sort-btn" data-act="toggle-sort-dropdown" title="${t("lib.sortTip", { label: esc(currentSortOpt.label) })}">
            ${icon(currentSortOpt.icon, 13)}
            <span class="sort-btn-label">${esc(currentSortOpt.label)}</span>
            <span class="dropdown-chevron">${icon("chevron-down", 12)}</span>
          </button>
          <div id="sort-dropdown-menu" class="sort-dropdown-menu ${S.isSortDropdownOpen ? "show" : ""}">
            <div class="sort-menu-header">${t("lib.sort")}</div>
            <div class="sort-menu-list">
              ${sortOptions.map((opt) => {
                const isSelected = S.epicSort === opt.id;
                return `
                  <button class="sort-menu-item-btn ${isSelected ? "selected" : ""}" data-act="select-sort" data-sort="${opt.id}">
                    <span class="sort-menu-item-icon">${icon(opt.icon, 13)}</span>
                    <span class="sort-menu-item-name" style="flex:1">${esc(opt.label)}</span>
                    ${isSelected ? icon("check", 12) : ""}
                  </button>
                `;
              }).join("")}
            </div>
          </div>
        </div>`;
        })()}
        <div class="card-size-toggle" title="${t("lib.cardSize")}">
          <button class="${S.epicCardSize === "compact" ? "active" : ""}" data-act="epic-size" data-val="compact" title="${t("lib.sizeSmall")}">S</button>
          <button class="${S.epicCardSize === "normal" ? "active" : ""}" data-act="epic-size" data-val="normal" title="${t("lib.sizeNormal")}">M</button>
          <button class="${S.epicCardSize === "large" ? "active" : ""}" data-act="epic-size" data-val="large" title="${t("lib.sizeLarge")}">L</button>
        </div>
        <div class="view-mode-toggle">
          <button class="${S.epicViewMode === "grid" ? "active" : ""}" data-act="epic-view-grid" title="${t("lib.viewGrid")}">${icon("layout-grid", 13)}</button>
          <button class="${S.epicViewMode === "shelves" ? "active" : ""}" data-act="epic-view-shelves" title="${t("lib.viewShelves")}">${icon("rows", 13)}</button>
          <button class="${S.epicViewMode === "list" ? "active" : ""}" data-act="epic-view-list" title="${t("lib.viewList")}">${icon("list", 13)}</button>
        </div>
      </div>
    </div>
    ${S.epicSyncNote ? `<p class="subtitle">${esc(S.epicSyncNote)}</p>` : ""}
    ${S.epicFilter === "platinum" ? `
    <div class="plat-category-banner">
      <div class="plat-banner-glow"></div>
      <div class="plat-banner-icon">${epicPlatinumIcon(32)}</div>
      <div class="plat-banner-info">
        <div class="plat-banner-title">${t("lib.platCollection")}</div>
        <div class="plat-banner-desc">${t("lib.platBannerDesc")}</div>
      </div>
      <div class="plat-banner-stat">
        <div class="val">${platCount}</div>
        <div class="lbl">${t("lib.completed")}</div>
      </div>
    </div>` : ""}
    <div id="lib-results" class="${S.epicViewMode === "grid" ? `pgrid size-${S.epicCardSize}` : S.epicViewMode === "shelves" ? "shelves-container" : ""}">${renderEpicItems()}</div>`;
}


export function updateLibraryFilterInPlace(): boolean {
  if (S.view !== "library") return false;
  const toolbar = document.querySelector(".lib-unified-toolbar");
  const resultsEl = document.getElementById("lib-results");
  if (!toolbar || !resultsEl) return false;

  toolbar.querySelectorAll<HTMLElement>(".unified-pill[data-act='quick-tab']").forEach((pill) => {
    const tab = pill.dataset.tab;
    const isAct =
      tab === "all"
        ? S.activeCollectionId === null && S.epicFilter === "all"
        : tab === "fav"
          ? S.activeCollectionId === "fav" || S.epicFilter === "fav"
          : tab === "installed"
            ? S.epicFilter === "installed"
            : tab === "platinum"
              ? S.epicFilter === "platinum"
              : tab === "updates"
                ? S.epicFilter === "updates"
                : false;
    pill.classList.toggle("active", isAct);
  });

  const platBanner = document.querySelector(".plat-category-banner") as HTMLElement | null;
  if (S.epicFilter === "platinum") {
    if (!platBanner) {
      const platCount = S.epicSummaries.filter((s) => isAppPlatinum(s.appName)).length;
      const bannerHtml = `
        <div class="plat-category-banner">
          <div class="plat-banner-glow"></div>
          <div class="plat-banner-icon">${epicPlatinumIcon(28)}</div>
          <div class="plat-banner-info">
            <div class="plat-banner-title">${t("lib.platCollection")}</div>
            <div class="plat-banner-desc">${t("lib.platBannerDesc")}</div>
          </div>
          <div class="plat-banner-stat">
            <div class="val">${platCount}</div>
            <div class="lbl">${t("lib.completed")}</div>
          </div>
        </div>`;
      resultsEl.insertAdjacentHTML("beforebegin", bannerHtml);
    }
  } else if (platBanner) {
    platBanner.remove();
  }

  resultsEl.className = S.epicViewMode === "grid" ? `pgrid size-${S.epicCardSize}` : S.epicViewMode === "shelves" ? "shelves-container" : "";
  resetCardChunk();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();

  return true;
}
