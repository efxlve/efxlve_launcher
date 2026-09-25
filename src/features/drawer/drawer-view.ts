/**
 * Game page: orchestration, header, tab renderers and lazy fetches.
 *
 * The page fills the content area next to the sidebar (it is not a side
 * drawer). Achievements, DLC, screenshots and system requirements are fetched
 * on demand. Pure presentational widgets live in drawer-widgets.ts; the Manage
 * tab lives in features/manage; state lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri, NO_DESC } from "../../core/constants";
import { currentLanguage, t } from "../../i18n";
import { modalRoot, syncSidebarGameActive } from "../../core/dom";

import { epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon, loadingState, type IconName } from "../../core/icons";
import { updateNavHistoryUi } from "../../core/nav";
import { presenceSync, updateGamepadHud } from "../../core/render";
import { epicWideArt, isTurkishUser, rawOf, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { epicDetectEos, epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetHltb, epicGetSteamAbout, epicGetSystemRequirements, epicPortrait, getAntiCheat, getThirdPartyLauncher, requiresThirdPartyLauncher, type CriticData, type EpicAchievementsData, type EpicSummary, type SteamAbout, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";

import { renderDrawerManage } from "../manage/manage-view";
import { fetchAndRenderScreenshots, renderDrawerScreenshots } from "../screenshots/screenshots-view";
import { cleanStoreDescription, getAchTier, getHardwareIcon, getHardwareLabel, isMacSys, isWinSys, renderAchievementSections, renderCriticCard, renderGameFeatures, renderHltbCard } from "./drawer-widgets";

/** Scrolls a tab into view only when it is clipped (narrow windows). */
export function ensureTabVisible(el: HTMLElement, container: HTMLElement): void {
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left < container.scrollLeft) container.scrollLeft = left - 16;
  else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth + 16;
}

/// Detects whether the game bundles the EOS SDK, once per game (result cached).
/// The filesystem scan runs only when a game page opens, never per library card.
function ensureEosSupport(appName: string): void {
  const s = summaryOf(appName);
  if (!isTauri || !s?.installed || !s.installPath || S.eosSupportMap.has(appName)) return;
  S.eosSupportMap.set(appName, false);
  void epicDetectEos(s.installPath)
    .then((has) => {
      S.eosSupportMap.set(appName, has);
      if (has && S.currentModalAppName === appName) openEpicModal(appName, false);
    })
    .catch(() => {});
}

function hltbLabel(appName: string): string {
  const hltb = S.loadedHltb.get(appName);
  const hours = hltb?.main_story || hltb?.main_extra;
  return hours ? `~${hours} ${t("common.hoursShort")}` : "—";
}

/** Critic stat value + tier class (shared by the header stat and its live update). */
function criticStat(data: CriticData | undefined): { text: string; cls: string; url: string } {
  if (!data?.supported) return { text: "—", cls: "", url: "" };
  const showGoygoy = isTurkishUser() && Boolean(data.goygoy_review);
  const url = data.opencritic_url || data.metacritic_url || (showGoygoy ? data.goygoy_review?.url : "") || "";
  const sc = data.opencritic_score || data.metacritic_score;
  if (sc) return { text: data.tier ? `${sc} · ${data.tier}` : `${sc}`, cls: data.tier ? `tier-${data.tier.toLowerCase()}` : "", url };
  if (showGoygoy && data.goygoy_review?.score) return { text: `${data.goygoy_review.score} · Goygoy`, cls: "tier-goygoy", url };
  if (showGoygoy && data.goygoy_review) return { text: t("drawer.goygoyReview"), cls: "tier-goygoy", url };
  return { text: "—", cls: "", url };
}

function primaryAction(s: EpicSummary, p: number | null, partner: ThirdPartyLauncherInfo | null): string {
  if (p !== null) {
    return `<button class="btn primary lg" data-view="downloads" data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`;
  }
  if (S.runningGames.has(s.appName)) {
    return `<button class="btn play lg" data-act="epic-stop" data-id="${s.appName}">${icon("square", 14)} ${t("common.stop")}</button>`;
  }
  if (s.installed) {
    return s.updateAvailable || S.availableUpdates.has(s.appName)
      ? `<button class="btn update lg" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} ${t("common.update")}</button>`
      : `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`;
  }
  return requiresThirdPartyLauncher(partner)
    ? `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("external", 16)} ${t("drawer.launchInstallWith", { name: esc(partner!.name) })}</button>`
    : `<button class="btn install lg" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} ${t("common.install")}</button>`;
}

