/**
 * Game detail drawer (Game Hub): orchestration, tab renderers and lazy fetches.
 *
 * Opens the full-screen detail view, renders each tab and fetches achievements,
 * DLC, screenshots and system requirements on demand. Pure presentational
 * widgets live in drawer-widgets.ts; state lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri, NO_DESC } from "../../core/constants";
import { t } from "../../i18n";
import { modalRoot } from "../../core/dom";

import { epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { presenceSync, updateGamepadHud } from "../../core/render";
import { epicWideArt, isTurkishUser, lastPlayedLabel, rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { epicDetectEos, epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetGameSettings, epicGetHltb, epicGetSystemRequirements, epicPortrait, getAntiCheat, getThirdPartyLauncher, type CriticData, type EpicAchievementsData, type EpicSummary, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";

import { updateManageModalInputsInPlace } from "../manage/manage-view";
import { fetchAndRenderScreenshots, renderDrawerScreenshots } from "../screenshots/screenshots-view";
import { cleanStoreDescription, getAchTier, getHardwareIcon, getHardwareLabel, isMacSys, isWinSys, renderAchievementSections, renderBackupListHtml, renderCriticCard, renderGameFeatures, renderHltbCard, renderOverviewMediaSpotlight, renderOverviewTrophySpotlight } from "./drawer-widgets";
export function updateDrawerTabArrows(): void {
  const wrapper = modalRoot.querySelector(".drawer-tabs-wrapper") as HTMLElement | null;
  const container = document.getElementById("drawer-tabs-scrollable");
  if (!wrapper || !container) return;

  const leftFade = wrapper.querySelector(".drawer-tabs-fade.left") as HTMLElement | null;
  const rightFade = wrapper.querySelector(".drawer-tabs-fade.right") as HTMLElement | null;

  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = maxScroll > 4;

  const canScrollLeft = hasOverflow && container.scrollLeft > 4;
  const canScrollRight = hasOverflow && container.scrollLeft < maxScroll - 4;

  if (leftFade) leftFade.classList.toggle("visible", canScrollLeft);
  if (rightFade) rightFade.classList.toggle("visible", canScrollRight);
}

export function ensureTabVisible(el: HTMLElement, container: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();

  // If already comfortably visible inside container bounds, do not scroll!
  if (elRect.left >= containerRect.left + 8 && elRect.right <= containerRect.right - 8) {
    return;
  }

  // Only if clipped on the right, scroll just enough to reveal it
  if (elRect.right > containerRect.right - 8) {
    const diff = elRect.right - containerRect.right + 16;
    container.scrollBy({ left: diff, behavior: "smooth" });
  } else if (elRect.left < containerRect.left + 8) {
    // Only if clipped on the left, scroll just enough to reveal it
    const diff = containerRect.left - elRect.left + 16;
    container.scrollBy({ left: -diff, behavior: "smooth" });
  }
}

/// Detects whether the game bundles the EOS SDK, once per game (result cached).
/// The filesystem scan runs only when a detail view opens, never per library card.
function ensureEosSupport(appName: string): void {
  const s = S.epicSummariesMap.get(appName);
  if (!isTauri || !s?.installed || !s.installPath || S.eosSupportMap.has(appName)) return;
  S.eosSupportMap.set(appName, false);
  void epicDetectEos(s.installPath)
    .then((has) => {
      S.eosSupportMap.set(appName, has);
      if (has && S.currentModalAppName === appName) openEpicModal(appName, false);
    })
    .catch(() => {});
}

export function openEpicModal(appName: string, isInitialOpen = true, animateTabContent = true): void {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (!s) return;
  S.currentModalAppName = appName;
  if (isInitialOpen) {
    S.activeDrawerTab = "overview";
    S.activeAchScope = "all";
    S.activeAchFilter = "all";
    S.achSearchQuery = "";
    S.achSortOrder = "default";
  }
  const prevOverlay = modalRoot.querySelector(".overlay") as HTMLElement | null;
  const prevScroll = !isInitialOpen && prevOverlay ? prevOverlay.scrollTop : 0;
  const g = rawOf(appName);
  const art = epicWideArt(s) || s.cover || (g ? epicPortrait(g) : null);
  const faved = S.epicFav.has(appName);
  const devRaw = g ? g.metadata.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";
  const p = epicDlProgress(appName);
  const isPlat = isAppPlatinum(appName);
  const achSum = S.epicAchSummaries[appName];
  const partner = getThirdPartyLauncher(g);
  const antiCheat = getAntiCheat(g);

  const pt = S.playtimeMap.get(appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "—";

  let achStatVal = "—";
  if (achSum && achSum.total_achievements > 0) {
    const pct = Math.round((achSum.user_unlocked / achSum.total_achievements) * 100);
    achStatVal = `${achSum.user_unlocked}/${achSum.total_achievements} (%${pct})`;
  }

  const hltb = S.loadedHltb.get(appName);
  const hltbVal = hltb?.main_story ? `~${hltb.main_story} sa` : (hltb?.main_extra ? `~${hltb.main_extra} sa` : "—");
  const hltbLoading = S.loadingHltbFor === appName;

  const critic = S.loadedCritic.get(appName);
  const criticLoading = S.loadingCriticFor === appName;
  let criticVal = "—";
  let criticTierClass = "";
  const showGoygoy = isTurkishUser() && Boolean(critic?.goygoy_review);
  const criticUrl = critic?.opencritic_url || critic?.metacritic_url || (showGoygoy ? critic?.goygoy_review?.url : "") || "";
  if (critic && critic.supported) {
    const sc = critic.opencritic_score || critic.metacritic_score;
    if (sc) {
      criticVal = critic.tier ? `${sc} • ${critic.tier}` : `${sc}`;
      if (critic.tier) {
        criticTierClass = `tier-${critic.tier.toLowerCase()}`;
      }
    } else if (showGoygoy && critic.goygoy_review?.score) {
      criticVal = `${critic.goygoy_review.score} • Goygoy`;
      criticTierClass = "tier-goygoy";
    } else if (showGoygoy && critic.goygoy_review) {
      criticVal = t("drawer.goygoyReview");
      criticTierClass = "tier-goygoy";
    }
  }

  const isRunning = S.runningGames.has(appName);
  const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
  const primary =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`
      : isRunning
        ? `<button class="btn primary running" data-id="${s.appName}"><span class="running-dot"></span> ${t("common.playing")}</button>`
        : s.installed
          ? hasUpdate
            ? `<button class="btn update" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} ${t("common.update")}</button>`
            : `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} ${t("common.playNow")}</button>`
          : partner
            ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 16)} ${t("drawer.launchInstallWith", { name: esc(partner.name) })}</button>`
            : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} ${t("common.install")}</button>`;

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== NO_DESC &&
    rawDesc !== s.title &&
    rawDesc.length > 25;
  const descHtml = hasRealDesc
    ? `<div class="drawer-desc">${esc(rawDesc)}</div>`
    : "";

  const dlcRes = S.dlcCache.get(s.appName);
  const currentDlcCount = dlcRes ? dlcRes.dlcs.length : s.dlcCount;
  const dlcTabBadge = currentDlcCount > 0
    ? `<span class="drawer-tab-badge">(${currentDlcCount})</span>`
    : "";

  const currentSsCount = S.loadedScreenshots.get(appName)?.length ?? 0;
  const ssTabBadge = currentSsCount > 0
    ? `<span class="drawer-tab-badge">(${currentSsCount})</span>`
    : "";

  if (S.activeDrawerTab === "overview" && !S.loadedHltb.has(appName) && S.loadingHltbFor !== appName) {
    S.loadingHltbFor = appName;
    epicGetHltb(s.title, s.appName)
      .then((data) => {
        S.loadedHltb.set(appName, data);
        S.loadingHltbFor = null;
        const el = document.getElementById("drawer-hltb-container");
        if (el && S.currentModalAppName === appName) {
          el.innerHTML = renderHltbCard(data);
        }
        const capEl = document.getElementById("hub-stat-hltb-val");
        if (capEl && S.currentModalAppName === appName) {
          capEl.textContent = data?.main_story ? `~${data.main_story} ${t("common.hoursShort")}` : (data?.main_extra ? `~${data.main_extra} ${t("common.hoursShort")}` : "—");
        }
      })
      .catch(() => {
        S.loadingHltbFor = null;
      });
  }

  if (S.activeDrawerTab === "overview" && !S.loadedCritic.has(appName) && S.loadingCriticFor !== appName) {
    S.loadingCriticFor = appName;
    epicGetCritic(s.title, s.appName)
      .then((data) => {
        S.loadedCritic.set(appName, data);
        S.loadingCriticFor = null;
        if (S.currentModalAppName === appName) {
          updateCriticUI(appName, data);
        }
      })
      .catch(() => {
        S.loadingCriticFor = null;
      });
  }

  if (!S.loadedRequirements.has(appName) && S.loadingReqFor !== appName) {
    void fetchAndRenderRequirements(appName, s.title);
  }

  if (!S.loadedScreenshots.has(appName) && S.loadingScreenshotsFor !== appName) {
    void fetchAndRenderScreenshots(appName, s.title);
  }

  ensureEosSupport(appName);

  if (!isInitialOpen) {
    const existingHub = modalRoot.querySelector(".game-hub, .drawer") as HTMLElement | null;
    const overlayEl = modalRoot.querySelector(".overlay") as HTMLElement | null;
    const contentEl = document.getElementById("drawer-tab-content");
    if (existingHub && contentEl && S.currentModalAppName === appName) {
      modalRoot.querySelectorAll(".drawer-tab").forEach((btn) => {
        const el = btn as HTMLElement;
        const isActive = el.dataset.tab === S.activeDrawerTab;
        el.classList.toggle("active", isActive);
        if (isActive) {
          const container = document.getElementById("drawer-tabs-scrollable");
          if (container) ensureTabVisible(el, container);
        }
      });

      const overlayScroll = overlayEl ? overlayEl.scrollTop : (existingHub ? existingHub.scrollTop : 0);
      const achList = contentEl.querySelector(".ach-list, .ach-list-container") as HTMLElement | null;
      const achScroll = achList ? achList.scrollTop : 0;

      contentEl.innerHTML =
        S.activeDrawerTab === "overview"
          ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
          : S.activeDrawerTab === "achievements"
            ? renderDrawerAchievements(s)
            : S.activeDrawerTab === "dlcs"
              ? renderDrawerDlcs(s)
              : S.activeDrawerTab === "screenshots"
                ? renderDrawerScreenshots(s)
                : S.activeDrawerTab === "manage"
                  ? renderDrawerManage(s)
                  : renderDrawerSystemRequirements(s);

      if (animateTabContent) {
        contentEl.classList.remove("tab-content-enter");
        void contentEl.offsetWidth;
        contentEl.classList.add("tab-content-enter");
      } else {
        contentEl.classList.remove("tab-content-enter");
      }

      if (overlayEl) overlayEl.scrollTop = overlayScroll;
      if (existingHub) existingHub.scrollTop = overlayScroll;
      if (achScroll > 0) {
        const nextAchList = contentEl.querySelector(".ach-list, .ach-list-container") as HTMLElement | null;
        if (nextAchList) nextAchList.scrollTop = achScroll;
      }

      const achTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="achievements"]');
      if (achTabBtn) {
        achTabBtn.innerHTML = `${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)} ${t("drawer.achievements")}`;
        achTabBtn.classList.toggle("plat", isPlat);
      }
      const dlcTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
      if (dlcTabBtn) {
        dlcTabBtn.innerHTML = `${icon("layers", 13)} ${t("drawer.dlcs")} ${dlcTabBadge}`;
      }

      requestAnimationFrame(() => {
        updateDrawerTabArrows();
      });

      return;
    }
  }

  modalRoot.innerHTML = `
    <div class="overlay" data-act="close">
      <div class="game-hub">
              <!-- 4K cinematic backdrop with deep PS5 atmospheric gradient -->
              <div class="hub-backdrop">
                ${art ? `<img src="${art}" alt="" />` : `<div class="hub-fallback-art">${icon("gamepad-2", 64)}</div>`}
                <div class="hub-backdrop-gradient"></div>
              </div>

              <!-- 1260px console stage -->
              <div class="hub-stage">
                <!-- Top bar: back button & tools -->
                <div class="hub-topbar">
                  <button class="hub-back-btn" data-act="close" title="${t("drawer.backToLibrary")}">
                    ${icon("arrow-left", 16)}
                    <span>${t("drawer.library")}</span>
              <span class="hub-back-esc">ESC</span>
            </button>
                  <div class="hub-topbar-tools">
                    <button class="hub-tool-btn" data-act="open-custom-cover" data-target="hero" data-id="${s.appName}" title="${t("drawer.customizeCover")}">
                      ${icon("image", 15)}
                    </button>
                    <button class="hub-tool-btn" data-act="close" title="${t("common.close")}">
                      ${icon("x", 16)}
                    </button>
                  </div>
                </div>

                <!-- Hero title and quick capsule -->
                <div class="hub-hero">
                  <div class="hub-hero-main">
                    <h1 class="hub-title">${esc(s.title)}</h1>
                    <div class="hub-meta-subline">
                      ${dev ? `<span class="meta-item dev">${esc(dev)}</span><span class="meta-dot"></span>` : ""}
                      <span class="meta-item status ${s.installed ? "installed" : ""}">${s.installed ? t("common.installed") : t("common.notInstalled")}</span>
                ${partner ? `<span class="meta-dot">•</span><span class="meta-item partner" title="${esc(t("drawer.partnerRequired", { name: partner.name }))}">${icon("layers", 12)} ${esc(partner.name)}</span>` : ""}
                ${antiCheat ? `<span class="meta-dot">•</span><span class="meta-item anticheat" title="${esc(t("drawer.anticheatTitle", { name: antiCheat }))}">${icon("shield", 12)} ${esc(antiCheat)}</span>` : ""}
                ${s.updateAvailable ? `<span class="meta-dot">•</span><span class="meta-item warn">${icon("zap", 11)} ${t("drawer.updateAvailable")}</span>` : ""}
              </div>

              <div class="hub-actions-bar">
                ${primary}
                <button class="btn ghost ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="${t("drawer.favTitle")}">
                  ${icon("heart", 15)} <span>${faved ? t("drawer.favorited") : t("drawer.favorite")}</span>
                </button>
                <button class="btn ghost" data-act="epic-store-page" data-id="${s.appName}" title="${t("drawer.storeTitle")}">
                  ${icon("external", 15)} <span>${t("drawer.store")}</span>
                </button>
                ${p !== null ? `<button class="btn ghost danger" data-act="epic-cancel" data-id="${s.appName}">${icon("x", 15)} <span>${t("common.cancel")}</span></button>` : ""}
              </div>
            </div>

            <!-- Right: quick stat capsule (PS5 glass capsule) -->
            <div class="hub-stat-capsule">
              <div class="hub-stat-col clickable" data-act="open-edit-playtime" data-id="${s.appName}" title="${t("drawer.editPlaytime")}">
                <span class="hub-stat-label">${icon("clock", 11)} ${t("drawer.statTime")}</span>
                <span class="hub-stat-val" id="drawer-stat-playtime">${esc(playtimeStr)}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${achSum && achSum.total_achievements > 0 ? "clickable" : ""}" ${achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}"` : ""} title="${t("drawer.viewAchievements")}">
                <span class="hub-stat-label ${isPlat ? "plat" : ""}">${isPlat ? epicPlatinumIcon(11) : icon("trophy", 11)} ${isPlat ? t("drawer.statPlat") : t("drawer.statTrophy")}</span>
                <span class="hub-stat-val ${isPlat ? "plat" : ""}">${achStatVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col" title="${t("drawer.hltbStory")}">
                <span class="hub-stat-label">${icon("timer", 11)} ${t("drawer.statStory")}</span>
                <span class="hub-stat-val" id="hub-stat-hltb-val">${hltbLoading ? `<span class="hltb-spinner"></span>` : hltbVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${criticUrl ? "clickable" : ""}" id="hub-stat-critic-col" ${criticUrl ? `data-act="open-critic-url" data-url="${esc(criticUrl)}"` : ""} title="${t("drawer.criticScore")}">
                <span class="hub-stat-label">${icon("star", 11)} ${t("drawer.statReview")}</span>
                <span class="hub-stat-val ${criticTierClass}" id="hub-stat-critic-val">${criticLoading ? `<span class="hltb-spinner"></span>` : criticVal}</span>
              </div>
            </div>
          </div>

                <!-- Tab headers -->
          <div class="drawer-tabs-wrapper">
            <div class="drawer-tabs-fade left">
              <button class="drawer-tabs-arrow left" data-act="drawer-tabs-scroll" data-dir="left" title="${t("drawer.scrollLeft")}">
                ${icon("chevron-left", 13)}
              </button>
            </div>
            <div class="drawer-tabs" id="drawer-tabs-scrollable">
              <button class="drawer-tab ${S.activeDrawerTab === "overview" ? "active" : ""}" data-act="drawer-tab" data-tab="overview">
                ${icon("gamepad-2", 13)} ${t("drawer.overview")}
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "achievements" ? "active" : ""} ${isPlat ? "plat" : ""}" data-act="drawer-tab" data-tab="achievements" data-id="${appName}">
                ${isPlat ? epicPlatinumIcon(13) : icon("trophy", 13)} ${t("drawer.achievements")}
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "dlcs" ? "active" : ""}" data-act="drawer-tab" data-tab="dlcs" data-id="${appName}">
                ${icon("layers", 13)} ${t("drawer.dlcs")} ${dlcTabBadge}
              </button>
              <button class="drawer-tab ${S.activeDrawerTab === "screenshots" ? "active" : ""}" data-act="drawer-tab" data-tab="screenshots" data-id="${appName}">
                ${icon("image", 13)} ${t("drawer.screenshots")} ${ssTabBadge}
              </button>
              ${s.installed ? `
              <button class="drawer-tab ${S.activeDrawerTab === "manage" ? "active" : ""}" data-act="drawer-tab" data-tab="manage" data-id="${appName}">
                ${icon("settings", 13)} ${t("drawer.manage")}
              </button>` : ""}
              <button class="drawer-tab ${S.activeDrawerTab === "specs" ? "active" : ""}" data-act="drawer-tab" data-tab="specs" data-id="${appName}">
                ${icon("monitor", 13)} ${t("drawer.specs")}
              </button>
            </div>
            <div class="drawer-tabs-fade right">
              <button class="drawer-tabs-arrow right" data-act="drawer-tabs-scroll" data-dir="right" title="${t("drawer.scrollRight")}">
                ${icon("chevron-right", 13)}
              </button>
            </div>
          </div>

          <!-- Tab content -->
          <div id="drawer-tab-content" class="${animateTabContent ? "tab-content-enter" : ""}">
            ${
              S.activeDrawerTab === "overview"
                ? renderDrawerOverview(s, primary, faved, p, descHtml, partner, antiCheat)
                : S.activeDrawerTab === "achievements"
                  ? renderDrawerAchievements(s)
                  : S.activeDrawerTab === "dlcs"
                    ? renderDrawerDlcs(s)
                    : S.activeDrawerTab === "screenshots"
                      ? renderDrawerScreenshots(s)
                      : S.activeDrawerTab === "manage"
                        ? renderDrawerManage(s)
                        : renderDrawerSystemRequirements(s)
            }
          </div>
        </div>
      </div>
    </div>`;

  if (prevScroll > 0) {
    const nextOverlay = modalRoot.querySelector(".overlay") as HTMLElement | null;
    if (nextOverlay) nextOverlay.scrollTop = prevScroll;
  }

  requestAnimationFrame(() => {
    updateDrawerTabArrows();
    const container = document.getElementById("drawer-tabs-scrollable");
    if (container && !(container as any)._hasScrollListener) {
      (container as any)._hasScrollListener = true;
      container.addEventListener("scroll", updateDrawerTabArrows, { passive: true });
    }
  });

  if (!S.dlcCache.has(appName)) {
    epicGetGameDlcs(appName)
      .then((res) => {
        S.dlcCache.set(appName, res);
        const cur = S.epicSummaries.find((x) => x.appName === appName);
        if (cur) cur.dlcCount = res.dlcs.length;
        if (S.currentModalAppName === appName) {
          const dlcTabBtn = modalRoot.querySelector('.drawer-tab[data-tab="dlcs"]');
          if (dlcTabBtn) {
            const badgeEl = dlcTabBtn.querySelector(".drawer-tab-badge");
            if (res.dlcs.length > 0) {
              if (badgeEl) {
                badgeEl.textContent = `(${res.dlcs.length})`;
              } else {
                dlcTabBtn.insertAdjacentHTML("beforeend", ` <span class="drawer-tab-badge">(${res.dlcs.length})</span>`);
              }
            } else if (badgeEl) {
              badgeEl.remove();
            }
          }
        }
      })
      .catch(() => {});
  }
  updateGamepadHud(S.gamepadPolling);
  presenceSync();
}

export function updateCriticUI(appName: string, data: CriticData): void {
  const container = document.getElementById("drawer-critic-container");
  if (container && S.currentModalAppName === appName) {
    container.innerHTML = renderCriticCard(data, false);
  }
  const capValEl = document.getElementById("hub-stat-critic-val");
  const capColEl = document.getElementById("hub-stat-critic-col");
  if (capValEl && S.currentModalAppName === appName) {
    const showGoygoy = isTurkishUser() && Boolean(data.goygoy_review);
    const sc = data.opencritic_score || data.metacritic_score;
    if (sc) {
      capValEl.textContent = data.tier ? `${sc} • ${data.tier}` : `${sc}`;
      if (data.tier) {
        capValEl.className = `hub-stat-val tier-${data.tier.toLowerCase()}`;
      } else {
        capValEl.className = "hub-stat-val";
      }
    } else if (showGoygoy && data.goygoy_review?.score) {
      capValEl.textContent = `${data.goygoy_review.score} • Goygoy`;
      capValEl.className = "hub-stat-val tier-goygoy";
    } else if (showGoygoy && data.goygoy_review) {
      capValEl.textContent = t("drawer.goygoyReview");
      capValEl.className = "hub-stat-val tier-goygoy";
    } else {
      capValEl.textContent = "—";
      capValEl.className = "hub-stat-val";
    }

    const url = data.opencritic_url || data.metacritic_url || (showGoygoy ? data.goygoy_review?.url : "");
    if (url && capColEl) {
      capColEl.classList.add("clickable");
      capColEl.setAttribute("data-act", "open-critic-url");
      capColEl.setAttribute("data-url", url);
    } else if (capColEl) {
      capColEl.classList.remove("clickable");
      capColEl.removeAttribute("data-act");
      capColEl.removeAttribute("data-url");
    }
  }
}

export function renderDrawerOverview(
  s: EpicSummary,
  _primary: string,
  _faved: boolean,
  _p: number | null,
  _descHtml: string,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
): string {
  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );

  const hltb = S.loadedHltb.get(s.appName);
  const hltbLoading = S.loadingHltbFor === s.appName;
  const critic = S.loadedCritic.get(s.appName);
  const criticLoading = S.loadingCriticFor === s.appName;
  const g = rawOf(s.appName);
  const reqData = S.loadedRequirements.get(s.appName);
  const achSum = S.epicAchSummaries[s.appName];

  // Collection tags (the add-ons tab is separate, so only collections are listed here).
  let tagsHtml = "";
  if (gameCols.length > 0) {
    const pills = gameCols.map((c) => `
      <button class="drawer-tag" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(t("drawer.collectionShow", { name: c.name }))}">
        ${isCollectionIcon(c.emoji) ? `<span>${collectionMarker(c.emoji, 13)}</span>` : ""}<span>${esc(c.name)}</span>
      </button>
    `).join("");
    const addBtn = `<button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} ${t("drawer.collection")}</button>`;
    tagsHtml = `<div class="drawer-tags-row">${pills}${addBtn}</div>`;
  } else {
    tagsHtml = `<div class="drawer-tags-row"><button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} ${t("drawer.addCollection")}</button></div>`;
  }

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== NO_DESC &&
    rawDesc !== s.title &&
    rawDesc.length > 25;
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : null);
  const effectiveDesc = hasRealDesc ? rawDesc : (storeDesc || null);
  const descText = effectiveDesc ? esc(effectiveDesc) : t("drawer.noDescription");

  return `
    <div class="hub-overview-layout">
      <!-- Left / main column: description, tags, trophy & media -->
      <div class="hub-overview-main">
        <div class="hub-card hub-desc-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("info", 14)} <span>${t("drawer.aboutGame")}</span></h3>
          </div>
          <div class="hub-desc-text" id="hub-desc-text">${descText}</div>
        </div>

        <div class="hub-card hub-tags-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("folder", 14)} <span>${t("drawer.collectionsTags")}</span></h3>
          </div>
          ${tagsHtml}
        </div>

        ${renderOverviewTrophySpotlight(s, g, achSum, partner)}

        <div id="overview-media-container">
          ${renderOverviewMediaSpotlight(s)}
        </div>
      </div>

      <!-- Right / sidebar: reviews, HowLongToBeat & features -->
      <div class="hub-overview-sidebar">
        <div id="drawer-critic-container">
          ${renderCriticCard(critic, criticLoading)}
        </div>

        <div id="drawer-hltb-container">
          ${renderHltbCard(hltb, hltbLoading)}
        </div>

        <div class="hub-card hub-features-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("layers", 14)} <span>${t("drawer.featuresSupport")}</span></h3>
          </div>
          <div class="hub-features-list" id="hub-features-list">
            ${renderGameFeatures(s, g, partner, antiCheat, reqData)}
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderDrawerDlcs(s: EpicSummary): string {
  const dlcRes = S.dlcCache.get(s.appName);
  if (S.dlcLoading && !dlcRes) {
    return `
      <div style="text-align:center;padding:50px 0;">
        <div class="spinner" style="margin:0 auto 16px"></div>
        <div class="muted">${t("dlc.scanning")}</div>
      </div>
    `;
  }
  const allDlcs = dlcRes?.dlcs || [];
  const query = S.dlcSearchQuery.trim().toLowerCase();
  const filteredDlcs = query
    ? allDlcs.filter((d) => d.title.toLowerCase().includes(query))
    : allDlcs;

  if (allDlcs.length === 0) {
    return `
      <div class="dlc-drawer-tab">
        <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:36px 20px;text-align:center;">
          <div style="color:var(--muted);margin-bottom:10px">${icon("package", 32)}</div>
          <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:6px">${t("drawer.noDlc")}</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:18px">${t("drawer.noDlcDesc")}</div>
          <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
            ${icon("external", 13)} ${t("drawer.discoverDlc")}
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="dlc-drawer-tab">
      <div class="dlc-drawer-search-bar">
        ${icon("search", 15)}
        <input id="dlc-drawer-search" placeholder="${t("drawer.searchDlc")}" value="${esc(S.dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
      </div>

      <div class="dlc-drawer-list">
        ${filteredDlcs.map((dlc) => {
          const isDownloadable = dlc.downloadable !== false;
          const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : (isDownloadable ? "—" : t("dlc.included"));
          const thumbHtml = dlc.image
            ? `<img class="dlc-drawer-thumb" src="${esc(dlc.image)}" alt="" />`
            : `<div class="dlc-drawer-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">${icon("layers", 14)}</div>`;

          const actionHtml = isDownloadable
            ? `
              <label class="toggle-switch" style="flex-shrink:0" title="${dlc.installed ? t("common.uninstall") : t("common.install")}">
                <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(s.appName)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            `
            : `
              <span class="dlc-badge-active" title="${t("drawer.dlcActiveTip")}">
                ${icon("check", 12)} ${t("dlc.activeBadge")}
              </span>
            `;

          return `
            <div class="dlc-drawer-item">
              <div class="dlc-drawer-left">
                ${thumbHtml}
                <div style="min-width:0">
                  <div class="dlc-drawer-title" title="${esc(dlc.title)}">${esc(dlc.title)}</div>
                  <div class="dlc-drawer-size">${esc(sizeStr)}</div>
                </div>
              </div>
              ${actionHtml}
            </div>
          `;
        }).join("")}
      </div>

      <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;margin-top:6px">
        <div style="font-size:12px;color:var(--muted)">${t("drawer.discoverMoreDlc")}</div>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
          ${icon("external", 12)} ${t("drawer.store")}
        </button>
      </div>
    </div>
  `;
}

export function renderDrawerManage(s: EpicSummary): string {
  if (!S.activeManageSettings || S.activeManageSettings.appName !== s.appName) {
    S.activeManageSettings = {
      appName: s.appName,
      title: s.title,
      launchParameters: "",
      autoUpdate: true,
      highPriority: false,
      cloudSavesEnabled: true,
      lastCloudSync: null,
      installSize: s.installSize || 0,
      installPath: s.installPath || "",
      version: s.installedVersion || s.version || "1.0",
    };
    epicGetGameSettings(s.appName).then((st) => {
      if (S.activeManageSettings?.appName === s.appName) {
        S.activeManageSettings = st;
        updateManageModalInputsInPlace(st);
      }
    }).catch(() => {});
  } else if (s.installPath && s.installPath !== S.activeManageSettings.installPath) {
    S.activeManageSettings.installPath = s.installPath;
  }
  const st = S.activeManageSettings;
  const v = S.verifyingMap.get(st.appName);
  const isVerifying = Boolean(v);
  const pt = S.playtimeMap.get(st.appName);
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : t("playtime.notPlayed");
  const lastPlayedStr = lastPlayedLabel(pt?.last_played);

  return `
    <div class="manage-tab-content">
      <!-- 1. Files & installation -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("folder", 14)} ${t("manage.groupFiles")}</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#60a5fa">${icon("shield", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.verifyTitle")}</div>
                <div class="manage-item-desc">${t("manage.verifyDesc")}</div>
                <div id="manage-verify-box-container">
                  ${
                    isVerifying && v
                      ? `
                    <div class="verify-box" style="margin-top:8px">
                      <div class="verify-bar">
                        <div id="manage-verify-fill" class="verify-fill" style="width:${v.percent}%"></div>
                      </div>
                      <div class="verify-meta">
                        <span id="manage-verify-count">${esc(v.detail || `${v.current}/${v.total} (%${v.percent})`)}</span>
                        <span id="manage-verify-speed">${esc(v.speed)}</span>
                      </div>
                    </div>`
                      : ""
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button id="manage-verify-btn" class="btn ghost small" data-act="manage-verify" data-id="${st.appName}" ${isVerifying ? "disabled" : ""}>
                ${isVerifying ? t("manage.verifying") : t("manage.verify")}
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("folder", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.installLocation")}</div>
                <div id="manage-install-path" class="manage-item-desc" style="word-break:break-all">${esc(s.installPath || st.installPath || t("manage.unspecified"))}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-move-game-modal" data-id="${st.appName}" title="${t("manage.moveTitle")}">
                ${icon("hard-drive", 13)} ${t("manage.move")}
              </button>
              <button class="btn ghost small" data-act="epic-open-folder" data-id="${st.appName}">
                ${icon("folder", 13)} ${t("manage.openFolder")}
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#a78bfa">${icon("monitor", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.shortcutTitle")}</div>
                <div class="manage-item-desc">${t("manage.shortcutDesc")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-create-shortcut" data-id="${st.appName}">
                ${t("manage.createShortcut")}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Save files & cloud -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("cloud", 14)} ${t("manage.groupSaves")}</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("cloud", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.eosCloudTitle")}</div>
                <div id="manage-cloud-subtitle" class="manage-item-desc">
                  ${
                    S.manageSyncingSaves
                      ? t("manage.syncing")
                      : st.lastCloudSync
                        ? t("manage.lastSync", { time: esc(st.lastCloudSync) })
                        : t("manage.cloudDesc")
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="${t("manage.syncNow")}" ${S.manageSyncingSaves ? "disabled" : ""}>
                ${icon("refresh", 13)} ${t("manage.sync")}
              </button>
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-cloud" ${st.cloudSavesEnabled ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row" style="flex-direction:column;align-items:stretch">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="manage-item-left">
                <div class="manage-item-icon" style="color:#c084fc">${icon("hard-drive", 18)}</div>
                <div class="manage-item-info">
                  <div class="manage-item-title">${t("manage.localBackupTitle")}</div>
                  <div class="manage-item-desc">${t("manage.backupDesc")}</div>
                </div>
              </div>
              <div class="manage-item-right">
                <button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${st.appName}" title="${t("manage.openBackupFolder")}">
                  ${icon("folder", 13)} ${t("manage.folder")}
                </button>
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${S.isBackingUp ? "disabled" : ""}>
                  ${S.isBackingUp ? t("manage.backingUp") : t("manage.backup")}
                </button>
              </div>
            </div>
            <div id="manage-backup-list" class="backup-list" style="margin-top:10px">
              ${renderBackupListHtml(st.appName)}
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Launch & updates -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("zap", 14)} ${t("manage.groupLaunch")}</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#34d399">${icon("refresh", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.autoUpdateTitle")}</div>
                <div class="manage-item-desc">${t("manage.autoUpdateDesc")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-autoupdate" ${st.autoUpdate ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#f59e0b">${icon("zap", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.priorityTitle")}</div>
                <div class="manage-item-desc">${t("manage.priorityDesc")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <label class="toggle-switch">
                <input type="checkbox" data-act="manage-toggle-priority" ${st.highPriority ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="manage-item-row" style="flex-direction:column;align-items:stretch">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#fb7185">${icon("terminal", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.argsTitle")}</div>
                <div class="manage-item-desc">${t("manage.argsDesc")}</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;width:100%">
              <input id="manage-args-input" class="text-input" style="flex:1" placeholder="-dx11 -novid" value="${esc(st.launchParameters || "")}" />
              <button class="btn primary small" data-act="manage-save-args" data-id="${st.appName}">${t("common.save")}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. Playtime & statistics -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("clock", 14)} ${t("manage.groupPlaytime")}</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("clock", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">${t("manage.totalPlaytime")}: <span id="manage-playtime-val" style="color:#38bdf8;font-weight:700">${esc(playtimeStr)}</span></div>
                <div id="manage-playtime-meta" class="manage-item-desc">${pt?.session_count ? t("manage.sessionMeta", { count: pt.session_count, last: esc(lastPlayedStr) }) : t("manage.noSession")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-edit-playtime" data-id="${st.appName}">
                ${icon("edit", 13)} ${t("manage.editTime")}
              </button>
            </div>
          </div>

          <div class="manage-info-callout">
            <div class="manage-callout-icon">${icon("info", 16)}</div>
            <div class="manage-callout-text">
              <strong>${t("manage.epicDataTitle")}</strong>
              <p>
                ${t("manage.epicDataP1")}
              </p>
              <p>
                ${t("manage.epicDataP2")}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. Danger zone -->
      <div class="manage-danger-card">
        <div class="manage-item-left">
          <div class="manage-item-icon" style="color:#ef4444;background:rgba(239,68,68,0.1)">${icon("trash", 18)}</div>
          <div class="manage-item-info">
            <div class="manage-item-title" style="color:#f87171">${t("manage.dangerTitle")}</div>
            <div class="manage-item-desc">${t("manage.dangerDesc")}</div>
          </div>
        </div>
        <div class="manage-item-right">
          <button class="btn danger small" data-act="epic-uninstall" data-id="${st.appName}">
            ${icon("trash", 13)} ${t("manage.uninstallTitle")}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function enrichAchievementsData(appName: string, data: EpicAchievementsData): void {
  const g = rawOf(appName);
  const raw = (g?.achievements || (g?.metadata as any)?.achievements) as any;
  const list = raw?.achievements || (Array.isArray(raw) ? raw : undefined);

  if (Array.isArray(list)) {
    for (const item of list) {
      const meta = (item as any)?.achievement || item;
      if (!meta?.name) continue;
      const target = data.achievements.find((a) => a.name === meta.name);
      if (target) {
        if (meta.hidden) target.hidden = true;
        if (typeof meta.isBase === "boolean") target.is_base = meta.isBase;
        else if (typeof meta.is_base === "boolean") target.is_base = meta.is_base;
        if ((!target.display_name || target.display_name.trim() === "") && (meta.unlockedDisplayName || meta.unlocked_display_name)) {
          target.display_name = meta.unlockedDisplayName || meta.unlocked_display_name || "";
        }
        if ((!target.description || target.description.trim() === "") && (meta.unlockedDescription || meta.unlocked_description)) {
          target.description = meta.unlockedDescription || meta.unlocked_description || "";
        }
        if ((!target.icon_link || target.icon_link.trim() === "") && (meta.unlockedIconLink || meta.unlocked_icon_link)) {
          target.icon_link = meta.unlockedIconLink || meta.unlocked_icon_link || "";
        }
      }
    }
  }
}

export function renderDrawerAchievements(s: EpicSummary): string {
  const isPlat = isAppPlatinum(s.appName);
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);

  if (S.loadingAchFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">${t("ach.loadingStore")}</div>
      </div>`;
  }

  const data = S.loadedAchievements.get(s.appName);
  if (!data) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">${t("ach.checking")}</div>
      </div>`;
  }

  if (data.achievements.length === 0) {
    if (partner) {
      return `
        <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
          <div style="color:var(--muted);margin-bottom:8px">${icon("gamepad-2", 32)}</div>
          <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">${t("ach.partnerTitle", { name: esc(partner.name) })}</div>
          <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 14px">${t("ach.partnerDesc", { name: `<strong>${esc(partner.name)}</strong>` })}</div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
            <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} ${t("ach.retry")}</button>
            <button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${t("ach.openPartner", { name: esc(partner.name) })}</button>
          </div>
        </div>`;
    }
    return `
      <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:8px">${icon("trophy", 32)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">${t("ach.noSupportTitle")}</div>
        <div style="font-size:12px;color:var(--muted);max-width:300px;margin:0 auto 14px">${t("ach.noSupportDesc")}</div>
        <div style="display:flex;justify-content:center;gap:8px">
          <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} ${t("ach.retry")}</button>
        </div>
      </div>`;
  }

  // Enrich instantly from catalog metadata (hidden achievements and base-game flags).
  enrichAchievementsData(s.appName, data);

  const dlcItems = data.achievements.filter((a) => !a.is_base);
  const hasDlc = dlcItems.length > 0;

  const effectiveUnlocked = isDemo ? data.total_achievements : data.user_unlocked;
  const effectiveXp = isDemo ? data.total_xp : data.user_xp;
  const pct = data.total_achievements > 0 ? Math.round((effectiveUnlocked / data.total_achievements) * 100) : 0;


  // Filtering (search query, status).
  const query = S.achSearchQuery.trim().toLowerCase();

  const filteredItems = data.achievements.filter((a) => {
    // 1. Status
    const isUnlocked = a.unlocked || isDemo;
    if (S.activeAchFilter === "unlocked" && !isUnlocked) return false;
    if (S.activeAchFilter === "locked" && isUnlocked) return false;
    if (S.activeAchFilter === "hidden" && !a.hidden) return false;

    // 2. Search query
    if (query) {
      const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
      const matchDesc = (a.description || "").toLowerCase().includes(query);
      if (!matchTitle && !matchDesc) return false;
    }

    return true;
  });

  // Sorting
  const sortedItems = [...filteredItems].sort((a, b) => {
    if (S.achSortOrder === "rarity") {
      const ra = a.rarity?.percent ?? 100;
      const rb = b.rarity?.percent ?? 100;
      return ra - rb;
    }
    if (S.achSortOrder === "xp") {
      return b.xp - a.xp;
    }
    if (S.achSortOrder === "date") {
      const da = a.unlock_date ? new Date(a.unlock_date).getTime() : 0;
      const db = b.unlock_date ? new Date(b.unlock_date).getTime() : 0;
      return db - da;
    }
    return 0; // default catalog order
  });

  // PlayStation four-tier trophy breakdown.
  let platTotal = 0, platUnlocked = 0;
  let goldTotal = 0, goldUnlocked = 0;
  let silverTotal = 0, silverUnlocked = 0;
  let bronzeTotal = 0, bronzeUnlocked = 0;

  for (const a of data.achievements) {
    const t = getAchTier(a);
    const u = a.unlocked || isDemo;
    if (t === "platinum") {
      platTotal++;
      if (u) platUnlocked++;
    } else if (t === "gold") {
      goldTotal++;
      if (u) goldUnlocked++;
    } else if (t === "silver") {
      silverTotal++;
      if (u) silverUnlocked++;
    } else {
      bronzeTotal++;
      if (u) bronzeUnlocked++;
    }
  }

  const showPlat = platTotal > 0 || isPlat || data.is_platinum || ((data.base_achievements ?? 0) > 0);
  const effPlatTotal = platTotal > 0 ? platTotal : (showPlat ? 1 : 0);
  const effPlatUnlocked = platTotal > 0 ? platUnlocked : (isPlat ? 1 : 0);

  // Counters (for the status chips)
  const scopedAll = data.achievements;
  const scopedUnlocked = isDemo ? scopedAll.length : scopedAll.filter((a) => a.unlocked).length;
  const scopedLocked = scopedAll.length - scopedUnlocked;
  const scopedHidden = scopedAll.filter((a) => a.hidden).length;

  return `
    <!-- 1. PS5 compact achievement summary bar -->
    <div class="ach-summary-bar ${isPlat ? "platinum" : ""}">
      <div class="ach-summary-left">
        <div class="ach-progress-ring" style="position:relative">
          <svg viewBox="0 0 48 48">
            <circle class="ring-bg" cx="24" cy="24" r="20" />
            <circle class="ring-fill" cx="24" cy="24" r="20"
              stroke-dasharray="${2 * Math.PI * 20}"
              stroke-dashoffset="${2 * Math.PI * 20 * (1 - pct / 100)}" />
          </svg>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#f8fafc;pointer-events:none">${isPlat ? epicPlatinumIcon(16) : `%${pct}`}</span>
        </div>
        <div class="ach-summary-text">
          <span class="ach-summary-count">${effectiveUnlocked} / ${data.total_achievements}</span>
          <span class="ach-summary-sub">${isPlat ? t("ach.platinumComplete") : `${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP`}</span>
        </div>
      </div>
      <div class="ach-summary-right">
        ${effPlatTotal > 0 ? `<span class="ach-tier-mini plat ${effPlatUnlocked >= effPlatTotal ? "complete" : ""}" title="${t("ach.tierPlatinum")}">${epicPlatinumIcon(11)} ${effPlatUnlocked}/${effPlatTotal}</span>` : ""}
        ${goldTotal > 0 ? `<span class="ach-tier-mini gold ${goldUnlocked >= goldTotal ? "complete" : ""}" title="${t("ach.tierGold")}">${icon("trophy", 11)} ${goldUnlocked}/${goldTotal}</span>` : ""}
        ${silverTotal > 0 ? `<span class="ach-tier-mini silver ${silverUnlocked >= silverTotal ? "complete" : ""}" title="${t("ach.tierSilver")}">${icon("trophy", 11)} ${silverUnlocked}/${silverTotal}</span>` : ""}
        ${bronzeTotal > 0 ? `<span class="ach-tier-mini bronze ${bronzeUnlocked >= bronzeTotal ? "complete" : ""}" title="${t("ach.tierBronze")}">${icon("trophy", 11)} ${bronzeUnlocked}/${bronzeTotal}</span>` : ""}
        <div class="ach-summary-tools">
          <button class="ach-tool-btn" data-act="ach-refresh" data-id="${s.appName}" title="${t("ach.refreshData")}">${icon("refresh", 13)}</button>
          <button class="ach-tool-btn" data-act="open-store-achievements" data-id="${s.appName}" title="${t("ach.viewInStore")}">${icon("external", 13)}</button>
        </div>
      </div>
    </div>

    <!-- 2. Search & sort bar -->
    <div class="ach-toolbar">
      <!-- Live search box -->
      <div class="ach-search-wrap">
        <span class="ach-search-icon">${icon("search", 13)}</span>
        <input type="text" id="ach-search-input" class="ach-search-field" placeholder="${t("ach.searchPlaceholder")}" value="${esc(S.achSearchQuery)}" autocomplete="off" />
        ${S.achSearchQuery ? `<button class="ach-search-clear" data-act="clear-ach-search" title="${t("ach.clearSearch")}">${icon("x", 12)}</button>` : ""}
      </div>

      <!-- Sort selection -->
      <div class="ach-sort-wrap">
        <select id="ach-sort-select" class="ach-sort-select" title="${t("ach.sortTitle")}">
          <option value="default" ${S.achSortOrder === "default" ? "selected" : ""}>${t("ach.sortDefault")}</option>
          <option value="rarity" ${S.achSortOrder === "rarity" ? "selected" : ""}>${t("ach.sortRarity")}</option>
          <option value="xp" ${S.achSortOrder === "xp" ? "selected" : ""}>${t("ach.sortXp")}</option>
          <option value="date" ${S.achSortOrder === "date" ? "selected" : ""}>${t("ach.sortDate")}</option>
        </select>
      </div>
    </div>

    <!-- 3. PlayStation-style status tabs -->
    <div class="ach-status-strip">
      <button class="ach-status-chip ${S.activeAchFilter === "all" ? "active" : ""}" data-act="ach-filter" data-val="all">
        ${t("ach.filterAll")} <span class="ach-chip-num">${scopedAll.length}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "unlocked" ? "active" : ""}" data-act="ach-filter" data-val="unlocked">
        ${icon("check", 11)} ${t("ach.filterUnlocked")} <span class="ach-chip-num">${scopedUnlocked}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "locked" ? "active" : ""}" data-act="ach-filter" data-val="locked">
        ${icon("lock", 11)} ${t("ach.filterLocked")} <span class="ach-chip-num">${scopedLocked}</span>
      </button>
      ${scopedHidden > 0 ? `
      <button class="ach-status-chip ${S.activeAchFilter === "hidden" ? "active" : ""}" data-act="ach-filter" data-val="hidden">
        ${icon("eye", 11)} ${t("ach.filterHidden")} <span class="ach-chip-num">${scopedHidden}</span>
      </button>` : ""}
    </div>

    <!-- 4. Grouped achievement list -->
    <div class="ach-list-container" id="ach-list-container">
      ${renderAchievementSections(sortedItems, s, hasDlc, data.achievements)}
    </div>
  `;
}

export async function fetchAndRenderAchievements(appName: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  if (S.loadingAchFor === appName) return;
  S.loadingAchFor = appName;
  if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") {
    openEpicModal(appName, false, false);
  }
  try {
    const data = await epicGetAchievements(appName, forceRefresh);
    S.loadedAchievements.set(appName, data);
    if (!S.epicAchSummaries[appName]) {
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
      S.epicAchSummaries[appName].user_unlocked = data.user_unlocked;
      S.epicAchSummaries[appName].total_achievements = data.total_achievements;
      S.epicAchSummaries[appName].user_xp = data.user_xp;
      S.epicAchSummaries[appName].total_xp = data.total_xp;
      S.epicAchSummaries[appName].is_platinum = data.is_platinum;
    }
  } catch (e) {
    console.warn("Achievements could not be fetched or this game has no achievement support:", e);
    S.loadedAchievements.set(appName, {
      achievements: [],
      hidden: [],
      user_unlocked: 0,
      user_xp: 0,
      total_achievements: 0,
      total_xp: 0,
      is_platinum: false,
    });
  } finally {
    S.loadingAchFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "achievements") {
      openEpicModal(appName, false, false);
    }
  }
}

/* ---------- System requirements UI ---------- */

