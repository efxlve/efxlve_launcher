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

import { achSummaryOf, epicDlProgress, isAppDownloading, isAppPlatinum, patchLibraryCardDom } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon, loadingState, type IconName } from "../../core/icons";
import { updateNavHistoryUi } from "../../core/nav";
import { cachedImage, warmImages } from "../../core/picture-cache";
import { recordSessionSummary, sessionSummaryFor } from "../../core/session-summary";
import { steamNews, type SteamNewsItem } from "../../steam";
import { presenceSync, updateGamepadHud } from "../../core/render";
import { canonicalGameTitle, epicWideArt, gameVersionsOf, isCompanionKey, isCompanionSource, libraryPlaytime, rawOf, sharedOwnerOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { storeVersionLabel } from "./external-versions";
import { sideCard } from "./side-widgets";
import { storeLogo } from "../store/store-logos";
import { holdStoreForCover } from "../store/store-view";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { epicDetectEos, epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetGameSettings, epicGetHltb, epicGetSystemRequirements, epicGetWikiAbout, epicPortrait, getAntiCheat, getThirdPartyLauncher, requiresThirdPartyLauncher, type CriticData, type EpicAchievementSummary, type EpicAchievementsData, type EpicSummary, type HltbData, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";
import { gogGetAchievements, gogGetSystemRequirements } from "../../gog";
import { loadGogDetails } from "./game-details-cache";
import { steamGetGameDetails, steamFindStoreApp } from "../../steam";
import { steamGetAchievements } from "../../steam";
import { companionAchievements } from "../../companion";
import { buildSteamRequirements, steamLanguage } from "./steam-details";

import { invalidateLibraryVisibleCache } from "../library/library-view";
import { renderDrawerManage } from "../manage/manage-view";
import { fetchAndRenderScreenshots, forgetGameScreenshots, renderDrawerScreenshots, renderMomentsStrip } from "../screenshots/screenshots-view";
import { cachedNotes, notesForScope } from "../notes/notes-client";
import { notePreview } from "../notes/markdown";
import { ensureDrawerNotes, renderDrawerNotes } from "../notes/drawer-notes";
import { igdbImage, igdbStatus } from "../../igdb";
import { ageOrgOrder, ensureIgdbOverview, gameGenresFor, igdbAboutSettled, igdbGameFor, igdbTagsFor, renderIgdbCredits, renderIgdbMedia, renderIgdbSimilar } from "./igdb-view";
import { cleanStoreDescription, detectGameMode, getAchTier, getHardwareLabel, heroCloudStatus, isMacSys, isWinSys, rememberCloudSync, renderAchievementSections, renderControllerCard, renderCriticCard, renderGameFeatures, renderHltbCard, renderInstalledCopyFacts, renderLastSession, renderNextAchievements, renderSteamNews, renderSupportedLanguages, verifySystemDetails } from "./drawer-widgets";

/** True once the open game page has played its one-shot platinum shine sweep. */
let platShineDone = false;

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
  // Companion games are owned and launched by their own client, so the client
  // itself is the external launcher (features, cloud and meta rows).
  switch (sourceOfKey(s.appName)) {
    case "ea": return { name: "EA App", type: "ea", shortName: "EA App" };
    case "ubisoft": return { name: "Ubisoft Connect", type: "ubisoft", shortName: "Ubisoft" };
    case "xbox": return { name: "Xbox", type: "other", shortName: "Xbox" };
    case "battlenet": return { name: "Battle.net", type: "other", shortName: "Battle.net" };
    case "riot": return { name: "Riot Client", type: "other", shortName: "Riot" };
    default: break;
  }
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
  // IGDB knows the studio that made the game; the store catalogs often list the
  // publisher or nothing at all. Their fields stay as the fallback.
  const igdbDev = igdbGameFor(s.appName)?.developer ?? "";
  if (igdbDev) return igdbDev;
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
  // IGDB carries the release year; the store catalog often does not. The PC
  // date wins, so a remaster does not show its console release here.
  const igdb = igdbGameFor(s.appName);
  const year = igdb?.pcReleaseYear ?? igdb?.releaseYear ?? null;
  // The publisher is the developer's stand-in, not a second name: "Grove Street
  // Games · Rockstar Games" reads as two studios, and the line is meant to stay
  // calm. It only shows when nothing else names the maker.
  const publisher = !dev && igdb?.publisher ? igdb.publisher : "";
  // One age rating — the one the user's region reads first. The others stay in
  // its tooltip: a "+3" counter is a database habit, and the reader who wants
  // the rest is the reader who hovers.
  const rated = (igdb?.ageRatings ?? []).filter((rating) => rating.rating);
  const preferred =
    ageOrgOrder()
      .map((org) => rated.find((rating) => rating.organization === org))
      .find((rating) => rating !== undefined) ?? rated[0];
  const labelOf = (rating: { organization: string; rating: string }) =>
    rating.organization ? `${rating.organization} ${rating.rating}` : rating.rating;
  // Wrapped, so the meta line's separator dot stays outside the pill.
  const ageChip = preferred
    ? `<span class="gp-meta-item" title="${esc(rated.map(labelOf).join(" · "))}"><span class="igdb-age-chip">${esc(labelOf(preferred))}</span></span>`
    : "";
  const colTags = renderCollectionTags(s.appName);
  const colChip = `<span id="drawer-col-chips-container" class="gp-hero-tags"${!colTags ? ' style="display:none;"' : ""}>${colTags}</span>`;
  // The one line under the title: who made it, when, for whom.
  // Everything else about the copy lives in the features card.
  return [
    dev ? `<span>${esc(dev)}</span>` : "",
    publisher ? `<span class="gp-meta-item">${esc(publisher)}</span>` : "",
    year ? `<span class="gp-meta-item">${icon("calendar", 13)} ${year}</span>` : "",
    colChip,
    ageChip,
    s.appName.startsWith("gog::") ? `<span class="gp-meta-item" title="GOG.COM DRM-Free">${icon("unlock", 13)} DRM-Free</span>` : "",
    S.steamSharedIds.has(s.appName)
      ? `<span class="gp-meta-item" title="${esc(t("drawer.familySharingTip"))}">${icon("users", 13)} ${esc(t("drawer.familySharing"))}</span>`
      : "",
  ].filter(Boolean).join("");
}

function paintGameCloud(s: EpicSummary): void {
  const el = document.getElementById("gp-stat-cloud-val");
  if (!el) return;
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
  // Any store, not just Steam: the store-page lookup that fills this map runs for
  // every game (the specs need it), so an Epic title can carry a Metacritic score
  // it would otherwise never show.
  const details = S.steamDetails.get(appName);
  if (!details?.metacriticScore) return data;
  // Steam's own block is per app id, so it beats the wiki lookup — that one can
  // land on an older game with the same name (that is how "Marvel's Spider-Man
  // 2" picked up a 42 from the 2004 game).
  return {
    ...data,
    supported: true,
    metacritic_score: details.metacriticScore,
    metacritic_url: details.metacriticUrl || data.metacritic_url,
  };
}

/** Release year for the lookups: the summary's, or the Steam store date. */
function gameReleaseYear(s: EpicSummary): number | null {
  if (s.releaseYear) return s.releaseYear;
  const match = /(19|20)\d{2}/.exec(S.steamDetails.get(s.appName)?.releaseDate ?? "");
  return match ? Number(match[0]) : null;
}

export function paintGameMeta(s: EpicSummary): void {
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
    // Client-owned stores cannot be stopped here: show the running state.
    if (s.appName.startsWith("steam::") || isCompanionKey(s.appName)) {
      const label = t("lib.running");
      return `<button class="btn play lg running" disabled title="${esc(label)}"><span class="running-dot"></span> ${t("lib.running")}</button>`;
    }
    return `<button class="btn play lg" data-act="epic-stop" data-id="${s.appName}">${icon("square", 16)} ${t("common.stop")}</button>`;
  }
  // Amazon Games: installed and launched by the launcher through Nile.
  if (s.appName.startsWith("amazon::")) {
    const amazonId = s.appName.slice(8);
    const progress = S.amazonProgress.get(s.appName);
    if (progress && progress.percent < 100) {
      return `<button class="btn primary lg" data-view="accounts" data-amazon-btn="${s.appName}">${icon("download", 16)} ${t("common.downloading", { p: Math.round(progress.percent) })}</button>`;
    }
    if (!s.installed) {
      return `<button class="btn install lg" data-act="amazon-install" data-id="${esc(amazonId)}">${icon("download", 16)} ${t("common.install")}</button>`;
    }
    if (s.updateAvailable) {
      return `<button class="btn update lg" data-act="amazon-install" data-id="${esc(amazonId)}">${icon("download", 16)} ${t("common.update")}</button>`;
    }
    return `<button class="btn play lg" data-act="amazon-play" data-id="${esc(amazonId)}">${icon("play", 16)} ${t("common.playNow")}</button>`;
  }
  if (isCompanionApp(s.appName)) {
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

/**
 * Games whose store data the launcher reads per game: the companion clients
 * (EA, Ubisoft, Xbox, Battle.net, Riot) and Amazon Games, which resolves its
 * store text and specs through the same Steam lookup.
 */
export function isCompanionApp(appName: string): boolean {
  return isCompanionKey(appName) || appName.startsWith("amazon::");
}

/** Epic app names whose achievement list is read from Ubisoft Connect. */
const ubiAchSource = new Set<string>();

/** The Ubisoft copy of an Epic title, matched by canonical name. */
function ubisoftCompanionFor(s: EpicSummary): import("../../core/types").LibraryItem | undefined {
  const canon = canonicalGameTitle(s.title);
  if (!canon) return undefined;
  return S.companionSummaries.find((g) => g.source === "ubisoft" && canonicalGameTitle(g.title) === canon);
}

/**
 * The actions that do not belong in the row: managing collections, the store
 * page, the partner client's own window, and the cover picker. The row keeps the
 * play button, the store picker, Manage, the heart and this.
 */
function moreMenuHtml(s: EpicSummary, partner: ThirdPartyLauncherInfo | null): string {
  const open = S.isGameMoreMenuOpen;
  const companion = isCompanionApp(s.appName);
  const storeTitle = t(
    s.appName.startsWith("gog::")
      ? "drawer.storeTitleGog"
      : s.appName.startsWith("steam::")
        ? "drawer.storeTitleSteam"
        : companion
          ? "ctx.storePage"
          : "drawer.storeTitle",
  );
  const clientItem = companion
    ? `<button type="button" class="ps5-context-item" role="menuitem" data-act="companion-open" data-id="${esc(sourceOfKey(s.appName))}">${icon("layers", 14)} <span>${t("accounts.openClient")}</span></button>`
    : "";
  return `
    <div class="gp-more-wrap">
      <button class="btn ghost lg icon-only${open ? " active" : ""}" data-act="game-more-menu" data-id="${esc(s.appName)}" title="${esc(t("drawer.moreActions"))}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}">${icon("dots", 16)}</button>
      <div id="game-more-menu" class="gp-more-menu${open ? " show" : ""}" role="menu">
        <button type="button" class="ps5-context-item" role="menuitem" data-act="manage-game-collections" data-id="${esc(s.appName)}">${icon("plus", 14)} <span>${t("drawer.collection")}</span></button>
        <button type="button" class="ps5-context-item" role="menuitem" data-act="epic-store-page" data-id="${esc(s.appName)}">${icon("external", 14)} <span>${storeTitle}</span></button>
        ${clientItem}
        <div class="gp-more-sep"></div>
        <button type="button" class="ps5-context-item" role="menuitem" data-act="open-custom-cover" data-target="cover" data-id="${esc(s.appName)}">${icon("image", 14)} <span>${t("manage.coverChange")}</span></button>
      </div>
    </div>`;
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
      ${moreMenuHtml(s, partner)}
      ${sourceChipHtml(s.appName)}`;
  }

  // Amazon Games: the launcher owns install, update and launch.
  if (s.appName.startsWith("amazon::")) {
    const amazonId = s.appName.slice(8);
    const primary = !s.installed
      ? `<button class="btn install lg" data-act="amazon-install" data-id="${esc(amazonId)}">${icon("download", 16)} ${t("common.install")}</button>`
      : s.updateAvailable
        ? `<button class="btn update lg" data-act="amazon-install" data-id="${esc(amazonId)}">${icon("download", 16)} ${t("common.update")}</button>`
        : `<button class="btn play lg" data-act="amazon-play" data-id="${esc(amazonId)}">${icon("play", 16)} ${t("common.playNow")}</button>`;
    return `${primary}
      <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      ${moreMenuHtml(s, partner)}
      ${sourceChipHtml(s.appName)}`;
  }

  // Companion games stay inside their client: install, uninstall and play all
  // go through that client's protocol handlers.
  if (isCompanionApp(s.appName)) {
    const store = sourceOfKey(s.appName);
    const primary = s.installed
      ? `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`
      : `<button class="btn install lg" data-act="companion-install" data-id="${s.appName}" data-store="${store}">${icon("download", 16)} ${t("common.install")}</button>`;
    return `${primary}
      <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      ${moreMenuHtml(s, partner)}
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
      ${moreMenuHtml(s, partner)}
      ${sourceChipHtml(s.appName)}`;
  }

  const p = epicDlProgress(s.appName);
  const isDl = isAppDownloading(s.appName);
  return `
    ${primaryAction(s, p, partner)}
    <button class="btn ghost lg" data-act="manage-game" data-id="${s.appName}">${icon("settings", 16)} ${t("drawer.manage")}</button>
    <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
    ${(p !== null || isDl) ? `<button class="btn ghost lg danger" data-act="epic-cancel" data-id="${s.appName}">${t("common.cancel")}</button>` : ""}
    ${moreMenuHtml(s, partner)}
    ${sourceChipHtml(s.appName)}`;
}

/** The facts page: what the game supports on the left, this PC's copy and
 *  controller support stacked on the right, and the verified hardware
 *  requirements grid across the bottom. */
function renderSpecsTab(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
  antiCheat: string | null,
): string {
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  const card = (title: string, glyph: IconName, body: string, wide = false): string => `
    <section class="card specs-card${wide ? " is-wide" : ""}">
      <h3 class="gp-section-title">${icon(glyph, 13)} <span>${title}</span></h3>
      ${body}
    </section>`;
  return `
    <div class="specs-grid">
      ${card(t("drawer.featuresSupport"), "sliders", renderDrawerFeatures(s, partner, antiCheat))}
      <div class="specs-side-col">
        ${card(t("sys.thisCopy"), "layers", `<div class="hub-features-list" id="sys-copy-body">${renderInstalledCopyFacts(s, partner)}</div>`)}
        ${card(t("feat.controller"), "gamepad-2", `<div id="sys-ctrl-body">${renderControllerCard(s, g, reqData)}</div>`)}
      </div>
      ${card(t("sys.reqCardTitle"), "cpu", `<div id="sys-req-body">${renderRequirementsBody(s)}</div>`, true)}
    </div>`;
}

function renderActiveTab(s: EpicSummary, partner: ThirdPartyLauncherInfo | null, antiCheat: string | null): string {
  switch (S.activeDrawerTab) {
    case "overview": return renderDrawerOverview(s, partner, antiCheat);
    case "achievements": return renderDrawerAchievements(s);
    case "dlcs": return renderDrawerDlcs(s);
    case "screenshots": return renderDrawerScreenshots(s);
    case "notes": return renderDrawerNotes(s.appName);
    case "specs": return renderSpecsTab(s, partner, antiCheat);
    // A session left on a retired tab lands on the overview.
    default: return renderDrawerOverview(s, partner, antiCheat);
  }
}

const TAB_ICON: Record<string, IconName> = {
  overview: "layout-grid",
  achievements: "trophy",
  dlcs: "package",
  screenshots: "camera",
  notes: "edit",
  manage: "settings",
  specs: "cpu",
};

function tabButton(tab: string, label: string, extraClass = ""): string {
  const glyph = TAB_ICON[tab] ? icon(TAB_ICON[tab], 14) : "";
  return `<button class="tab drawer-tab ${S.activeDrawerTab === tab ? "active" : ""} ${extraClass}" data-act="drawer-tab" data-tab="${tab}" data-id="${S.currentModalAppName ?? ""}">${glyph}${label}</button>`;
}

/**
 * TIME / TROPHY / CLOUD chips. Re-rendered in place whenever late data (local
 * achievements, service playtime, cloud stamp) arrives, so the open page never
 * keeps a stale dash.
 */
function heroStatsHtml(s: EpicSummary, partner: ThirdPartyLauncherInfo | null): string {
  const stat = (label: string, value: string, attrs = "", valId = "", valCls = ""): string =>
    `<div class="gp-stat${attrs.includes("data-act") ? " clickable" : ""}" ${attrs}><span class="gp-stat-label">${label}</span><span class="gp-stat-val ${valCls}"${valId ? ` id="${valId}"` : ""}>${value}</span></div>`;
  const isPlat = isAppPlatinum(s.appName);
  const achSum = achSummaryOf(s.appName);
  const pt = S.playtimeMap.get(s.appName);
  const achVal = achSum && achSum.total_achievements > 0
    ? `${achSum.user_unlocked}/${achSum.total_achievements}`
    : "—";
  const cloud = heroCloudStatus(s, rawOf(s.appName), partner);
  const cloudTone = cloud.synced ? "ok" : cloud.neutral ? "" : (cloud.label !== "—" ? "warn" : "");
  // The number alone says how much; the tooltip says when — the cheapest way to
  // make a static figure feel like the player's own history.
  const lastPlayed = pt?.last_played_timestamp
    ? new Date(pt.last_played_timestamp * 1000).toLocaleDateString(currentLanguage(), {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";
  const timeTooltip = lastPlayed
    ? `${t("drawer.editPlaytime")} · ${t("drawer.lastPlayed", { date: lastPlayed })}`
    : t("drawer.editPlaytime");
  return `
            ${stat(t("drawer.statTime"), esc(pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—"), `data-act="open-edit-playtime" data-id="${s.appName}" title="${esc(timeTooltip)}"`, "drawer-stat-playtime")}
            ${stat(isPlat ? t("drawer.statPlat") : t("drawer.statTrophy"), achVal, achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}" title="${t("drawer.viewAchievements")}"` : "", "", isPlat ? "plat" : "")}
            ${stat(t("drawer.statCloud"), esc(cloud.label), `title="${esc(cloud.tooltip)}"`, "gp-stat-cloud-val", cloudTone)}`;
}

/** Split Epic's catalog blurb into readable paragraphs. */
function aboutMarkup(text: string): string {
  const parts = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts.map((part) => `<p>${esc(part)}</p>`).join("");
}

/** Blurbs past this read as a wall; the box shows the opening and a way in. */
const ABOUT_CLAMP_CHARS = 520;
/** Games whose blurb the user opened in full (session-scoped). */
const expandedAbout = new Set<string>();

/** Opens or closes a clamped blurb; the action handler calls this. */
export function toggleAboutExpanded(appName: string): void {
  if (expandedAbout.has(appName)) expandedAbout.delete(appName);
  else expandedAbout.add(appName);
}

/**
 * The About box body: the whole blurb, or its opening plus a "read more". Store
 * catalogs can run twenty lines, and the facts below should not be pushed off
 * the screen by a wall of marketing copy.
 */
function aboutBodyHtml(s: EpicSummary, text: string): { html: string; clamped: boolean } {
  if (!text) return { html: "", clamped: false };
  if (expandedAbout.has(s.appName) || text.length <= ABOUT_CLAMP_CHARS) {
    return { html: aboutMarkup(text), clamped: false };
  }
  const head = text.slice(0, ABOUT_CLAMP_CHARS);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  const space = head.lastIndexOf(" ");
  const cut = sentence > 200 ? head.slice(0, sentence + 1) : head.slice(0, space > 200 ? space : head.length);
  return { html: aboutMarkup(`${cut}…`), clamped: true };
}

/** The "read more" / "read less" control under a clamped blurb. */
function aboutToggleHtml(s: EpicSummary): string {
  const expanded = expandedAbout.has(s.appName);
  return `<button type="button" class="btn ghost small about-toggle" data-act="toggle-about" data-id="${esc(s.appName)}">${t(expanded ? "drawer.readLess" : "drawer.readMore")}</button>`;
}

/** IGDB's blurb for this game: the About box's first choice. */
function igdbAboutText(s: EpicSummary): string {
  return igdbGameFor(s.appName)?.summary?.trim() || "";
}

/** Epic's catalog description (raw or from the store data); empty when unusable. */
function epicDescription(s: EpicSummary): string {
  const rawDesc = s.description?.trim();
  const hasRealDesc = rawDesc && rawDesc !== NO_DESC && rawDesc !== s.title && rawDesc.length > 25;
  const reqData = S.loadedRequirements.get(s.appName);
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : "");
  // Companion catalogs ship plain text that may still carry store markup.
  if (hasRealDesc) return isCompanionApp(s.appName) ? cleanStoreDescription(rawDesc) : rawDesc;
  return storeDesc || "";
}

/** Wikipedia fallback text per game + language ("" = checked, nothing found). */
const aboutCache = new Map<string, string>();

/** Games whose store-side "about" sources have all settled. */
const storeAboutSettled = new Set<string>();

function aboutKey(appName: string): string {
  return `${appName}|${currentLanguage()}`;
}

/**
 * Order: IGDB first (it is the page's metadata source), then the game's own
 * store (Epic/GOG), then Wikipedia.
 *
 * The wiki fallback is deliberately NOT requested until IGDB and the store
 * lookup have settled. Starting it earlier made Wikipedia appear first and then
 * get replaced by the better text, which read like a wrong description.
 */
function maybeLoadWikiAbout(s: EpicSummary): void {
  if (igdbAboutText(s)) return;
  if (!igdbAboutSettled(s.appName)) return;
  if (epicDescription(s)) return;
  if (!storeAboutSettled.has(s.appName)) return;
  if (!S.loadedRequirements.has(s.appName)) return;
  const key = aboutKey(s.appName);
  if (aboutCache.has(key) || S.loadingAboutFor.has(key)) return;
  S.loadingAboutFor.add(key);
  void loadWikiAbout(s).finally(() => {
    if (S.loadingAboutFor.has(key)) S.loadingAboutFor.delete(key);
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

/** Source note under the description: IGDB, the game's own store, or Wikipedia. */
function aboutSourceText(s: EpicSummary, storeDesc: string, wikiText: string): string {
  if (igdbAboutText(s)) return t("drawer.sourceIgdb");
  const source = sourceOfKey(s.appName);
  const storeName = source === "gog" ? "GOG" : source === "steam" ? "Steam" : source === "ea" ? "EA App" : source === "ubisoft" ? "Ubisoft Connect" : source === "xbox" ? "Xbox" : source === "battlenet" ? "Battle.net" : source === "riot" ? "Riot Games" : source === "amazon" ? "Amazon Games" : "Epic Games Store";
  if (!storeDesc && wikiText) return t("drawer.wikiSource", { store: storeName });
  if (source === "gog") return t("drawer.sourceGog");
  if (source === "steam") return t("drawer.sourceSteam");
  if (source === "amazon" || isCompanionSource(source)) {
    // Amazon and companion clients publish no catalog text; when the Steam
    // store filled the gap, the note names Steam instead of the store.
    const steam = S.steamDetails.get(s.appName);
    if (steam && storeDesc && (steam.description === storeDesc || steam.shortDescription === storeDesc)) {
      return t("drawer.sourceSteam");
    }
    return t("drawer.sourceStore", { store: storeName });
  }
  return t("drawer.sourceEpic");
}

/** Paints the About box and its source note from the current sources. */
function paintAboutText(s: EpicSummary): void {
  if (S.currentModalAppName !== s.appName) return;
  const aboutSec = document.getElementById("hub-about-section");
  if (aboutSec && S.activeDrawerTab === "overview") {
    aboutSec.outerHTML = renderAboutSection(s);
    return;
  }
  const descEl = document.getElementById("hub-desc-text");
  if (!descEl) return;
  const storeDesc = epicDescription(s);
  const wikiText = aboutCache.get(aboutKey(s.appName)) || "";
  const igdbDesc = igdbAboutText(s);
  const text = igdbDesc || storeDesc || wikiText;
  const pending = !igdbDesc && !igdbAboutSettled(s.appName);
  const body = aboutBodyHtml(s, text);
  descEl.innerHTML = pending
    ? `<div class="hub-desc-loading"><span class="spinner"></span><span>${t("drawer.loadingAbout")}</span></div>`
    : body.html || `<p>${t("drawer.noDescription")}</p>`;
  const toggle = document.querySelector<HTMLElement>(".about-toggle");
  if (toggle) toggle.hidden = text.length <= ABOUT_CLAMP_CHARS;
  const srcEl = document.getElementById("hub-desc-source");
  if (srcEl) {
    srcEl.hidden = pending || !text;
    srcEl.textContent = aboutSourceText(s, storeDesc, wikiText);
  }
}

/** Kicks off the lazy overview fetches (HLTB, critic, store data) once per game. */
function ensureOverviewData(s: EpicSummary): void {
  const appName = s.appName;
  if (S.activeDrawerTab !== "overview") return;
  // A store catalog entry can carry another game's text (an Epic DLC in place
  // of the main title). The library item's own title is what the page header
  // shows, so the score lookups use that one.
  const lookupTitle = S.allGamesMap.get(appName)?.title ?? s.title;
  const year = gameReleaseYear(s);
  if (!S.loadedHltb.has(appName) && !S.loadingHltbFor.has(appName)) {
    S.loadingHltbFor.add(appName);
    epicGetHltb(lookupTitle, appName, false, year)
      .then((data) => {
        S.loadedHltb.set(appName, data);
        if (S.currentModalAppName === appName) updateHltbUI(appName, data);
      })
      .catch(() => {
        if (S.currentModalAppName === appName) updateHltbUI(appName, undefined);
      })
      .finally(() => { S.loadingHltbFor.delete(appName); });
  }
  if (!S.loadedCritic.has(appName) && !S.loadingCriticFor.has(appName)) {
    S.loadingCriticFor.add(appName);
    epicGetCritic(lookupTitle, appName, false, year)
      .then((data) => {
        const merged = mergeSteamCritic(data, appName);
        S.loadedCritic.set(appName, merged);
        if (S.currentModalAppName === appName) updateCriticUI(appName, merged);
      })
      .catch(() => {})
      .finally(() => { S.loadingCriticFor.delete(appName); });
  }

  // Fetch official GOG metadata on demand
  if (appName.startsWith("gog::")) {
    const rawId = appName.slice(5);
    const detailsP = loadGogDetails(rawId)
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
          if (heroEl) {
            heroEl.src = details.hero_url;
            const bgEl = modalRoot.querySelector<HTMLElement>(".gp-hero-backdrop");
            if (bgEl) bgEl.style.backgroundImage = `url('${details.hero_url}')`;
          }
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
      !S.loadedRequirements.has(appName) && !S.loadingReqFor.has(appName)
        ? fetchAndRenderRequirements(appName, s.title)
        : Promise.resolve();
    // GOG has two store-side sources (details + requirements): the wiki may only
    // start once both have settled, otherwise its text would flash and be
    // replaced by the store description.
    void Promise.allSettled([detailsP, reqP]).then(() => {
      storeAboutSettled.add(appName);
      maybeLoadWikiAbout(s);
      // The store page can land after the critic answer: its Metacritic score is
      // worth showing, so the card is merged and painted again.
      const loaded = S.loadedCritic.get(appName);
      if (loaded) {
        const merged = mergeSteamCritic(loaded, appName);
        if (merged !== loaded) {
          S.loadedCritic.set(appName, merged);
          if (S.currentModalAppName === appName) updateCriticUI(appName, merged);
        }
      }
    });
    if (!S.loadedAchievements.has(appName) && !S.loadingAchFor.has(appName)) {
      void fetchAndRenderAchievements(appName);
    }
  } else {
    // Epic: the store description arrives with the requirements call.
    maybeLoadWikiAbout(s);
  }
}

/** The lazily loaded IGDB transport status: `idle` until a game page asks. */
let igdbTransport: "idle" | "loading" | "done" = "idle";
/** A failed status probe is retried after this cooldown, not once per page. */
let igdbTransportFailedAt = 0;
const IGDB_TRANSPORT_RETRY_MS = 60_000;
/** Callbacks waiting for that status, so two game pages can ask at once. */
const igdbTransportWaiters: Array<() => void> = [];

/**
 * Loads the IGDB transport status once per session. Settings loads it too, but a
 * game page can be the first thing the user opens, and without this the page
 * would never ask IGDB at all.
 */
function ensureIgdbTransport(onReady: () => void): void {
  if (S.igdbConfigured || igdbTransport === "done") {
    onReady();
    return;
  }
  // The idle prefetch walks several games; a dead transport must not become
  // one probe per game. A real page open retries after the cooldown.
  if (
    igdbTransport === "idle" &&
    igdbTransportFailedAt > 0 &&
    Date.now() - igdbTransportFailedAt < IGDB_TRANSPORT_RETRY_MS
  ) {
    onReady();
    return;
  }
  igdbTransportWaiters.push(onReady);
  if (igdbTransport === "loading") return;
  igdbTransport = "loading";
  void igdbStatus()
    .then((status) => {
      S.igdbConfigured = status.configured;
      S.igdbMode = status.mode;
      S.igdbProxyUrl = status.proxyUrl;
      igdbTransport = "done";
    })
    .catch(() => {
      // A later game page gets another try after the cooldown.
      igdbTransport = "idle";
      igdbTransportFailedAt = Date.now();
    })
    .finally(() => {
      for (const waiter of igdbTransportWaiters.splice(0)) waiter();
    });
}

export function openEpicModal(appName: string, isInitialOpen = true, _animateTabContent = true): void {
  const s = summaryOf(appName);
  if (!s) return;
  // The game page lives in the main webview; the storefront is a native child
  // webview that ignores z-index. Park it while the page covers the store.
  holdStoreForCover();
  const isSameApp = S.currentModalAppName === appName;
  // A freshly opened game page celebrates a platinum once: the cup's shine
  // sweep replays only when the page is opened again, not on every re-render.
  if (isInitialOpen) platShineDone = false;
  // Switching games inside the open drawer must not keep the previous
  // gallery (and its full-size originals) alive.
  if (!isSameApp && S.currentModalAppName) forgetGameScreenshots(S.currentModalAppName);
  S.currentModalAppName = appName;
  S.isVersionDropdownOpen = false;
  S.isGameMoreMenuOpen = false;
  if (isInitialOpen) {
    S.activeDrawerTab = "overview";
    S.activeAchFilter = "all";
    S.achTierFilter = "all";
    S.achSearchQuery = "";
    S.achSortOrder = "default";
  }
  const g = rawOf(appName);
  const partner = gamePartner(s, g);
  const antiCheat = gameAntiCheat(s, g);
  const companion = isCompanionApp(appName);
  // Companion games open on Overview; the rest of the tabs read their own
  // local or store data and are available too.
  if (companion && isInitialOpen) S.activeDrawerTab = "overview";

  ensureOverviewData(s);
  // IGDB is the page's first metadata source: one cached call per game. The
  // transport status is loaded lazily — Settings is not the only way into a game
  // page — and the enrichment starts as soon as it is known. When the answer
  // lands the hero line and the overview are repainted, so the store data only
  // ever fills the gaps.
  ensureIgdbTransport(() => {
    if (S.currentModalAppName !== appName) return;
    ensureIgdbOverview(s, gameReleaseYear(s), () => {
      paintGameMeta(s);
      // Only the blocks IGDB feeds are rebuilt: a full repaint of the tab reset
      // the reader's scroll position and rebuilt every strip on the page.
      repaintIgdbBlocks(appName);
    });
  });
  if (companion) {
    // The client catalog often ships its own description; Wikipedia is only
    // the fallback, so the store text does not flash and get replaced.
    if (!S.loadedRequirements.has(appName) && !S.loadingReqFor.has(appName)) void fetchAndRenderRequirements(appName, s.title);
    if (!S.loadedScreenshots.has(appName) && !S.loadingScreenshotsFor.has(appName)) void fetchAndRenderScreenshots(appName, s.title);
    if (!S.loadedAchievements.has(appName) && !S.loadingAchFor.has(appName)) void fetchAndRenderAchievements(appName);
  } else {
    ensureCloudSyncStamp(s);
    if (!S.loadedRequirements.has(appName) && !S.loadingReqFor.has(appName)) void fetchAndRenderRequirements(appName, s.title);
    if (!S.loadedScreenshots.has(appName) && !S.loadingScreenshotsFor.has(appName)) void fetchAndRenderScreenshots(appName, s.title);
    if (!S.loadedAchievements.has(appName) && !S.loadingAchFor.has(appName)) void fetchAndRenderAchievements(appName);
    ensureEosSupport(appName);
  }
  // The notes tab's list and badge; the client caches, so this is one call.
  ensureDrawerNotes(appName, () => repaintPersonalBlock(appName));

  const dlcRes = S.dlcCache.get(appName);
  const dlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const ssCount = S.loadedScreenshots.get(appName)?.length ?? 0;
  const notesCount = cachedNotes().filter((note) => note.scope === appName).length;
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
    if (dlcTab) dlcTab.outerHTML = tabButton("dlcs", t("drawer.dlcs"));
    const actions = modalRoot.querySelector(".gp-actions");
    if (actions) actions.innerHTML = actionsHtml(s, partner);
    const stats = modalRoot.querySelector(".gp-stats");
    if (stats) stats.innerHTML = heroStatsHtml(s, partner);
    paintGameMeta(s);
    paintGameCloud(s);
    return;
  }

  const isGog = appName.startsWith("gog::");
  const isSteam = appName.startsWith("steam::");
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  // The hero is the one picture the page waits for: ask for it as soon as the
  // page opens, and paint from the cached copy the moment it arrives.
  warmImages([art]);
  const meta = gameMetaHtml(s, partner, antiCheat);

  const tabs = `${tabButton("overview", t("drawer.overview"))}
       ${tabButton("achievements", t("drawer.achievements"), isPlat ? "plat" : "")}
       ${tabButton("dlcs", t("drawer.dlcs"))}
       ${tabButton("screenshots", t("drawer.screenshots"))}
       ${tabButton("notes", t("drawer.notes"))}
       ${tabButton("specs", t("drawer.specs"))}`;

  modalRoot.innerHTML = `
    <div class="overlay">
      <div class="game-hub">
        <div class="gp-hero">
          ${
            art
              ? `<div class="gp-hero-backdrop" style="background-image:url('${esc(cachedImage(art))}');"></div>
          <img class="gp-hero-img" src="${esc(cachedImage(art))}" data-img-url="${esc(art)}" alt="" decoding="async" onload="if(this.naturalWidth && this.naturalHeight && this.naturalWidth/this.naturalHeight < 1.3) this.classList.add('is-portrait')" />`
              : ""
          }
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
          <div class="gp-stats">${heroStatsHtml(s, partner)}</div>
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
        if (dlcTab) dlcTab.outerHTML = tabButton("dlcs", t("drawer.dlcs"));
      })
      .catch(() => {});
  }
  syncSidebarGameActive();
  updateGamepadHud(S.gamepadPolling);
  presenceSync();
  updateNavHistoryUi();
  // The cached answers decide whether the scores card has anything to frame.
  syncScoresCardVisibility();
}

export function updateHltbUI(appName: string, data?: HltbData): void {
  if (S.currentModalAppName !== appName) return;
  const container = document.getElementById("drawer-hltb-container");
  if (!container) return;
  container.innerHTML = renderHltbCard(data, false);
  syncScoresCardVisibility();
}

/** Hides each sidebar card when its own block came back with nothing: a frame
 *  around an empty body reads as a broken card. While an answer is on its way the
 *  block holds a skeleton, so the card keeps its place. */
function syncScoresCardVisibility(): void {
  const pairs: Array<[string, string]> = [
    [".gp-lengths-card", "drawer-hltb-container"],
    [".gp-critic-card", "drawer-critic-container"],
  ];
  for (const [selector, hostId] of pairs) {
    const card = document.querySelector<HTMLElement>(selector);
    const host = document.getElementById(hostId);
    if (!card || !host) continue;
    card.classList.toggle("is-empty", host.children.length === 0);
  }
}

export function updateCriticUI(appName: string, data: CriticData): void {
  if (S.currentModalAppName !== appName) return;
  const container = document.getElementById("drawer-critic-container");
  if (container) container.innerHTML = renderCriticCard(data, false, igdbGameFor(appName)?.rating ?? null);
  syncScoresCardVisibility();
}

/** The collections this game belongs to, as chips in the meta row under the title. */
export function renderCollectionTags(appName: string): string {
  const lowerApp = appName.toLowerCase();
  const gameCols = S.epicCollections.filter((c) => c.app_names.some((name) => name.toLowerCase() === lowerApp));
  return gameCols.map((c) => `
    <button type="button" class="chip gp-col-chip" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(t("drawer.collectionShow", { name: c.name }))}">
      ${isCollectionIcon(c.emoji) ? collectionMarker(c.emoji, 12) : ""}${esc(c.name)}
    </button>`).join("");
}

/**
 * The About box, its source line and the credits line under it.
 *
 * Everything in here can change when the IGDB answer lands, which is why it is
 * its own function: the page repaints this block alone instead of rebuilding the
 * whole tab (and throwing the reader's scroll position away).
 */
function renderAboutSection(s: EpicSummary): string {
  const epicDesc = epicDescription(s);
  const igdbDesc = igdbAboutText(s);
  const key = aboutKey(s.appName);
  const wikiText = aboutCache.get(key) || "";
  // IGDB first, then the game's own store, then Wikipedia. The note under the
  // box names whichever source won, so a fallback is never silent.
  const effectiveDesc = igdbDesc || epicDesc || wikiText || null;
  // The box waits for IGDB before showing the store text: replacing the text
  // under the reader's eyes reads like the wrong description. Once IGDB has
  // settled, the spinner only stays while the store or the wiki can still answer.
  const igdbPending = !igdbDesc && !igdbAboutSettled(s.appName);
  const aboutLoading =
    igdbPending ||
    (!effectiveDesc && !(aboutCache.has(key) || S.loadedRequirements.has(s.appName) || Boolean(epicDesc)));
  const sourceText = aboutSourceText(s, epicDesc, wikiText);
  const sourceHidden = aboutLoading || !effectiveDesc;

  const genres = gameGenresFor(s.appName);
  const genresHtml = genres.length > 0
    ? `
    <div class="gp-about-genres">
      <div class="gp-about-genres-label">${icon("hash", 12)} <span>${esc(t("feat.genres"))}</span></div>
      <div class="gp-about-tags">
        ${genres.map((g) => `<span class="gp-tag">${esc(g)}</span>`).join("")}
      </div>
    </div>`
    : "";
  const igdbShotsHtml = renderIgdbMedia(s);
  const creditsHtml = renderIgdbCredits(s);
  const footHtml = (sourceText || creditsHtml)
    ? `
    <div class="gp-about-foot">
      <p class="hub-desc-source" id="hub-desc-source"${sourceHidden ? " hidden" : ""}>${sourceText}</p>
      ${creditsHtml}
    </div>`
    : "";

  return `
    <section class="card gp-about-card" id="hub-about-section">
      <h3 class="gp-section-title">${icon("info", 14)} <span>${t("drawer.aboutGame")}</span></h3>
      <div class="hub-desc-text" id="hub-desc-text">${
        aboutLoading
          ? `<div class="hub-desc-loading"><span class="spinner"></span><span>${t("drawer.loadingAbout")}</span></div>`
          : aboutMarkup(effectiveDesc ?? "") || `<p>${t("drawer.noDescription")}</p>`
      }</div>
      ${genresHtml}
      ${igdbShotsHtml}
      ${footHtml}
    </section>`;
}

/**
 * Repaints only what IGDB feeds: the About block, similar games and the score
 * card. Called when the answer lands, where a full repaint used to rebuild the
 * whole tab and reset the scroll position for four small changes.
 */
export function repaintIgdbBlocks(appName: string): void {
  if (S.currentModalAppName !== appName) return;
  const s = summaryOf(appName);
  if (!s) return;
  if (S.activeDrawerTab === "specs") {
    const g = rawOf(appName);
    const reqData = S.loadedRequirements.get(appName);
    const featuresEl = document.getElementById("hub-features-list");
    if (featuresEl) {
      featuresEl.innerHTML = renderGameFeatures(s, g, gamePartner(s, g), gameAntiCheat(s, g), reqData, igdbTagsFor(appName));
    }
    const ctrlEl = document.getElementById("sys-ctrl-body");
    if (ctrlEl) {
      ctrlEl.innerHTML = renderControllerCard(s, g, reqData);
    }
    return;
  }
  if (S.activeDrawerTab === "dlcs") {
    const host = document.getElementById("igdb-dlc-extras");
    if (host) host.outerHTML = renderIgdbDlcExtras(s, storeDlcTitles(s));
    return;
  }
  if (S.activeDrawerTab !== "overview") return;
  const about = document.getElementById("hub-about-section");
  if (about) about.outerHTML = renderAboutSection(s);
  const similar = document.getElementById("hub-igdb-similar");
  if (similar) similar.innerHTML = renderIgdbSimilar(s);
  const critic = document.getElementById("drawer-critic-container");
  if (critic) {
    critic.innerHTML = renderCriticCard(
      S.loadedCritic.get(s.appName),
      S.loadingCriticFor.has(s.appName),
      igdbGameFor(s.appName)?.rating ?? null,
    );
    syncScoresCardVisibility();
  }
}

/** News is asked for once per game per session; the answer is kept so returning
 *  to the page paints it instead of a skeleton that would never fill. */
const newsCache = new Map<string, SteamNewsItem[]>();
const newsRequested = new Set<string>();

async function resolveNewsAppId(s: EpicSummary): Promise<string> {
  if (s.appName.startsWith("steam::")) return s.appName.slice(7);
  const fromDetails = S.steamDetails.get(s.appName)?.appId;
  if (fromDetails) return fromDetails;
  const steamCopy = gameVersionsOf(s.appName).find((v) => v.appName.startsWith("steam::"));
  if (steamCopy) return steamCopy.appName.slice(7);
  try {
    const hit = await steamFindStoreApp(s.title, "english");
    return hit?.appId ?? "";
  } catch {
    return "";
  }
}

async function loadGameNews(s: EpicSummary): Promise<void> {
  const appName = s.appName;
  if (newsRequested.has(appName)) return;
  newsRequested.add(appName);
  try {
    const appId = await resolveNewsAppId(s);
    const items = appId ? await steamNews(appId, 3) : [];
    newsCache.set(appName, items);
    if (S.currentModalAppName !== appName) return;
    const host = document.getElementById("gp-news");
    if (host) host.innerHTML = renderSteamNews(items);
  } catch {
    // A feed that cannot be read is not worth an error box: the block goes away,
    // and an empty list is remembered so it does not come back as a skeleton.
    newsCache.set(appName, []);
    if (S.currentModalAppName !== appName) return;
    const host = document.getElementById("gp-news");
    if (host) host.innerHTML = "";
  }
}

function renderOverviewNote(appName: string): string {
  const notes = notesForScope(appName);
  if (notes.length === 0) return "";
  const top = notes[0];
  const title = top.title.trim() || t("notes.untitled");
  const preview = top.body.trim() ? notePreview(top.body, 160) : "";
  return `
    <section class="gp-section gp-overview-note">
      <button type="button" class="card gp-overview-note-card" data-act="drawer-tab" data-tab="notes" data-id="${esc(appName)}" title="${esc(t("drawer.notes"))}">
        <span class="gp-overview-note-icon">${icon(top.pinned ? "pin" : "edit", 14)}</span>
        <span class="gp-overview-note-main">
          <span class="gp-overview-note-title">${esc(title)}</span>
          ${preview ? `<span class="gp-overview-note-body">${esc(preview)}</span>` : ""}
        </span>
        ${notes.length > 1 ? `<span class="gp-overview-note-count num">+${notes.length - 1}</span>` : ""}
      </button>
    </section>`;
}

/**
 * The personal half of the overview main column: the last session, pinned/latest
 * note and, when there is nothing at all, the card that explains the space.
 * Next achievements and Moments live in the right sidebar as dedicated widgets.
 *
 * It is a function of its own because it is the one block that changes while the
 * page is open: a session ends, the recorder writes it down, and the block is
 * painted again in place — repainting the whole tab would throw the reader's
 * scroll position away.
 */
function personalBlockHtml(s: EpicSummary, personalFirst: boolean): string {
  const noteCard = renderOverviewNote(s.appName);
  // Both sidebar widgets hold their place while they load; when they have answered and
  // there is genuinely nothing, the player gets a card that says what this space
  // is for instead of a silent gap. A recorded session or a note is a record
  // too: offering "your record starts here" under a last-session card that just
  // said "+2 trophies" contradicts itself.
  const settledEmpty =
    !sessionSummaryFor(s.appName) &&
    !cachedNotes().some((note) => note.scope === s.appName) &&
    S.loadedScreenshots.has(s.appName) &&
    (S.loadedScreenshots.get(s.appName)?.length ?? 0) === 0 &&
    S.loadedAchievements.has(s.appName) &&
    (S.loadedAchievements.get(s.appName)?.total_achievements ?? 0) === 0;
  const personalEmpty =
    personalFirst && settledEmpty
      ? `
        <section class="gp-section gp-personal-empty">
          <div class="card gp-personal-empty-card">
            <div class="gp-personal-empty-main">
              <div class="gp-personal-empty-title">${t("drawer.personalEmptyTitle")}</div>
              <div class="gp-personal-empty-desc">${t("drawer.personalEmptyDesc")}</div>
            </div>
            <button type="button" class="btn ghost small" data-act="drawer-tab" data-tab="screenshots" data-id="${esc(s.appName)}">${icon("camera", 13)} ${t("drawer.personalEmptyCta")}</button>
          </div>
        </section>`
      : "";
  return `${renderLastSession(s.appName)}${noteCard}${personalEmpty}`;
}

/** Paints the personal block and personal sidebar widgets again after a session ended or notes changed, if its page is open. */
export function repaintPersonalBlock(appName: string): void {
  if (S.currentModalAppName !== appName || S.activeDrawerTab !== "overview") return;
  const host = document.getElementById("gp-personal-block");
  const s = summaryOf(appName);
  if (!host || !s) return;
  const playtime = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  host.innerHTML = personalBlockHtml(s, s.installed || playtime > 0);
  const nextAchEl = document.getElementById("gp-next-ach");
  if (nextAchEl) nextAchEl.outerHTML = renderNextAchievements(appName);
  const momentsEl = document.getElementById("gp-moments");
  if (momentsEl) momentsEl.outerHTML = renderMomentsStrip(appName);
}

export function renderDrawerOverview(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
): string {
  const playtime = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const personalFirst = s.installed || playtime > 0;
  const personal = `<div id="gp-personal-block">${personalBlockHtml(s, personalFirst)}</div>`;
  const about = renderAboutSection(s);
  void loadGameNews(s);
  const cachedNews = newsCache.get(s.appName);
  const news = `<div id="gp-news">${renderSteamNews(cachedNews ?? null)}</div>`;
  // The two blocks live in their own containers: the painters that fill them late
  // must not overwrite each other's work.
  const hltbBlock = `<div id="drawer-hltb-container">${renderHltbCard(
    S.loadedHltb.get(s.appName),
    S.loadingHltbFor.has(s.appName),
  )}</div>`;
  const criticBlock = `<div id="drawer-critic-container">${renderCriticCard(
    S.loadedCritic.get(s.appName),
    S.loadingCriticFor.has(s.appName),
    igdbGameFor(s.appName)?.rating ?? null,
  )}</div>`;

  // Main column order:
  // 1. About Game (top)
  // 2. News
  // 3. Similar games
  // Four dedicated sidebar widgets in order:
  // 1. Next achievements (above estimated lengths)
  // 2. Estimated lengths (HowLongToBeat)
  // 3. Scores (IGDB / OpenCritic / Metacritic)
  // 4. Moments (below scores)
  return `
    <div class="hub-overview-layout">
      <div class="hub-overview-main">
        ${about}
        ${news}
        <div id="hub-igdb-similar">${renderIgdbSimilar(s)}</div>
        ${personal}
      </div>
      <aside class="hub-overview-sidebar">
        ${renderNextAchievements(s.appName)}
        ${sideCard(s.appName, "lengths", t("hltb.times"), "clock", hltbBlock, { extraClass: "gp-lengths-card" })}
        ${sideCard(s.appName, "scores", t("critic.scoresTitle"), "star", criticBlock, { extraClass: "gp-critic-card" })}
        ${renderMomentsStrip(s.appName)}
      </aside>
    </div>`;
}

/** The features list alone: the sidebar wraps it in a card that folds. */
function renderDrawerFeatures(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
  antiCheat: string | null,
): string {
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  return `<div class="hub-features-list" id="hub-features-list">${renderGameFeatures(s, g, partner, antiCheat, reqData, igdbTagsFor(s.appName))}</div>`;
}

function igdbExtraUrl(hit: { slug: string; name: string }): string {
  return hit.slug
    ? `https://www.igdb.com/games/${hit.slug}`
    : `https://www.igdb.com/search?type=1&q=${encodeURIComponent(hit.name)}`;
}

/** Store DLC titles, so an IGDB row does not repeat what the store already lists. */
function storeDlcTitles(s: EpicSummary): string[] {
  return S.dlcCache.get(s.appName)?.dlcs.map((dlc) => dlc.title) ?? [];
}

/**
 * The add-ons IGDB knows but the store's install list may not name. The store
 * rows stay the install surface; this block only adds names, years, covers and
 * a link to the IGDB page.
 */
function renderIgdbDlcExtras(s: EpicSummary, storeTitles: string[]): string {
  const game = igdbGameFor(s.appName);
  if (!game) {
    if (S.igdbConfigured && !S.offlineMode && !igdbAboutSettled(s.appName)) {
      return `<div id="igdb-dlc-extras" class="dlc-igdb-block">${loadingState(t("dlc.scanning"))}</div>`;
    }
    return "";
  }
  const seen = new Set(storeTitles.map((title) => canonicalGameTitle(title)));
  seen.add(canonicalGameTitle(s.title));
  const query = S.dlcSearchQuery.trim().toLowerCase();
  const extras = [
    ...(game.dlcs ?? []).map((hit) => ({ hit, kind: "dlc" as const })),
    ...(game.expansions ?? []).map((hit) => ({ hit, kind: "expansion" as const })),
  ].filter(({ hit }) => {
    const canon = canonicalGameTitle(hit.name);
    if (!canon || seen.has(canon)) return false;
    if (query && !hit.name.toLowerCase().includes(query)) return false;
    seen.add(canon);
    return true;
  });
  if (extras.length === 0) return "";
  warmImages(extras.map(({ hit }) => (hit.coverId ? igdbImage(hit.coverId, "cover_big") : "")));
  const rows = extras
    .map(({ hit, kind }) => {
      const cover = hit.coverId ? igdbImage(hit.coverId, "cover_big") : "";
      const thumb = cover
        ? `<img class="row-thumb" src="${esc(cachedImage(cover))}" data-img-url="${esc(cover)}" alt="" loading="lazy" />`
        : `<span class="row-thumb gp-thumb-ph">${icon("layers", 14)}</span>`;
      return `
        <div class="row">
          ${thumb}
          <div class="row-main">
            <div class="row-title" title="${esc(hit.name)}">${esc(hit.name)}</div>
            <div class="row-meta">${hit.year ? `${hit.year} · ` : ""}${esc(t(kind === "expansion" ? "drawer.expansion" : "drawer.dlcKind"))}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" data-act="open-external-url" data-url="${esc(igdbExtraUrl(hit))}">${icon("external", 13)} IGDB</button>
          </div>
        </div>`;
    })
    .join("");
  return `
    <div id="igdb-dlc-extras" class="dlc-igdb-block">
      <h3 class="gp-section-title">${icon("sparkles", 14)} ${esc(t("drawer.igdbAddons"))}</h3>
      <div class="list">${rows}</div>
    </div>`;
}

export function renderDrawerDlcs(s: EpicSummary): string {
  // Companion games: their client lists no add-ons, so the Steam store page of
  // the same title supplies the count and the browsing hand-off.
  if (isCompanionApp(s.appName)) {
    const details = S.steamDetails.get(s.appName);
    if (!details && !S.loadingReqFor.has(s.appName)) {
      void fetchAndRenderRequirements(s.appName, s.title);
      return loadingState(t("dlc.scanning"));
    }
    const count = details?.dlc.length ?? 0;
    const extras = renderIgdbDlcExtras(s, []);
    if (count === 0 && !extras) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    const dlcStoreBtn = s.appName.startsWith("amazon::")
      ? ""
      : `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("ctx.storePage")}</button>`;
    return `
      ${
        count > 0
          ? `<div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("drawer.addonsCount", { count })}</div>
            <div class="row-meta">${t("drawer.addonsDesc")}</div>
          </div>
          <div class="row-actions">
            ${dlcStoreBtn}
          </div>
        </div>
      </div>`
          : ""
      }
      ${extras}`;
  }
  // Steam lists DLC ids only; names would need one store call per add-on, so the
  // tab reports the count and hands the browsing over to Steam.
  if (s.appName.startsWith("steam::")) {
    const details = S.steamDetails.get(s.appName);
    if (!details && !S.loadingReqFor.has(s.appName)) {
      void fetchAndRenderRequirements(s.appName, s.title);
      return loadingState(t("dlc.scanning"));
    }
    const count = details?.dlc.length ?? 0;
    const extras = renderIgdbDlcExtras(s, []);
    if (count === 0 && !extras) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    return `
      ${
        count > 0
          ? `<div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("steam.dlcCount", { count })}</div>
            <div class="row-meta">${t("steam.dlcDesc")}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.storeTitleSteam")}</button>
          </div>
        </div>
      </div>`
          : ""
      }
      ${extras}`;
  }
  if (s.appName.startsWith("gog::")) {
    const count = s.dlcCount || S.allGamesMap.get(s.appName)?.dlcCount || 0;
    const extras = renderIgdbDlcExtras(s, []);
    if (count === 0 && !extras) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    return `
      ${
        count > 0
          ? `<div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("gog.dlcCount", { count })}</div>
            <div class="row-meta">${t("gog.dlcDesc")}</div>
          </div>
          <div class="row-actions">
            <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.storeTitleGog")}</button>
          </div>
        </div>
      </div>`
          : ""
      }
      ${extras}`;
  }
  const dlcRes = S.dlcCache.get(s.appName);
  if (S.dlcLoading && !dlcRes) return loadingState(t("dlc.scanning"));
  const allDlcs = dlcRes?.dlcs || [];
  const extras = renderIgdbDlcExtras(s, allDlcs.map((dlc) => dlc.title));
  const storeBtn = `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("drawer.discoverDlc")}</button>`;
  if (allDlcs.length === 0 && !extras) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));

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
    ${
      rows
        ? `<div class="list">${rows}</div>`
        : extras
          ? ""
          : `<div class="list"><div class="row"><div class="row-meta">${t("ach.emptyTitle")}</div></div></div>`
    }
    ${extras}`;
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

  if (S.loadingAchFor.has(s.appName)) return loadingState(t("ach.loadingStore"));
  const data = S.loadedAchievements.get(s.appName);
  if (!data) {
    void fetchAndRenderAchievements(s.appName);
    return loadingState(t("ach.checking"));
  }

  if (data.achievements.length === 0) {
    // Epic copies of Ubisoft games: Epic ships no achievement set for some of
    // them (Watch Dogs), so the local Ubisoft Connect cache is the source.
    if (sourceOfKey(s.appName) === "epic" && partner?.type === "ubisoft") {
      const openClient = `<button class="btn ghost small" data-act="companion-open" data-id="ubisoft">${icon("external", 13)} ${t("accounts.openClient")}</button>`;
      const install = `<button class="btn play small" data-act="epic-play" data-id="${esc(s.appName)}">${icon("download", 13)} ${t("drawer.launchInstallWith", { name: "Ubisoft Connect" })}</button>`;
      return emptyState(
        "gamepad-2",
        t("ach.ubiEpicTitle"),
        s.installed ? t("ach.ubiEpicEmptyInstalled") : t("ach.ubiEpicEmptyNotInstalled"),
        s.installed ? openClient : `${install}${openClient}`,
      );
    }
    // Ubisoft has no public achievement API: the list comes from the client's
    // local cache, and a game the client never opened has no cache yet.
    if (s.appName.startsWith("ubisoft::")) {
      return emptyState(
        "gamepad-2",
        t("ach.ubiTitle"),
        t("ach.ubiDesc"),
        `<button class="btn ghost small" data-act="companion-open" data-id="ubisoft">${icon("external", 13)} ${t("accounts.openClient")}</button>`,
      );
    }
    // EA games ship achievements through the EA account service; a title with
    // no achievement set of its own stays empty here.
    if (s.appName.startsWith("ea::")) {
      return emptyState("trophy", t("ach.eaTitle"), t("ach.eaDesc"));
    }
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
    if (S.achTierFilter !== "all" && getAchTier(a) !== S.achTierFilter) return false;
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
  // A chip filters only when the tier really holds achievements. The synthetic
  // platinum slot (a game without a platinum trophy) stays a plain indicator,
  // so clicking it cannot filter the list down to nothing.
  const tierChip = (
    tier: "platinum" | "gold" | "silver" | "bronze",
    cls: string,
    title: string,
    glyph: string,
    done: number,
    total: number,
    clickable = true,
  ): string =>
    total > 0
      ? clickable
        ? `<button type="button" class="ach-tier-mini ${cls} ${done >= total ? "complete" : ""} ${S.achTierFilter === tier ? "active" : ""}" data-act="ach-tier-filter" data-tier="${tier}" title="${title}" aria-pressed="${S.achTierFilter === tier}">${glyph} ${done}/${total}</button>`
        : `<span class="ach-tier-mini static ${cls} ${done >= total ? "complete" : ""}" title="${title}">${glyph} ${done}/${total}</span>`
      : "";
  const filterChip = (val: string, label: string, n: number): string =>
    `<button class="tab ach-status-chip ${S.activeAchFilter === val ? "active" : ""}" data-act="ach-filter" data-val="${val}">${label}<span class="count">${n}</span></button>`;

  const sourceNote = ubiAchSource.has(s.appName)
    ? `<div class="ach-source-note">${icon("info", 13)}<span>${t("ach.ubiEpicDesc")}</span></div>`
    : "";

  // Platinum celebration: a soft glow behind the cup, two sparkles and a
  // one-shot shine sweep (the sweep only runs on the first paint of the page).
  const platCup = `<span class="plat-cup${platShineDone ? "" : " shine"}">${epicPlatinumIcon(28)}<span class="plat-spark s1" aria-hidden="true">${icon("sparkles", 11)}</span><span class="plat-spark s2" aria-hidden="true">${icon("sparkles", 9)}</span><span class="plat-shine" aria-hidden="true"></span></span>`;
  if (isPlat) platShineDone = true;

  return `
    ${sourceNote}
    <div class="ach-summary-bar ${isPlat ? "platinum" : ""}">
      <div class="ach-summary-left">
        <span class="ach-summary-pct ${isPlat ? "plat" : ""}">${isPlat ? platCup : `${pct}%`}</span>
        <div class="ach-summary-text">
          <span class="ach-summary-count">${effectiveUnlocked} / ${data.total_achievements}</span>
          <span class="ach-summary-sub">${isPlat ? t("ach.platinumComplete") : data.total_xp > 0 ? `${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP` : ""}</span>
        </div>
        <div class="progress ach-summary-progress"><span style="width:${pct}%"></span></div>
      </div>
      <div class="ach-summary-right">
        ${tierChip("platinum", "plat", t("ach.tierPlatinum"), epicPlatinumIcon(11), platUnlocked, platTotal, tiers.platinum[0] > 0)}
        ${tierChip("gold", "gold", t("ach.tierGold"), icon("trophy", 11), tiers.gold[1], tiers.gold[0])}
        ${tierChip("silver", "silver", t("ach.tierSilver"), icon("trophy", 11), tiers.silver[1], tiers.silver[0])}
        ${tierChip("bronze", "bronze", t("ach.tierBronze"), icon("trophy", 11), tiers.bronze[1], tiers.bronze[0])}
        <button class="icon-btn" data-act="ach-refresh" data-id="${s.appName}" title="${t("ach.refreshData")}">${icon("refresh", 14)}</button>
        ${isCompanionApp(s.appName) || ubiAchSource.has(s.appName) ? "" : `<button class="icon-btn" data-act="open-store-achievements" data-id="${s.appName}" title="${t("ach.viewInStore")}">${icon("external", 14)}</button>`}
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