/** Primary action + favorite/store/cancel buttons (re-rendered on state changes). */
function actionsHtml(s: EpicSummary, partner: ThirdPartyLauncherInfo | null): string {
  const p = epicDlProgress(s.appName);
  const faved = S.epicFav.has(s.appName);
  return `
    ${primaryAction(s, p, partner)}
    <button class="btn ghost lg ${S.activeDrawerTab === "manage" ? "active" : ""}" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
    <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
    <button class="btn ghost lg icon-only" data-act="epic-store-page" data-id="${s.appName}" title="${t("drawer.storeTitle")}">${icon("external", 16)}</button>
    ${p !== null ? `<button class="btn ghost lg danger" data-act="epic-cancel" data-id="${s.appName}">${t("common.cancel")}</button>` : ""}`;
}

function renderActiveTab(s: EpicSummary, partner: ThirdPartyLauncherInfo | null, antiCheat: string | null): string {
  switch (S.activeDrawerTab) {
    case "overview": return renderDrawerOverview(s, partner, antiCheat);
    case "achievements": return renderDrawerAchievements(s);
    case "dlcs": return renderDrawerDlcs(s);
    case "screenshots": return renderDrawerScreenshots(s);
    case "manage": return renderDrawerManage(s);
    default: return renderDrawerSystemRequirements(s);
  }
}

const TAB_ICON: Record<string, IconName> = {
  overview: "layout-grid",
  achievements: "trophy",
  dlcs: "package",
  screenshots: "camera",
  manage: "settings",
  specs: "cpu",
};

function tabButton(tab: string, label: string, count = 0, extraClass = ""): string {
  const glyph = TAB_ICON[tab] ? icon(TAB_ICON[tab], 14) : "";
  return `<button class="tab drawer-tab ${S.activeDrawerTab === tab ? "active" : ""} ${extraClass}" data-act="drawer-tab" data-tab="${tab}" data-id="${S.currentModalAppName ?? ""}">${glyph}${label}${count > 0 ? `<span class="count drawer-tab-badge">${count}</span>` : ""}</button>`;
}

/** Steam about text plus store facts, keyed by app and launcher language. */
const steamAboutCache = new Map<string, SteamAbout>();

function steamAboutKey(appName: string): string {
  return `${appName}|${currentLanguage()}`;
}

function steamMetaLine(data: SteamAbout): string {
  return [data.developers, data.release_date, data.genres].filter((part) => part && part.trim()).join(" · ");
}

/** Split a store/wiki blurb into readable paragraphs. */
function aboutMarkup(text: string): string {
  const parts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.map((part) => `<p>${esc(part)}</p>`).join("");
}

function applySteamAbout(appName: string, data: SteamAbout): void {
  if (!data.description) return;
  steamAboutCache.set(steamAboutKey(appName), data);
  if (S.currentModalAppName !== appName) return;
  const descEl = document.getElementById("hub-desc-text");
  if (descEl) descEl.innerHTML = aboutMarkup(data.description);
  const metaEl = document.getElementById("hub-desc-meta");
  const meta = steamMetaLine(data);
  if (metaEl) {
    metaEl.textContent = meta;
    metaEl.hidden = !meta;
  }
}

/** Kicks off the lazy overview fetches (HLTB, critic, Steam about) once per game and language. */
function ensureOverviewData(s: EpicSummary): void {
  const appName = s.appName;
  if (S.activeDrawerTab !== "overview") return;
  if (!S.loadedHltb.has(appName) && S.loadingHltbFor !== appName) {
    S.loadingHltbFor = appName;
    epicGetHltb(s.title, appName)
      .then((data) => {
        S.loadedHltb.set(appName, data);
        if (S.currentModalAppName !== appName) return;
        const el = document.getElementById("drawer-hltb-container");
        if (el) el.innerHTML = renderHltbCard(data);
        const capEl = document.getElementById("hub-stat-hltb-val");
        if (capEl) capEl.textContent = hltbLabel(appName);
      })
      .catch(() => {})
      .finally(() => { S.loadingHltbFor = null; });
  }
  if (!S.loadedCritic.has(appName) && S.loadingCriticFor !== appName) {
    S.loadingCriticFor = appName;
    epicGetCritic(s.title, appName)
      .then((data) => {
        S.loadedCritic.set(appName, data);
        if (S.currentModalAppName === appName) updateCriticUI(appName, data);
      })
      .catch(() => {})
      .finally(() => { S.loadingCriticFor = null; });
  }
  const aboutKey = steamAboutKey(appName);
  if (!steamAboutCache.has(aboutKey) && S.loadingSteamAboutFor !== aboutKey) {
    S.loadingSteamAboutFor = aboutKey;
    epicGetSteamAbout(s.title, appName, currentLanguage())
      .then((data) => {
        if (data.supported && data.description) applySteamAbout(appName, data);
      })
      .catch((err) => console.warn("Steam about text could not be loaded:", err))
      .finally(() => {
        if (S.loadingSteamAboutFor === aboutKey) S.loadingSteamAboutFor = null;
      });
  }
}

