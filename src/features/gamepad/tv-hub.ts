/**
 * TV Game Hub: Cinematic fullscreen details view for Steam Deck and 10-ft TV.
 *
 * PS5/Hydra console aesthetic:
 * - Full-bleed dynamic wide hero art with dark vignette scrim
 * - Controller-navigable tabs: Overview, Trophies, DLCs, Screenshots, Manage
 * - Console stat cards: Playtime, Trophies & Platinum, HLTB, Critic score, Cloud sync
 * - Zero emojis (inline SVG icons only), tabular numbers, pure pitch black surfaces
 */

import { achSummaryOf, epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { emptyState, epicPlatinumIcon, icon, loadingState } from "../../core/icons";
import { epicWideArt, rawOf, sourceOfKey, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import {
  epicGetCritic,
  epicGetGameDlcs,
  epicGetHltb,
  type CriticData,
  type EpicAchievementItem,
  type EpicSummary,
  type HltbData,
} from "../../epic";
import { storeLogo } from "../store/store-logos";
import { storeVersionLabel } from "../drawer/external-versions";
import {
  fetchAndRenderAchievements,
  fetchAndRenderRequirements,
  renderDrawerSystemRequirements,
  epicOpenFolder,
} from "../drawer/drawer-view";
import {
  cleanStoreDescription,
  getAchTier,
  heroCloudStatus,
  renderGameFeatures,
  renderNextAchievements,
} from "../drawer/drawer-widgets";
import {
  fetchAndRenderScreenshots,
  hydrateShotPreviews,
  openScreenshotLightbox,
  renderMomentsStrip,
  shotThumbHtml,
} from "../screenshots/screenshots-view";

export type TvHubTab = "overview" | "achievements" | "dlcs" | "screenshots" | "manage";

export const TV_HUB_TABS: { id: TvHubTab; labelKey: string; icon: string }[] = [
  { id: "overview", labelKey: "tv.tabOverview", icon: "layout-grid" },
  { id: "achievements", labelKey: "tv.tabAchievements", icon: "trophy" },
  { id: "dlcs", labelKey: "tv.tabDlcs", icon: "package" },
  { id: "screenshots", labelKey: "tv.tabScreenshots", icon: "camera" },
  { id: "manage", labelKey: "tv.tabManage", icon: "settings" },
];

/** Fetch all lazy metadata once for the TV Game Hub. */
export function ensureGameHubData(s: EpicSummary): void {
  const appName = s.appName;
  if (!S.loadedHltb.has(appName) && S.loadingHltbFor !== appName) {
    S.loadingHltbFor = appName;
    epicGetHltb(s.title, appName)
      .then((data: HltbData) => {
        S.loadedHltb.set(appName, data);
        refreshTvHubStats();
      })
      .catch(() => {})
      .finally(() => {
        S.loadingHltbFor = null;
      });
  }

  if (!S.loadedCritic.has(appName) && S.loadingCriticFor !== appName) {
    S.loadingCriticFor = appName;
    epicGetCritic(s.title, appName)
      .then((data: CriticData) => {
        S.loadedCritic.set(appName, data);
        refreshTvHubStats();
      })
      .catch(() => {})
      .finally(() => {
        S.loadingCriticFor = null;
      });
  }

  if (!S.dlcCache.has(appName)) {
    epicGetGameDlcs(appName)
      .then((res) => {
        S.dlcCache.set(appName, res);
      })
      .catch(() => {});
  }

  if (!S.loadedScreenshots.has(appName) && S.loadingScreenshotsFor !== appName) {
    void fetchAndRenderScreenshots(appName, s.title);
  }

  if (!S.loadedAchievements.has(appName) && S.loadingAchFor !== appName) {
    void fetchAndRenderAchievements(appName);
  }

  if (!S.loadedRequirements.has(appName) && S.loadingReqFor !== appName) {
    void fetchAndRenderRequirements(appName, s.title);
  }
}

function refreshTvHubStats(): void {
  const el = document.getElementById("tv-hub-stats");
  const hubEl = document.getElementById("tv-hub");
  if (!el || !hubEl) return;
  const appName = hubEl.dataset.app;
  if (!appName) return;
  const s = summaryOf(appName);
  if (!s) return;
  el.outerHTML = renderConsoleStatCards(s);
}

/** Store badge pill with native SVG/PNG icon. */
function storeBadgeHtml(appName: string): string {
  const source = sourceOfKey(appName);
  const label = storeVersionLabel(source);
  return `<span class="tv-meta-pill tv-store-pill">${storeLogo(source, 16)}<span>${esc(label)}</span></span>`;
}

/** Primary CTA button (Play / Update / Install / Stop). */
export function tvHubPrimaryAction(s: EpicSummary, focused = false): string {
  const p = epicDlProgress(s.appName);
  const fCls = focused ? " focused" : "";
  if (p !== null) {
    return `<button type="button" class="tv-btn-primary tv-action-btn${fCls}" data-view="downloads" data-dlbtn="${esc(s.appName)}">${icon("download", 18)} <span>${t("common.downloading", { p })}</span></button>`;
  }
  if (s.downloading) {
    return `<button type="button" class="tv-btn-primary tv-action-btn${fCls}" data-view="downloads" data-dlbtn="${esc(s.appName)}">${icon("download", 18)} <span>${t("steam.downloading")}</span></button>`;
  }
  if (S.runningGames.has(s.appName)) {
    return `<button type="button" class="tv-btn-primary is-stop tv-action-btn${fCls}" data-act="epic-stop" data-id="${esc(s.appName)}">${icon("square", 18)} <span>${t("common.stop")}</span></button>`;
  }
  if (s.installed) {
    const hasUpdate = Boolean(s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName));
    if (hasUpdate) {
      if (s.appName.startsWith("steam::")) {
        return `<button type="button" class="tv-btn-primary is-update tv-action-btn${fCls}" data-act="steam-action" data-id="${esc(s.appName.slice(7))}" data-mode="update">${icon("download", 18)} <span>${t("common.update")}</span></button>`;
      }
      return `<button type="button" class="tv-btn-primary is-update tv-action-btn${fCls}" data-act="epic-install" data-id="${esc(s.appName)}">${icon("download", 18)} <span>${t("common.update")}</span></button>`;
    }
    if (s.appName.startsWith("steam::")) {
      return `<button type="button" class="tv-btn-primary tv-action-btn${fCls}" data-act="steam-action" data-id="${esc(s.appName.slice(7))}" data-mode="launch">${icon("play", 18)} <span>${t("common.playNow")}</span></button>`;
    }
    return `<button type="button" class="tv-btn-primary tv-action-btn${fCls}" data-act="epic-play" data-id="${esc(s.appName)}">${icon("play", 18)} <span>${t("common.playNow")}</span></button>`;
  }
  if (s.appName.startsWith("steam::")) {
    return `<button type="button" class="tv-btn-primary is-install tv-action-btn${fCls}" data-act="steam-action" data-id="${esc(s.appName.slice(7))}" data-mode="install">${icon("download", 18)} <span>${t("common.install")}</span></button>`;
  }
  return `<button type="button" class="tv-btn-primary is-install tv-action-btn${fCls}" data-act="epic-install" data-id="${esc(s.appName)}">${icon("download", 18)} <span>${t("common.install")}</span></button>`;
}

/** PS5 console style quick stat tiles. */
export function renderConsoleStatCards(s: EpicSummary): string {
  const pt = S.playtimeMap.get(s.appName);
  const ach = achSummaryOf(s.appName);
  const isPlat = isAppPlatinum(s.appName);
  const hltb = S.loadedHltb.get(s.appName);
  const critic = S.loadedCritic.get(s.appName);
  const g = rawOf(s.appName);
  const cloud = heroCloudStatus(s, g, null);

  // Playtime
  const playtimeVal = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—";

  // Trophies / Achievements
  let trophyVal = "—";
  let trophySub = "";
  if (ach && ach.total_achievements > 0) {
    const pct = Math.round((ach.user_unlocked / ach.total_achievements) * 100);
    trophyVal = `${ach.user_unlocked} / ${ach.total_achievements}`;
    trophySub = `%${pct}`;
  }

  // HLTB
  let hltbVal = "—";
  let hltbSub = "";
  if (hltb?.supported) {
    if (hltb.main_story) {
      hltbVal = `${hltb.main_story} sa`;
      hltbSub = t("hltb.mainStory");
    } else if (hltb.completionist) {
      hltbVal = `${hltb.completionist} sa`;
      hltbSub = t("hltb.completionist");
    }
  }

  // Critic
  let criticVal = "—";
  let criticSub = "";
  if (critic?.supported) {
    const score = critic.metacritic_score || critic.opencritic_score || critic.igdb_score;
    if (score) {
      criticVal = String(score);
      criticSub = critic.metacritic_score ? "Metacritic" : critic.opencritic_score ? "OpenCritic" : "IGDB";
    }
  }

  // Cloud
  const cloudVal = cloud.label;
  const cloudTone = cloud.synced ? "ok" : cloud.label !== "—" ? "warn" : "";

  return `
    <div class="tv-hub-stats-grid" id="tv-hub-stats">
      <div class="tv-stat-card">
        <span class="tv-stat-title">${icon("clock", 13)} ${t("drawer.statTime")}</span>
        <span class="tv-stat-value tabular-nums">${esc(playtimeVal)}</span>
      </div>

      <div class="tv-stat-card${isPlat ? " is-plat" : ""}">
        <span class="tv-stat-title">${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)} ${isPlat ? t("drawer.statPlat") : t("drawer.statTrophy")}</span>
        <div class="tv-stat-value-group">
          <span class="tv-stat-value tabular-nums">${esc(trophyVal)}</span>
          ${trophySub ? `<span class="tv-stat-sub tabular-nums">${esc(trophySub)}</span>` : ""}
        </div>
      </div>

      <div class="tv-stat-card">
        <span class="tv-stat-title">${icon("timer", 13)} HowLongToBeat</span>
        <div class="tv-stat-value-group">
          <span class="tv-stat-value tabular-nums">${esc(hltbVal)}</span>
          ${hltbSub ? `<span class="tv-stat-sub">${esc(hltbSub)}</span>` : ""}
        </div>
      </div>

      <div class="tv-stat-card">
        <span class="tv-stat-title">${icon("star", 13)} ${t("critic.title")}</span>
        <div class="tv-stat-value-group">
          <span class="tv-stat-value tabular-nums">${esc(criticVal)}</span>
          ${criticSub ? `<span class="tv-stat-sub">${esc(criticSub)}</span>` : ""}
        </div>
      </div>
      ${!s.appName.startsWith("steam::") && !s.appName.startsWith("gog::") ? `
      <div class="tv-stat-card">
        <span class="tv-stat-title">${icon("cloud", 13)} ${t("drawer.statCloud")}</span>
        <span class="tv-stat-value ${cloudTone}">${esc(cloudVal)}</span>
      </div>` : ""}
    </div>`;
}

/** Render Overview Tab Content. */
function renderOverviewTab(s: EpicSummary): string {
  const g = rawOf(s.appName);
  const rawDesc = s.description;
  const desc = rawDesc && rawDesc !== s.title ? cleanStoreDescription(rawDesc) : "";
  const paragraphs = desc
    ? desc
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  const descHtml =
    paragraphs.length > 0
      ? paragraphs.map((p) => `<p class="tv-overview-p">${esc(p)}</p>`).join("")
      : `<p class="tv-overview-empty">${t("drawer.noDescription")}</p>`;

  const nextAchHtml = renderNextAchievements(s.appName);
  const featuresHtml = renderGameFeatures(s, g);
  const momentsHtml = renderMomentsStrip(s.appName);

  return `
    <div class="tv-tab-pane tv-overview-pane">
      <div class="tv-overview-cols">
        <div class="tv-overview-main">
          <div class="tv-hub-box">
            <h3 class="tv-hub-box-title">${icon("info", 15)} ${t("drawer.overview")}</h3>
            <div class="tv-overview-body">${descHtml}</div>
          </div>
          ${nextAchHtml ? `<div class="tv-hub-box">${nextAchHtml}</div>` : ""}
        </div>
        <div class="tv-overview-aside">
          ${featuresHtml ? `<div class="tv-hub-box">${featuresHtml}</div>` : ""}
          ${momentsHtml ? `<div class="tv-hub-box"><h3 class="tv-hub-box-title">${icon("camera", 15)} ${t("tv.moments")}</h3>${momentsHtml}</div>` : ""}
        </div>
      </div>
    </div>`;
}

/** Render Trophies Tab Content with console card layout. */
function renderAchievementsTab(s: EpicSummary): string {
  const achData = S.loadedAchievements.get(s.appName);
  if (S.loadingAchFor === s.appName && !achData) {
    return `<div class="tv-tab-pane"><div class="tv-hub-loading">${loadingState(t("ach.loadingStore"))}</div></div>`;
  }
  if (!achData || achData.total_achievements === 0) {
    return `<div class="tv-tab-pane">${emptyState("trophy", t("ach.emptyTitle"), t("ach.emptyDesc"))}</div>`;
  }

  const isPlat = isAppPlatinum(s.appName);
  const unlocked = achData.achievements.filter((a) => a.unlocked);
  const locked = achData.achievements.filter((a) => !a.unlocked);
  const sorted = [...unlocked, ...locked];

  const cardsHtml = sorted
    .map((a: EpicAchievementItem) => {
      const tier = getAchTier(a);
      const isUnlocked = a.unlocked;
      const isHidden = a.hidden && !isUnlocked;
      const title = isHidden ? t("ach.secret") : a.display_name || a.name;
      const desc = isHidden ? t("ach.secretDesc") : a.description || "";
      const rarity = a.rarity?.percent;

      return `
        <div class="tv-trophy-card${isUnlocked ? " is-unlocked" : " is-locked"}" tabindex="0">
          <div class="tv-trophy-icon-wrap">
            ${
              isUnlocked && a.icon_link
                ? `<img class="tv-trophy-icon" src="${esc(a.icon_link)}" alt="" />`
                : `<span class="tv-trophy-ph tier-${tier}">${tier === "platinum" ? epicPlatinumIcon(20) : icon("trophy", 20)}</span>`
            }
          </div>
          <div class="tv-trophy-info">
            <div class="tv-trophy-title-row">
              <span class="tv-trophy-name">${esc(title)}</span>
              <span class="tv-trophy-tier-badge tier-${tier}">${tier.toUpperCase()}</span>
            </div>
            ${desc ? `<p class="tv-trophy-desc">${esc(desc)}</p>` : ""}
            <div class="tv-trophy-meta">
              ${rarity != null ? `<span class="tv-trophy-rarity tabular-nums">${rarity.toFixed(1)}%</span>` : ""}
              <span class="tv-trophy-state">${isUnlocked ? t("ach.unlocked") : t("ach.locked")}</span>
            </div>
          </div>
        </div>`;
    })
    .join("");

  return `
    <div class="tv-tab-pane tv-ach-pane">
      <div class="tv-ach-header">
        <div class="tv-ach-progress-box">
          <div class="tv-ach-prog-label">
            <span>${t("drawer.statTrophy")}: ${achData.user_unlocked} / ${achData.total_achievements}</span>
            <span class="tabular-nums">%${Math.round((achData.user_unlocked / achData.total_achievements) * 100)}</span>
          </div>
          <div class="tv-ach-prog-track">
            <div class="tv-ach-prog-bar" style="width: ${(achData.user_unlocked / achData.total_achievements) * 100}%"></div>
          </div>
        </div>
        ${isPlat ? `<div class="tv-plat-badge">${epicPlatinumIcon(20)} <span>${t("drawer.statPlat")}</span></div>` : ""}
      </div>
      <div class="tv-trophies-grid">${cardsHtml}</div>
    </div>`;
}

/** Render DLCs Tab Content. */
function renderDlcsTab(s: EpicSummary): string {
  const dlcRes = S.dlcCache.get(s.appName);
  const dlcs = dlcRes?.dlcs ?? [];

  if (dlcs.length === 0) {
    return `<div class="tv-tab-pane">${emptyState("package", t("drawer.dlcEmptyTitle"), t("drawer.dlcEmptyDesc"))}</div>`;
  }

  const dlcCards = dlcs
    .map((d) => `
      <div class="tv-dlc-card" tabindex="0">
        <div class="tv-dlc-art">
          ${d.image ? `<img src="${esc(d.image)}" alt="" />` : `<div class="tv-dlc-ph">${icon("package", 24)}</div>`}
        </div>
        <div class="tv-dlc-details">
          <h4 class="tv-dlc-title">${esc(d.title)}</h4>
          ${d.size > 0 ? `<span class="tv-dlc-size tabular-nums">${fmtBytes(d.size)}</span>` : ""}
          <span class="tv-dlc-status ${d.installed ? "ok" : ""}">${d.installed ? t("common.installed") : t("common.notInstalled")}</span>
        </div>
      </div>
    `)
    .join("");

  return `
    <div class="tv-tab-pane tv-dlc-pane">
      <div class="tv-dlc-grid">${dlcCards}</div>
    </div>`;
}

/** Render Screenshots Tab Content. */
function renderScreenshotsTab(s: EpicSummary): string {
  const list = S.loadedScreenshots.get(s.appName) ?? [];
  if (list.length === 0) {
    return `<div class="tv-tab-pane">${emptyState("camera", t("drawer.ssEmptyTitle"), t("drawer.ssEmptyDesc"))}</div>`;
  }

  const thumbs = list
    .map(
      (item, idx) => `
      <button type="button" class="tv-ss-thumb" data-act="tv-open-ss" data-app="${esc(s.appName)}" data-idx="${idx}" tabindex="0">
        ${shotThumbHtml(item)}
        <span class="tv-ss-overlay">${icon("camera", 16)}</span>
      </button>`,
    )
    .join("");

  hydrateShotPreviews();
  return `
    <div class="tv-tab-pane tv-ss-pane">
      <div class="tv-ss-grid">${thumbs}</div>
    </div>`;
}

/** Render Manage Tab Content. */
function renderManageTab(s: EpicSummary): string {
  const sysReqHtml = renderDrawerSystemRequirements(s);

  return `
    <div class="tv-tab-pane tv-manage-pane">
      <div class="tv-manage-cols">
        <div class="tv-manage-actions-col">
          <div class="tv-hub-box">
            <h3 class="tv-hub-box-title">${icon("settings", 15)} ${t("drawer.manage")}</h3>
            <div class="tv-manage-list">
              <div class="tv-manage-item">
                <div class="tv-manage-item-info">
                  <span class="tv-manage-item-title">${t("manage.installLocation")}</span>
                  <span class="tv-manage-item-sub">${esc(s.installPath || "—")}</span>
                </div>
                ${s.installed ? `<button type="button" class="btn ghost small" data-act="tv-open-folder" data-id="${esc(s.appName)}">${icon("folder", 14)} ${t("tv.openFolder")}</button>` : ""}
              </div>

              ${
                s.installed
                  ? `
                <div class="tv-manage-item">
                  <div class="tv-manage-item-info">
                    <span class="tv-manage-item-title">${t("manage.verify")}</span>
                    <span class="tv-manage-item-sub">${t("manage.verifyDesc")}</span>
                  </div>
                  <button type="button" class="btn ghost small" data-act="epic-verify" data-id="${esc(s.appName)}">${icon("shield", 14)} ${t("tv.verifyFiles")}</button>
                </div>

                <div class="tv-manage-item">
                  <div class="tv-manage-item-info">
                    <span class="tv-manage-item-title">${t("manage.editTime")}</span>
                    <span class="tv-manage-item-sub">${t("manage.groupPlaytime")}</span>
                  </div>
                  <button type="button" class="btn ghost small" data-act="open-edit-playtime" data-id="${esc(s.appName)}">${icon("edit", 14)} ${t("common.edit")}</button>
                </div>

                <div class="tv-manage-item is-danger">
                  <div class="tv-manage-item-info">
                    <span class="tv-manage-item-title">${t("manage.uninstallTitle")}</span>
                    <span class="tv-manage-item-sub">${t("manage.dangerDesc")}</span>
                  </div>
                  <button type="button" class="btn danger small" data-act="epic-uninstall" data-id="${esc(s.appName)}">${icon("trash", 14)} ${t("common.uninstall")}</button>
                </div>`
                  : ""
              }
            </div>
          </div>
        </div>

        <div class="tv-manage-specs-col">
          <div class="tv-hub-box">
            <h3 class="tv-hub-box-title">${icon("cpu", 15)} ${t("drawer.specs")}</h3>
            ${sysReqHtml}
          </div>
        </div>
      </div>
    </div>`;
}

/** Render Active Tab Content based on activeTab state. */
export function renderTvHubTabContent(s: EpicSummary, tab: TvHubTab): string {
  switch (tab) {
    case "achievements":
      return renderAchievementsTab(s);
    case "dlcs":
      return renderDlcsTab(s);
    case "screenshots":
      return renderScreenshotsTab(s);
    case "manage":
      return renderManageTab(s);
    case "overview":
    default:
      return renderOverviewTab(s);
  }
}

/** Complete TV Game Hub HTML markup. */
export function renderTvGameHub(s: EpicSummary, activeTab: TvHubTab = "overview"): string {
  ensureGameHubData(s);
  const wideArt = epicWideArt(s) || s.cover || "";
  const faved = S.epicFav.has(s.appName);
  const storePill = storeBadgeHtml(s.appName);

  const tabsHtml = TV_HUB_TABS.map(
    (item) => `
    <button type="button" class="tv-hub-tab${item.id === activeTab ? " active" : ""}" data-tv-tab="${item.id}" tabindex="0">
      ${icon(item.icon as Parameters<typeof icon>[0], 14)}
      <span>${t(item.labelKey as Parameters<typeof t>[0])}</span>
    </button>`,
  ).join("");

  return `
    <div class="tv-hub" id="tv-hub" data-app="${esc(s.appName)}">
      <div class="tv-hub-bg">
        ${wideArt ? `<img class="tv-hub-bg-img" src="${esc(wideArt)}" alt="" decoding="async" />` : ""}
        <div class="tv-hub-bg-scrim"></div>
      </div>

      <header class="tv-hub-header">
        <button type="button" class="tv-hub-back-btn" data-act="tv-hub-close" title="${esc(t("common.back"))}">
          <span class="tv-btn-glyph">${icon("arrow-left", 14)}</span>
          <span>${t("common.back")}</span>
        </button>

        <nav class="tv-hub-tabs" id="tv-hub-tabs">
          <span class="tv-bumper-glyph">L1</span>
          ${tabsHtml}
          <span class="tv-bumper-glyph">R1</span>
        </nav>

        <div class="tv-hub-header-right">
          ${storePill}
        </div>
      </header>

      <section class="tv-hub-hero">
        <h1 class="tv-hub-title">${esc(s.title)}</h1>
        <div class="tv-hub-cta-bar">
          ${tvHubPrimaryAction(s)}
          <button type="button" class="tv-btn-secondary${faved ? " faved" : ""}" data-act="epic-fav" data-id="${esc(s.appName)}" title="${esc(t("drawer.favTitle"))}">
            ${icon("heart", 16)} <span>${faved ? t("common.favorited") : t("common.favorite")}</span>
          </button>
          <button type="button" class="tv-btn-secondary" data-act="epic-store-page" data-id="${esc(s.appName)}" title="${esc(t("drawer.storeTitle"))}">
            ${icon("external", 16)} <span>${t("drawer.storeTitle")}</span>
          </button>
        </div>

        ${renderConsoleStatCards(s)}
      </section>

      <main class="tv-hub-body" id="tv-hub-body">
        ${renderTvHubTabContent(s, activeTab)}
      </main>
    </div>`;
}

/** Global click delegate for TV Game Hub specific actions. */
document.addEventListener("click", (e) => {
  if (S.view !== "tv") return;
  const target = e.target as HTMLElement;

  // Tab switch
  const tabBtn = target.closest<HTMLElement>("[data-tv-tab]");
  if (tabBtn) {
    e.preventDefault();
    const tab = tabBtn.dataset.tvTab as TvHubTab;
    const hub = document.getElementById("tv-hub");
    const appName = hub?.dataset.app;
    if (tab && appName) {
      const s = summaryOf(appName);
      if (s) {
        document.querySelectorAll(".tv-hub-tab").forEach((btn) => btn.classList.remove("active"));
        tabBtn.classList.add("active");
        const body = document.getElementById("tv-hub-body");
        if (body) body.innerHTML = renderTvHubTabContent(s, tab);
      }
    }
    return;
  }

  // Screenshot click inside TV Hub
  const ssBtn = target.closest<HTMLElement>("[data-act=\"tv-open-ss\"]");
  if (ssBtn) {
    e.preventDefault();
    const app = ssBtn.dataset.app;
    const idx = Number(ssBtn.dataset.idx);
    if (app && !isNaN(idx)) openScreenshotLightbox(app, idx);
    return;
  }

  // Open install folder in file manager
  const folderBtn = target.closest<HTMLElement>("[data-act=\"tv-open-folder\"]");
  if (folderBtn) {
    e.preventDefault();
    const id = folderBtn.dataset.id;
    if (id) void epicOpenFolder(id);
    return;
  }
});