/**
 * Last session-end achievement refresh per game: a stop can arrive twice (the
 * stop command and the process watcher), and both must fold into one fetch.
 */
const sessionAchRefreshAt = new Map<string, number>();

/**
 * A finished session can unlock achievements in every store, but the caches
 * keep the pre-session state: Epic's cache has no TTL and Steam's is TTL'd, so
 * the ended game is refetched with a forced refresh (GOG and the companion
 * stores always read live sources). Called on `game-status` end events; the
 * cooldown makes duplicate stop events harmless.
 */
export function refreshAchievementsAfterSession(appName: string, sessionSeconds?: number): void {
  if (!isTauri) return;
  // The length arrives with the stop event; the trophies only once the store has
  // answered, which is why the summary is written in two steps.
  if (sessionSeconds !== undefined && sessionSeconds > 0) {
    recordSessionSummary(appName, { seconds: sessionSeconds, at: Date.now() });
    // The card that shows it is part of the overview, which may be the page the
    // player is looking at right now.
    repaintPersonalBlock(appName);
  }
  const now = Date.now();
  if (now - (sessionAchRefreshAt.get(appName) ?? 0) < 15_000) return;
  sessionAchRefreshAt.set(appName, now);
  // `before` has to be read while the old answer is still here.
  const before = S.loadedAchievements.get(appName)?.user_unlocked ?? 0;
  S.loadedAchievements.delete(appName);
  void fetchAndRenderAchievements(appName, true).then(() => {
    const after = S.loadedAchievements.get(appName)?.user_unlocked ?? 0;
    // The hero numbers repaint themselves: the fetch ends with a soft repaint of
    // the open page. This delta is written *after* that, so the card that shows it
    // is painted again here — otherwise it would wait for the next repaint.
    if (after > before) {
      recordSessionSummary(appName, { unlocked: after - before, at: Date.now() });
      repaintPersonalBlock(appName);
    }
  });
}