export function openEpicModal(appName: string, isInitialOpen = true, _animateTabContent = true): void {
  const s = summaryOf(appName);
  if (!s) return;
  S.currentModalAppName = appName;
  if (isInitialOpen) {
    S.activeDrawerTab = "overview";
    S.activeAchScope = "all";
    S.activeAchFilter = "all";
    S.achSearchQuery = "";
    S.achSortOrder = "default";
  }
  const g = rawOf(appName);
  const partner = getThirdPartyLauncher(g);
  const antiCheat = getAntiCheat(g);

  ensureOverviewData(s);
  if (!S.loadedRequirements.has(appName) && S.loadingReqFor !== appName) void fetchAndRenderRequirements(appName, s.title);
  if (!S.loadedScreenshots.has(appName) && S.loadingScreenshotsFor !== appName) void fetchAndRenderScreenshots(appName, s.title);
  ensureEosSupport(appName);

  const dlcRes = S.dlcCache.get(appName);
  const dlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const ssCount = S.loadedScreenshots.get(appName)?.length ?? 0;
  const isPlat = isAppPlatinum(appName);

  // Tab switch / live refresh: patch the tab strip and content only.
  const contentEl = document.getElementById("drawer-tab-content");
  if (!isInitialOpen && contentEl && modalRoot.querySelector(".game-hub")) {
    const tabs = document.getElementById("drawer-tabs-scrollable");
    modalRoot.querySelectorAll<HTMLElement>(".drawer-tab").forEach((btn) => {
      const active = btn.dataset.tab === S.activeDrawerTab;
      btn.classList.toggle("active", active);
      if (active && tabs) ensureTabVisible(btn, tabs);
    });
    const achList = contentEl.querySelector<HTMLElement>(".ach-list-container");
    const achScroll = achList ? achList.scrollTop : 0;
    contentEl.innerHTML = renderActiveTab(s, partner, antiCheat);
    if (achScroll > 0) {
      const next = contentEl.querySelector<HTMLElement>(".ach-list-container");
      if (next) next.scrollTop = achScroll;
    }
    const dlcTab = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
    if (dlcTab) dlcTab.outerHTML = tabButton("dlcs", t("drawer.dlcs"), dlcCount);
    const actions = modalRoot.querySelector(".gp-actions");
    if (actions) actions.innerHTML = actionsHtml(s, partner);
    return;
  }

  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  const devRaw = g ? g.metadata.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";
  const hasUpdate = s.updateAvailable || S.availableUpdates.has(appName);
  const achSum = S.epicAchSummaries[appName];
  const pt = S.playtimeMap.get(appName);
  const critic = criticStat(S.loadedCritic.get(appName));
  const achVal = achSum && achSum.total_achievements > 0
    ? `${achSum.user_unlocked}/${achSum.total_achievements}`
    : "—";

  const status = hasUpdate ? `<span class="chip warn">${t("drawer.updateAvailable")}</span>` : "";
  const meta = [
    dev ? `<span>${esc(dev)}</span>` : "",
    status,
    `<span id="drawer-col-chips-container" class="gp-tags">${renderCollectionTags(appName)}</span>`,
    partner ? `<span class="gp-meta-item" title="${esc(t("drawer.partnerRequired", { name: partner.name }))}">${icon("layers", 13)} ${esc(partner.name)}</span>` : "",
    antiCheat ? `<span class="gp-meta-item" title="${esc(t("drawer.anticheatTitle", { name: antiCheat }))}">${icon("shield", 13)} ${esc(antiCheat)}</span>` : "",
  ].filter(Boolean).join("");

  const loadingDot = `<span class="spinner gp-mini-spin"></span>`;
  const stat = (label: string, value: string, attrs = "", valId = "", valCls = ""): string =>
    `<div class="gp-stat ${attrs ? "clickable" : ""}" ${attrs}><span class="gp-stat-label">${label}</span><span class="gp-stat-val ${valCls}"${valId ? ` id="${valId}"` : ""}>${value}</span></div>`;

  modalRoot.innerHTML = `
    <div class="overlay">
      <div class="game-hub">
        <div class="gp-hero">
          ${art ? `<img class="gp-hero-img" src="${esc(art)}" alt="" decoding="async" />` : ""}
          <div class="gp-hero-scrim"></div>
          <div class="gp-hero-top">
            <div class="gp-hero-nav">
              <button class="icon-btn gp-hero-tool" id="gp-nav-back" data-act="page-back" data-i18n-title="nav.historyBack" title="${t("nav.historyBack")}">${icon("arrow-left", 16)}</button>
            </div>
            <button class="icon-btn gp-hero-tool" data-act="open-custom-cover" data-target="hero" data-id="${appName}" title="${t("drawer.customizeCover")}">${icon("image", 16)}</button>
          </div>
          <div class="gp-hero-bottom">
            <h1 class="gp-title">${esc(s.title)}</h1>
            <div class="gp-meta">${meta}</div>
          </div>
        </div>

        <div class="gp-bar">
          <div class="gp-actions">${actionsHtml(s, partner)}</div>
          <div class="gp-stats">
            ${stat(t("drawer.statTime"), esc(pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—"), `data-act="open-edit-playtime" data-id="${appName}" title="${t("drawer.editPlaytime")}"`, "drawer-stat-playtime")}
            ${stat(isPlat ? t("drawer.statPlat") : t("drawer.statTrophy"), achVal, achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${appName}" title="${t("drawer.viewAchievements")}"` : "", "", isPlat ? "plat" : "")}
            ${stat(t("drawer.statStory"), S.loadingHltbFor === appName ? loadingDot : hltbLabel(appName), "", "hub-stat-hltb-val")}
            <div class="gp-stat ${critic.url ? "clickable" : ""}" id="hub-stat-critic-col" ${critic.url ? `data-act="open-critic-url" data-url="${esc(critic.url)}"` : ""} title="${t("drawer.criticScore")}">
              <span class="gp-stat-label">${t("drawer.statReview")}</span>
              <span class="gp-stat-val ${critic.cls}" id="hub-stat-critic-val">${S.loadingCriticFor === appName ? loadingDot : critic.text}</span>
            </div>
          </div>
        </div>

        <div class="gp-body">
          <div class="tabs gp-tabs" id="drawer-tabs-scrollable">
            ${tabButton("overview", t("drawer.overview"))}
            ${tabButton("achievements", t("drawer.achievements"), 0, isPlat ? "plat" : "")}
            ${tabButton("dlcs", t("drawer.dlcs"), dlcCount)}
            ${tabButton("screenshots", t("drawer.screenshots"), ssCount)}
            ${tabButton("specs", t("drawer.specs"))}
          </div>
          <div id="drawer-tab-content">${renderActiveTab(s, partner, antiCheat)}</div>
        </div>
      </div>
    </div>`;

  if (!S.dlcCache.has(appName)) {
    epicGetGameDlcs(appName)
      .then((res) => {
        S.dlcCache.set(appName, res);
        const cur = summaryOf(appName);
        if (cur) cur.dlcCount = res.dlcs.length;
        if (S.currentModalAppName !== appName) return;
        const dlcTab = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
        if (dlcTab) dlcTab.outerHTML = tabButton("dlcs", t("drawer.dlcs"), res.dlcs.length);
      })
      .catch(() => {});
  }
  syncSidebarGameActive();
  updateGamepadHud(S.gamepadPolling);
  presenceSync();
  updateNavHistoryUi();
}

export function updateCriticUI(appName: string, data: CriticData): void {
  if (S.currentModalAppName !== appName) return;
  const container = document.getElementById("drawer-critic-container");
  if (container) container.innerHTML = renderCriticCard(data, false);
  const valEl = document.getElementById("hub-stat-critic-val");
  const colEl = document.getElementById("hub-stat-critic-col");
  if (!valEl) return;
  const c = criticStat(data);
  valEl.textContent = c.text;
  valEl.className = `gp-stat-val ${c.cls}`;
  if (!colEl) return;
  colEl.classList.toggle("clickable", Boolean(c.url));
  if (c.url) {
    colEl.setAttribute("data-act", "open-critic-url");
    colEl.setAttribute("data-url", c.url);
  } else {
    colEl.removeAttribute("data-act");
    colEl.removeAttribute("data-url");
  }
}

/** Collection chips + add button shown under the game description. */
export function renderCollectionTags(appName: string): string {
  const lowerApp = appName.toLowerCase();
  const gameCols = S.epicCollections.filter((c) => c.app_names.some((name) => name.toLowerCase() === lowerApp));
  const pills = gameCols.map((c) => `
    <button class="chip gp-tag" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(t("drawer.collectionShow", { name: c.name }))}">
      ${isCollectionIcon(c.emoji) ? collectionMarker(c.emoji, 12) : ""}${esc(c.name)}
    </button>`).join("");
  return `${pills}<button class="btn ghost small" data-act="manage-game-collections" data-id="${appName}">${icon("plus", 12)} ${gameCols.length > 0 ? t("drawer.collection") : t("drawer.addCollection")}</button>`;
}

export function renderDrawerOverview(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
): string {
  const reqData = S.loadedRequirements.get(s.appName);

  const rawDesc = s.description?.trim();
  const hasRealDesc = rawDesc && rawDesc !== NO_DESC && rawDesc !== s.title && rawDesc.length > 25;
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : null);
  const steamAbout = steamAboutCache.get(steamAboutKey(s.appName));
  const effectiveDesc = steamAbout?.description || (hasRealDesc ? rawDesc : storeDesc || null);
  const steamMeta = steamAbout ? steamMetaLine(steamAbout) : "";

  return `
    <div class="hub-overview-layout">
      <div class="hub-overview-main">
        <section class="gp-section">
          <h3 class="gp-section-title">${t("drawer.aboutGame")}</h3>
          <div class="hub-desc-text" id="hub-desc-text">${effectiveDesc ? aboutMarkup(effectiveDesc) : `<p>${t("drawer.noDescription")}</p>`}</div>
          <p class="hub-desc-meta" id="hub-desc-meta"${steamMeta ? "" : " hidden"}>${esc(steamMeta)}</p>
        </section>
      </div>
      <aside class="hub-overview-sidebar">
        <div id="drawer-hltb-container">${renderHltbCard(S.loadedHltb.get(s.appName), S.loadingHltbFor === s.appName)}</div>
        <div id="drawer-critic-container">${renderCriticCard(S.loadedCritic.get(s.appName), S.loadingCriticFor === s.appName)}</div>
        ${renderDrawerFeatures(s, partner, antiCheat)}
      </aside>
    </div>`;
}

function renderDrawerFeatures(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
  antiCheat: string | null,
): string {
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  return `
    <section class="card gp-side-card gp-features-card">
      <h3 class="gp-section-title">${t("drawer.featuresSupport")}</h3>
      <div class="hub-features-list" id="hub-features-list">${renderGameFeatures(s, g, partner, antiCheat, reqData)}</div>
    </section>`;
}

export function renderDrawerDlcs(s: EpicSummary): string {
  const dlcRes = S.dlcCache.get(s.appName);
  if (S.dlcLoading && !dlcRes) return loadingState(t("dlc.scanning"));
  const allDlcs = dlcRes?.dlcs || [];
  const storeBtn = `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.discoverDlc")}</button>`;
  if (allDlcs.length === 0) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"), storeBtn);

  const query = S.dlcSearchQuery.trim().toLowerCase();
  const filtered = query ? allDlcs.filter((d) => d.title.toLowerCase().includes(query)) : allDlcs;
  const rows = filtered.map((dlc) => {
    const downloadable = dlc.downloadable !== false;
    const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : downloadable ? "—" : t("dlc.included");
    const thumb = dlc.image
      ? `<img class="row-thumb" src="${esc(dlc.image)}" alt="" loading="lazy" />`
      : `<span class="row-thumb gp-thumb-ph">${icon("layers", 14)}</span>`;
    const action = downloadable
      ? `<label class="switch" title="${dlc.installed ? t("common.uninstall") : t("common.install")}"><input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(s.appName)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} /><span class="track"></span></label>`
      : `<span class="chip ok" title="${t("drawer.dlcActiveTip")}">${icon("check", 12)} ${t("dlc.activeBadge")}</span>`;
    return `
      <div class="row">
        ${thumb}
        <div class="row-main"><div class="row-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div><div class="row-meta">${esc(sizeStr)}</div></div>
        <div class="row-actions">${action}</div>
      </div>`;
  }).join("");

  return `
    <div class="gp-toolbar">
      <label class="search gp-search">${icon("search", 15)}<input id="dlc-drawer-search" placeholder="${t("drawer.searchDlc")}" value="${esc(S.dlcSearchQuery)}" spellcheck="false" autocomplete="off" /></label>
      ${storeBtn}
    </div>
    <div class="list">${rows || `<div class="row"><div class="row-meta">${t("ach.emptyTitle")}</div></div>`}</div>`;
}

