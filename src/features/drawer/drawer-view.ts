/**
 * Game page: orchestration, header, tab renderers and lazy fetches.
 *
 * The page fills the content area next to the sidebar (it is not a side
 * drawer). Achievements, DLC, screenshots and system requirements are fetched
 * on demand. Pure presentational widgets live in drawer-widgets.ts; the Manage
 * tab lives in features/manage; state lives in S.
 * One primary action. A number already on the page is not repeated. Status
 * color only.
 */

import { invoke } from "@tauri-apps/api/core";
import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri, NO_DESC } from "../../core/constants";
import { currentLanguage, t } from "../../i18n";
import { modalRoot, syncSidebarGameActive } from "../../core/dom";

import { epicDlProgress, isAppDownloading, isAppPlatinum, patchLibraryCardDom } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon, loadingState, type IconName } from "../../core/icons";
import { updateNavHistoryUi } from "../../core/nav";
import { presenceSync, updateGamepadHud } from "../../core/render";
import { epicWideArt, gameVersionsOf, rawOf, sharedOwnerOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { storeVersionLabel } from "./external-versions";
import { storeLogo } from "../store/store-logos";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { epicDetectEos, epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetGameSettings, epicGetHltb, epicGetSystemRequirements, epicGetWikiAbout, epicPortrait, getAntiCheat, getThirdPartyLauncher, requiresThirdPartyLauncher, type CriticData, type EpicAchievementSummary, type EpicAchievementsData, type EpicSummary, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";
import { gogGetAchievements, gogGetGameDetails, gogGetSystemRequirements } from "../../gog";
import { steamGetGameDetails } from "../../steam";
import { steamGetAchievements } from "../../steam";
import { buildSteamRequirements, steamLanguage } from "./steam-details";

import { invalidateLibraryVisibleCache } from "../library/library-view";
import { renderDrawerManage } from "../manage/manage-view";
import { fetchAndRenderScreenshots, renderDrawerScreenshots, renderMomentsStrip } from "../screenshots/screenshots-view";
import { cleanStoreDescription, getAchTier, getHardwareIcon, getHardwareLabel, heroCloudStatus, isMacSys, isWinSys, rememberCloudSync, renderAchievementSections, renderCriticCard, renderGameFeatures, renderNextAchievements, renderProgressStrip } from "./drawer-widgets";

/** Scrolls a tab into view only when it is clipped (narrow windows). */
export function ensureTabVisible(el: HTMLElement, container: HTMLElement): void {
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left < container.scrollLeft) container.scrollLeft = left - 16;
  else if (right > container.scrollLeft + container.clientWidth) container.scrollLeft = right - container.clientWidth + 16;
}

function steamStudioHints(appName: string): string {
  const d = S.steamDetails.get(appName);
  if (!d) return "";
  return [...d.developers, ...d.publishers].join(" ");
}

function partnerFromSteamNotice(notice: string): ThirdPartyLauncherInfo | null {
  const n = notice.trim();
  if (!n) return null;
  const lower = n.toLowerCase();
  if (lower.includes("ea app") || lower.includes("origin") || (/\bea\b/.test(lower) && lower.includes("account"))) {
    return { name: "EA App", type: "ea", shortName: "EA App" };
  }
  if (lower.includes("ubisoft")) {
    return { name: "Ubisoft Connect", type: "ubisoft", shortName: "Ubisoft" };
  }
  if (lower.includes("rockstar")) {
    return { name: "Rockstar Games Launcher", type: "rockstar", shortName: "Rockstar" };
  }
  if (lower.includes("gog")) {
    return { name: "GOG GALAXY", type: "gog", shortName: "GOG" };
  }
  return null;
}

function gamePartner(s: EpicSummary, g: ReturnType<typeof rawOf>): ThirdPartyLauncherInfo | null {
  const notice = S.steamDetails.get(s.appName)?.extUserAccountNotice || "";
  return partnerFromSteamNotice(notice) || getThirdPartyLauncher(g, s.title, steamStudioHints(s.appName));
}

function gameAntiCheat(s: EpicSummary, g: ReturnType<typeof rawOf>): string | null {
  const named = getAntiCheat(g, s.title, s.appName);
  if (named) return named;
  const drm = (S.steamDetails.get(s.appName)?.drmNotice || "").toLowerCase();
  if (drm.includes("easy anti-cheat") || drm.includes("easyanticheat")) return "Easy Anti-Cheat";
  if (drm.includes("battleye")) return "BattlEye";
  const cats = S.steamDetails.get(s.appName)?.categories ?? [];
  if (cats.includes(8)) return "VAC";
  return null;
}

function gameDeveloper(s: EpicSummary, g: ReturnType<typeof rawOf>): string {
  if (s.appName.startsWith("gog::")) {
    return S.gogSummariesMap.get(s.appName.slice(5))?.developer || "";
  }
  const epicDev = g?.metadata?.developer;
  if (typeof epicDev === "string" && epicDev.trim()) return epicDev;
  const d = S.steamDetails.get(s.appName);
  return d?.developers[0] || d?.publishers[0] || "";
}

function gameMetaHtml(s: EpicSummary, partner: ThirdPartyLauncherInfo | null, antiCheat: string | null): string {
  const dev = gameDeveloper(s, rawOf(s.appName));
  return [
    dev ? `<span>${esc(dev)}</span>` : "",
    s.appName.startsWith("gog::") ? `<span class="gp-meta-item" title="GOG.COM DRM-Free">${icon("unlock", 13)} DRM-Free</span>` : "",
    partner ? `<span class="gp-meta-item" title="${esc(t("drawer.partnerRequired", { name: partner.name }))}">${icon("layers", 13)} ${esc(partner.name)}</span>` : "",
    antiCheat ? `<span class="gp-meta-item" title="${esc(t("drawer.anticheatTitle", { name: antiCheat }))}">${icon("shield", 13)} ${esc(antiCheat)}</span>` : "",
  ].filter(Boolean).join("");
}

function paintGameCloud(s: EpicSummary): void {
  const el = document.getElementById("gp-stat-cloud-val");
  if (!el) return;
  const isEpic = !s.appName.startsWith("gog::") && !s.appName.startsWith("steam::");
  if (!isEpic) return;
  const g = rawOf(s.appName);
  const info = heroCloudStatus(s, g, gamePartner(s, g));
  el.textContent = info.label;
  el.classList.toggle("ok", info.synced);
  el.classList.toggle("warn", !info.synced && !info.neutral && info.label !== "—");
  const wrap = el.closest(".gp-stat");
  if (wrap) wrap.setAttribute("title", info.tooltip);
}

const cloudStampAsked = new Set<string>();

/** Loads last-sync once so the hero CLOUD chip is a real status, not a guess. */
function ensureCloudSyncStamp(s: EpicSummary): void {
  const appName = s.appName;
  if (cloudStampAsked.has(appName)) return;
  if (appName.startsWith("gog::") || appName.startsWith("steam::") || !s.installed) {
    cloudStampAsked.add(appName);
    return;
  }
  cloudStampAsked.add(appName);
  void epicGetGameSettings(appName)
    .then((st) => {
      if (st.lastCloudSync) {
        rememberCloudSync(appName, st.lastCloudSync);
        if (S.activeManageSettings?.appName === appName) {
          S.activeManageSettings.lastCloudSync = st.lastCloudSync;
        }
      }
      if (S.currentModalAppName === appName) paintGameCloud(s);
    })
    .catch(() => {});
}

function mergeSteamCritic(data: CriticData, appName: string): CriticData {
  if (data.metacritic_score || !appName.startsWith("steam::")) return data;
  const details = S.steamDetails.get(appName);
  if (!details?.metacriticScore) return data;
  return {
    ...data,
    supported: true,
    metacritic_score: details.metacriticScore,
    metacritic_url: details.metacriticUrl || data.metacritic_url,
  };
}

function paintGameMeta(s: EpicSummary): void {
  const el = document.getElementById("gp-meta");
  if (!el) return;
  const g = rawOf(s.appName);
  el.innerHTML = gameMetaHtml(s, gamePartner(s, g), gameAntiCheat(s, g));
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

function primaryAction(s: EpicSummary, p: number | null, partner: ThirdPartyLauncherInfo | null): string {
  if (p !== null) {
    return `<button class="btn primary lg" data-view="downloads" data-dlbtn="${s.appName}">${icon("download", 16)} ${t("common.downloading", { p })}</button>`;
  }
  if (isAppDownloading(s.appName)) {
    return `<button class="btn primary lg" data-view="downloads" data-dlbtn="${s.appName}">${icon("download", 16)} ${t("steam.downloading")}</button>`;
  }
  if (S.runningGames.has(s.appName)) {
    return `<button class="btn play lg" data-act="epic-stop" data-id="${s.appName}">${icon("square", 16)} ${t("common.stop")}</button>`;
  }
  if (s.appName.startsWith("ea::") || s.appName.startsWith("ubisoft::") || s.appName.startsWith("xbox::") || s.appName.startsWith("battlenet::")) {
    return s.installed
      ? `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`
      : `<button class="btn install lg" data-act="epic-play" data-id="${s.appName}">${icon("download", 16)} ${t("common.install")}</button>`;
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

/** Store chip in the action row. A dropdown when the game is owned on several stores. */
function sourceChipHtml(appName: string): string {
  const versions = gameVersionsOf(appName);
  const activeSource = versions.find((v) => v.appName === appName)?.source ?? sourceOfKey(appName);
  const label = storeVersionLabel(activeSource);
  const mark = `${storeLogo(activeSource, 18)}<span>${esc(label)}</span>`;
  if (versions.length < 2) {
    return `<div class="gp-source static" title="${esc(`${t("lib.storeBy")} ${label}`)}">${mark}</div>`;
  }
  const row = (v: (typeof versions)[number]): string => {
    const name = storeVersionLabel(v.source);
    const active = v.appName === appName;
    return `<button type="button" class="gp-store-row ${active ? "selected" : ""}" role="option" aria-selected="${active}" data-act="switch-drawer-version" data-id="${esc(v.appName)}">
      ${storeLogo(v.source, 28)}
      <span class="gp-store-text"><span class="gp-store-name">${name}</span><span class="gp-store-sub ${v.installed ? "ok" : ""}">${esc(v.installed ? t("common.installed") : t("common.notInstalled"))}</span></span>
      <span class="gp-store-trail">${active ? icon("check", 14) : ""}</span>
    </button>`;
  };
  return `<div class="gp-version-dropdown">
      <button type="button" class="gp-source gp-version-trigger" data-act="toggle-version-dropdown" aria-haspopup="listbox" aria-expanded="${S.isVersionDropdownOpen}" title="${esc(`${t("lib.storeBy")} ${label}`)}">
        ${mark}${icon("chevron-down", 13)}
      </button>
      <div id="version-dropdown-menu" class="gp-version-menu ${S.isVersionDropdownOpen ? "show" : ""}" role="listbox">
        ${versions.map(row).join("")}
      </div>
    </div>`;
}

/** Games owned inside another launcher: EA App, Ubisoft Connect, Xbox, Battle.net. */
function isCompanionApp(appName: string): boolean {
  const source = sourceOfKey(appName);
  return source !== "epic" && source !== "gog" && source !== "steam";
}

/** Primary action + favorite/store/cancel buttons (re-rendered on state changes). */
function actionsHtml(s: EpicSummary, partner: ThirdPartyLauncherInfo | null): string {
  const faved = S.epicFav.has(s.appName);
  const isGog = s.appName.startsWith("gog::");
  const storeTitle = t(isGog ? "drawer.storeTitleGog" : "drawer.storeTitle");

  // Games from another saved account cannot be installed or managed with the
  // active one, so the action bar offers the one-click account switch instead.
  const sharedOwner = sharedOwnerOf(s.appName);
  if (sharedOwner) {
    return `
      <button class="btn primary lg" data-act="shared-switch" data-id="${sharedOwner.ownerKey}" title="${t("shared.detailNote", { name: esc(sharedOwner.ownerName) })}">${icon("arrow-left-right", 16)} ${t("shared.switchTo", { name: esc(sharedOwner.ownerName) })}</button>
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      <button class="btn ghost lg icon-only" data-act="epic-store-page" data-id="${s.appName}" title="${storeTitle}">${icon("external", 16)}</button>
      ${sourceChipHtml(s.appName)}`;
  }

  // Companion games stay inside their client: install, uninstall and play all
  // go through that client's protocol handlers.
  if (isCompanionApp(s.appName)) {
    const store = sourceOfKey(s.appName);
    const primary = s.installed
      ? `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`
      : `<button class="btn install lg" data-act="companion-install" data-id="${s.appName}" data-store="${store}">${icon("download", 16)} ${t("common.install")}</button>`;
    const remove = s.installed
      ? `<button class="btn ghost lg danger" data-act="companion-uninstall" data-id="${s.appName}" data-store="${store}">${icon("trash", 16)} ${t("common.uninstall")}</button>`
      : "";
    return `${primary}
      <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
      <button class="btn ghost lg" data-act="companion-open" data-id="${store}">${icon("external", 16)} ${t("accounts.openClient")}</button>
      ${remove}
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      ${sourceChipHtml(s.appName)}`;
  }

  // Steam games are owned by the Steam client: play, update and verify all
  // hand off through it, and nothing is installed by the launcher itself.
  if (s.appName.startsWith("steam::")) {
    const steamId = s.appName.slice(7);
    const isDl = isAppDownloading(s.appName);
    const steamPct = isDl ? epicDlProgress(s.appName) : null;
    const primary = isDl
      ? `<button class="btn primary lg" data-view="downloads" data-dlbtn="${s.appName}" title="${esc(t("steam.downloadingHint"))}">${icon("download", 16)} ${steamPct !== null ? t("common.downloading", { p: steamPct }) : t("steam.downloading")}</button>`
      : !s.installed
        ? `<button class="btn install lg" data-act="steam-action" data-id="${steamId}" data-mode="install">${icon("download", 16)} ${t("common.install")}</button>`
        : s.updateAvailable
          ? `<button class="btn update lg" data-act="steam-action" data-id="${steamId}" data-mode="update">${icon("download", 16)} ${t("common.update")}</button>`
          : `<button class="btn play lg" data-act="steam-action" data-id="${steamId}" data-mode="launch">${icon("play", 16)} ${t("common.play")}</button>`;
    return `${primary}
      <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      <button class="btn ghost lg icon-only" data-act="epic-store-page" data-id="${s.appName}" title="${t("drawer.storeTitleSteam")}">${icon("external", 16)}</button>
      ${sourceChipHtml(s.appName)}`;
  }

  const p = epicDlProgress(s.appName);
  const isDl = isAppDownloading(s.appName);
  return `
    ${primaryAction(s, p, partner)}
    <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
    <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
    <button class="btn ghost lg icon-only" data-act="epic-store-page" data-id="${s.appName}" title="${storeTitle}">${icon("external", 16)}</button>
    ${(p !== null || isDl) ? `<button class="btn ghost lg danger" data-act="epic-cancel" data-id="${s.appName}">${t("common.cancel")}</button>` : ""}
    ${sourceChipHtml(s.appName)}`;
}

function renderActiveTab(s: EpicSummary, partner: ThirdPartyLauncherInfo | null, antiCheat: string | null): string {
  if (isCompanionApp(s.appName)) return renderDrawerOverview(s, partner, antiCheat);
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

/** Split Epic's catalog blurb into readable paragraphs. */
function aboutMarkup(text: string): string {
  const parts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.map((part) => `<p>${esc(part)}</p>`).join("");
}

/** IGDB has no keyless API, so the About box links to its search page. */
function igdbSearchUrl(title: string): string {
  return `https://www.igdb.com/search?type=1&q=${encodeURIComponent(title)}`;
}

/** Epic's catalog description (raw or from the store data); empty when unusable. */
function epicDescription(s: EpicSummary): string {
  const rawDesc = s.description?.trim();
  const hasRealDesc = rawDesc && rawDesc !== NO_DESC && rawDesc !== s.title && rawDesc.length > 25;
  const reqData = S.loadedRequirements.get(s.appName);
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : "");
  return (hasRealDesc ? rawDesc : storeDesc) || "";
}

/** Wikipedia fallback text per game + language ("" = checked, nothing found). */
const aboutCache = new Map<string, string>();

/** Games whose store-side "about" sources have all settled. */
const storeAboutSettled = new Set<string>();

function aboutKey(appName: string): string {
  return `${appName}|${currentLanguage()}`;
}

/**
 * Order: the game's own store first (Epic/GOG), then Wikipedia.
 *
 * The wiki fallback is deliberately NOT requested until the store lookup has
 * settled. Starting it earlier made Wikipedia appear first and then get
 * replaced by the store text, which read like a wrong description.
 */
function maybeLoadWikiAbout(s: EpicSummary): void {
  if (epicDescription(s)) return;
  if (!storeAboutSettled.has(s.appName)) return;
  if (!S.loadedRequirements.has(s.appName)) return;
  const key = aboutKey(s.appName);
  if (aboutCache.has(key) || S.loadingAboutFor === key) return;
  S.loadingAboutFor = key;
  void loadWikiAbout(s).finally(() => {
    if (S.loadingAboutFor === key) S.loadingAboutFor = null;
  });
}

async function loadWikiAbout(s: EpicSummary): Promise<void> {
  try {
    const wiki = await epicGetWikiAbout(s.title, s.appName, currentLanguage());
    aboutCache.set(aboutKey(s.appName), wiki.description?.trim() || "");
  } catch (err) {
    console.warn("Wiki about could not be loaded:", err);
  } finally {
    paintAboutText(s);
  }
}

/** Source note under the description: the game's own store, or the Wikipedia fallback. */
function aboutSourceText(storeDesc: string, wikiText: string, source: "epic" | "gog" | "steam" | "ea" | "ubisoft" | "xbox" | "battlenet"): string {
  const storeName = source === "gog" ? "GOG" : source === "steam" ? "Steam" : source === "ea" ? "EA App" : source === "ubisoft" ? "Ubisoft Connect" : source === "xbox" ? "Xbox" : source === "battlenet" ? "Battle.net" : "Epic Games Store";
  if (!storeDesc && wikiText) return t("drawer.wikiSource", { store: storeName });
  if (source === "gog") return t("drawer.sourceGog");
  if (source === "steam") return t("drawer.sourceSteam");
  return t("drawer.sourceEpic");
}

/** Paints the About box and its source note from the current sources. */
function paintAboutText(s: EpicSummary): void {
  if (S.currentModalAppName !== s.appName) return;
  const descEl = document.getElementById("hub-desc-text");
  if (!descEl) return;
  const storeDesc = epicDescription(s);
  const wikiText = aboutCache.get(aboutKey(s.appName)) || "";
  const text = storeDesc || wikiText;
  descEl.innerHTML = text ? aboutMarkup(text) : `<p>${t("drawer.noDescription")}</p>`;
  const srcEl = document.getElementById("hub-desc-source");
  if (srcEl) {
    srcEl.hidden = !text;
    srcEl.textContent = aboutSourceText(storeDesc, wikiText, sourceOfKey(s.appName));
  }
}

/** Kicks off the lazy overview fetches (HLTB, critic, store data) once per game. */
function ensureOverviewData(s: EpicSummary): void {
  const appName = s.appName;
  if (S.activeDrawerTab !== "overview") return;
  if (!S.loadedHltb.has(appName) && S.loadingHltbFor !== appName) {
    S.loadingHltbFor = appName;
    epicGetHltb(s.title, appName)
      .then((data) => {
        S.loadedHltb.set(appName, data);
        if (S.currentModalAppName !== appName) return;
        const el = document.getElementById("gp-progress");
        if (el) el.outerHTML = renderProgressStrip(s);
      })
      .catch(() => {})
      .finally(() => { S.loadingHltbFor = null; });
  }
  if (!S.loadedCritic.has(appName) && S.loadingCriticFor !== appName) {
    S.loadingCriticFor = appName;
    epicGetCritic(s.title, appName)
      .then((data) => {
        const merged = mergeSteamCritic(data, appName);
        S.loadedCritic.set(appName, merged);
        if (S.currentModalAppName === appName) updateCriticUI(appName, merged);
      })
      .catch(() => {})
      .finally(() => { S.loadingCriticFor = null; });
  }

  // Fetch official GOG metadata on demand
  if (appName.startsWith("gog::")) {
    const rawId = appName.slice(5);
    const detailsP = gogGetGameDetails(rawId)
      .then((details) => {
        if (details.requirements) {
          S.loadedRequirements.set(appName, details.requirements);
        }
        if (S.currentModalAppName !== appName) return;
        if (details.description && !s.description) {
          s.description = cleanStoreDescription(details.description);
          paintAboutText(s);
        }
        if (details.hero_url) {
          const heroEl = modalRoot.querySelector<HTMLImageElement>(".gp-hero-img");
          if (heroEl) heroEl.src = details.hero_url;
        }
        if (details.developer) {
          const item = S.gogSummariesMap.get(rawId);
          if (item) item.developer = details.developer;
          paintGameMeta(s);
          paintGameCloud(s);
        }
      })
      .catch(() => {});
    const reqP =
      !S.loadedRequirements.has(appName) && S.loadingReqFor !== appName
        ? fetchAndRenderRequirements(appName, s.title)
        : Promise.resolve();
    // GOG has two store-side sources (details + requirements): the wiki may only
    // start once both have settled, otherwise its text would flash and be
    // replaced by the store description.
    void Promise.allSettled([detailsP, reqP]).then(() => {
      storeAboutSettled.add(appName);
      maybeLoadWikiAbout(s);
    });
    if (!S.loadedAchievements.has(appName) && S.loadingAchFor !== appName) {
      void fetchAndRenderAchievements(appName);
    }
  } else {
    // Epic: the store description arrives with the requirements call.
    maybeLoadWikiAbout(s);
  }
}

export function openEpicModal(appName: string, isInitialOpen = true, _animateTabContent = true): void {
  const s = summaryOf(appName);
  if (!s) return;
  const isSameApp = S.currentModalAppName === appName;
  S.currentModalAppName = appName;
  S.isVersionDropdownOpen = false;
  if (isInitialOpen) {
    S.activeDrawerTab = "overview";
    S.activeAchFilter = "all";
    S.achSearchQuery = "";
    S.achSortOrder = "default";
  }
  const g = rawOf(appName);
  const partner = gamePartner(s, g);
  const antiCheat = gameAntiCheat(s, g);
  const companion = isCompanionApp(appName);
  // Companion games only have the overview: the other tabs read store metadata
  // they do not have.
  if (companion) S.activeDrawerTab = "overview";

  ensureOverviewData(s);
  if (companion) {
    // No Epic metadata: the title-based Wikipedia lookup fills the About box.
    const key = aboutKey(appName);
    if (!aboutCache.has(key) && S.loadingAboutFor !== key) {
      S.loadingAboutFor = key;
      void loadWikiAbout(s).finally(() => {
        if (S.loadingAboutFor === key) S.loadingAboutFor = null;
      });
    }
  } else {
    ensureCloudSyncStamp(s);
    if (!S.loadedRequirements.has(appName) && S.loadingReqFor !== appName) void fetchAndRenderRequirements(appName, s.title);
    if (!S.loadedScreenshots.has(appName) && S.loadingScreenshotsFor !== appName) void fetchAndRenderScreenshots(appName, s.title);
    if (!S.loadedAchievements.has(appName) && S.loadingAchFor !== appName) void fetchAndRenderAchievements(appName);
    ensureEosSupport(appName);
  }

  const dlcRes = S.dlcCache.get(appName);
  const dlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const ssCount = S.loadedScreenshots.get(appName)?.length ?? 0;
  const isPlat = isAppPlatinum(appName);

  // Tab switch / live refresh on the SAME game: patch the tab strip and content only.
  const contentEl = document.getElementById("drawer-tab-content");
  if (!isInitialOpen && isSameApp && contentEl && modalRoot.querySelector(".game-hub")) {
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
    paintGameMeta(s);
    paintGameCloud(s);
    return;
  }

  const isGog = appName.startsWith("gog::");
  const isSteam = appName.startsWith("steam::");
  const isEpic = sourceOfKey(appName) === "epic";
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  const achSum = S.epicAchSummaries[appName];
  const pt = S.playtimeMap.get(appName);
  const achVal = achSum && achSum.total_achievements > 0
    ? `${achSum.user_unlocked}/${achSum.total_achievements}`
    : "—";

  const meta = gameMetaHtml(s, partner, antiCheat);
  const cloud = heroCloudStatus(s, g, partner);

  const stat = (label: string, value: string, attrs = "", valId = "", valCls = ""): string =>
    `<div class="gp-stat${attrs.includes("data-act") ? " clickable" : ""}" ${attrs}><span class="gp-stat-label">${label}</span><span class="gp-stat-val ${valCls}"${valId ? ` id="${valId}"` : ""}>${value}</span></div>`;
  const cloudTone = cloud.synced ? "ok" : (cloud.label !== "—" ? "warn" : "");
  const tabs = companion
    ? tabButton("overview", t("drawer.overview"))
    : `${tabButton("overview", t("drawer.overview"))}
       ${tabButton("achievements", t("drawer.achievements"), 0, isPlat ? "plat" : "")}
       ${tabButton("dlcs", t("drawer.dlcs"), dlcCount)}
       ${tabButton("screenshots", t("drawer.screenshots"), ssCount)}
       ${tabButton("specs", t("drawer.specs"))}`;

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
            <div class="gp-meta" id="gp-meta">${meta}</div>
          </div>
        </div>

        <div class="gp-bar">
          <div class="gp-bar-left">
            <div class="gp-actions">${actionsHtml(s, partner)}</div>
          </div>
          <div class="gp-stats">
            ${stat(t("drawer.statTime"), esc(pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—"), `data-act="open-edit-playtime" data-id="${appName}" title="${t("drawer.editPlaytime")}"`, "drawer-stat-playtime")}
            ${stat(isPlat ? t("drawer.statPlat") : t("drawer.statTrophy"), achVal, achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${appName}" title="${t("drawer.viewAchievements")}"` : "", "", isPlat ? "plat" : "")}
            ${isEpic ? stat(t("drawer.statCloud"), esc(cloud.label), `title="${esc(cloud.tooltip)}"`, "gp-stat-cloud-val", cloudTone) : ""}
          </div>
        </div>

        <div class="gp-body">
          <div class="tabs gp-tabs" id="drawer-tabs-scrollable">
            ${tabs}
          </div>
          <div id="drawer-tab-content">${renderActiveTab(s, partner, antiCheat)}</div>
        </div>
      </div>
    </div>`;

  if (!companion && !isGog && !S.dlcCache.has(appName)) {
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
  const epicDesc = epicDescription(s);
  const key = aboutKey(s.appName);
  const wikiText = aboutCache.get(key) || "";
  // The game's own store (Epic) wins; Wikipedia is the fallback. The source
  // note under the box tells the user when the fallback is being used.
  const effectiveDesc = epicDesc || wikiText || null;
  const aboutResolved = aboutCache.has(key);
  const aboutLoading = !effectiveDesc && !aboutResolved && (S.loadingReqFor === s.appName || S.loadingAboutFor === key);
  const sourceText = aboutSourceText(epicDesc, wikiText, sourceOfKey(s.appName));
  const sourceHidden = !effectiveDesc;

  return `
    <div class="hub-overview-layout">
      <div class="hub-overview-main">
        <div id="drawer-col-chips-container" class="gp-tags gp-about-tags">${renderCollectionTags(s.appName)}</div>
        <section class="gp-section">
          <h3 class="gp-section-title">${t("drawer.aboutGame")}</h3>
          <div class="hub-desc-text" id="hub-desc-text">${
            aboutLoading
              ? `<div class="hub-desc-loading"><span class="spinner"></span><span>${t("drawer.loadingAbout")}</span></div>`
              : effectiveDesc
                ? aboutMarkup(effectiveDesc)
                : `<p>${t("drawer.noDescription")}</p>`
          }</div>
          <p class="hub-desc-igdb">
            <button type="button" class="btn ghost small" data-act="open-external-url" data-url="${igdbSearchUrl(s.title)}">${icon("external", 13)} ${t("drawer.igdbLink")}</button>
          </p>
          <p class="hub-desc-source" id="hub-desc-source"${sourceHidden ? " hidden" : ""}>${sourceText}</p>
        </section>
        ${renderMomentsStrip(s.appName)}
        ${renderNextAchievements(s.appName)}
      </div>
      <aside class="hub-overview-sidebar">
        ${renderProgressStrip(s)}
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
  // Steam lists DLC ids only; names would need one store call per add-on, so the
  // tab reports the count and hands the browsing over to Steam.
  if (s.appName.startsWith("steam::")) {
    const details = S.steamDetails.get(s.appName);
    if (!details && S.loadingReqFor !== s.appName) {
      void fetchAndRenderRequirements(s.appName, s.title);
      return loadingState(t("dlc.scanning"));
    }
    const count = details?.dlc.length ?? 0;
    if (count === 0) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    return `
      <div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("steam.dlcCount", { count })}</div>
            <div class="row-meta">${t("steam.dlcDesc")}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.storeTitleSteam")}</button>
          </div>
        </div>
      </div>`;
  }
  if (s.appName.startsWith("gog::")) {
    const count = s.dlcCount || S.allGamesMap.get(s.appName)?.dlcCount || 0;
    if (count === 0) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    return `
      <div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("gog.dlcCount", { count })}</div>
            <div class="row-meta">${t("gog.dlcDesc")}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.storeTitleGog")}</button>
          </div>
        </div>
      </div>`;
  }
  const dlcRes = S.dlcCache.get(s.appName);
  if (S.dlcLoading && !dlcRes) return loadingState(t("dlc.scanning"));
  const allDlcs = dlcRes?.dlcs || [];
  const storeBtn = `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.discoverDlc")}</button>`;
  if (allDlcs.length === 0) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));

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
  const partner = gamePartner(s, rawOf(s.appName));

  if (S.loadingAchFor === s.appName) return loadingState(t("ach.loadingStore"));
  const data = S.loadedAchievements.get(s.appName);
  if (!data) {
    void fetchAndRenderAchievements(s.appName);
    return loadingState(t("ach.checking"));
  }

  if (data.achievements.length === 0) {
    if (partner) {
      return emptyState("gamepad-2", t("ach.partnerTitle", { name: esc(partner.name) }), t("ach.partnerDesc", { name: `<strong>${esc(partner.name)}</strong>` }));
    }
    return emptyState("trophy", t("ach.noSupportTitle"), t("ach.noSupportDesc"));
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
    const isGog = appName.startsWith("gog::");
    const isSteam = appName.startsWith("steam::");
    const rawId = isGog ? appName.slice(5) : appName;
    const data = isGog
      ? await gogGetAchievements(rawId)
      : isSteam
        ? await steamGetAchievements(appName.slice(7), forceRefresh)
        : await epicGetAchievements(appName, forceRefresh);
    S.loadedAchievements.set(appName, data);
    const summary: EpicAchievementSummary = {
      app_name: appName,
      user_unlocked: data.user_unlocked,
      total_achievements: data.total_achievements,
      user_xp: data.user_xp,
      total_xp: data.total_xp,
      is_platinum: data.is_platinum,
      supported: (data.total_achievements ?? 0) > 0,
    };
    S.epicAchSummaries[appName] = summary;
    if (isGog) {
      S.epicAchSummaries[rawId] = summary;
      S.epicAchSummaries[`gog::${rawId}`] = summary;
    }
    patchLibraryCardDom(appName);
    if (isGog) patchLibraryCardDom(rawId);
    invalidateLibraryVisibleCache();
  } catch (e) {
    console.warn("Achievements could not be fetched or this game has no achievement support:", e);
    S.loadedAchievements.set(appName, { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false });
  } finally {
    S.loadingAchFor = null;
    if (S.currentModalAppName === appName && (S.activeDrawerTab === "achievements" || S.activeDrawerTab === "overview")) {
      openEpicModal(appName, false, false);
    }
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
    return emptyState("cpu", t("sys.notFoundTitle"), t("sys.notFoundDesc"));
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
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t(s.appName.startsWith("gog::") ? "sys.openGogStore" : s.appName.startsWith("steam::") ? "drawer.storeTitleSteam" : "sys.openEpicStore")}</button>
      </div>
    </div>`;
}

export async function fetchAndRenderRequirements(appName: string, title: string, forceRefresh = false): Promise<void> {
  if (!isTauri || S.loadingReqFor === appName) return;
  // Steam: one store call carries the description, the hero art and the specs.
  if (appName.startsWith("steam::")) {
    await loadSteamDetails(appName, forceRefresh);
    return;
  }
  S.loadingReqFor = appName;
  try {
    const isGog = appName.startsWith("gog::");
    const rawId = isGog ? appName.slice(5) : appName;
    const data = isGog ? await gogGetSystemRequirements(rawId) : await epicGetSystemRequirements(title, appName, forceRefresh);
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
        const text = data.shortDescription || cleanStoreDescription(data.description || "");
        if (descEl && text) {
          // The game's own store always outranks the Wikipedia fallback.
          descEl.innerHTML = aboutMarkup(text);
          const srcEl = document.getElementById("hub-desc-source");
          if (srcEl) {
            srcEl.hidden = false;
            srcEl.textContent = t("drawer.sourceEpic");
          }
        } else if (descEl?.querySelector(".hub-desc-loading") && S.loadingAboutFor !== aboutKey(appName)) {
          // Store data arrived without a description and no fallback is pending.
          descEl.innerHTML = `<p>${t("drawer.noDescription")}</p>`;
        }
      }
      const featuresEl = document.getElementById("hub-features-list");
      if (featuresEl) {
        const g = rawOf(appName);
        featuresEl.innerHTML = renderGameFeatures(cur, g, gamePartner(cur, g), gameAntiCheat(cur, g), data);
      }
    }
  } catch (e) {
    console.warn("System requirements could not be fetched:", e);
    S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
  } finally {
    S.loadingReqFor = null;
    // Epic's description arrives with this call: mark the store side settled and
    // only then decide whether the wiki fallback is needed. GOG is marked by the
    // details + requirements pair in `ensureOverviewData`.
    if (!appName.startsWith("gog::")) {
      storeAboutSettled.add(appName);
      const settled = summaryOf(appName);
      if (settled) maybeLoadWikiAbout(settled);
    }
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") openEpicModal(appName, false);
  }
}

/**
 * Steam store details arrive in a single call: description, developer, hero art
 * and the requirement bullets. The Rust side caches the payload for six hours.
 */
async function loadSteamDetails(appName: string, force = false): Promise<void> {
  const s = summaryOf(appName);
  if (!s) return;
  S.loadingReqFor = appName;
  try {
    const details = await steamGetGameDetails(appName.slice(7), steamLanguage(S.appLanguage), force);
    S.steamDetails.set(appName, details);
    S.loadedRequirements.set(appName, buildSteamRequirements(appName, details));
    if (S.currentModalAppName === appName) {
      if (details.description || details.shortDescription) {
        s.description = details.description || details.shortDescription;
        paintAboutText(s);
      }
      // Never downgrade the hero: `library_hero.jpg` is 1920×620 while the
      // store header is only 460×215, so swapping it in later looked pixelated.
      // It is used only when the hero art itself fails to load.
      const heroEl = modalRoot.querySelector<HTMLImageElement>(".gp-hero-img");
      if (heroEl && details.headerImage) {
        const fallback = details.headerImage;
        heroEl.addEventListener("error", () => { heroEl.src = fallback; }, { once: true });
        if (heroEl.complete && heroEl.naturalWidth === 0) heroEl.src = fallback;
      }
      paintGameMeta(s);
      paintGameCloud(s);
      const cloud = details.categories.includes(23);
      const item = S.allGamesMap.get(appName) || S.steamSummariesMap.get(appName);
      if (item) {
        item.cloudSavesSupported = cloud;
        item.dlcCount = details.dlc.length;
      }
      const critic = S.loadedCritic.get(appName);
      if (critic) {
        const merged = mergeSteamCritic(critic, appName);
        S.loadedCritic.set(appName, merged);
        updateCriticUI(appName, merged);
      }
    }
  } catch {
    S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
  } finally {
    S.loadingReqFor = null;
    storeAboutSettled.add(appName);
    maybeLoadWikiAbout(s);
    if (S.currentModalAppName === appName && (S.activeDrawerTab === "specs" || S.activeDrawerTab === "overview")) {
      openEpicModal(appName, false, false);
    }
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