export async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri || S.loadingAchFor.has(appName)) return;
  S.loadingAchFor.add(appName);
  if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") openEpicModal(appName, false, false);
  try {
    const isGog = appName.startsWith("gog::");
    const isSteam = appName.startsWith("steam::");
    const source = sourceOfKey(appName);
    const isCompanion = source !== "epic" && source !== "gog" && source !== "steam";
    const rawId = isGog ? appName.slice(5) : appName;
    // Amazon Games has no achievement API: the tab shows its empty state
    // instead of asking a client that cannot answer.
    let data = source === "amazon"
      ? { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false }
      : isGog
        ? await gogGetAchievements(rawId)
        : isSteam
          ? await steamGetAchievements(appName.slice(7), forceRefresh)
          : isCompanion
            ? await companionAchievements(
                source as "ea" | "ubisoft" | "xbox" | "battlenet" | "riot",
                appName.slice(appName.indexOf("::") + 2),
                summaryOf(appName)?.title || appName,
                currentLanguage(),
              )
            : await epicGetAchievements(appName, forceRefresh);
    // Epic copies of Ubisoft games often ship no achievement set (Watch Dogs),
    // while Ubisoft Connect tracks them for the same account. Read the client's
    // local cache as the fallback and flag the page so it can say so.
    if (source === "epic" && data.achievements.length === 0) {
      const s = summaryOf(appName);
      const ubi = s ? ubisoftCompanionFor(s) : undefined;
      const partner = s ? gamePartner(s, rawOf(appName)) : null;
      if (partner?.type === "ubisoft") {
        const ubiData = await companionAchievements(
          "ubisoft",
          ubi?.id ?? "",
          ubi?.title ?? s?.title ?? appName,
          currentLanguage(),
        );
        if (ubiData.achievements.length > 0) {
          data = ubiData;
          ubiAchSource.add(appName);
        } else {
          ubiAchSource.delete(appName);
        }
      } else {
        ubiAchSource.delete(appName);
      }
    } else {
      ubiAchSource.delete(appName);
    }
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
    S.loadingAchFor.delete(appName);
    if (S.currentModalAppName === appName && (S.activeDrawerTab === "achievements" || S.activeDrawerTab === "overview")) {
      openEpicModal(appName, false, false);
    }
  }
}