export function enrichAchievementsData(appName: string, data: EpicAchievementsData): void {
  const g = rawOf(appName);
  const raw = (g?.achievements || (g?.metadata as any)?.achievements) as any;
  const list = raw?.achievements || (Array.isArray(raw) ? raw : undefined);
  if (!Array.isArray(list)) return;
  const byName = new Map(data.achievements.map((a) => [a.name, a]));
  for (const item of list) {
    const meta = (item as any)?.achievement || item;
    if (!meta?.name) continue;
    const target = byName.get(meta.name);
    if (!target) continue;
    if (meta.hidden) target.hidden = true;
    if (typeof meta.isBase === "boolean") target.is_base = meta.isBase;
    else if (typeof meta.is_base === "boolean") target.is_base = meta.is_base;
    if (!target.display_name?.trim() && (meta.unlockedDisplayName || meta.unlocked_display_name)) {
      target.display_name = meta.unlockedDisplayName || meta.unlocked_display_name || "";
    }
    if (!target.description?.trim() && (meta.unlockedDescription || meta.unlocked_description)) {
      target.description = meta.unlockedDescription || meta.unlocked_description || "";
    }
    if (!target.icon_link?.trim() && (meta.unlockedIconLink || meta.unlocked_icon_link)) {
      target.icon_link = meta.unlockedIconLink || meta.unlocked_icon_link || "";
    }
  }
}