export function renderDrawerSystemRequirements(s: EpicSummary): string {
  if (S.loadingReqFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">${t("sys.loadingStore")}</div>
      </div>`;
  }

  const data = S.loadedRequirements.get(s.appName);
  if (!data) {
    if (S.loadingReqFor !== s.appName) {
      void fetchAndRenderRequirements(s.appName, s.title);
    }
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">${t("sys.loading")}</div>
      </div>`;
  }

  if (!data.supported || data.systems.length === 0) {
    return `
      <div style="text-align:center;padding:36px 18px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:10px">${icon("cpu", 36)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:6px">${t("sys.notFoundTitle")}</div>
        <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 16px;line-height:1.5">${t("sys.notFoundDesc")}</div>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} ${t("common.retry")}</button>
          <button class="btn play small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("sys.goStore")}</button>
        </div>
      </div>`;
  }

  const hasWin = data.systems.some((sys) => isWinSys(sys.systemType));
  const hasMac = data.systems.some((sys) => isMacSys(sys.systemType));

  const currentSys =
    data.systems.find((sys) =>
      S.activeSystemPlatform === "Windows" ? isWinSys(sys.systemType) : isMacSys(sys.systemType)
    ) || data.systems[0];

  const minItems = currentSys.details.filter((d) => d.minimum && d.minimum.trim() !== "");
  const recItems = currentSys.details.filter((d) => d.recommended && d.recommended.trim() !== "");

  const renderDetailList = (items: SystemDetailItem[], isMin: boolean) => {
    if (items.length === 0) {
      return `<div style="font-size:11.5px;color:var(--muted);padding:8px">${t("sys.unspecified")}</div>`;
    }
    return items
      .map((d) => {
        const val = isMin ? d.minimum : d.recommended;
        if (!val) return "";
        return `
          <div class="sys-req-row">
            <div class="sys-req-label">
              ${getHardwareIcon(d.title)}
              <span>${esc(getHardwareLabel(d.title))}</span>
            </div>
            <div class="sys-req-val">${esc(val)}</div>
          </div>`;
      })
      .join("");
  };

  const languagesHtml =
    data.languages.length > 0
      ? `<div class="sys-req-lang-card">
          <div class="sys-req-lang-head">
            ${icon("globe", 13)}
            <span>${t("sys.languages")}</span>
          </div>
          <div class="sys-req-lang-body">${esc(data.languages.join(" • "))}</div>
        </div>`
      : "";

  return `
    <div class="sys-req-container">
      ${
        hasWin && hasMac
          ? `
          <div class="sys-req-platforms">
            <button class="sys-req-plat-pill ${isWinSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Windows">
              ${icon("layers", 13)} ${t("sys.windowsPc")}
            </button>
            <button class="sys-req-plat-pill ${isMacSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">
              ${icon("monitor", 13)} ${t("sys.macos")}
            </button>
          </div>`
          : ""
      }

      <div class="sys-req-cards-grid">
        <div class="sys-req-card min">
          <div class="sys-req-card-head">
            <div class="sys-req-badge min">${icon("cpu", 12)} ${t("sys.minTitle")}</div>
            <div class="sys-req-hint">${t("sys.minHint")}</div>
          </div>
          <div class="sys-req-body">
            ${renderDetailList(minItems, true)}
          </div>
        </div>

        ${
          recItems.length > 0
            ? `
          <div class="sys-req-card rec">
            <div class="sys-req-card-head">
              <div class="sys-req-badge rec">${icon("rocket", 12)} ${t("sys.recTitle")}</div>
              <div class="sys-req-hint">${t("sys.recHint")}</div>
            </div>
            <div class="sys-req-body">
              ${renderDetailList(recItems, false)}
            </div>
          </div>`
            : ""
        }
      </div>

      ${languagesHtml}

      <div class="sys-req-footer">
        <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} ${t("sys.requery")}</button>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} ${t("sys.openStore")}</button>
      </div>
    </div>`;
}