/* ---------- System requirements ---------- */

export function renderDrawerSystemRequirements(s: EpicSummary): string {
  const g = rawOf(s.appName);
  const partner = gamePartner(s, g);
  const copyCard = `
    <section class="card sys-req-copy">
      <h3 class="gp-section-title">${t("sys.thisCopy")}</h3>
      <div>${renderInstalledCopyFacts(s, partner)}</div>
    </section>`;
  const manage = `<section class="sys-manage">${renderDrawerManage(s)}</section>`;
  return `<div class="sys-req-container">${copyCard}${manage}<div id="sys-req-body">${renderRequirementsBody(s)}</div></div>`;
}

/** The verified requirement hardware grid and localized language chips. */
export function renderRequirementsBody(s: EpicSummary): string {
  if (S.loadingReqFor.has(s.appName)) return loadingState(t("sys.loadingStore"));
  const data = S.loadedRequirements.get(s.appName);
  if (!data) {
    void fetchAndRenderRequirements(s.appName, s.title);
    return loadingState(t("sys.loading"));
  }

  const actionsHtml = `
    <div class="sys-req-actions">
      <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 13)} ${t("sys.requery")}</button>
      ${s.appName.startsWith("riot::") || s.appName.startsWith("amazon::")
        ? ""
        : `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t(s.appName.startsWith("gog::") ? "sys.openGogStore" : s.appName.startsWith("steam::") ? "drawer.storeTitleSteam" : isCompanionApp(s.appName) ? "ctx.storePage" : "sys.openEpicStore")}</button>`}
    </div>`;

  if (!data.supported || data.systems.length === 0) {
    return `${emptyState("cpu", t("sys.notFoundTitle"), t("sys.notFoundDesc"))}<div class="page-actions">${actionsHtml}</div>`;
  }

  const hasWin = data.systems.some((sys) => isWinSys(sys.systemType));
  const hasMac = data.systems.some((sys) => isMacSys(sys.systemType));
  const currentSys =
    data.systems.find((sys) =>
      S.activeSystemPlatform === "Windows" ? isWinSys(sys.systemType) : isMacSys(sys.systemType),
    ) || data.systems[0];

  const verified = verifySystemDetails(currentSys.details);
  const minItems = verified.filter((d) => d.minimum);
  const recItems = verified.filter((d) => d.recommended);

  if (minItems.length === 0 && recItems.length === 0) {
    return `${emptyState("cpu", t("sys.notFoundTitle"), t("sys.notFoundDesc"))}<div class="page-actions">${actionsHtml}</div>`;
  }

  const hasBothTiers = minItems.length > 0 && recItems.length > 0;
  const showingMin = !hasBothTiers ? minItems.length > 0 : S.reqTab !== "rec";
  const activeItems = showingMin ? minItems : recItems;

  const cellsHtml = activeItems
    .map(
      (item) => `
        <div class="sys-hw-cell">
          <div class="sys-hw-icon">${icon(item.iconName, 15)}</div>
          <div class="sys-hw-main">
            <div class="sys-hw-label">${esc(item.label)}</div>
            <div class="sys-hw-val">${esc(showingMin ? item.minimum : item.recommended)}</div>
          </div>
        </div>`,
    )
    .join("");

  const platformSwitch =
    hasWin && hasMac
      ? `<div class="seg sys-req-platforms">
          <button class="${isWinSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Windows">${t("sys.windowsPc")}</button>
          <button class="${isMacSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">${t("sys.macos")}</button>
        </div>`
      : "";

  const tierSwitch = hasBothTiers
    ? `<div class="seg sys-req-tabs">
        <button class="${showingMin ? "active" : ""}" data-act="req-tab" data-val="min" data-id="${esc(s.appName)}">${t("sys.minTitle")}</button>
        <button class="${!showingMin ? "active" : ""}" data-act="req-tab" data-val="rec" data-id="${esc(s.appName)}">${t("sys.recTitle")}</button>
      </div>`
    : `<div class="seg sys-req-tabs">
        <button class="active" disabled>${t(showingMin ? "sys.minTitle" : "sys.recTitle")}</button>
      </div>`;

  return `
    <div class="sys-req-toolbar">
      <div class="sys-req-controls">
        ${platformSwitch}
        ${tierSwitch}
      </div>
      ${actionsHtml}
    </div>
    <div class="sys-hw-grid">${cellsHtml}</div>
    ${renderSupportedLanguages(data.languages)}`;
}