export function renderDrawerAchievements(s: EpicSummary): string {
  const isPlat = isAppPlatinum(s.appName);
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const partner = getThirdPartyLauncher(rawOf(s.appName));

  if (S.loadingAchFor === s.appName) return loadingState(t("ach.loadingStore"));
  const data = S.loadedAchievements.get(s.appName);
  if (!data) return loadingState(t("ach.checking"));

  const retry = `<button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 13)} ${t("ach.retry")}</button>`;
  if (data.achievements.length === 0) {
    if (partner) {
      const open = requiresThirdPartyLauncher(partner)
        ? `<button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${t("ach.openPartner", { name: esc(partner.name) })}</button>`
        : "";
      return emptyState("gamepad-2", t("ach.partnerTitle", { name: esc(partner.name) }), t("ach.partnerDesc", { name: `<strong>${esc(partner.name)}</strong>` }), retry + open);
    }
    return emptyState("trophy", t("ach.noSupportTitle"), t("ach.noSupportDesc"), retry);
  }

  enrichAchievementsData(s.appName, data);

  const hasDlc = data.achievements.some((a) => !a.is_base);
  const effectiveUnlocked = isDemo ? data.total_achievements : data.user_unlocked;
  const effectiveXp = isDemo ? data.total_xp : data.user_xp;
  const pct = data.total_achievements > 0 ? Math.round((effectiveUnlocked / data.total_achievements) * 100) : 0;
  const query = S.achSearchQuery.trim().toLowerCase();

  const filtered = data.achievements.filter((a) => {
    const unlocked = a.unlocked || isDemo;
    if (S.activeAchFilter === "unlocked" && !unlocked) return false;
    if (S.activeAchFilter === "locked" && unlocked) return false;
    if (S.activeAchFilter === "hidden" && !a.hidden) return false;
    if (query) {
      const inTitle = (a.display_name || a.name).toLowerCase().includes(query);
      if (!inTitle && !(a.description || "").toLowerCase().includes(query)) return false;
    }
    return true;
  });
  const sorted = [...filtered].sort((a, b) => {
    if (S.achSortOrder === "rarity") return (a.rarity?.percent ?? 100) - (b.rarity?.percent ?? 100);
    if (S.achSortOrder === "xp") return b.xp - a.xp;
    if (S.achSortOrder === "date") {
      return (b.unlock_date ? new Date(b.unlock_date).getTime() : 0) - (a.unlock_date ? new Date(a.unlock_date).getTime() : 0);
    }
    return 0;
  });

  const tiers = { platinum: [0, 0], gold: [0, 0], silver: [0, 0], bronze: [0, 0] } as Record<string, [number, number]>;
  let unlockedCount = 0;
  let hiddenCount = 0;
  for (const a of data.achievements) {
    const tier = tiers[getAchTier(a)];
    const u = a.unlocked || isDemo;
    tier[0]++;
    if (u) { tier[1]++; unlockedCount++; }
    if (a.hidden) hiddenCount++;
  }
  const showPlat = tiers.platinum[0] > 0 || isPlat || data.is_platinum || (data.base_achievements ?? 0) > 0;
  const platTotal = tiers.platinum[0] > 0 ? tiers.platinum[0] : showPlat ? 1 : 0;
  const platUnlocked = tiers.platinum[0] > 0 ? tiers.platinum[1] : isPlat ? 1 : 0;
  const tierChip = (cls: string, title: string, glyph: string, done: number, total: number): string =>
    total > 0 ? `<span class="ach-tier-mini ${cls} ${done >= total ? "complete" : ""}" title="${title}">${glyph} ${done}/${total}</span>` : "";
  const filterChip = (val: string, label: string, n: number): string =>
    `<button class="tab ach-status-chip ${S.activeAchFilter === val ? "active" : ""}" data-act="ach-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  return `
    <div class="ach-summary-bar ${isPlat ? "platinum" : ""}">
      <div class="ach-summary-left">
        <span class="ach-summary-pct ${isPlat ? "plat" : ""}">${isPlat ? epicPlatinumIcon(18) : `${pct}%`}</span>
        <div class="ach-summary-text">
          <span class="ach-summary-count">${effectiveUnlocked} / ${data.total_achievements}</span>
          <span class="ach-summary-sub">${isPlat ? t("ach.platinumComplete") : `${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP`}</span>
        </div>
        <div class="progress ach-summary-progress"><span style="width:${pct}%"></span></div>
      </div>
      <div class="ach-summary-right">
        ${tierChip("plat", t("ach.tierPlatinum"), epicPlatinumIcon(11), platUnlocked, platTotal)}
        ${tierChip("gold", t("ach.tierGold"), icon("trophy", 11), tiers.gold[1], tiers.gold[0])}
        ${tierChip("silver", t("ach.tierSilver"), icon("trophy", 11), tiers.silver[1], tiers.silver[0])}
        ${tierChip("bronze", t("ach.tierBronze"), icon("trophy", 11), tiers.bronze[1], tiers.bronze[0])}
        <button class="icon-btn" data-act="ach-refresh" data-id="${s.appName}" title="${t("ach.refreshData")}">${icon("refresh", 14)}</button>
        <button class="icon-btn" data-act="open-store-achievements" data-id="${s.appName}" title="${t("ach.viewInStore")}">${icon("external", 14)}</button>
      </div>
    </div>

    <div class="gp-toolbar">
      <div class="tabs ach-status-strip">
        ${filterChip("all", t("ach.filterAll"), data.achievements.length)}
        ${filterChip("unlocked", t("ach.filterUnlocked"), unlockedCount)}
        ${filterChip("locked", t("ach.filterLocked"), data.achievements.length - unlockedCount)}
        ${hiddenCount > 0 ? filterChip("hidden", t("ach.filterHidden"), hiddenCount) : ""}
      </div>
      <div class="gp-toolbar-right">
        <label class="search gp-search">${icon("search", 15)}<input type="text" id="ach-search-input" placeholder="${t("ach.searchPlaceholder")}" value="${esc(S.achSearchQuery)}" autocomplete="off" />
          ${S.achSearchQuery ? `<button class="icon-btn ach-search-clear" data-act="clear-ach-search" title="${t("ach.clearSearch")}">${icon("x", 12)}</button>` : ""}
        </label>
        <select id="ach-sort-select" class="ach-sort-select" title="${t("ach.sortTitle")}">
          <option value="default" ${S.achSortOrder === "default" ? "selected" : ""}>${t("ach.sortDefault")}</option>
          <option value="rarity" ${S.achSortOrder === "rarity" ? "selected" : ""}>${t("ach.sortRarity")}</option>
          <option value="xp" ${S.achSortOrder === "xp" ? "selected" : ""}>${t("ach.sortXp")}</option>
          <option value="date" ${S.achSortOrder === "date" ? "selected" : ""}>${t("ach.sortDate")}</option>
        </select>
      </div>
    </div>

    <div class="ach-list-container" id="ach-list-container">
      ${renderAchievementSections(sorted, s, hasDlc, data.achievements)}
    </div>`;
}

export async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri || S.loadingAchFor === appName) return;
  S.loadingAchFor = appName;
  if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") openEpicModal(appName, false, false);
  try {
    const data = await epicGetAchievements(appName, forceRefresh);
    S.loadedAchievements.set(appName, data);
    const sum = S.epicAchSummaries[appName];
    if (!sum) {
      S.epicAchSummaries[appName] = {
        app_name: appName,
        user_unlocked: data.user_unlocked,
        total_achievements: data.total_achievements,
        user_xp: data.user_xp,
        total_xp: data.total_xp,
        is_platinum: data.is_platinum,
        supported: data.total_achievements > 0,
      };
    } else {
      sum.user_unlocked = data.user_unlocked;
      sum.total_achievements = data.total_achievements;
      sum.user_xp = data.user_xp;
      sum.total_xp = data.total_xp;
      sum.is_platinum = data.is_platinum;
    }
  } catch (e) {
    console.warn("Achievements could not be fetched or this game has no achievement support:", e);
    S.loadedAchievements.set(appName, { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false });
  } finally {
    S.loadingAchFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") openEpicModal(appName, false, false);
  }
}

/* ---------- System requirements ---------- */

export function renderDrawerSystemRequirements(s: EpicSummary): string {
  if (S.loadingReqFor === s.appName) return loadingState(t("sys.loadingStore"));
  const data = S.loadedRequirements.get(s.appName);
  if (!data) {
    void fetchAndRenderRequirements(s.appName, s.title);
    return loadingState(t("sys.loading"));
  }
  if (!data.supported || data.systems.length === 0) {
    return emptyState("cpu", t("sys.notFoundTitle"), t("sys.notFoundDesc"),
      `<button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 13)} ${t("common.retry")}</button>
       <button class="btn primary small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("sys.goStore")}</button>`);
  }

  const hasWin = data.systems.some((sys) => isWinSys(sys.systemType));
  const hasMac = data.systems.some((sys) => isMacSys(sys.systemType));
  const currentSys = data.systems.find((sys) => (S.activeSystemPlatform === "Windows" ? isWinSys(sys.systemType) : isMacSys(sys.systemType))) || data.systems[0];
  const minItems = currentSys.details.filter((d) => d.minimum?.trim());
  const recItems = currentSys.details.filter((d) => d.recommended?.trim());

  const rows = (items: SystemDetailItem[], isMin: boolean): string =>
    items.length === 0
      ? `<div class="sys-req-row"><span class="sys-req-val">${t("sys.unspecified")}</span></div>`
      : items.map((d) => `
          <div class="sys-req-row">
            <div class="sys-req-label">${getHardwareIcon(d.title)}<span>${esc(getHardwareLabel(d.title))}</span></div>
            <div class="sys-req-val">${esc((isMin ? d.minimum : d.recommended) || "")}</div>
          </div>`).join("");
  const card = (title: string, hint: string, body: string): string => `
    <section class="card sys-req-card">
      <div class="sys-req-card-head"><h3 class="gp-section-title">${title}</h3><span class="sys-req-hint">${hint}</span></div>
      ${body}
    </section>`;

  return `
    <div class="sys-req-container">
      ${hasWin && hasMac ? `
        <div class="seg sys-req-platforms">
          <button class="${isWinSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Windows">${t("sys.windowsPc")}</button>
          <button class="${isMacSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">${t("sys.macos")}</button>
        </div>` : ""}
      <div class="sys-req-cards-grid">
        ${card(t("sys.minTitle"), t("sys.minHint"), rows(minItems, true))}
        ${recItems.length > 0 ? card(t("sys.recTitle"), t("sys.recHint"), rows(recItems, false)) : ""}
      </div>
      ${data.languages.length > 0 ? `<section class="card sys-req-lang"><h3 class="gp-section-title">${t("sys.languages")}</h3><p>${esc(data.languages.join(" · "))}</p></section>` : ""}
      <div class="page-actions">
        <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 13)} ${t("sys.requery")}</button>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("sys.openStore")}</button>
      </div>
    </div>`;
}

