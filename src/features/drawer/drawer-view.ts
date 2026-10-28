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
import { achGameNotificationsEnabled } from "../../core/ach-game-prefs";
import { emptyPanel, emptyState, epicPlatinumIcon, filledTrophy, icon, loadingState, platinumCup, type IconName } from "../../core/icons";
import { updateNavHistoryUi } from "../../core/nav";
import { cachedImage, warmImages } from "../../core/picture-cache";
import { recordSessionSummary, sessionSummaryFor, sessionWhen } from "../../core/session-summary";
import { cachedSteamCover, cachedSteamHero, isFlatSteamArt, rememberSteamCover, rememberSteamHero } from "../../core/steam-art-cache";
import { steamLibraryArt, steamNews, steamSetAchievementNotifications, steamWatchRunning, type SteamLibraryArt, type SteamNewsItem } from "../../steam";
import { presenceSync, scheduleRender, updateGamepadHud } from "../../core/render";
import { gameStatusOf, gameStatusOptions, statusMenuHtml, type GameStatus } from "../library/game-status";
import { canonicalGameTitle, clearWideArtCache, epicWideArt, gameVersionsOf, isCompanionKey, isCompanionSource, libraryPlaytime, rawOf, sharedOwnerOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { storeVersionLabel } from "./external-versions";
import { sideCard } from "./side-widgets";
import { storeLogo } from "../store/store-logos";
import { holdStoreForCover } from "../store/store-view";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtDecimal1, fmtHours, fmtPlaytime } from "../../core/utils";
import { checkInstallPathState, epicDetectEos, epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetGameSettings, epicGetHltb, epicGetSystemRequirements, epicGetWikiAbout, epicPortrait, getAntiCheat, getThirdPartyLauncher, requiresThirdPartyLauncher, type CriticData, type EpicAchievementSummary, type EpicAchievementsData, type EpicSummary, type HltbData, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";
import { gogGetAchievements, gogGetSystemRequirements } from "../../gog";
import { loadGogDetails } from "./game-details-cache";
import { hydrateGameCompatCard } from "./game-compat";
import { hydrateProtonDbChip } from "./protondb";
import { hydrateAntiCheatChip } from "./awacy";
import { hydrateDeckChip } from "./deck";
import {
  achievementTestNotification,
  steamFindStoreApp,
  steamGetAchievementCommunity,
  steamGetAchievementSource,
  steamGetAchievements,
  steamGetEmulatorAchievements,
  steamGetGameDetails,
  steamSetAchievementSource,
  steamStartEmulatorWatcher,
  steamStopAchievementWatcher,
  type AchievementSourceConfig,
} from "../../steam";

export const steamAchSourceCache = new Map<string, AchievementSourceConfig>();
import { companionAchievements } from "../../companion";
import { buildSteamRequirements, steamLanguage } from "./steam-details";

import { invalidateLibraryVisibleCache } from "../library/library-view";
import { fetchAndRenderScreenshots, forgetGameScreenshots, renderDrawerScreenshots, renderMomentsStrip } from "../screenshots/screenshots-view";
import { cachedNotes, notesForScope, onNotesChanged } from "../notes/notes-client";
import { notePreview } from "../notes/markdown";
import { ensureDrawerNotes, renderDrawerNotes } from "../notes/drawer-notes";
import { ensureLegacyAchievementNotes } from "./ach-notes";
import { igdbImage, igdbStatus } from "../../igdb";
import { ageOrgOrder, ensureIgdbOverview, gameGenresFor, igdbAboutSettled, igdbGameFor, igdbTagsFor, renderIgdbCredits, renderIgdbMedia, renderIgdbSimilar } from "./igdb-view";
import { cleanStoreDescription, detectGameMode, getAchTier, getHardwareLabel, heroCloudStatus, rememberCloudSync, renderAchievementSections, renderControllerCard, renderCriticCard, renderGameFeatures, renderHltbCard, renderInstalledCopyFacts, renderLastSessionCompact, renderNextAchievements, renderSteamNews } from "./drawer-widgets";
import { renderRequirementPanel, renderSystemTab, repaintSystemRequirements } from "./system-tab";
import { achievementProgress, achievementStats, estimateRemainingHours, isAchievementUnlocked, nextAchievements } from "../../core/achievements";
import { renderAchievementDetail } from "./ach-detail";
import { renderAchSidePanel } from "./ach-side-panel";
import { renderPowerPyxCard } from "./ach-powerpyx";
import { powerpyxGameGuide } from "../../guides";

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
  // The personal label sits in the same line, so setting it in the menu has a
  // visible result on the page instead of only inside the closed menu.
  const currentStatus = gameStatusOf(s.appName);
  const statusOption = currentStatus ? gameStatusOptions().find((option) => option.value === currentStatus) : undefined;
  const statusChip = statusOption
    ? `<span class="gp-meta-item" title="${esc(t("status.label"))}">${icon(statusOption.ic, 13)} ${esc(statusOption.label)}</span>`
    : "";
  // The one line under the title: who made it, when, for whom.
  // Everything else about the copy lives in the features card.
  return [
    dev ? `<span>${esc(dev)}</span>` : "",
    publisher ? `<span class="gp-meta-item">${esc(publisher)}</span>` : "",
    year ? `<span class="gp-meta-item">${icon("calendar", 13)} ${year}</span>` : "",
    statusChip,
    colChip,
    ageChip,
    s.appName.startsWith("gog::") ? `<span class="gp-meta-item" title="GOG.COM DRM-Free">${icon("unlock", 13)} DRM-Free</span>` : "",
    S.steamSharedIds.has(s.appName)
      ? `<span class="gp-meta-item" title="${esc(t("drawer.familySharingTip"))}">${icon("users", 13)} ${esc(t("drawer.familySharing"))}</span>`
      : "",
  ].filter(Boolean).join("");
}

/** Who owns cloud saves for this copy, and whether the launcher can observe it. */
function cloudProvider(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
): { name: string; external: boolean; tip: string } {
  const source = sourceOfKey(s.appName);
  if (partner?.type === "ea" || source === "ea") {
    return { name: t("feat.eaCloud"), external: true, tip: t("feat.eaCloudTip") };
  }
  if (partner?.type === "ubisoft" || source === "ubisoft") {
    return { name: t("feat.ubiCloud"), external: true, tip: t("feat.ubiCloudTip") };
  }
  if (partner?.type === "rockstar") {
    return {
      name: t("cloud.rockstar"),
      external: true,
      tip: t("feat.partnerCloudTip", { name: "Rockstar Games" }),
    };
  }
  if (source === "steam") {
    return { name: t("feat.steamCloud"), external: true, tip: t("feat.steamCloudTip") };
  }
  if (source === "gog") {
    return { name: t("feat.gogCloud"), external: true, tip: t("feat.gogCloudTip") };
  }
  if (source === "xbox") {
    return {
      name: t("cloud.xbox"),
      external: true,
      tip: t("cloud.externalTip", { provider: t("cloud.xbox") }),
    };
  }
  if (source === "battlenet") {
    return {
      name: t("cloud.battlenet"),
      external: true,
      tip: t("cloud.externalTip", { provider: t("cloud.battlenet") }),
    };
  }
  if (source === "riot") {
    return {
      name: t("cloud.riot"),
      external: true,
      tip: t("cloud.externalTip", { provider: t("cloud.riot") }),
    };
  }
  if (partner) {
    const name = t("feat.partnerCloud", { name: partner.name });
    return {
      name,
      external: true,
      tip: t("feat.partnerCloudTip", { name: partner.name }),
    };
  }
  if (source === "epic") return { name: t("cloud.epic"), external: false, tip: "" };
  if (source === "amazon") return { name: t("cloud.amazon"), external: false, tip: "" };
  return { name: "", external: false, tip: "" };
}

function cloudWidgetBody(s: EpicSummary, partner: ThirdPartyLauncherInfo | null): string {
  const g = rawOf(s.appName);
  const status = heroCloudStatus(s, g, partner, S.loadedRequirements.get(s.appName));
  const provider = cloudProvider(s, partner);
  let main = status.label;
  let note = status.tooltip;
  if (provider.external) {
    // Keep the provider itself as the headline; the note explains ownership
    // without repeating the name in a sentence above it.
    main = provider.name;
    note = provider.tip;
  } else {
    if (main === "—") {
      main = t("feat.localSave");
      note = t("feat.localSaveTip");
    } else if (!status.synced && status.label === t("drawer.cloudNotSynced")) {
      main = `${provider.name} · ${status.label}`;
    }
  }
  return `<div class="gp-cloud-main${status.synced ? " ok" : ""}${provider.external ? " is-provider" : ""}">${icon("cloud", 16)}<span>${esc(main)}</span></div>
    <p class="gp-cloud-note">${esc(note)}</p>`;
}