export async function fetchAndRenderRequirements(appName: string, title: string, forceRefresh = false): Promise<void> {
  if (!isTauri || S.loadingReqFor.has(appName)) return;
  // Steam: one store call carries the description, the hero art and the specs.
  if (appName.startsWith("steam::")) {
    await loadSteamDetails(appName, forceRefresh);
    return;
  }
  // Companion games: their own client publishes no specs, so the same Steam
  // store lookup supplies the requirements, developer and add-on count.
  if (isCompanionApp(appName)) {
    await loadCompanionStoreDetails(appName, title, forceRefresh);
    return;
  }
  S.loadingReqFor.add(appName);
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
        if (text) {
          // Recomputes the text and its source note; the note must name the
          // store that actually supplied the description, not always Epic.
          paintAboutText(cur);
        } else if (descEl?.querySelector(".hub-desc-loading") && !S.loadingAboutFor.has(aboutKey(appName))) {
          // Store data arrived without a description and no fallback is pending.
          descEl.innerHTML = `<p>${t("drawer.noDescription")}</p>`;
        }
      }
      const g = rawOf(appName);
      const featuresEl = document.getElementById("hub-features-list");
      if (featuresEl) {
        featuresEl.innerHTML = renderGameFeatures(cur, g, gamePartner(cur, g), gameAntiCheat(cur, g), data, igdbTagsFor(cur.appName));
      }
      const ctrlEl = document.getElementById("sys-ctrl-body");
      if (ctrlEl) {
        ctrlEl.innerHTML = renderControllerCard(cur, g, data);
      }
    }
  } catch (e) {
    console.warn("System requirements could not be fetched:", e);
    S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
  } finally {
    S.loadingReqFor.delete(appName);
    // Epic's description arrives with this call: mark the store side settled and
    // only then decide whether the wiki fallback is needed. GOG is marked by the
    // details + requirements pair in `ensureOverviewData`.
    if (!appName.startsWith("gog::")) {
      storeAboutSettled.add(appName);
      const settled = summaryOf(appName);
      if (settled) maybeLoadWikiAbout(settled);
    }
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") {
      const body = document.getElementById("sys-req-body");
      const settled = summaryOf(appName);
      if (body && settled) body.innerHTML = renderRequirementsBody(settled);
      else if (settled) openEpicModal(appName, false);
    }
  }
}