export async function fetchAndRenderRequirements(appName: string, title: string, forceRefresh = false): Promise<void> {
  if (!isTauri || S.loadingReqFor === appName) return;
  S.loadingReqFor = appName;
  try {
    const data = await epicGetSystemRequirements(title, appName, forceRefresh);
    S.loadedRequirements.set(appName, data);

    // Fill in the store description for games that lack one.
    const cur = summaryOf(appName);
    if (cur && (data.shortDescription || data.description)) {
      const sDesc = cur.description?.trim();
      if (!sDesc || sDesc === NO_DESC || sDesc === cur.title || sDesc.length <= 25) {
        cur.description = data.shortDescription || cleanStoreDescription(data.description || "");
      }
    }

    if (cur && S.currentModalAppName === appName) {
      if (S.activeDrawerTab === "overview") {
        const descEl = document.getElementById("hub-desc-text");
        const steamAbout = steamAboutCache.get(steamAboutKey(appName));
        if (descEl && !steamAbout?.description && (data.shortDescription || data.description)) {
          const text = data.shortDescription || cleanStoreDescription(data.description || "");
          descEl.innerHTML = aboutMarkup(text);
        }
      }
      const featuresEl = document.getElementById("hub-features-list");
      if (featuresEl) {
        const g = rawOf(appName);
        featuresEl.innerHTML = renderGameFeatures(cur, g, getThirdPartyLauncher(g), getAntiCheat(g), data);
      }
    }
  } catch (e) {
    console.warn("System requirements could not be fetched:", e);
    S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
  } finally {
    S.loadingReqFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") openEpicModal(appName, false);
  }
}

export async function epicOpenFolder(appName: string): Promise<void> {
  const s = summaryOf(appName);
  const targetPath =
    (S.activeManageSettings?.appName === appName ? S.activeManageSettings.installPath : null) || s?.installPath;
  if (!targetPath) {
    toast(t("common.installPathUnknown"), "err");
    return;
  }
  try {
    if (isTauri) toast(await invoke<string>("open_folder", { path: targetPath }), "ok");
    else toast(`(demo) ${targetPath}`, "");
  } catch (e) {
    toast(String(e), "err");
  }
}