export function renderGameHeaderMeta(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null = null,
): string {
  const g = rawOf(s.appName);
  const status = heroCloudStatus(s, g, partner, S.loadedRequirements.get(s.appName));
  const provider = cloudProvider(s, partner);
  let cloudMain = status.label;
  let cloudNote = status.tooltip;
  if (provider.external) {
    cloudMain = provider.name;
    cloudNote = provider.tip;
  } else {
    if (cloudMain === "—") {
      cloudMain = t("feat.localSave");
      cloudNote = t("feat.localSaveTip");
    } else if (!status.synced && status.label === t("drawer.cloudNotSynced")) {
      cloudMain = `${provider.name} · ${status.label}`;
    }
  }

  const pt = S.playtimeMap.get(s.appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—";
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

  const summary = sessionSummaryFor(s.appName);
  let sessionLabel = t("drawer.lastPlayedLabel");
  let sessionVal = "";
  let sessionTooltip = "";

  if (summary) {
    sessionLabel = t("drawer.lastSession");
    const when = sessionWhen(summary.at);
    const whenText =
      when.unit === "minutes"
        ? t("time.minutesAgo", { n: when.n })
        : when.unit === "hours"
          ? t("time.hoursAgo", { n: when.n })
          : t("time.daysAgo", { n: when.n });
    sessionVal = `${fmtPlaytime(summary.seconds)} · ${whenText}`;
    sessionTooltip = t("drawer.lastSession");
  } else if (lastPlayed) {
    sessionLabel = t("drawer.lastPlayedLabel");
    sessionVal = lastPlayed;
    sessionTooltip = lastPlayed;
  } else {
    sessionLabel = t("drawer.lastPlayedLabel");
    sessionVal = "—";
    sessionTooltip = t(pt?.total_seconds ? "playtime.noSession" : "playtime.notPlayedYet");
  }

  const isSynced = Boolean(status.synced);

  return `
    <div class="gp-bar-meta-group">
      <div class="gp-bar-meta-item gp-bar-meta-cloud" title="${esc(cloudNote)}">
        <div class="gp-bar-meta-icon${isSynced ? " is-synced" : ""}">
          ${icon("cloud", 14)}
        </div>
        <div class="gp-bar-meta-text">
          <span class="gp-bar-meta-label">${t("drawer.cloudTitle")}</span>
          <span class="gp-bar-meta-val">${esc(cloudMain)}</span>
        </div>
      </div>
      <div class="gp-bar-meta-sep" aria-hidden="true"></div>
      <div class="gp-bar-meta-item gp-bar-meta-time is-clickable" data-act="open-edit-playtime" data-id="${s.appName}" title="${esc(timeTooltip)}">
        <div class="gp-bar-meta-icon">
          ${icon("clock", 14)}
        </div>
        <div class="gp-bar-meta-text">
          <span class="gp-bar-meta-label">${t("drawer.statTime")}</span>
          <span class="gp-bar-meta-val" id="drawer-stat-playtime">${esc(playtimeStr)}</span>
        </div>
      </div>
      <div class="gp-bar-meta-sep" aria-hidden="true"></div>
      <div class="gp-bar-meta-item gp-bar-meta-session" title="${esc(sessionTooltip)}">
        <div class="gp-bar-meta-icon">
          ${icon("calendar", 14)}
        </div>
        <div class="gp-bar-meta-text">
          <span class="gp-bar-meta-label">${esc(sessionLabel)}</span>
          <span class="gp-bar-meta-val" id="drawer-stat-last-activity">${esc(sessionVal)}</span>
        </div>
      </div>
    </div>`;
}

export function paintGameHeaderMeta(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null = null,
): void {
  const host = document.querySelector(".gp-bar-right");
  if (!host) return;
  host.innerHTML = renderGameHeaderMeta(s, partner ?? gamePartner(s, rawOf(s.appName)));
}

function paintGameCloud(s: EpicSummary): void {
  const partner = gamePartner(s, rawOf(s.appName));
  paintGameHeaderMeta(s, partner);
  const host = document.getElementById("gp-cloud-widget-body");
  if (host) host.innerHTML = cloudWidgetBody(s, partner);
}

/** Repaints the cloud card after a sync/decision elsewhere on the page. */
export function repaintCloudWidget(appName: string): void {
  if (S.currentModalAppName !== appName) return;
  const s = summaryOf(appName);
  if (s) paintGameCloud(s);
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

/// Detects whether an Epic copy bundles the EOS SDK, once per game (result
/// cached). EOS is Epic's own overlay; scanning Steam or GOG copies would only
/// surface a row that does not apply to them.
function ensureEosSupport(appName: string): void {
  if (sourceOfKey(appName) !== "epic" || appName.startsWith("custom::")) return;
  const s = summaryOf(appName);
  if (!isTauri || !s?.installed || !s.installPath || S.eosSupportMap.has(appName)) return;
  S.eosSupportMap.set(appName, false);
  void epicDetectEos(s.installPath)
    .then((has) => {
      S.eosSupportMap.set(appName, has);
      if (has) repaintCopyFacts(appName);
    })
    .catch(() => {});
}

/** One folder check per drawer visit. A failed check is repeated next time so
 *  a drive that was plugged back in recovers without restarting the app. */
const copyHealthPending = new Set<string>();

function ensureCopyHealth(appName: string): void {
  const s = summaryOf(appName);
  if (!isTauri || !s?.installed || !s.installPath) return;
  if (S.copyPathStates.get(appName)?.state === "ok" || copyHealthPending.has(appName)) return;
  copyHealthPending.add(appName);
  const path = s.installPath;
  void checkInstallPathState(path)
    .then((state) => {
      S.copyPathStates.set(appName, state);
      repaintCopyFacts(appName);
    })
    .catch(() => {})
    .finally(() => copyHealthPending.delete(appName));
}

/** The EOS row and the copy-health warning live in the "this copy" card. */
function repaintCopyFacts(appName: string): void {
  if (S.currentModalAppName !== appName) return;
  const s = summaryOf(appName);
  const host = document.getElementById("sys-copy-body");
  if (!s || !host) return;
  host.innerHTML = renderInstalledCopyFacts(
    s,
    gamePartner(s, rawOf(appName)),
    S.copyPathStates.get(appName),
  );
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
  if (s.appName.startsWith("custom::")) {
    const custom = S.customGames.find((g) => g.id === s.appName);
    const hasExe = Boolean(custom?.exePath && custom.exePath.trim().length > 0);
    if (!hasExe) {
      return `<button class="btn ghost lg" data-act="pick-custom-exe-for" data-id="${s.appName}" title="${esc(t("customGames.setExeHint"))}">${icon("folder", 16)} ${esc(t("customGames.setExe"))}</button>`;
    }
    return `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`;
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
    ? `<button type="button" class="ps5-context-item" role="menuitem" data-act="companion-open" data-id="${esc(sourceOfKey(s.appName))}">${icon("gamepad-2", 15)} <span>${t("accounts.openClient")}</span></button>`
    : "";
  return `
    <div class="gp-more-wrap">
      <button class="btn ghost lg icon-only gp-more-btn${open ? " active" : ""}" data-act="game-more-menu" data-id="${esc(s.appName)}" title="${esc(t("drawer.moreActions"))}" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}">${icon("dots", 16)}</button>
      <div id="game-more-menu" class="gp-more-menu${open ? " show" : ""}" role="menu">
        <button type="button" class="ps5-context-item" role="menuitem" data-act="manage-game-collections" data-id="${esc(s.appName)}">${icon("layers", 15)} <span>${t("drawer.collection")}</span></button>
        ${statusMenuHtml(s.appName)}
        <div class="gp-more-sep"></div>
        <button type="button" class="ps5-context-item" role="menuitem" data-act="epic-store-page" data-id="${esc(s.appName)}">${icon("external", 15)} <span>${storeTitle}</span></button>
        ${clientItem}
        <div class="gp-more-sep"></div>
        <button type="button" class="ps5-context-item" role="menuitem" data-act="open-custom-cover" data-target="cover" data-id="${esc(s.appName)}">${icon("image", 15)} <span>${t("manage.coverChange")}</span></button>
      </div>
    </div>`;
}

/** Wires hover and click interaction on the game page More menu's status submenu with a grace buffer. */
export function wireDrawerSubmenu(menuEl: HTMLElement): void {
  const wrap = menuEl.querySelector<HTMLElement>(".ctx-submenu-wrap");
  if (!wrap || wrap.dataset.wired === "true") return;
  wrap.dataset.wired = "true";

  const sub = wrap.querySelector<HTMLElement>(".ps5-context-submenu");
  const trigger = wrap.querySelector<HTMLElement>(".ctx-submenu-trigger");
  if (!sub || !trigger) return;

  let timer: number | null = null;
  const cancel = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };
  const close = (): void => {
    cancel();
    timer = window.setTimeout(() => {
      wrap.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    }, 200);
  };
  const open = (): void => {
    cancel();
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
  };

  trigger.addEventListener("mouseenter", open);
  trigger.addEventListener("mouseleave", close);
  sub.addEventListener("mouseenter", cancel);
  sub.addEventListener("mouseleave", close);

  trigger.addEventListener("click", () => {
    if (wrap.classList.contains("open")) {
      wrap.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    } else {
      open();
    }
  });

  menuEl.querySelectorAll(".ps5-context-item:not(.ctx-submenu-trigger)").forEach((item) => {
    item.addEventListener("mouseenter", () => {
      cancel();
      wrap.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    });
  });
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

  if (s.appName.startsWith("custom::")) {
    const custom = S.customGames.find((g) => g.id === s.appName);
    const hasExe = Boolean(custom?.exePath && custom.exePath.trim().length > 0);
    const primary = S.runningGames.has(s.appName)
      ? `<button class="btn play lg" data-act="epic-stop" data-id="${s.appName}">${icon("square", 16)} ${t("common.stop")}</button>`
      : !hasExe
        ? `<button class="btn ghost lg" data-act="pick-custom-exe-for" data-id="${s.appName}" title="${esc(t("customGames.setExeHint"))}">${icon("folder", 16)} ${esc(t("customGames.setExe"))}</button>`
        : `<button class="btn play lg" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`;
    return `${primary}
      <button class="btn ghost lg icon-only ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">${icon("heart", 16)}</button>
      <button class="btn ghost lg icon-only" data-act="edit-custom-game" data-id="${s.appName}" title="${esc(t("common.edit"))}">${icon("edit", 16)}</button>
      <button class="btn ghost lg danger" data-act="custom-game-remove" data-id="${s.appName}" title="${esc(t("customGames.delete"))}">${icon("trash", 16)} ${esc(t("customGames.delete"))}</button>
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

/** The System tab: the verified hardware table is the page, and the practical
 *  facts (this copy, controller, features) move to a quieter side column. */
function renderSpecsTab(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null,
  antiCheat: string | null,
): string {
  return renderSystemTab(s, partner, antiCheat, renderRequirementsBody(s));
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

function tabButton(tab: string, label: string, extraClass = "", glyphHtml = ""): string {
  const glyph = glyphHtml || (TAB_ICON[tab] ? icon(TAB_ICON[tab], 14) : "");
  return `<button class="tab drawer-tab ${S.activeDrawerTab === tab ? "active" : ""} ${extraClass}" data-act="drawer-tab" data-tab="${tab}" data-id="${S.currentModalAppName ?? ""}">${glyph}${label}</button>`;
}

/**
 * TIME / TROPHY / CLOUD chips. Re-rendered in place whenever late data (local
 * achievements, service playtime, cloud stamp) arrives, so the open page never
 * keeps a stale dash.
 */
function heroStatsHtml(s: EpicSummary): string {
  const stat = (label: string, value: string, attrs = "", valId = "", valCls = ""): string =>
    `<div class="gp-stat${attrs.includes("data-act") ? " clickable" : ""}" ${attrs}><span class="gp-stat-label">${label}</span><span class="gp-stat-val ${valCls}"${valId ? ` id="${valId}"` : ""}>${value}</span></div>`;
  const isPlat = isAppPlatinum(s.appName);
  const achSum = achSummaryOf(s.appName);
  const pt = S.playtimeMap.get(s.appName);
  const achVal = achSum && achSum.total_achievements > 0
    ? `${achSum.user_unlocked}/${achSum.total_achievements}`
    : "—";
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
            ${stat(isPlat ? t("drawer.statPlat") : t("drawer.statTrophy"), achVal, achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}" title="${t("drawer.viewAchievements")}"` : "", "", isPlat ? "plat" : "")}`;
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

/** True when the text is the game's own real blurb, not a store placeholder. */
function isRealDescription(s: EpicSummary, text: string): boolean {
  return Boolean(text && text !== NO_DESC && text !== s.title);
}

/** Epic's catalog description (raw or from the store data); empty when unusable. */
function epicDescription(s: EpicSummary): string {
  const rawDesc = s.description?.trim() ?? "";
  const reqData = S.loadedRequirements.get(s.appName);
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : "");
  // A custom game's description is written by the player, so a short note is
  // legitimate text: the catalog length filter below would hide it.
  if (s.appName.startsWith("custom::")) return isRealDescription(s, rawDesc) ? rawDesc : "";
  const hasRealDesc = isRealDescription(s, rawDesc) && rawDesc.length > 25;
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
  // Custom text is shown ahead of IGDB, so the note has to name it first.
  if (s.appName.startsWith("custom::") && epicDescription(s)) return t("drawer.sourceCustom");
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
  const customDesc = s.appName.startsWith("custom::") ? storeDesc : "";
  const text = customDesc || igdbDesc || storeDesc || wikiText;
  const pending = !customDesc && !igdbDesc && !igdbAboutSettled(s.appName);
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

  // Fetch official GOG metadata on demand. The details answer carries the
  // requirements too, so it is the only store call the page makes: asking for
  // the same payload a second time doubled the wait on the first open.
  if (appName.startsWith("gog::")) {
    const rawId = appName.slice(5);
    // The details call is also the requirements source: keep the specs tab from
    // starting the same fetch while it is in flight.
    const ownsReq = !S.loadingReqFor.has(appName);
    if (ownsReq) S.loadingReqFor.add(appName);
    void loadGogDetails(rawId)
      .then((details) => {
        if (details.requirements) {
          S.loadedRequirements.set(appName, details.requirements);
        } else if (!S.loadedRequirements.has(appName)) {
          S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
        }
        if (S.currentModalAppName !== appName) return;
        if (details.description && !s.description) {
          s.description = cleanStoreDescription(details.description);
          paintAboutText(s);
        }
        if (details.hero_url) {
          // The store answer is cached, the picture behind it must be too: keep
          // both the image and its blurred backdrop on the same cached URL.
          const heroEl = modalRoot.querySelector<HTMLImageElement>(".gp-hero-img");
          if (heroEl) {
            heroEl.dataset.imgUrl = details.hero_url;
            heroEl.src = cachedImage(details.hero_url);
          }
          const bgEl = modalRoot.querySelector<HTMLElement>(".gp-hero-backdrop");
          if (bgEl) {
            bgEl.dataset.imgUrl = details.hero_url;
            bgEl.style.backgroundImage = `url('${cachedImage(details.hero_url)}')`;
          }
          warmImages([details.hero_url]);
        }
        if (details.developer) {
          const item = S.gogSummariesMap.get(rawId);
          if (item) item.developer = details.developer;
          paintGameMeta(s);
          paintGameCloud(s);
        }
      })
      .catch(() => {
        if (!S.loadedRequirements.has(appName)) {
          S.loadedRequirements.set(appName, { supported: false, systems: [], languages: [], appName });
        }
      })
      .finally(() => {
        if (ownsReq) S.loadingReqFor.delete(appName);
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
        if (S.currentModalAppName === appName && (S.activeDrawerTab === "specs" || S.activeDrawerTab === "overview")) {
          repaintStoreDetails(appName);
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
  // A detail belongs to the game page it was opened from; a new page or a new
  // game starts on the list again.
  if (isInitialOpen || !isSameApp) S.achDetail = null;
  // Switching games inside the open drawer must not keep the previous
  // gallery (and its full-size originals) alive.
  if (!isSameApp && S.currentModalAppName) forgetGameScreenshots(S.currentModalAppName);
  S.currentModalAppName = appName;
  // A game started from the Steam client may be running before the periodic
  // watcher reports it; opening the page asks the backend once so the drawer
  // never shows Play for a live session.
  if (appName.startsWith("steam::")) {
    void steamWatchRunning()
      .then((ids) => {
        const id = appName.slice("steam::".length);
        if (ids.includes(id) && !S.runningGames.has(appName)) {
          S.runningGames.add(appName);
          scheduleRender();
        }
      })
      .catch(() => {});
  }
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
    // GOG's details call carries the requirements; `ensureOverviewData` owns it.
    if (!appName.startsWith("gog::") && !S.loadedRequirements.has(appName) && !S.loadingReqFor.has(appName)) void fetchAndRenderRequirements(appName, s.title);
    if (!S.loadedScreenshots.has(appName) && !S.loadingScreenshotsFor.has(appName)) void fetchAndRenderScreenshots(appName, s.title);
    if (!S.loadedAchievements.has(appName) && !S.loadingAchFor.has(appName)) void fetchAndRenderAchievements(appName);
    ensureEosSupport(appName);
    ensureCopyHealth(appName);
  }
  // The notes tab's list and badge; the client caches, so this is one call.
  ensureDrawerNotes(appName, () => {
    repaintPersonalBlock(appName);
    repaintAchievementsTab(appName);
  });

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
    paintGameHeaderMeta(s, partner);
    paintGameMeta(s);
    paintGameCloud(s);
    if (S.activeDrawerTab === "specs") {
      void hydrateGameCompatCard(appName);
      void hydrateDeckChip(appName);
      void hydrateProtonDbChip(appName);
      void hydrateAntiCheatChip(appName);
    }
    return;
  }

  const isGog = appName.startsWith("gog::");
  const isSteam = appName.startsWith("steam::");
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  // The hero is the one picture the page waits for: ask for it as soon as the
  // page opens, and paint from the cached copy the moment it arrives.
  warmImages([art]);
  // A Steam title's wide art only exists under the store's hashed path; resolve
  // it before the hero settles on a low-resolution fallback.
  if (isSteam) void ensureSteamHeroArt(appName);
  const meta = gameMetaHtml(s, partner, antiCheat);

  const tabs = `${tabButton("overview", t("drawer.overview"))}
       ${tabButton("achievements", t("drawer.achievements"), isPlat ? "plat" : "", isPlat ? filledTrophy(14) : "")}
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
              ? `<div class="gp-hero-backdrop" data-img-url="${esc(art)}" style="background-image:url('${esc(cachedImage(art))}');"></div>
          <img class="gp-hero-img" src="${esc(cachedImage(art))}" data-img-url="${esc(art)}" alt="" decoding="async" onload="this.classList.remove('is-broken');this.classList.toggle('is-portrait', this.naturalWidth/this.naturalHeight < 1.3)" onerror="this.classList.add('is-broken')" />`
              : ""
          }
          <div class="gp-hero-scrim"></div>
          <div class="gp-hero-top">
            <div class="gp-hero-nav">
              <button class="icon-btn gp-hero-tool" id="gp-nav-back" data-act="page-back" data-i18n-title="nav.historyBack" title="${t("nav.historyBack")}">${icon("arrow-left", 16)}</button>
            </div>
            <div class="gp-hero-actions">
              <button class="icon-btn gp-hero-tool" data-act="open-custom-cover" data-target="hero" data-id="${appName}" title="${t("drawer.customizeCover")}">${icon("image", 16)}</button>
            </div>
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
          <div class="gp-bar-right">${renderGameHeaderMeta(s, partner)}</div>
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
  if (S.activeDrawerTab === "specs") {
    void hydrateGameCompatCard(appName);
    void hydrateDeckChip(appName);
    void hydrateProtonDbChip(appName);
    void hydrateAntiCheatChip(appName);
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
    const isEmpty = host.children.length === 0 || host.innerHTML.trim() === "";
    card.classList.toggle("is-empty", isEmpty);
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
  // A custom game's own description wins over every catalog: the player wrote
  // it for this exact entry. Otherwise IGDB first, then the game's own store,
  // then Wikipedia. The note under the box names whichever source won, so a
  // fallback is never silent.
  const customDesc = s.appName.startsWith("custom::") ? epicDesc : "";
  const effectiveDesc = customDesc || igdbDesc || epicDesc || wikiText || null;
  // The box waits for IGDB before showing the store text: replacing the text
  // under the reader's eyes reads like the wrong description. Once IGDB has
  // settled, the spinner only stays while the store or the wiki can still answer.
  const igdbPending = !customDesc && !igdbDesc && !igdbAboutSettled(s.appName);
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
  return `${noteCard}${personalEmpty}`;
}

/** Paints the personal block and personal sidebar widgets again after a session ended or notes changed, if its page is open. */
export function repaintPersonalBlock(appName: string): void {
  if (S.currentModalAppName !== appName || S.activeDrawerTab !== "overview") return;
  const host = document.getElementById("gp-personal-block");
  const s = summaryOf(appName);
  if (!host || !s) return;
  const playtime = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  host.innerHTML = personalBlockHtml(s, s.installed || playtime > 0);
  paintGameHeaderMeta(s, gamePartner(s, rawOf(appName)));
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
    if (count === 0) return emptyState("package", t("drawer.noDlc"), t("drawer.noDlcDesc"));
    const dlcStoreBtn = s.appName.startsWith("amazon::")
      ? ""
      : `<button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("ctx.storePage")}</button>`;
    return `
      <div class="dlc-tab-content">
        <div class="row">
          <div class="row-main">
            <div class="row-title">${t("drawer.addonsCount", { count })}</div>
            <div class="row-meta">${t("drawer.addonsDesc")}</div>
          </div>
          <div class="row-actions">
            ${dlcStoreBtn}
          </div>
        </div>
      </div>`;
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
  if (allDlcs.length === 0) return `<div class="dlc-empty-panel">${emptyPanel("package", t("drawer.noDlc"), t("drawer.noDlcDesc"), storeBtn)}</div>`;

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
        : `<div class="list"><div class="row"><div class="row-meta">${t("ach.emptyTitle")}</div></div></div>`
    }`;
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

/**
 * Repaints the achievements tab without throwing away the list or detail
 * scroll position. Late notes, community answers and legacy migration data use
 * this instead of a full drawer repaint.
 */
export function repaintAchievementsTab(appName: string, force = false): void {
  if (S.currentModalAppName !== appName || S.activeDrawerTab !== "achievements") return;
  // The reader is typing: leave the textarea and its caret alone. A link add or
  // a note delete passes `force` because the focused field is about to be
  // replaced anyway.
  if (
    !force &&
    (document.activeElement?.id === "ach-note-input" ||
      document.activeElement?.id === "ach-guide-url-input")
  ) return;
  const s = summaryOf(appName);
  const content = document.getElementById("drawer-tab-content");
  if (!s || !content) return;
  const list = content.querySelector<HTMLElement>(".ach-list-container");
  const pane = document.getElementById("ach-detail-pane");
  const personalWasOpen = Boolean(content.querySelector("details.ach-personal[open]"));
  const guidesWereOpen = Boolean(content.querySelector("details.ach-detail-guides[open]"));
  const listScroll = list?.scrollTop ?? 0;
  const paneScroll = pane?.scrollTop ?? 0;
  content.innerHTML = renderDrawerAchievements(s);
  const nextList = content.querySelector<HTMLElement>(".ach-list-container");
  const nextPane = document.getElementById("ach-detail-pane");
  const nextPersonal = content.querySelector<HTMLDetailsElement>("details.ach-personal");
  const nextGuides = content.querySelector<HTMLDetailsElement>("details.ach-detail-guides");
  if (nextList) nextList.scrollTop = listScroll;
  if (nextPane) nextPane.scrollTop = paneScroll;
  if (nextPersonal) nextPersonal.open = personalWasOpen;
  if (nextGuides) nextGuides.open = guidesWereOpen;
}

/** Another window wrote a note: the open achievement detail picks it up. */
onNotesChanged(() => {
  const appName = S.currentModalAppName;
  if (!appName) return;
  if (S.activeDrawerTab === "achievements") repaintAchievementsTab(appName);
  else if (S.activeDrawerTab === "overview") repaintPersonalBlock(appName);
});

/**
 * One achievement's Steam Community answers. Called when a detail opens, not
 * for the whole list: a hundred achievements must not become a hundred search
 * requests. The backend caches each query for a day.
 */
export function ensureAchievementCommunity(appName: string, achName: string): void {
  if (!isTauri) return;
  const data = S.loadedAchievements.get(appName);
  const item = data?.achievements.find((achievement) => achievement.name === achName);
  if (!item) return;
  if (
    item.hidden &&
    !isAchievementUnlocked(item) &&
    !S.revealedAchievements.has(`${appName}:${item.name}`)
  ) return;
  const custom = appName.startsWith("custom::")
    ? S.customGames.find((game) => game.id === appName)
    : undefined;
  const appId = appName.startsWith("steam::") ? appName.slice(7) : custom?.steamAppId;
  if (!appId) return;

  const key = `${appName}:${achName}`;
  if (S.achCommunity.has(key) || S.loadingAchCommunity.has(key)) return;
  S.loadingAchCommunity.add(key);
  void steamGetAchievementCommunity(appId, item.display_name || item.name)
    .then((response) => {
      S.achCommunity.set(key, response);
    })
    .catch(() => {
      S.achCommunity.set(key, { guides: [], threads: [], supported: false });
    })
    .finally(() => {
      S.loadingAchCommunity.delete(key);
      if (S.currentModalAppName !== appName || S.achDetail !== achName) return;
      repaintAchievementsTab(appName);
    });
}

/**
 * PowerPyx publishes a roadmap card per game. It is best effort and cached;
 * a miss is kept for a day so a page open does not hammer the site.
 */
export function ensurePowerPyxGuide(appName: string, title: string): void {
  if (!isTauri || S.powerpyxGuides.has(appName) || S.loadingPowerpyx.has(appName)) return;
  S.loadingPowerpyx.add(appName);
  void powerpyxGameGuide(title)
    .then((guide) => {
      S.powerpyxGuides.set(appName, guide);
    })
    .catch(() => {
      S.powerpyxGuides.set(appName, {
        supported: false,
        title: "",
        url: "",
        difficulty: "",
        time: "",
        missables: "",
      });
    })
    .finally(() => {
      S.loadingPowerpyx.delete(appName);
      if (S.currentModalAppName !== appName || S.activeDrawerTab !== "achievements" || S.achDetail) return;
      // Late data patches its own host; a full tab rebuild would throw the
      // reader back to the top of a long achievement list.
      const host = document.getElementById("ach-powerpyx-host");
      if (host) host.innerHTML = renderPowerPyxCard(S.powerpyxGuides.get(appName));
    });
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
  // Move the old per-achievement localStorage notes into the shared notes file
  // once; the repaint shows them as soon as the writes land.
  ensureLegacyAchievementNotes(s.appName, () => repaintAchievementsTab(s.appName));

  const customGame = s.appName.startsWith("custom::") ? S.customGames.find((g) => g.id === s.appName) : undefined;
  const targetSteamAppId = s.appName.startsWith("steam::") ? s.appName.slice(7) : (customGame?.steamAppId || null);
  const isMaskedHidden = (a: (typeof data.achievements)[number]): boolean =>
    Boolean(a.hidden) &&
    !isAchievementUnlocked(a) &&
    !S.revealedAchievements.has(`${s.appName}:${a.name}`);

  ensurePowerPyxGuide(s.appName, s.title);
  const hasDlc = data.achievements.some((a) => !a.is_base);
  const effectiveUnlocked = isDemo ? data.total_achievements : data.user_unlocked;
  const effectiveXp = isDemo ? data.total_xp : data.user_xp;
  const pct = data.total_achievements > 0 ? Math.round((effectiveUnlocked / data.total_achievements) * 100) : 0;
  const achStats = achievementStats(data.achievements);
  const nearCount = data.achievements.filter((a) => {
    const progress = achievementProgress(a);
    return !isMaskedHidden(a) && !isAchievementUnlocked(a) && progress >= 0.5 && progress < 1;
  }).length;
  const hiddenCount = data.achievements.filter((a) => Boolean(a.hidden)).length;
  if (S.activeAchFilter === "near" && nearCount === 0) S.activeAchFilter = "all";
  if (S.activeAchFilter === "hidden" && hiddenCount === 0) S.activeAchFilter = "all";
  const playtime = libraryPlaytime(s);
  const hltb = S.loadedHltb.get(s.appName);
  const remainingHours = isDemo
    ? null
    : estimateRemainingHours(achStats, playtime.seconds, hltb?.completionist);
  const estimate = remainingHours != null ? Math.max(1, Math.round(remainingHours)) : null;
  const remaining = Math.max(0, data.total_achievements - effectiveUnlocked);
  const query = S.achSearchQuery.trim().toLowerCase();

  const filtered = data.achievements.filter((a) => {
    const unlocked = isAchievementUnlocked(a) || isDemo;
    if (S.activeAchFilter === "unlocked" && !unlocked) return false;
    if (S.activeAchFilter === "locked" && unlocked) return false;
    if (S.activeAchFilter === "hidden" && !a.hidden) return false;
    if (S.activeAchFilter === "near") {
      const progress = achievementProgress(a);
      if (unlocked || progress < 0.5 || progress >= 1) return false;
    }
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
  for (const a of data.achievements) {
    const tier = tiers[getAchTier(a)];
    const u = isAchievementUnlocked(a) || isDemo;
    tier[0]++;
    if (u) { tier[1]++; unlockedCount++; }
  }

  // Unrevealed hidden achievements stay in the normal list as masked rows.
  // Their names, rarity and tier are withheld until the player reveals them.
  const visibleItems = sorted;
  // Opening the tab should land on something useful. The best next target is
  // the default; a filter that hides the open item falls back to the first
  // row on screen, so the rail always matches the list.
  const selectedVisible = S.achDetail
    ? visibleItems.find((a) => a.name === S.achDetail)
    : undefined;
  if (!selectedVisible) {
    const next = nextAchievements(visibleItems, 1)[0];
    S.achDetail = next?.name ?? visibleItems[0]?.name ?? null;
  }
  const detailItem = S.achDetail
    ? data.achievements.find((a) => a.name === S.achDetail)
    : undefined;
  if (S.achDetail && !detailItem) S.achDetail = null;
  if (detailItem && !isMaskedHidden(detailItem)) {
    ensureAchievementCommunity(s.appName, detailItem.name);
  }
  const detailIndex = detailItem ? visibleItems.findIndex((a) => a.name === detailItem.name) : -1;
  const neighbourOf = (a: (typeof data.achievements)[number] | undefined) =>
    a
      ? {
          name: a.name,
          title: isMaskedHidden(a) ? t("ach.hiddenName") : a.display_name || a.name,
        }
      : undefined;
  const detailPosition = detailItem && detailIndex >= 0
    ? {
        index: detailIndex + 1,
        total: visibleItems.length,
        prev: neighbourOf(visibleItems[detailIndex - 1]),
        next: neighbourOf(visibleItems[detailIndex + 1]),
      }
    : undefined;
  const showPlat = tiers.platinum[0] > 0 || isPlat || Boolean(data.is_platinum);
  const platTotal = tiers.platinum[0] > 0 ? tiers.platinum[0] : showPlat ? 1 : 0;
  const platUnlocked = tiers.platinum[0] > 0 ? tiers.platinum[1] : isPlat ? 1 : 0;
  // A chip filters only when the tier really holds achievements. The synthetic
  // platinum slot (a game without a platinum trophy) stays a plain indicator,
  // so clicking it cannot filter the list down to nothing.
  const tierChip = (
    tier: "platinum" | "gold" | "silver" | "bronze",
    cls: string,
    label: string,
    glyph: string,
    done: number,
    total: number,
    clickable = true,
  ): string =>
    total > 0
      ? clickable
        ? `<button type="button" class="ach-tier-mini ${cls} ${done >= total ? "complete" : ""} ${S.achTierFilter === tier ? "active" : ""}" data-act="ach-tier-filter" data-tier="${tier}" title="${esc(label)}" aria-pressed="${S.achTierFilter === tier}">${glyph}<span>${esc(label)}</span><strong class="tabular-nums">${done}/${total}</strong></button>`
        : `<span class="ach-tier-mini static ${cls} ${done >= total ? "complete" : ""}" title="${esc(label)}">${glyph}<span>${esc(label)}</span><strong class="tabular-nums">${done}/${total}</strong></span>`
      : "";
  const filterChip = (val: string, label: string, n: number, glyph: IconName, disabled = false): string =>
    `<button class="tab ach-status-chip${S.activeAchFilter === val ? " active" : ""}${disabled ? " is-disabled" : ""}" data-act="ach-filter" data-val="${val}"${disabled ? ' disabled aria-disabled="true"' : ""}>${icon(glyph, 12)}<span>${label}</span><span class="count">${n}</span></button>`;

  const sourceNote = ubiAchSource.has(s.appName)
    ? `<div class="ach-source-note">${icon("info", 13)}<span>${t("ach.ubiEpicDesc")}</span></div>`
    : "";

  // Platinum celebration: glow, ring, sparkles, particle burst and a one-shot
  // shine sweep (the sweep only runs on the first paint of the page).
  const platCup = platinumCup(28, !platShineDone);
  if (isPlat) platShineDone = true;

  if (targetSteamAppId) {
    if (!steamAchSourceCache.has(s.appName)) {
      void steamGetAchievementSource(targetSteamAppId).then((cfg) => {
        steamAchSourceCache.set(s.appName, cfg);
        if (S.achSourceModalOpen === s.appName) {
          const content = document.getElementById("drawer-tab-content");
          if (content) content.innerHTML = renderDrawerAchievements(s);
        }
      });
    }
  }

  const srcCfg = steamAchSourceCache.get(s.appName) ?? { mode: "auto" };
  const detectedPath = srcCfg.detectedPath;
  const sourceCard = S.achSourceModalOpen === s.appName && Boolean(targetSteamAppId)
    ? `<div class="ach-source-card">
        <div class="ach-source-header">
          <span class="ach-source-title">${icon("settings", 14)} ${t("ach.sourceTitle")}</span>
          <button class="icon-btn" data-act="ach-source-close" title="${t("common.close")}">${icon("x", 12)}</button>
        </div>
        <div class="ach-source-desc">${t("ach.sourceDesc")}</div>
        <div class="ach-source-modes">
          <label class="radio-label">
            <input type="radio" name="ach-source-mode" value="auto" ${srcCfg.mode === "auto" ? "checked" : ""} data-act="ach-mode-change" data-id="${s.appName}" />
            <span>${t("ach.modeAuto")}</span>
          </label>
          <label class="radio-label">
            <input type="radio" name="ach-source-mode" value="custom" ${srcCfg.mode === "custom" ? "checked" : ""} data-act="ach-mode-change" data-id="${s.appName}" />
            <span>${t("ach.modeCustom")}</span>
          </label>
          <label class="radio-label">
            <input type="radio" name="ach-source-mode" value="disabled" ${srcCfg.mode === "disabled" ? "checked" : ""} data-act="ach-mode-change" data-id="${s.appName}" />
            <span>${t("ach.modeDisabled")}</span>
          </label>
        </div>
        ${srcCfg.mode === "auto"
          ? (detectedPath
            ? `<div class="ach-source-detected">${icon("check", 12)} <span>${t("ach.detectedPath", { path: esc(detectedPath) })}</span></div>`
            : `<div class="ach-source-not-found">${icon("info", 12)} <span>${t("ach.noPathDetected")}</span></div>`)
          : ""}
        ${srcCfg.mode === "custom"
          ? `<div class="ach-source-custom-row">
              <input type="text" id="ach-custom-path-input" class="ach-custom-input" placeholder="${t("ach.customPathPlaceholder")}" value="${esc(srcCfg.customPath ?? "")}" />
              <button class="btn small play" data-act="ach-source-save" data-id="${s.appName}">${t("ach.saveSource")}</button>
            </div>`
          : ""}
      </div>`
    : "";

  const detailKey = detailItem ? `${s.appName}:${detailItem.name}` : "";
  const detailPane = detailItem
    ? renderAchievementDetail({
        summary: s,
        data,
        item: detailItem,
        steamAppId: targetSteamAppId,
        community: S.achCommunity.get(detailKey) ?? null,
        communityLoading: S.loadingAchCommunity.has(detailKey),
        position: detailPosition,
      })
    : renderAchSidePanel({ summary: s, data, steamAppId: targetSteamAppId });

  return `
    <div class="ach-workspace${detailItem ? " has-detail" : ""}">
      <div class="ach-list-pane">
    ${sourceCard}
    ${sourceNote}
    <div class="ach-notif-row">
      <span class="ach-notif-label">
        <span class="ach-notif-icon">${icon(achGameNotificationsEnabled(s.appName) ? "bell" : "bell-off", 14)}</span>
        <span>${esc(t("ach.gameNotifToggle"))}</span>
      </span>
      <label class="switch" data-act="toggle-ach-game-notif" data-id="${esc(s.appName)}" data-steam-appid="${esc(targetSteamAppId ?? "")}">
        <input type="checkbox" ${achGameNotificationsEnabled(s.appName) ? "checked" : ""} />
        <span class="track"></span>
      </label>
    </div>
    <div class="ach-summary-bar ${isPlat ? "platinum" : ""}">
      <div class="ach-summary-main">
        <div class="ach-summary-percent ${isPlat ? "plat" : ""}">${isPlat ? platCup : `${pct}%`}</div>
        <div class="ach-summary-info">
          <div class="ach-summary-count">${effectiveUnlocked} <span>/ ${data.total_achievements}</span></div>
          <div class="ach-summary-label">${isPlat ? t("ach.platinumComplete") : t("drawer.achievements")}</div>
          ${data.total_xp > 0 && !isPlat ? `<div class="ach-summary-xp tabular-nums">${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP</div>` : ""}
          <div class="progress ach-summary-progress"><span style="width:${pct}%"></span></div>
        </div>
        <div class="ach-summary-stats">
          ${remaining > 0 ? `<div class="ach-stat"><span class="ach-stat-label">${esc(t("ach.statRemaining"))}</span><strong class="ach-stat-value tabular-nums">${remaining}</strong></div>` : ""}
          ${achStats.rarestUnlocked != null ? `<div class="ach-stat"><span class="ach-stat-label">${esc(t("ach.statRarest"))}</span><strong class="ach-stat-value tabular-nums">%${fmtDecimal1(achStats.rarestUnlocked)}</strong></div>` : ""}
          ${estimate != null ? `<div class="ach-stat" title="${esc(t("ach.insightEstimateHint"))}"><span class="ach-stat-label">${esc(t("ach.statEstimate"))}</span><strong class="ach-stat-value tabular-nums">~${fmtHours(estimate)} ${t("common.hoursShort")}</strong></div>` : ""}
        </div>
        <div class="ach-summary-actions">
          ${targetSteamAppId ? `<button class="icon-btn ${S.achSourceModalOpen === s.appName ? "active" : ""}" data-act="ach-source-settings" data-id="${s.appName}" title="${t("ach.sourceSettings")}">${icon("settings", 14)}</button>` : ""}
          <button class="icon-btn" data-act="ach-refresh" data-id="${s.appName}" title="${t("ach.refreshData")}">${icon("refresh", 14)}</button>
          ${isCompanionApp(s.appName) || ubiAchSource.has(s.appName) ? "" : `<button class="icon-btn" data-act="open-store-achievements" data-id="${s.appName}" title="${t("ach.viewInStore")}">${icon("external", 14)}</button>`}
        </div>
      </div>
      <div class="ach-tier-row">
        ${tierChip("platinum", "plat", t("ach.tierPlatinum"), epicPlatinumIcon(11), platUnlocked, platTotal, tiers.platinum[0] > 0)}
        ${tierChip("gold", "gold", t("ach.tierGold"), icon("trophy", 11), tiers.gold[1], tiers.gold[0])}
        ${tierChip("silver", "silver", t("ach.tierSilver"), icon("trophy", 11), tiers.silver[1], tiers.silver[0])}
        ${tierChip("bronze", "bronze", t("ach.tierBronze"), icon("trophy", 11), tiers.bronze[1], tiers.bronze[0])}
      </div>
    </div>

    <div class="gp-toolbar">
      <div class="tabs ach-status-strip">
        ${filterChip("all", t("ach.filterAll"), data.achievements.length, "list")}
        ${filterChip("unlocked", t("ach.filterUnlocked"), unlockedCount, "check-circle")}
        ${filterChip("locked", t("ach.filterLocked"), data.achievements.length - unlockedCount, "lock")}
        ${nearCount > 0 ? filterChip("near", t("ach.filterNear"), nearCount, "activity") : ""}
        ${filterChip("hidden", t("ach.filterHidden"), hiddenCount, "eye-off", hiddenCount === 0)}
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
      ${renderAchievementSections(visibleItems, s, hasDlc, data.achievements)}
    </div>
      </div>
      <aside class="ach-detail-pane" id="ach-detail-pane">${detailPane}</aside>
    </div>`;
}

/**
 * Last session-end achievement refresh per game: a stop can arrive twice (the
 * stop command and the process watcher), and both must fold into one fetch.
 */
const sessionAchRefreshAt = new Map<string, number>();
const sessionUnlockedBaseline = new Map<string, Set<string>>();
const sessionPollTimers = new Map<string, number>();

async function resolveCustomGameSteamAppId(customGame: {
  id: string;
  title: string;
  steamAppId?: string | null;
  exePath?: string;
}): Promise<string> {
  if (customGame.steamAppId && /^\d+$/.test(customGame.steamAppId.trim())) {
    return customGame.steamAppId.trim();
  }
  try {
    const hit = await steamFindStoreApp(customGame.title);
    if (hit?.appId && /^\d+$/.test(hit.appId)) {
      customGame.steamAppId = hit.appId;
      return hit.appId;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function classifyStoreRarityTier(
  rarityPercent: number | null | undefined,
  tierName: string | undefined,
  unlockedCount: number,
  totalCount: number,
): number {
  if (totalCount > 0 && unlockedCount >= totalCount) return 4;
  if (typeof rarityPercent === "number" && Number.isFinite(rarityPercent)) {
    if (rarityPercent <= 3.5) return 3;
    if (rarityPercent <= 12.0) return 2;
    if (rarityPercent <= 30.0) return 1;
    return 0;
  }
  switch ((tierName || "").toLowerCase()) {
    case "platinum":
      return 4;
    case "ultra":
    case "diamond":
      return 3;
    case "gold":
      return 2;
    case "silver":
      return 1;
    default:
      return 0;
  }
}

function emitStoreAchievementUnlock(
  appName: string,
  ach: {
    name: string;
    display_name?: string;
    description?: string;
    icon_link?: string;
    rarity?: { percent?: number | null } | null;
    tier?: { name?: string } | null;
  },
  unlockedCount: number,
  totalCount: number,
): void {
  if (!S.achievementNotificationOptions.enabled) return;
  if (!achGameNotificationsEnabled(appName)) return;
  const storeKey = sourceOfKey(appName);
  if ((S.achievementNotificationOptions.disabledStores || []).includes(storeKey)) {
    return;
  }
  const pct = ach.rarity?.percent ?? null;
  const tierCode = classifyStoreRarityTier(pct, ach.tier?.name, unlockedCount, totalCount);
  const title = ach.display_name?.trim() || ach.name;
  const body = ach.description || "";
  void achievementTestNotification(
    title,
    body,
    tierCode,
    appName,
    ach.name,
    ach.icon_link || "",
    unlockedCount,
    totalCount,
    true,
  ).catch(() => {});
}

function checkAndEmitNewStoreUnlocks(appName: string): number {
  const data = S.loadedAchievements.get(appName);
  if (!data || !Array.isArray(data.achievements) || data.achievements.length === 0) {
    return 0;
  }
  let baseline = sessionUnlockedBaseline.get(appName);
  if (!baseline) {
    baseline = new Set(data.achievements.filter((a) => a.unlocked).map((a) => a.name));
    sessionUnlockedBaseline.set(appName, baseline);
    return 0;
  }
  let newlyUnlocked = 0;
  const totalCount = Math.max(data.total_achievements || 0, data.achievements.length);
  for (const ach of data.achievements) {
    if (!ach.unlocked || baseline.has(ach.name)) continue;
    baseline.add(ach.name);
    newlyUnlocked += 1;
    emitStoreAchievementUnlock(appName, ach, baseline.size, totalCount);
  }
  return newlyUnlocked;
}

function stopStoreAchievementPoll(appName: string): void {
  const timer = sessionPollTimers.get(appName);
  if (timer !== undefined) {
    window.clearInterval(timer);
    sessionPollTimers.delete(appName);
  }
}

/**
 * Starts live achievement tracking for a running game across non-Steam stores
 * (Epic, GOG, Ubisoft Connect, EA App, Xbox) and custom/emulator games.
 */
export function startStoreAchievementSession(appName: string): void {
  if (!isTauri || appName.startsWith("steam::")) return;
  if (appName.startsWith("custom::")) {
    const game = S.customGames.find((item) => item.id === appName);
    if (!game) return;
    const exeDir = game.exePath?.replace(/[\\/][^\\/]*$/, "");
    void resolveCustomGameSteamAppId(game).then((appId) => {
      void steamSetAchievementNotifications(appId, achGameNotificationsEnabled(appName)).catch(
        () => {},
      );
      void steamStartEmulatorWatcher(appId, exeDir).catch(() => {});
    });
    return;
  }

  const source = sourceOfKey(appName);
  if (source === "amazon" || source === "battlenet" || source === "riot") return;

  const existing = S.loadedAchievements.get(appName);
  if (existing && existing.achievements.length > 0 && !sessionUnlockedBaseline.has(appName)) {
    sessionUnlockedBaseline.set(
      appName,
      new Set(existing.achievements.filter((a) => a.unlocked).map((a) => a.name)),
    );
  } else if (!sessionUnlockedBaseline.has(appName)) {
    void fetchAndRenderAchievements(appName, false, true).then(() => {
      checkAndEmitNewStoreUnlocks(appName);
    });
  }

  if (sessionPollTimers.has(appName)) return;
  const isUbi = source === "ubisoft" || ubiAchSource.has(appName);
  // A running game is the only thing polled here; a short interval is what
  // makes the card feel immediate. The calls are small local/store reads.
  const intervalMs = isUbi ? 3_000 : 4_000;
  const timer = window.setInterval(() => {
    if (!S.runningGames.has(appName)) {
      stopStoreAchievementPoll(appName);
      return;
    }
    void fetchAndRenderAchievements(appName, true, true).then(() => {
      const unlockedDelta = checkAndEmitNewStoreUnlocks(appName);
      if (unlockedDelta > 0) {
        recordSessionSummary(appName, { unlocked: unlockedDelta, at: Date.now() });
        repaintPersonalBlock(appName);
      }
    });
  }, intervalMs);
  sessionPollTimers.set(appName, timer);
}

/**
 * A finished session can unlock achievements in every store, but the caches
 * keep the pre-session state: Epic's cache has no TTL and Steam's is TTL'd, so
 * the ended game is refetched with a forced refresh (GOG and the companion
 * stores always read live sources). Called on `game-status` end events; the
 * cooldown makes duplicate stop events harmless.
 */
export function refreshAchievementsAfterSession(appName: string, sessionSeconds?: number): void {
  if (!isTauri) return;
  stopStoreAchievementPoll(appName);
  if (appName.startsWith("custom::")) {
    const game = S.customGames.find((item) => item.id === appName);
    if (game?.steamAppId) {
      const appId = game.steamAppId;
      window.setTimeout(() => {
        if (S.runningGames.has(appName)) return;
        void steamStopAchievementWatcher(appId).catch(() => {});
      }, 8_000);
    }
  }
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
  // The Steam client and external store backends often flush achievement state a
  // moment after the game process exits. Two passes catch both immediate local
  // writes and slower cloud syncs.
  const delays = appName.startsWith("steam::") ? [2500, 8000] : [1500, 6000];
  for (const delay of delays) {
    window.setTimeout(() => refreshAchievementsNow(appName), delay);
  }
}

function refreshAchievementsNow(appName: string): void {
  // `before` has to be read while the old answer is still here.
  const before = S.loadedAchievements.get(appName)?.user_unlocked ?? 0;
  S.loadedAchievements.delete(appName);
  void fetchAndRenderAchievements(appName, true, true).then(() => {
    if (!appName.startsWith("steam::") && !appName.startsWith("custom::")) {
      checkAndEmitNewStoreUnlocks(appName);
    }
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

export async function fetchAndRenderAchievements(
  appName: string,
  forceRefresh = false,
  silent = false,
): Promise<void> {
  if (!isTauri || S.loadingAchFor.has(appName)) return;
  S.loadingAchFor.add(appName);
  if (!silent && S.currentModalAppName === appName && S.activeDrawerTab === "achievements") {
    // The tab is already open: repaint its body for the spinner instead of
    // rebuilding the hero and every other tab behind it.
    const content = document.getElementById("drawer-tab-content");
    const s = summaryOf(appName);
    if (content && s) content.innerHTML = renderDrawerAchievements(s);
  }
  try {
    const isGog = appName.startsWith("gog::");
    const isSteam = appName.startsWith("steam::");
    const isCustom = appName.startsWith("custom::");
    const source = sourceOfKey(appName);
    const isCompanion = source !== "epic" && source !== "gog" && source !== "steam" && !isCustom;
    const rawId = isGog ? appName.slice(5) : appName;
    const customGame = isCustom ? S.customGames.find((g) => g.id === appName) : undefined;
    const customAppId = customGame ? await resolveCustomGameSteamAppId(customGame) : "";
    let data = source === "amazon"
      ? { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false }
      : isGog
        ? await gogGetAchievements(rawId)
        : isSteam
          ? await steamGetAchievements(appName.slice(7), forceRefresh)
          : isCustom
            ? customAppId || customGame?.exePath
              ? await steamGetEmulatorAchievements(
                  customAppId,
                  forceRefresh,
                  customGame?.exePath?.replace(/[\\/][^\\/]*$/, ""),
                )
              : { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false }
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
      progress_known: true,
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
    // A transient network/schema failure must not erase a list that was already
    // loaded; only a game with no cached answer gets the empty state.
    if (!S.loadedAchievements.has(appName)) {
      S.loadedAchievements.set(appName, { achievements: [], hidden: [], user_unlocked: 0, user_xp: 0, total_achievements: 0, total_xp: 0, is_platinum: false });
    }
  } finally {
    S.loadingAchFor.delete(appName);
    repaintAchievementSummary(appName);
  }
}

/**
 * Paints the late achievement answer where it is visible: the hero chips, the
 * achievements tab when it is open, and the personal block's next-trophy row.
 * A full `openEpicModal` here rebuilt the overview (and reset its scroll) for
 * three numbers.
 */
export function repaintDlcsTab(appName: string): void {
  if (S.currentModalAppName !== appName || S.activeDrawerTab !== "dlcs") return;
  const s = summaryOf(appName);
  const content = document.getElementById("drawer-tab-content");
  if (!s || !content) return;
  content.innerHTML = renderDrawerDlcs(s);
}

function repaintAchievementSummary(appName: string): void {
  if (S.currentModalAppName !== appName) return;
  const s = summaryOf(appName);
  if (!s) return;
  const tab = document.querySelector<HTMLElement>('.drawer-tab[data-tab="achievements"]');
  const plat = isAppPlatinum(appName);
  // The platinum answer can land after the page painted: the tab has to pick up
  // the filled cup, not just the class. Replace the glyph alone so the button
  // (and keyboard focus) survives the update.
  if (tab) {
    tab.classList.toggle("plat", plat);
    const glyph = tab.querySelector("svg");
    const isFilled = Boolean(glyph?.classList.contains("trophy-filled-svg"));
    if (plat !== isFilled) {
      const next = plat ? filledTrophy(14) : icon("trophy", 14);
      if (glyph) glyph.outerHTML = next;
      else tab.insertAdjacentHTML("afterbegin", next);
    }
  }
  if (S.activeDrawerTab === "achievements") {
    const content = document.getElementById("drawer-tab-content");
    if (content) content.innerHTML = renderDrawerAchievements(s);
  } else if (S.activeDrawerTab === "overview") {
    repaintPersonalBlock(appName);
  }
}

/* ---------- System requirements ---------- */

/**
 * Starts the store lookup when the page has not asked yet, then paints the
 * panel. The renderer itself lives in `system-tab.ts`; keeping the fetch here
 * avoids a cycle between the pure view and this orchestrator.
 */
export function renderRequirementsBody(s: EpicSummary): string {
  if (!S.loadedRequirements.has(s.appName) && !S.loadingReqFor.has(s.appName)) {
    void fetchAndRenderRequirements(s.appName, s.title);
  }
  return renderRequirementPanel(s);
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
  // Custom games have no store requirements API. The Epic slug lookup would
  // otherwise attach another game's table (or offer an Epic store page that
  // does not exist); the empty state points at IGDB or says there is no source.
  if (appName.startsWith("custom::")) {
    if (!S.loadedRequirements.has(appName)) {
      S.loadedRequirements.set(appName, {
        supported: false,
        systems: [],
        languages: [],
        appName,
      });
    }
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") {
      const current = summaryOf(appName);
      const content = document.getElementById("drawer-tab-content");
      if (current && content) {
        const g = rawOf(appName);
        content.innerHTML = renderSystemTab(
          current,
          gamePartner(current, g),
          gameAntiCheat(current, g),
          renderRequirementsBody(current),
        );
      }
    }
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
      if (body && settled) repaintSystemRequirements(appName);
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
  if (S.activeDrawerTab === "specs") repaintSystemRequirements(appName);
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

/** In-flight official Steam art lookups, one per game page. */
const steamHeroLookups = new Map<string, Promise<void>>();

/**
 * Steam's flat hero path (`/steam/apps/<id>/library_hero.jpg`) 404s for newer
 * titles, and the 460x215 store header is not a banner: stretching it over the
 * hero is the pixelated picture those pages used to show. Resolve the published
 * wide art once, remember it for the library and repaint the hero in place.
 */
function ensureSteamHeroArt(appName: string): Promise<void> {
  if (!appName.startsWith("steam::")) return Promise.resolve();
  const existing = steamHeroLookups.get(appName);
  if (existing) return existing;

  const run = (async () => {
    const appId = appName.slice("steam::".length);
    if (!/^\d+$/.test(appId)) return;
    const known = cachedSteamHero(appId);
    if (known !== undefined && !isFlatSteamArt(known)) return;
    let art: SteamLibraryArt | undefined;
    try {
      art = (await steamLibraryArt([appId]))[appId];
    } catch {
      return;
    }
    if (!art) return;
    rememberSteamCover(appId, art.cover);
    rememberSteamHero(appId, art.hero);
    clearWideArtCache(appName);
    const item = S.steamSummariesMap.get(appName);
    if (item && art.hero) item.heroUrl = art.hero;
    // A store with no wide art still has its portrait capsule, which the hero
    // renders contained instead of stretching.
    const url = art.hero || art.cover;
    if (!url || S.currentModalAppName !== appName) return;
    const heroEl = modalRoot.querySelector<HTMLImageElement>(".gp-hero-img");
    if (heroEl) {
      heroEl.dataset.imgUrl = url;
      heroEl.src = cachedImage(url);
    }
    const bgEl = modalRoot.querySelector<HTMLElement>(".gp-hero-backdrop");
    if (bgEl) {
      bgEl.dataset.imgUrl = url;
      bgEl.style.backgroundImage = `url('${cachedImage(url)}')`;
    }
    warmImages([url]);
  })().finally(() => steamHeroLookups.delete(appName));

  steamHeroLookups.set(appName, run);
  return run;
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
      // A failed wide hero falls back to the portrait capsule, never the
      // 460x215 store header: stretched over the banner that header is the
      // pixelated picture this page used to show.
      const fallback = cachedSteamCover(appName.slice("steam::".length));
      const heroEl = modalRoot.querySelector<HTMLImageElement>(".gp-hero-img");
      if (heroEl && fallback) {
        heroEl.addEventListener("error", () => {
          // The same disk cache as the hero: the fallback is fetched once.
          heroEl.dataset.imgUrl = fallback;
          heroEl.src = cachedImage(fallback);
          warmImages([fallback]);
        }, { once: true });
        if (heroEl.complete && heroEl.naturalWidth === 0) {
          heroEl.dataset.imgUrl = fallback;
          heroEl.src = cachedImage(fallback);
          warmImages([fallback]);
        }
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