/**
 * Repaints only the blocks a store-details answer feeds. The old path called
 * `openEpicModal` here, which rebuilt the whole tab (and re-decoded every
 * picture) for a description, a feature row and a requirement grid.
 */
function repaintStoreDetails(appName: string): void {
  if (S.currentModalAppName !== appName) return;
  const s = summaryOf(appName);
  if (!s) return;
  const g = rawOf(appName);
  const reqData = S.loadedRequirements.get(appName);
  const featuresEl = document.getElementById("hub-features-list");
  if (featuresEl) {
    featuresEl.innerHTML = renderGameFeatures(
      s,
      g,
      gamePartner(s, g),
      gameAntiCheat(s, g),
      reqData,
      igdbTagsFor(appName),
    );
  }
  const ctrlEl = document.getElementById("sys-ctrl-body");
  if (ctrlEl) ctrlEl.innerHTML = renderControllerCard(s, g, reqData);
  if (S.activeDrawerTab === "specs") {
    const body = document.getElementById("sys-req-body");
    if (body) body.innerHTML = renderRequirementsBody(s);
  }
  paintGameMeta(s);
  paintGameCloud(s);
  const critic = S.loadedCritic.get(appName);
  if (critic) {
    const merged = mergeSteamCritic(critic, appName);
    if (merged !== critic) S.loadedCritic.set(appName, merged);
    updateCriticUI(appName, merged);
  }
}