export async function fetchAndRenderRequirements(appName: string, title: string, forceRefresh = false): Promise<void> {
  if (!isTauri) return;
  if (S.loadingReqFor === appName) return;
  S.loadingReqFor = appName;
  try {
    const data = await epicGetSystemRequirements(title, appName, forceRefresh);
    S.loadedRequirements.set(appName, data);

    // Fill in the store description for games that lack one.
    if (data.shortDescription || data.description) {
      const curSummary = S.epicSummaries.find((x) => x.appName === appName);
      const sDesc = curSummary?.description?.trim();
      const needsDesc = !sDesc || sDesc === NO_DESC || sDesc === curSummary?.title || sDesc.length <= 25;
      if (needsDesc && curSummary) {
        curSummary.description = data.shortDescription || cleanStoreDescription(data.description || "");
      }
    }

    // If the modal is open on the overview tab, update the DOM in place.
    if (S.currentModalAppName === appName && S.activeDrawerTab === "overview") {
      const descEl = document.getElementById("hub-desc-text");
      if (descEl && (data.shortDescription || data.description)) {
        descEl.textContent = data.shortDescription || cleanStoreDescription(data.description || "");
      }
      const featuresListEl = document.getElementById("hub-features-list");
      if (featuresListEl) {
        const curSummary = S.epicSummaries.find((x) => x.appName === appName);
        if (curSummary) {
          const g = rawOf(appName);
          const partner = getThirdPartyLauncher(g);
          const antiCheat = getAntiCheat(g);
          featuresListEl.innerHTML = renderGameFeatures(curSummary, g, partner, antiCheat, data);
        }
      }
    }
  } catch (e) {
    console.warn("System requirements could not be fetched:", e);
    S.loadedRequirements.set(appName, {
      supported: false,
      systems: [],
      languages: [],
      appName,
    });
  } finally {
    S.loadingReqFor = null;
    if (S.currentModalAppName === appName && S.activeDrawerTab === "specs") {
      openEpicModal(appName, false);
    }
  }
}


export async function epicOpenFolder(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const targetPath =
    (S.activeManageSettings?.appName === appName ? S.activeManageSettings.installPath : null) ||
    s?.installPath;
  if (!targetPath) {
    toast(t("common.installPathUnknown"), "err");
    return;
  }
  try {
    if (isTauri) {
      const msg = await invoke<string>("open_folder", { path: targetPath });
      toast(msg, "ok");
    } else toast(`(demo) ${targetPath}`, "");
  } catch (e) {
    toast(String(e), "err");
  }
}
