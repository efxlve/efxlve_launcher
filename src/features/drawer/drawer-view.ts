/**
 * Game detail drawer (Game Hub): orchestration, tab renderers and lazy fetches.
 *
 * Opens the full-screen detail view, renders each tab and fetches achievements,
 * DLC, screenshots and system requirements on demand. Pure presentational
 * widgets live in drawer-widgets.ts; state lives in S.
 */

import { invoke } from "@tauri-apps/api/core";
import { collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri } from "../../core/constants";
import { t } from "../../i18n";
import { modalRoot } from "../../core/dom";

import { epicDlProgress, isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { updateGamepadHud } from "../../core/render";
import { epicWideArt, isTurkishUser, rawOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes, fmtPlaytime } from "../../core/utils";
import { epicGetAchievements, epicGetCritic, epicGetGameDlcs, epicGetGameSettings, epicGetHltb, epicGetSystemRequirements, epicPortrait, getAntiCheat, getThirdPartyLauncher, type CriticData, type EpicAchievementsData, type EpicSummary, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";

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
      criticVal = "Goygoy İnceleme";
      criticTierClass = "tier-goygoy";
    }
  }

  const isRunning = S.runningGames.has(appName);
  const primary =
    p !== null
      ? `<button class="btn primary" disabled data-dlbtn="${s.appName}">%${p} indiriliyor…</button>`
      : isRunning
        ? `<button class="btn primary running" data-id="${s.appName}"><span class="running-dot"></span> Oynanıyor…</button>`
        : s.installed
          ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("play", 16)} Hemen Oyna</button>`
          : partner
            ? `<button class="btn play" data-act="epic-play" data-id="${s.appName}">${icon("external", 16)} ${esc(partner.name)} ile Başlat / Yükle</button>`
            : `<button class="btn primary" data-act="epic-install" data-id="${s.appName}">${icon("download", 16)} Yükle</button>`;

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== "Açıklama yok." &&
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
          capEl.textContent = data?.main_story ? `~${data.main_story} sa` : (data?.main_extra ? `~${data.main_extra} sa` : "—");
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
        <!-- 4K Sinematik Arka Plan & Derin PS5 Atmosferik Degrade -->
        <div class="hub-backdrop">
          ${art ? `<img src="${art}" alt="" />` : `<div class="hub-fallback-art">${icon("gamepad-2", 64)}</div>`}
          <div class="hub-backdrop-gradient"></div>
        </div>

        <!-- 1260px Genişliğindeki Konsol Sahnesi -->
        <div class="hub-stage">
          <!-- Üst Bar: Geri Butonu & Araçlar -->
          <div class="hub-topbar">
            <button class="hub-back-btn" data-act="close" title="Kütüphaneye Dön (ESC)">
              ${icon("arrow-left", 16)}
              <span>Kütüphane</span>
              <span class="hub-back-esc">ESC</span>
            </button>
            <div class="hub-topbar-tools">
              <button class="hub-tool-btn" data-act="open-custom-cover" data-target="hero" data-id="${s.appName}" title="Afiş ve Kapak Görselini Özelleştir">
                ${icon("image", 15)}
              </button>
              <button class="hub-tool-btn" data-act="close" title="Kapat">
                ${icon("x", 16)}
              </button>
            </div>
          </div>

          <!-- Hero Başlık ve Hızlı Kapsül -->
          <div class="hub-hero">
            <div class="hub-hero-main">
              <h1 class="hub-title">${esc(s.title)}</h1>
              <div class="hub-meta-subline">
                ${dev ? `<span class="meta-item dev">${esc(dev)}</span><span class="meta-dot">•</span>` : ""}
                <span class="meta-item status ${s.installed ? "installed" : ""}">${s.installed ? "Kurulu" : "Kurulu Değil"}</span>
                ${partner ? `<span class="meta-dot">•</span><span class="meta-item partner" title="${esc(partner.name)} başlatıcısı gereklidir">${icon("layers", 12)} ${esc(partner.name)}</span>` : ""}
                ${antiCheat ? `<span class="meta-dot">•</span><span class="meta-item anticheat" title="Hile Koruması: ${esc(antiCheat)}">${icon("shield", 12)} ${esc(antiCheat)}</span>` : ""}
                ${s.updateAvailable ? `<span class="meta-dot">•</span><span class="meta-item warn">${icon("zap", 11)} Güncelleme Mevcut</span>` : ""}
              </div>

              <div class="hub-actions-bar">
                ${primary}
                <button class="btn ghost ${faved ? "faved" : ""}" data-act="epic-fav" data-id="${s.appName}" title="Favorilere Ekle / Çıkar">
                  ${icon("heart", 15)} <span>${faved ? "Favorilerde" : "Favori"}</span>
                </button>
                <button class="btn ghost" data-act="epic-store-page" data-id="${s.appName}" title="Epic Games Store Sayfasını Aç">
                  ${icon("external", 15)} <span>Mağaza</span>
                </button>
                ${p !== null ? `<button class="btn ghost danger" data-act="epic-cancel" data-id="${s.appName}">${icon("x", 15)} <span>İptal</span></button>` : ""}
              </div>
            </div>

            <!-- Sağ Taraf: Hızlı Stat Kapsülü (PS5 Glass Capsule) -->
            <div class="hub-stat-capsule">
              <div class="hub-stat-col clickable" data-act="open-edit-playtime" data-id="${s.appName}" title="Oynama süresini düzenle">
                <span class="hub-stat-label">${icon("clock", 11)} SÜRE</span>
                <span class="hub-stat-val" id="drawer-stat-playtime">${esc(playtimeStr)}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${achSum && achSum.total_achievements > 0 ? "clickable" : ""}" ${achSum && achSum.total_achievements > 0 ? `data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}"` : ""} title="Başarımları Gör">
                <span class="hub-stat-label ${isPlat ? "plat" : ""}">${isPlat ? epicPlatinumIcon(11) : icon("trophy", 11)} ${isPlat ? "PLATİN" : "KUPA"}</span>
                <span class="hub-stat-val ${isPlat ? "plat" : ""}">${achStatVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col" title="HowLongToBeat Hikaye Süresi">
                <span class="hub-stat-label">${icon("timer", 11)} HİKAYE</span>
                <span class="hub-stat-val" id="hub-stat-hltb-val">${hltbLoading ? `<span class="hltb-spinner"></span>` : hltbVal}</span>
              </div>
              <div class="hub-stat-divider"></div>
              <div class="hub-stat-col ${criticUrl ? "clickable" : ""}" id="hub-stat-critic-col" ${criticUrl ? `data-act="open-critic-url" data-url="${esc(criticUrl)}"` : ""} title="Eleştirmen İnceleme Skoru">
                <span class="hub-stat-label">${icon("star", 11)} İNCELEME</span>
                <span class="hub-stat-val ${criticTierClass}" id="hub-stat-critic-val">${criticLoading ? `<span class="hltb-spinner"></span>` : criticVal}</span>
              </div>
            </div>
          </div>

          <!-- Sekme Başlıkları -->
          <div class="drawer-tabs-wrapper">
            <div class="drawer-tabs-fade left">
              <button class="drawer-tabs-arrow left" data-act="drawer-tabs-scroll" data-dir="left" title="Sola kaydır">
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
              <button class="drawer-tabs-arrow right" data-act="drawer-tabs-scroll" data-dir="right" title="Sağa kaydır">
                ${icon("chevron-right", 13)}
              </button>
            </div>
          </div>

          <!-- Sekme İçeriği -->
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
      capValEl.textContent = "Goygoy İnceleme";
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

  // Koleksiyon etiketleri (Eklentiler sekmesi yukarıda olduğu için burada yalnızca koleksiyonlar listelenir)
  let tagsHtml = "";
  if (gameCols.length > 0) {
    const pills = gameCols.map((c) => `
      <button class="drawer-tag" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(c.name)} koleksiyonunu göster">
        ${isCollectionIcon(c.emoji) ? `<span>${collectionMarker(c.emoji, 13)}</span>` : ""}<span>${esc(c.name)}</span>
      </button>
    `).join("");
    const addBtn = `<button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} Koleksiyon</button>`;
    tagsHtml = `<div class="drawer-tags-row">${pills}${addBtn}</div>`;
  } else {
    tagsHtml = `<div class="drawer-tags-row"><button class="drawer-tag-add" data-act="manage-game-collections" data-id="${s.appName}">${icon("plus", 10)} Koleksiyon Ekle</button></div>`;
  }

  const rawDesc = s.description?.trim();
  const hasRealDesc =
    rawDesc &&
    rawDesc !== "Açıklama yok." &&
    rawDesc !== s.title &&
    rawDesc.length > 25;
  const storeDesc = reqData?.shortDescription || (reqData?.description ? cleanStoreDescription(reqData.description) : null);
  const effectiveDesc = hasRealDesc ? rawDesc : (storeDesc || null);
  const descText = effectiveDesc ? esc(effectiveDesc) : "Bu oyun için katalog açıklaması henüz eklenmemiş.";

  return `
    <div class="hub-overview-layout">
      <!-- Sol / Ana Alan: Açıklama, Etiketler, Kupa & Medya Vitrini -->
      <div class="hub-overview-main">
        <div class="hub-card hub-desc-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("info", 14)} <span>Oyun Hakkında</span></h3>
          </div>
          <div class="hub-desc-text" id="hub-desc-text">${descText}</div>
        </div>

        <div class="hub-card hub-tags-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("folder", 14)} <span>Koleksiyonlar & Etiketler</span></h3>
          </div>
          ${tagsHtml}
        </div>

        ${renderOverviewTrophySpotlight(s, g, achSum, partner)}

        <div id="overview-media-container">
          ${renderOverviewMediaSpotlight(s)}
        </div>
      </div>

      <!-- Sağ / Kenar Çubuğu: İncelemeler, HowLongToBeat & Özellikler -->
      <div class="hub-overview-sidebar">
        <div id="drawer-critic-container">
          ${renderCriticCard(critic, criticLoading)}
        </div>

        <div id="drawer-hltb-container">
          ${renderHltbCard(hltb, hltbLoading)}
        </div>

        <div class="hub-card hub-features-card">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("layers", 14)} <span>Oyun Özellikleri & Destek</span></h3>
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
        <div class="muted">Eklentiler taranıyor…</div>
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
          <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:6px">Kayıtlı Eklenti Bulunmuyor</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:18px">Bu oyun için kütüphanenizde eklenti veya ek içerik kaydı yok.</div>
          <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
            ${icon("external", 13)} Mağazada Eklentileri Keşfet
          </button>
        </div>
      </div>
    `;
  }

  return `
    <div class="dlc-drawer-tab">
      <div class="dlc-drawer-search-bar">
        ${icon("search", 15)}
        <input id="dlc-drawer-search" placeholder="Eklentiler arasında ara…" value="${esc(S.dlcSearchQuery)}" spellcheck="false" autocomplete="off" />
      </div>

      <div class="dlc-drawer-list">
        ${filteredDlcs.map((dlc) => {
          const isDownloadable = dlc.downloadable !== false;
          const sizeStr = dlc.size > 0 ? fmtBytes(dlc.size) : (isDownloadable ? "—" : "Oyuna Dahil");
          const thumbHtml = dlc.image
            ? `<img class="dlc-drawer-thumb" src="${esc(dlc.image)}" alt="" />`
            : `<div class="dlc-drawer-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--muted)">${icon("layers", 14)}</div>`;

          const actionHtml = isDownloadable
            ? `
              <label class="toggle-switch" style="flex-shrink:0" title="${dlc.installed ? "Kaldır" : "Yükle"}">
                <input type="checkbox" data-act="dlc-toggle-install" data-app="${esc(s.appName)}" data-dlc="${esc(dlc.appId)}" ${dlc.installed ? "checked" : ""} />
                <span class="toggle-slider"></span>
              </label>
            `
            : `
              <span class="dlc-badge-active" title="Bu içerik ana oyuna entegredir ve Epic hesabınızda etkindir.">
                ${icon("check", 12)} Hesapta Aktif
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
        <div style="font-size:12px;color:var(--muted)">Daha fazla eklenti ve genişletme keşfet</div>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">
          ${icon("external", 12)} Mağaza
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
  const playtimeStr = pt?.total_seconds ? fmtPlaytime(pt.total_seconds) : "Oynanmadı";
  const lastPlayedStr = pt?.last_played || "Henüz oynanmadı";

  return `
    <div class="manage-tab-content">
      <!-- 1. Dosyalar & Kurulum -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("folder", 14)} Dosyalar & Kurulum</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#60a5fa">${icon("shield", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Dosyaları Doğrula</div>
                <div class="manage-item-desc">Oyun dosyalarının bütünlüğünü kontrol et ve hasarlı parçaları onar</div>
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
                ${isVerifying ? "Doğrulanıyor…" : "Doğrula"}
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("folder", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Kurulum Konumu</div>
                <div id="manage-install-path" class="manage-item-desc" style="word-break:break-all">${esc(s.installPath || st.installPath || "Belirtilmemiş")}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-move-game-modal" data-id="${st.appName}" title="Oyun Dosyalarını Başka Bir Diske veya Klasöre Taşı">
                ${icon("hard-drive", 13)} Taşı
              </button>
              <button class="btn ghost small" data-act="epic-open-folder" data-id="${st.appName}">
                ${icon("folder", 13)} Klasörü Aç
              </button>
            </div>
          </div>

          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#a78bfa">${icon("monitor", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Masaüstü Kısayolu</div>
                <div class="manage-item-desc">Oyunu masaüstünden tek tıkla doğrudan başlatmak için kısayol ekle</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-create-shortcut" data-id="${st.appName}">
                Kısayol Oluştur
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 2. Kayıt Dosyaları & Bulut -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("cloud", 14)} Kayıt Dosyaları & Bulut</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("cloud", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">EOS Bulut Kayıtları</div>
                <div id="manage-cloud-subtitle" class="manage-item-desc">
                  ${
                    S.manageSyncingSaves
                      ? "Bulut ile eşitleniyor…"
                      : st.lastCloudSync
                        ? `En son eşitleme: ${esc(st.lastCloudSync)}`
                        : "İlerlemeleri Epic Online Services (EOS) bulutuna kaydet"
                  }
                </div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="manage-sync-saves" data-id="${st.appName}" title="Şimdi Eşitle" ${S.manageSyncingSaves ? "disabled" : ""}>
                ${icon("refresh", 13)} Eşitle
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
                  <div class="manage-item-title">Yerel Kayıt Yedekleme (Save Backup)</div>
                  <div class="manage-item-desc">İlerlemenizi korumak için yerel arşiv oluşturun veya geri yükleyin</div>
                </div>
              </div>
              <div class="manage-item-right">
                <button class="btn ghost small" data-act="manage-open-backup-folder" data-id="${st.appName}" title="Yedek Klasörünü Aç">
                  ${icon("folder", 13)} Klasör
                </button>
                <button class="btn primary small" data-act="manage-create-backup" data-id="${st.appName}" ${S.isBackingUp ? "disabled" : ""}>
                  ${S.isBackingUp ? "Yedekleniyor…" : "Yedek Al"}
                </button>
              </div>
            </div>
            <div id="manage-backup-list" class="backup-list" style="margin-top:10px">
              ${renderBackupListHtml(st.appName)}
            </div>
          </div>
        </div>
      </div>

      <!-- 3. Başlatma ve Güncellemeler -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("zap", 14)} Başlatma ve Güncellemeler</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#34d399">${icon("refresh", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Otomatik Güncelleme</div>
                <div class="manage-item-desc">Yeni bir güncelleme yayınlandığında otomatik indir</div>
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
                <div class="manage-item-title">Öncelikli İndirmeler</div>
                <div class="manage-item-desc">Bu oyunun güncellemelerini indirme kuyruğunda en öne al</div>
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
                <div class="manage-item-title">Başlatma Parametreleri (Launch Arguments)</div>
                <div class="manage-item-desc">Gelişmiş komut satırı parametreleri ekleyin (örn: -dx11, -novid)</div>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;width:100%">
              <input id="manage-args-input" class="text-input" style="flex:1" placeholder="-dx11 -novid" value="${esc(st.launchParameters || "")}" />
              <button class="btn primary small" data-act="manage-save-args" data-id="${st.appName}">Kaydet</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 4. Oynama Süresi & İstatistikler -->
      <div class="manage-card-group">
        <div class="manage-group-title">${icon("clock", 14)} Oynama Süresi & İstatistikler</div>
        <div class="manage-group-card">
          <div class="manage-item-row">
            <div class="manage-item-left">
              <div class="manage-item-icon" style="color:#38bdf8">${icon("clock", 18)}</div>
              <div class="manage-item-info">
                <div class="manage-item-title">Toplam Oynama Süresi: <span id="manage-playtime-val" style="color:#38bdf8;font-weight:700">${esc(playtimeStr)}</span></div>
                <div id="manage-playtime-meta" class="manage-item-desc">${pt?.session_count ? `${pt.session_count} oturum kaydedildi • Son: ${esc(lastPlayedStr)}` : "Bu launcher üzerinden henüz oturum kaydedilmedi"}</div>
              </div>
            </div>
            <div class="manage-item-right">
              <button class="btn ghost small" data-act="open-edit-playtime" data-id="${st.appName}">
                ${icon("edit", 13)} Süreyi Düzenle
              </button>
            </div>
          </div>

          <div class="manage-info-callout">
            <div class="manage-callout-icon">${icon("info", 16)}</div>
            <div class="manage-callout-text">
              <strong>Epic Games Verileri Neden Otomatik Alınamıyor?</strong>
              <p>
                Epic Games Store, oynama sürelerini sadece kendi sunucularındaki özel telemetri sisteminde depolar ve üçüncü parti istemcilerin (Heroic, GOG Galaxy vb.) erişebileceği bir REST/GraphQL veya OAuth API sağlamaz.
              </p>
              <p>
                Launcher üzerinden oyunu başlattığınızda oturum süreleri yerel olarak kaydedilir. Daha önce Epic Games'te geçirdiğiniz süreyi yukarıdaki "Süreyi Düzenle" butonundan bir kez ekleyerek kaldığınız yerden biriktirmeye devam edebilirsiniz.
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- 5. Tehlikeli Bölge -->
      <div class="manage-danger-card">
        <div class="manage-item-left">
          <div class="manage-item-icon" style="color:#ef4444;background:rgba(239,68,68,0.1)">${icon("trash", 18)}</div>
          <div class="manage-item-info">
            <div class="manage-item-title" style="color:#f87171">Oyunu Bilgisayardan Kaldır</div>
            <div class="manage-item-desc">Kurulum dosyaları diskten silinecektir. Kayıt dosyalarınız korunur.</div>
          </div>
        </div>
        <div class="manage-item-right">
          <button class="btn danger small" data-act="epic-uninstall" data-id="${st.appName}">
            ${icon("trash", 13)} Oyunu Kaldır
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
        <div style="font-size:13px;font-weight:600">Epic Games Store başarımları yükleniyor…</div>
      </div>`;
  }

  const data = S.loadedAchievements.get(s.appName);
  if (!data) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Başarımlar kontrol ediliyor…</div>
      </div>`;
  }

  if (data.achievements.length === 0) {
    if (partner) {
      return `
        <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
          <div style="color:var(--muted);margin-bottom:8px">${icon("gamepad-2", 32)}</div>
          <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">${esc(partner.name)} Başarımları</div>
          <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 14px">Bu oyunun başarımları doğrudan <strong>${esc(partner.name)}</strong> üzerinden takip edilmektedir.</div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
            <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
            <button class="btn play small" data-act="epic-play" data-id="${s.appName}">${icon("external", 13)} ${esc(partner.name)}'i Aç</button>
          </div>
        </div>`;
    }
    return `
      <div style="text-align:center;padding:30px 16px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:8px">${icon("trophy", 32)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:4px">Başarım Desteği Bulunmuyor</div>
        <div style="font-size:12px;color:var(--muted);max-width:300px;margin:0 auto 14px">Bu oyun için Epic Games Store üzerinde tanımlı başarım bulunmuyor.</div>
        <div style="display:flex;justify-content:center;gap:8px">
          <button class="btn ghost small" data-act="ach-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
        </div>
      </div>`;
  }

  // Katalog metadatasıyla anında zenginleştir (gizli başarımlar ve ana oyun bayrakları)
  enrichAchievementsData(s.appName, data);

  const dlcItems = data.achievements.filter((a) => !a.is_base);
  const hasDlc = dlcItems.length > 0;

  const effectiveUnlocked = isDemo ? data.total_achievements : data.user_unlocked;
  const effectiveXp = isDemo ? data.total_xp : data.user_xp;
  const pct = data.total_achievements > 0 ? Math.round((effectiveUnlocked / data.total_achievements) * 100) : 0;


  // Filtreleme (Arama sorgusu, Durum)
  const query = S.achSearchQuery.trim().toLowerCase();

  const filteredItems = data.achievements.filter((a) => {
    // 1. Durum (Status)
    const isUnlocked = a.unlocked || isDemo;
    if (S.activeAchFilter === "unlocked" && !isUnlocked) return false;
    if (S.activeAchFilter === "locked" && isUnlocked) return false;
    if (S.activeAchFilter === "hidden" && !a.hidden) return false;

    // 2. Arama Sorgusu
    if (query) {
      const matchTitle = (a.display_name || a.name).toLowerCase().includes(query);
      const matchDesc = (a.description || "").toLowerCase().includes(query);
      if (!matchTitle && !matchDesc) return false;
    }

    return true;
  });

  // Sıralama (Sort)
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
    return 0; // varsayılan katalog sırası
  });

  // PlayStation 4-Seviyeli Kupa Sayımı (Trophy Breakdown)
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

  // Sayaçlar (Status Chips için)
  const scopedAll = data.achievements;
  const scopedUnlocked = isDemo ? scopedAll.length : scopedAll.filter((a) => a.unlocked).length;
  const scopedLocked = scopedAll.length - scopedUnlocked;
  const scopedHidden = scopedAll.filter((a) => a.hidden).length;

  return `
    <!-- 1. PS5 Kompakt Başarım Özet Çubuğu -->
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
          <span class="ach-summary-sub">${isPlat ? "Platin Kupa Tamamlandı!" : `${effectiveXp.toLocaleString()} / ${data.total_xp.toLocaleString()} XP`}</span>
        </div>
      </div>
      <div class="ach-summary-right">
        ${effPlatTotal > 0 ? `<span class="ach-tier-mini plat ${effPlatUnlocked >= effPlatTotal ? "complete" : ""}" title="Platin">${epicPlatinumIcon(11)} ${effPlatUnlocked}/${effPlatTotal}</span>` : ""}
        ${goldTotal > 0 ? `<span class="ach-tier-mini gold ${goldUnlocked >= goldTotal ? "complete" : ""}" title="Altın">${icon("trophy", 11)} ${goldUnlocked}/${goldTotal}</span>` : ""}
        ${silverTotal > 0 ? `<span class="ach-tier-mini silver ${silverUnlocked >= silverTotal ? "complete" : ""}" title="Gümüş">${icon("trophy", 11)} ${silverUnlocked}/${silverTotal}</span>` : ""}
        ${bronzeTotal > 0 ? `<span class="ach-tier-mini bronze ${bronzeUnlocked >= bronzeTotal ? "complete" : ""}" title="Bronz">${icon("trophy", 11)} ${bronzeUnlocked}/${bronzeTotal}</span>` : ""}
        <div class="ach-summary-tools">
          <button class="ach-tool-btn" data-act="ach-refresh" data-id="${s.appName}" title="Verileri Yeniden Sorgula">${icon("refresh", 13)}</button>
          <button class="ach-tool-btn" data-act="open-store-achievements" data-id="${s.appName}" title="Epic Games Store'da Gör">${icon("external", 13)}</button>
        </div>
      </div>
    </div>

    <!-- 2. Arama & Sıralama Barı -->
    <div class="ach-toolbar">
      <!-- Canlı Arama Kutusu -->
      <div class="ach-search-wrap">
        <span class="ach-search-icon">${icon("search", 13)}</span>
        <input type="text" id="ach-search-input" class="ach-search-field" placeholder="Başarım ara..." value="${esc(S.achSearchQuery)}" autocomplete="off" />
        ${S.achSearchQuery ? `<button class="ach-search-clear" data-act="clear-ach-search" title="Aramayı Temizle">${icon("x", 12)}</button>` : ""}
      </div>

      <!-- Sıralama Seçimi -->
      <div class="ach-sort-wrap">
        <select id="ach-sort-select" class="ach-sort-select" title="Sıralama Düzeni">
          <option value="default" ${S.achSortOrder === "default" ? "selected" : ""}>Varsayılan Sıra</option>
          <option value="rarity" ${S.achSortOrder === "rarity" ? "selected" : ""}>Nadirliğe Göre</option>
          <option value="xp" ${S.achSortOrder === "xp" ? "selected" : ""}>XP'ye Göre</option>
          <option value="date" ${S.achSortOrder === "date" ? "selected" : ""}>Kazanılma Tarihine Göre</option>
        </select>
      </div>
    </div>

    <!-- 3. PlayStation Konsol Tarzı Durum Sekmeleri -->
    <div class="ach-status-strip">
      <button class="ach-status-chip ${S.activeAchFilter === "all" ? "active" : ""}" data-act="ach-filter" data-val="all">
        Tümü <span class="ach-chip-num">${scopedAll.length}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "unlocked" ? "active" : ""}" data-act="ach-filter" data-val="unlocked">
        ${icon("check", 11)} Kazanılanlar <span class="ach-chip-num">${scopedUnlocked}</span>
      </button>
      <button class="ach-status-chip ${S.activeAchFilter === "locked" ? "active" : ""}" data-act="ach-filter" data-val="locked">
        ${icon("lock", 11)} Kilitliler <span class="ach-chip-num">${scopedLocked}</span>
      </button>
      ${scopedHidden > 0 ? `
      <button class="ach-status-chip ${S.activeAchFilter === "hidden" ? "active" : ""}" data-act="ach-filter" data-val="hidden">
        ${icon("eye", 11)} Gizli <span class="ach-chip-num">${scopedHidden}</span>
      </button>` : ""}
    </div>

    <!-- 4. Gruplandırılmış Başarım Listesi -->
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
    console.warn("Başarımlar alınamadı veya bu oyun için başarım desteği yok:", e);
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