/**
 * Steam store id resolved for a companion title (null = no exact match yet).
 * Session-lived: the store search is the only uncached network step.
 */
const companionSteamApps = new Map<string, string | null>();

/**
 * Companion games have no store API for specs, so the Steam store page of the
 * same title supplies the requirements, developer and add-on count. The title
 * match is exact; anything looser would show another game's data.
 */
async function loadCompanionStoreDetails(appName: string, title: string, force = false): Promise<void> {
  const s = summaryOf(appName);
  if (!s) return;
  S.loadingReqFor.add(appName);
  try {
    const language = steamLanguage(S.appLanguage);
    let hitApp = companionSteamApps.get(appName);
    if (hitApp === undefined || force) {
      const hit = await steamFindStoreApp(title, language);
      hitApp = hit?.appId ?? null;
      companionSteamApps.set(appName, hitApp);
    }
    if (!hitApp) {
      S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
      return;
    }
    const details = await steamGetGameDetails(hitApp, language, force);
    S.steamDetails.set(appName, details);
    S.loadedRequirements.set(appName, buildSteamRequirements(appName, details));
    const item = S.allGamesMap.get(appName);
    if (item) item.dlcCount = details.dlc.length;
    // The client catalog text always wins; Steam only fills the gap.
    const desc = s.description?.trim();
    if (!desc || desc === NO_DESC || desc === s.title || desc.length <= 25) {
      s.description = details.description || details.shortDescription;
    }
    if (S.currentModalAppName === appName) {
      paintAboutText(s);
      paintGameMeta(s);
      paintGameCloud(s);
      const featuresEl = document.getElementById("hub-features-list");
      if (featuresEl) {
        const g = rawOf(appName);
        featuresEl.innerHTML = renderGameFeatures(s, g, gamePartner(s, g), gameAntiCheat(s, g), S.loadedRequirements.get(appName), igdbTagsFor(appName));
      }
      const dlcTab = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
      if (dlcTab) dlcTab.outerHTML = tabButton("dlcs", t("drawer.dlcs"));
    }
  } catch (e) {
    console.warn("Companion store details could not be fetched:", e);
    S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
  } finally {
    S.loadingReqFor.delete(appName);
    storeAboutSettled.add(appName);
    maybeLoadWikiAbout(s);
    if (S.currentModalAppName === appName && (S.activeDrawerTab === "specs" || S.activeDrawerTab === "overview")) {
      repaintStoreDetails(appName);
    }
  }
}

