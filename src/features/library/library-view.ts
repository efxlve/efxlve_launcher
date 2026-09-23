/**
 * Library view: Minimalist PS5 Console Hybrid Architecture (Shelves + Unified Grid).
 *
 * Renders the main library page, horizontal dynamic shelves (Recently Played & Free Games),
 * and the progressive chunking game grid. Reads shared state (S); all actions are
 * routed through the global data-act delegation in click-router.ts.
 */

import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { INITIAL_CARD_CHUNK, MORE_CARD_CHUNK, isTauri } from "../../core/constants";
import { viewEl } from "../../core/dom";
import { epicActionButtons, epicArt, epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { epicWideArt, rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";

import { getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary } from "../../epic";
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
    if (tk.startsWith("dev:") || tk.startsWith("studio:")) out.dev = tk.slice(tk.indexOf(":") + 1).toLowerCase();
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

/** Portrait game card adhering strictly to PS5 Console Dark design standards. */
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
    ? `<div class="platinum-badge" title="${t("lib.platinumTitle", { name: esc(s.title) })}">${epicPlatinumIcon(16)}</div>`
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
    microChips.push(`<span class="micro-chip plat">${epicPlatinumIcon(11)} ${t("lib.platinum")}</span>`);
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

/** Featured wide card for the primary game in a horizontal shelf. */
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
       ? `<button class="btn primary small" data-view="downloads" data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`
      : isRunning
        ? `<button class="btn running small" data-id="${s.appName}"><span class="running-dot"></span> ${t("common.playing")}</button>`
        : s.installed
          ? s.updateAvailable || S.availableUpdates.has(s.appName)
            ? `<button class="btn update small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} ${t("common.update")}</button>`
            : `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("play", 13)} ${t("common.play")}</button>`
          : requiresThirdPartyLauncher(partner)
            ? `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${t("lib.launch")}</button>`
            : `<button class="btn install small" data-act="epic-install" data-id="${s.appName}">${icon("download", 13)} ${t("common.install")}</button>`;

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
  const preview = total > SHELF_PREVIEW ? items.slice(0, SHELF_PREVIEW) : items;
  const firstItem = opts.featuredFirst ? preview[0] : null;
  const restItems = opts.featuredFirst ? preview.slice(1) : preview;

  const seeAll =
    total > SHELF_PREVIEW
      ? `<button class="shelf-see-all" data-act="shelf-see-all" ${opts.filter ? `data-filter="${opts.filter}"` : ""} ${opts.collectionId ? `data-col-id="${esc(opts.collectionId)}"` : ""}>${t("lib.seeAll")} (${total}) ${icon("chevron-right", 12)}</button>`
      : "";

  return `
    <div class="shelf-section size-${S.epicCardSize}">
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

export function resetCardChunk(): void {
  S.renderedCardCount = INITIAL_CARD_CHUNK;
}

/**
 * Renders all user collections as Steam-style categorized shelves.
 * Each collection gets its own horizontal track, count badge, and edit action.
 */
function renderSteamCollectionsView(): string {
  if (S.epicCollections.length === 0) {
    return `
      <div class="empty">
        <div style="font-size:36px;margin-bottom:12px;opacity:0.5">${icon("folder", 40)}</div>
        <div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:6px">${t("lib.noCollections")}</div>
        <div style="font-size:13px;color:#94a3b8;max-width:380px;margin-bottom:16px">${t("col.noCollectionsLong")}</div>
        <button class="btn install" data-act="open-new-collection-modal">${t("col.newCollectionBtn")}</button>
      </div>`;
  }

  const allCategorizedApps = new Set<string>();
  const collectionShelves = S.epicCollections.map((col) => {
    const cSet = new Set(col.app_names.map((n) => n.toLowerCase()));
    for (const name of col.app_names) {
      allCategorizedApps.add(name.toLowerCase());
    }
    const colGames = S.epicSummaries.filter((s) => cSet.has(s.appName.toLowerCase()));
    const marker = isCollectionIcon(col.emoji) ? col.emoji : "folder";
    const editBtn = `
      <button class="shelf-nav-btn" data-act="edit-collection" data-col-id="${esc(col.id)}" title="${t("lib.editCollection", { name: esc(col.name) })}">
        ${icon("edit", 13)}
      </button>`;
    const scrollBtns = colGames.length > 5 ? `
      <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="left" title="${t("lib.scrollLeft")}">${icon("chevron-left", 14)}</button>
      <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="right" title="${t("lib.scrollRight")}">${icon("chevron-right", 14)}</button>
    ` : "";

    return `
      <div class="shelf-section size-${S.epicCardSize}">
        <div class="shelf-header">
          <div class="shelf-title-group">
            <span class="shelf-icon">${icon(marker, 16)}</span>
            <h3 class="shelf-title">${esc(col.name)}</h3>
            <span class="shelf-badge">${colGames.length}</span>
          </div>
          <div class="shelf-nav">
            ${editBtn}
            ${scrollBtns}
          </div>
        </div>
        ${colGames.length > 0
          ? `<div class="shelf-row-track">${colGames.map((s) => epicCardPortrait(s)).join("")}</div>`
          : `<div class="shelf-empty-hint">
               <span>${t("col.noCategory")}</span>
               <button data-act="edit-collection" data-col-id="${esc(col.id)}">${t("col.edit")}</button>
             </div>`
        }
      </div>`;
  }).join("");

  const uncategorized = S.epicSummaries.filter((s) => !allCategorizedApps.has(s.appName.toLowerCase()));
  const uncatShelf = uncategorized.length > 0 ? `
    <div class="shelf-section size-${S.epicCardSize}">
      <div class="shelf-header">
        <div class="shelf-title-group">
          <span class="shelf-icon">${icon("layers", 16)}</span>
          <h3 class="shelf-title">${t("col.noCategory")}</h3>
          <span class="shelf-badge">${uncategorized.length}</span>
        </div>
        <div class="shelf-nav">
          ${uncategorized.length > 5 ? `
            <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="left" title="${t("lib.scrollLeft")}">${icon("chevron-left", 14)}</button>
            <button class="shelf-nav-btn" data-act="shelf-scroll" data-dir="right" title="${t("lib.scrollRight")}">${icon("chevron-right", 14)}</button>
          ` : ""}
        </div>
      </div>
      <div class="shelf-row-track">${uncategorized.map((s) => epicCardPortrait(s)).join("")}</div>
    </div>` : "";

  return `
    <div class="collections-steam-view">
      <div class="col-steam-header">
        <div class="col-steam-header-info">
          <h2 class="col-steam-header-title">
            ${icon("folder", 18)}
            <span>${t("lib.collections")}</span>
            <span class="shelf-badge">${S.epicCollections.length}</span>
          </h2>
          <p class="col-steam-header-desc">${t("col.noCollectionsLong")}</p>
        </div>
        <button class="col-steam-new-btn" data-act="open-new-collection-modal">
          ${icon("folder", 14)}
          <span>${t("lib.newCollection")}</span>
        </button>
      </div>
      ${collectionShelves}
      ${uncatShelf}
    </div>`;
}

/**
 * Renders the library content area using the Hybrid Console Architecture:
 * - Default View (All / no search query): Top shelves (Free Games + Recent Games) + full grid.
 * - Filtered / Search View: Clean, pure, focused Grid of matching games.
 */
export function renderEpicItems(): string {
  if (
    S.epicFilter === "collections" &&
    S.query.trim().length === 0 &&
    (S.activeCollectionId === null || S.activeCollectionId === "all")
  ) {
    return renderSteamCollectionsView();
  }

  const visible = epicVisibleSummaries();
  const isFilteringOrSearching =
    S.query.trim().length > 0 ||
    S.epicFilter !== "all" ||
    (S.activeCollectionId !== null && S.activeCollectionId !== "all");

  if (visible.length === 0) {
    return `<div class="empty">${t("lib.noGames")}</div>`;
  }

  const chunk = visible.slice(0, S.renderedCardCount);
  const cardsHtml = chunk.map((s) => epicCardPortrait(s)).join("");

  const hasMore = S.renderedCardCount < visible.length;
  const sentinelHtml = hasMore
    ? `<div id="lib-scroll-sentinel" style="height:24px;grid-column:1/-1;width:100%;pointer-events:none;"></div>`
    : "";

  // When searching or applying a specific filter, render purely the focused grid.
  if (isFilteringOrSearching) {
    return `
      <div class="pgrid size-${S.epicCardSize}">
        ${cardsHtml}
        ${sentinelHtml}
      </div>`;
  }

  // Default Console Hybrid View: Upper shelves (Free Games & Recent Games) + Full Library Grid below
  const shelves: string[] = [];
  const freeShelf = renderFreeGamesShelf();
  if (freeShelf) {
    shelves.push(freeShelf);
  }

  const recentGames = S.epicRecent
    .map((id) => S.epicSummariesMap.get(id))
    .filter((s): s is EpicSummary => !!s);

  if (recentGames.length > 0) {
    shelves.push(renderShelfSection("clock", t("lib.recentGames"), recentGames, { featuredFirst: true }));
  }

  const shelvesMarkup = shelves.length > 0
    ? `<div class="lib-shelves-stage">${shelves.join("")}</div>`
    : "";

  return `
    <div class="lib-content-wrap">
      ${shelvesMarkup}
      <div class="lib-grid-stage">
        <div class="lib-section-heading">
          <div class="lib-section-title">
            ${icon("layout-grid", 15)}
            <span>${t("lib.allGames")}</span>
            <span class="shelf-badge">${visible.length}</span>
          </div>
        </div>
        <div class="pgrid size-${S.epicCardSize}">
          ${cardsHtml}
          ${sentinelHtml}
        </div>
      </div>
    </div>`;
}

export function setupLibScrollObserver(): void {
  if (S.libScrollObserver) {
    S.libScrollObserver.disconnect();
    S.libScrollObserver = null;
  }

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
      .map((s) => epicCardPortrait(s))
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
        <div class="skeleton-circle" style="width:36px;height:36px;border-radius:10px;"></div>
      </div>
    </div>
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

  // Pre-calculate filter and update metrics in a single pass.
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

  const currentSortOpt = sortOptions.find((o) => o.id === S.epicSort) || sortOptions[0];

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

    <div class="lib-unified-toolbar">
      <div class="unified-toolbar-left">
        <div class="apple-segmented-rail">
          <button class="apple-segment ${S.activeCollectionId === null && S.epicFilter === "all" ? "active" : ""}" data-act="quick-tab" data-tab="all">
            <span>${t("library.all")}</span>
            <span class="segment-cnt">${S.epicSummaries.length}</span>
          </button>
          <button class="apple-segment ${S.epicFilter === "installed" ? "active" : ""}" data-act="quick-tab" data-tab="installed">
            <span class="segment-dot installed"></span>
            <span>${t("library.installed")}</span>
            <span class="segment-cnt">${allInstalledCount}</span>
          </button>
          <button class="apple-segment ${S.activeCollectionId === "fav" || S.epicFilter === "fav" ? "active" : ""}" data-act="quick-tab" data-tab="fav">
            <span class="segment-icon">${icon("heart", 12)}</span>
            <span>${t("library.favorites")}</span>
            <span class="segment-cnt">${favTotalCount}</span>
          </button>
          <button class="apple-segment ${S.epicFilter === "platinum" ? "active" : ""}" data-act="quick-tab" data-tab="platinum">
            <span class="segment-icon">${epicPlatinumIcon(12)}</span>
            <span>${t("library.platinum")}</span>
            <span class="segment-cnt">${platCount}</span>
          </button>
          ${allUpdatesCount > 0 ? `
          <button class="apple-segment ${isUpdateNewlyAdded ? "segment-dynamic" : ""} ${S.epicFilter === "updates" ? "active" : ""}" data-act="quick-tab" data-tab="updates">
            <span class="segment-icon">${icon("zap", 12)}</span>
            <span>${t("library.updates")}</span>
            <span class="segment-cnt">${allUpdatesCount}</span>
          </button>` : ""}
          <button class="apple-segment ${S.epicFilter === "collections" ? "active" : ""}" data-act="quick-tab" data-tab="collections">
            <span class="segment-icon">${icon("folder", 12)}</span>
            <span>${t("lib.collections")}</span>
            ${S.epicCollections.length > 0 ? `<span class="segment-cnt">${S.epicCollections.length}</span>` : ""}
          </button>
        </div>

        ${selectedCol ? `
        <div class="apple-active-col-chip">
          ${isCollectionIcon(selectedCol.emoji) ? `<span class="col-pill-marker">${collectionMarker(selectedCol.emoji, 13)}</span>` : icon("folder", 13)}
          <span>${esc(selectedCol.name)}</span>
          <span class="segment-cnt">${totalColCount}</span>
          <button class="col-clear-btn" data-act="clear-collection" title="${t("lib.clearCollection")}">${icon("x", 11)}</button>
        </div>` : ""}
      </div>

      <div class="unified-toolbar-right">
        <label class="apple-search-box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="search" type="search" placeholder="${t("lib.searchPlaceholder")}" value="${esc(S.query)}" autocomplete="off" spellcheck="false" />
          <span class="search-shortcut">Ctrl+F</span>
        </label>

        <div class="sort-dropdown-container">
          <button class="apple-sort-btn" data-act="toggle-sort-dropdown" title="${t("lib.sortTip", { label: esc(currentSortOpt.label) })}">
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
        </div>

        <div class="card-size-toggle" title="${t("lib.cardSize")}">
          <button class="${S.epicCardSize === "compact" ? "active" : ""}" data-act="epic-size" data-val="compact" title="${t("lib.sizeSmall")}">S</button>
          <button class="${S.epicCardSize === "normal" ? "active" : ""}" data-act="epic-size" data-val="normal" title="${t("lib.sizeNormal")}">M</button>
          <button class="${S.epicCardSize === "large" ? "active" : ""}" data-act="epic-size" data-val="large" title="${t("lib.sizeLarge")}">L</button>
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
    <div id="lib-results" class="lib-content-wrap">${renderEpicItems()}</div>`;
}

export function updateLibraryFilterInPlace(): boolean {
  if (S.view !== "library") return false;
  const toolbar = document.querySelector(".lib-unified-toolbar");
  const resultsEl = document.getElementById("lib-results");
  if (!toolbar || !resultsEl) return false;

  toolbar.querySelectorAll<HTMLElement>(".apple-segment[data-act='quick-tab'], .unified-pill[data-act='quick-tab']").forEach((pill) => {
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
                : tab === "collections"
                  ? S.epicFilter === "collections"
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

  resultsEl.className = "lib-content-wrap";
  resetCardChunk();
  resultsEl.innerHTML = renderEpicItems();
  setupLibScrollObserver();

  return true;
}