/* ---------- Sistem Gereksinimleri UI ---------- */

export function renderDrawerSystemRequirements(s: EpicSummary): string {
  if (S.loadingReqFor === s.appName) {
    return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:50px 20px;gap:12px;color:var(--muted)">
        <div class="spinner"></div>
        <div style="font-size:13px;font-weight:600">Epic Games Store sistem gereksinimleri alınıyor…</div>
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
        <div style="font-size:13px;font-weight:600">Sistem gereksinimleri alınıyor…</div>
      </div>`;
  }

  if (!data.supported || data.systems.length === 0) {
    return `
      <div style="text-align:center;padding:36px 18px;background:rgba(0,0,0,0.2);border:1px dashed var(--border);border-radius:12px">
        <div style="color:var(--muted);margin-bottom:10px">${icon("cpu", 36)}</div>
        <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:6px">Gereksinim Tablosu Bulunamadı</div>
        <div style="font-size:12px;color:var(--muted);max-width:320px;margin:0 auto 16px;line-height:1.5">Bu oyun için Epic Games Store üzerinde doğrudan donanım tablosu tanımlanmamış olabilir.</div>
        <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap">
          <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} Tekrar Dene</button>
          <button class="btn play small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} Mağaza Sayfası'na Git</button>
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
      return `<div style="font-size:11.5px;color:var(--muted);padding:8px">Gereksinim belirtilmemiş.</div>`;
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
            <span>Desteklenen Diller</span>
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
              ${icon("layers", 13)} Windows (PC)
            </button>
            <button class="sys-req-plat-pill ${isMacSys(currentSys.systemType) ? "active" : ""}" data-act="sys-plat" data-val="Mac">
              ${icon("monitor", 13)} macOS
            </button>
          </div>`
          : ""
      }

      <div class="sys-req-cards-grid">
        <div class="sys-req-card min">
          <div class="sys-req-card-head">
            <div class="sys-req-badge min">${icon("cpu", 12)} Minimum Gereksinimler</div>
            <div class="sys-req-hint">Oyunu açıp oynamak için gereken temel donanım</div>
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
              <div class="sys-req-badge rec">${icon("rocket", 12)} Önerilen Gereksinimler</div>
              <div class="sys-req-hint">Yüksek kare hızı ve akıcı grafik deneyimi için</div>
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
        <button class="btn ghost small" data-act="req-refresh" data-id="${s.appName}">${icon("refresh", 12)} Yeniden Sorgula</button>
        <button class="btn ghost small" data-act="epic-store-page" data-id="${s.appName}">${icon("external", 13)} Epic Mağazası'nda Aç</button>
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

    // Açıklaması olmayan oyunlarda mağaza açıklamasını güncelle
    if (data.shortDescription || data.description) {
      const curSummary = S.epicSummaries.find((x) => x.appName === appName);
      const sDesc = curSummary?.description?.trim();
      const needsDesc = !sDesc || sDesc === "Açıklama yok." || sDesc === curSummary?.title || sDesc.length <= 25;
      if (needsDesc && curSummary) {
        curSummary.description = data.shortDescription || cleanStoreDescription(data.description || "");
      }
    }

    // Modal açıksa ve Genel Bakış (overview) sekmesindeyse, arayüzü DOM üzerinde yerinde güncelle
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
    console.warn("Sistem gereksinimleri alınamadı:", e);
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
    toast("Kurulum klasörü bilinmiyor", "err");
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