/**
 * Steam store details arrive in a single call: description, developer, hero art
 * and the requirement bullets. The Rust side caches the payload for six hours.
 */
async function loadSteamDetails(appName: string, force = false): Promise<void> {
  const s = summaryOf(appName);
  if (!s) return;
  S.loadingReqFor.add(appName);
  try {
    const details = await steamGetGameDetails(appName.slice(7), steamLanguage(S.appLanguage), force);
    S.steamDetails.set(appName, details);
    S.loadedRequirements.set(appName, buildSteamRequirements(appName, details));
    // Family-shared games have no local appinfo, so their release year only
    // arrives here: redo the lookups that ran without one, or they keep the
    // older game of the same name.
    if (!s.releaseYear && gameReleaseYear(s) && (S.loadedHltb.has(appName) || S.loadedCritic.has(appName))) {
      S.loadedHltb.delete(appName);
      S.loadedCritic.delete(appName);
      ensureOverviewData(s);
    }    if (S.currentModalAppName === appName) {
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
      const cloud = details.categories.includes(23);
      const item = S.allGamesMap.get(appName) || S.steamSummariesMap.get(appName);
      if (item) {
        item.cloudSavesSupported = cloud;
        item.dlcCount = details.dlc.length;
        if (!item.developer) item.developer = details.developers[0] || details.publishers[0] || "";
      }
      paintGameMeta(s);
      paintGameCloud(s);
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
    S.loadingReqFor.delete(appName);
    storeAboutSettled.add(appName);
    maybeLoadWikiAbout(s);
    if (S.currentModalAppName === appName && (S.activeDrawerTab === "specs" || S.activeDrawerTab === "overview")) {
      repaintStoreDetails(appName);
    }
  }
}

/**
 * Fills the metadata caches for one game without opening its page.
 *
 * Every source already writes a disk cache in Rust, but nothing filled those
 * caches until the player opened the page: the first visit still waited for
 * HLTB, the critic service, the store and IGDB. The idle prefetch walks the
 * recent games once and lands the same answers the page would ask for, so a
 * later open paints from memory. It is deliberately sequential (one game at a
 * time, a caller-side pause between games) and skips a game whose page is open.
 */
export async function prefetchGamePage(appName: string): Promise<void> {
  if (!isTauri || S.offlineMode) return;
  if (S.currentModalAppName === appName) return;
  const s = summaryOf(appName);
  if (!s) return;
  const year = gameReleaseYear(s);
  const lookupTitle = S.allGamesMap.get(appName)?.title ?? s.title;
  const jobs: Promise<unknown>[] = [];

  if (!S.loadedHltb.has(appName)) {
    jobs.push(
      epicGetHltb(lookupTitle, appName, false, year)
        .then((data) => { S.loadedHltb.set(appName, data); })
        .catch(() => undefined),
    );
  }
  if (!S.loadedCritic.has(appName)) {
    jobs.push(
      epicGetCritic(lookupTitle, appName, false, year)
        .then((data) => { S.loadedCritic.set(appName, mergeSteamCritic(data, appName)); })
        .catch(() => undefined),
    );
  }
  if (!S.loadedRequirements.has(appName)) {
    jobs.push(fetchAndRenderRequirements(appName, s.title).catch(() => undefined));
  }
  if (!S.loadedAchievements.has(appName)) {
    jobs.push(fetchAndRenderAchievements(appName).catch(() => undefined));
  }
  if (!appName.includes("::") && !S.dlcCache.has(appName)) {
    jobs.push(
      epicGetGameDlcs(appName)
        .then((res) => { S.dlcCache.set(appName, res); })
        .catch(() => undefined),
    );
  }
  if (s.installed && !S.loadedScreenshots.has(appName)) {
    // Local folder scan; it paints in its own time and has no promise to await.
    fetchAndRenderScreenshots(appName, s.title);
  }
  // The hero is the one picture the page waits for; the rest (IGDB screenshots,
  // similar-game covers) is warmed once the IGDB answer lands.
  warmImages([epicWideArt(s) || s.cover]);

  // News is Steam's feed. Asking for a Steam store search on every Epic game
  // would cost a request for nothing, so only titles with a Steam copy do it.
  if (appName.startsWith("steam::") || gameVersionsOf(appName).some((v) => v.appName.startsWith("steam::"))) {
    void loadGameNews(s);
  }

  await Promise.allSettled(jobs);

  ensureIgdbTransport(() => {
    if (S.currentModalAppName === appName) return;
    ensureIgdbOverview({ appName, title: lookupTitle }, year, () => {
      const game = igdbGameFor(appName);
      if (!game) return;
      const urls: Array<string | null> = [
        ...game.screenshots.map((id) => igdbImage(id, "screenshot_big")),
        ...game.similar.map((hit) => (hit.coverId ? igdbImage(hit.coverId, "cover_big") : null)),
      ];
      warmImages(urls);
    });
  });
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
