/**
 * Overlay Home dashboard: the in-game overview cards and the launcher-mode
 * dashboard.
 *
 * One-way dependency: the page configures context, widget queries and the
 * media helpers through configureHome; this module never imports overlay.ts.
 */

import { OVERLAY_HUD_KEY } from "../../core/constants";
import { IS_WINDOWS } from "../../core/platform";
import { icon } from "../../core/icons";
import { esc, fmtDecimal1 } from "../../core/utils";
import { t } from "../../i18n";
import {
  achievementRarity,
  achievementStats,
  isAchievementUnlocked,
  nextAchievements,
} from "../../core/achievements";
import { achievementData, achMasked } from "./overlay-achievements";
import { screenshotItems } from "./overlay-screenshots";
import {
  drawPerfCanvas,
  fmtMb,
  fpsNoticeHtml,
  metricsSample,
  perfCanvasHtml,
  updatePerfEmptyStates,
} from "./overlay-performance";

interface HomeContext {
  appName: string;
  title: string;
}

interface HomeMedia {
  isSpotify: boolean;
}

interface HomeDeps {
  context: () => HomeContext;
  launcherMode: () => boolean;
  activeTab: () => string;
  viewEl: () => HTMLElement | null;
  splitKey: (key: string) => { store: string; id: string };
  storeLabel: (store: string) => string;
  media: () => HomeMedia;
  mediaTitleHtml: () => string;
  mediaInnerHtml: () => string;
}

let deps: HomeDeps | null = null;

export function configureHome(next: HomeDeps): void {
  deps = next;
}

function D(): HomeDeps {
  if (!deps) throw new Error("overlay home rendered before configuration");
  return deps;
}

/* 1. Home / Overview Modular Dashboard */
// The Performance view lives in overlay-performance.ts; Home reads the same
// metrics sample and canvas helpers from there.

export function renderHome(): void {
  const el = D().viewEl();
  if (!el) return;
  if (D().launcherMode()) {
    renderHomeLauncher(el);
    return;
  }
  const { store } = D().splitKey(D().context().appName);
  const m = metricsSample();
  const currentFps = m?.fps != null ? Math.round(m.fps) : "—";
  const hudActive = localStorage.getItem(OVERLAY_HUD_KEY) === "true";

  // Achievements preview: the next targets, not the first two rows of the
  // store's list. A completed set falls back to two earned rows.
  const achData = achievementData();
  const achStats = achData ? achievementStats(achData.achievements) : null;
  const achUnlocked = achStats?.unlocked ?? achData?.user_unlocked ?? 0;
  const achTotal = achStats?.total ?? achData?.total_achievements ?? achData?.achievements?.length ?? 0;
  const achPct = achTotal > 0 ? Math.round((achUnlocked / achTotal) * 100) : 0;
  const nextAchs = achData ? nextAchievements(achData.achievements, 2) : [];
  const earnedPreview = achData?.achievements.filter(isAchievementUnlocked).slice(0, 2) ?? [];
  const visiblePreview = achData?.achievements.filter((item) => !achMasked(item)).slice(0, 2) ?? [];
  const previewAchs = nextAchs.length > 0
    ? nextAchs
    : earnedPreview.length > 0
      ? earnedPreview
      : visiblePreview;

  // Screenshots preview
  const shotsPreview = screenshotItems().slice(0, 4);

  el.innerHTML = `
    <div class="ov-dashboard">
      <!-- Session Hero Banner -->
      <div class="ov-card ov-span-12 ov-hero-card">
        <div class="ov-hero-banner">
          <div class="ov-hero-info">
            <div class="ov-hero-game">${esc(D().context().title || D().context().appName || "Game")}</div>
            <div class="ov-hero-status">
              <span class="ov-badge-pill">${esc(D().storeLabel(store))}</span>
              <span>·</span>
              <span style="color:var(--ok)">● ${esc(t("overlay.running"))}</span>
            </div>
          </div>
          <div class="ov-hero-actions">
            <button class="btn ghost small" data-ov="browser-open">${icon("globe", 14)} <span>${esc(t("overlay.tabBrowser"))}</span></button>
            <button class="btn ghost small" data-ov="launcher">${icon("external", 14)} <span>${esc(t("overlay.openLauncher"))}</span></button>
          </div>
        </div>
      </div>

      <!-- Live Performance Card -->
      <div class="ov-card ov-span-6" data-nav-target="perf">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("cpu", 14)} <span class="title-text">${esc(t("overlay.tabPerformance"))}</span></div>
          <button class="ov-card-action" data-ov-tab="perf">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-perf-hero">
          <span class="ov-perf-val${m?.fps != null ? "" : " is-empty"}" id="ov-home-fps">${currentFps}</span>
          <span class="ov-perf-unit">FPS</span>
          <span class="ov-perf-frame${m?.frameMs != null ? "" : " is-empty"}" id="ov-home-frame">${m?.frameMs != null ? `${m.frameMs.toFixed(1)} ms` : ""}</span>
        </div>
        ${perfCanvasHtml("ov-home-perf-canvas", ' style="height:68px"')}
        <div class="ov-metrics-mini">
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.cpu"))}</span>
            <span class="ov-metric-num${m ? "" : " is-empty"}" id="ov-home-cpu">${m ? `${Math.round(m.gameCpu ?? m.cpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.gpu"))}</span>
            <span class="ov-metric-num${m?.gpu != null ? "" : " is-empty"}" id="ov-home-gpu">${m?.gpu != null ? `${Math.round(m.gpu)}%` : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">${esc(t("overlay.ram"))}</span>
            <span class="ov-metric-num${m ? "" : " is-empty"}" id="ov-home-ram">${m ? fmtMb(m.ramUsedMb) : "—"}</span>
          </div>
          <div class="ov-metric-pill">
            <span class="ov-metric-label">HUD</span>
            <span class="ov-metric-num" style="display:flex;align-items:center;height:100%">
              <label class="switch" style="transform:scale(0.8)"><input type="checkbox" data-ov-toggle="hud" ${hudActive ? "checked" : ""} /><span class="track"></span></label>
            </span>
          </div>
        </div>
        ${fpsNoticeHtml(m)}
      </div>

      <!-- In-Game Web Browser Quick Launch Card -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("globe", 14)} <span class="title-text">${esc(t("overlay.tabBrowser"))}</span></div>
          <button class="ov-card-action" data-ov-tab="browser">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-home-browser-bar">
          <input id="ov-home-browser-input" class="input ov-home-browser-input" placeholder="${esc(t("overlay.browserAddress"))}" spellcheck="false" />
          <button class="btn primary small" data-ov="home-browser-go" title="${esc(t("overlay.tabBrowser"))}">${icon("chevron-right", 14)}</button>
        </div>
        <div class="ov-home-browser-chips">
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.google.com">${icon("search", 12)} <span>Google</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.youtube.com">${icon("play", 12)} <span>YouTube</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.fandom.com">${icon("gamepad-2", 12)} <span>Wiki</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.reddit.com/r/gaming">${icon("globe", 12)} <span>Reddit</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://discord.com/app">${icon("discord", 12)} <span>Discord</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://steamcommunity.com">${icon("users", 12)} <span>Steam</span></button>
        </div>
        <button class="btn ghost small full" data-ov="browser-open">
          ${icon("external", 13)} <span>${esc(t("overlay.tabBrowser"))}</span>
        </button>
      </div>

      <!-- Media Player Card (Spotify playback is Windows-only) -->
      ${IS_WINDOWS ? `<div class="ov-card ov-span-6 ov-media-card">
        <div class="ov-card-head">
          <div class="ov-card-title" id="ov-media-card-title" data-kind="${D().media().isSpotify ? "spotify" : "media"}">${D().mediaTitleHtml()}</div>
          <button class="ov-card-action" data-ov-tab="music">${icon("chevron-right", 16)}</button>
        </div>
        ${D().mediaInnerHtml()}
      </div>` : ""}

      <!-- Achievements Card -->
      <div class="ov-card ov-span-6" data-nav-target="ach">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("trophy", 14)} <span class="title-text">${esc(t("overlay.tabAchievements"))}</span></div>
          <button class="ov-card-action" data-ov-tab="ach">${achTotal > 0 ? `${achUnlocked}/${achTotal}` : ""} ${icon("chevron-right", 16)}</button>
        </div>
        ${achTotal > 0 ? `
          <div class="ov-ach-summary">
            <div class="ov-ach-bar"><span style="width:${achPct}%"></span></div>
            <span class="ov-ach-pct">%${achPct}</span>
          </div>
          <div class="ov-ach-mini-list">
            ${previewAchs.map((item) => {
              const unlocked = isAchievementUnlocked(item);
              const masked = achMasked(item);
              const rarity = achievementRarity(item);
              return `
              <button type="button" class="ov-ach-item${unlocked ? " unlocked" : ""}" data-ov="ach-open" data-ach="${esc(item.name)}" data-nav-row>
                ${item.icon_link && !masked ? `<img class="ov-ach-thumb" src="${esc(item.icon_link)}" alt="" />` : `<span class="ov-ach-thumb">${masked ? icon("lock", 12) : ""}</span>`}
                <div class="ov-ach-meta">
                  <div class="ov-ach-name">${esc(masked ? t("ach.hiddenName") : item.display_name || item.name)}</div>
                  <div class="ov-ach-desc">${esc(masked ? t("ach.hiddenDesc") : item.description || "")}</div>
                </div>
                ${rarity != null ? `<span class="ov-ach-rarity tabular-nums">%${fmtDecimal1(rarity)}</span>` : ""}
                ${unlocked ? `<span style="color:var(--ok)">${icon("check", 14)}</span>` : ""}
              </button>`;
            }).join("")}
          </div>` : `
          <div class="ov-empty" style="padding:16px 0">${esc(t("overlay.noAchievements"))}</div>`}
      </div>

      <!-- Quick Notes Card -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("edit", 14)} <span class="title-text">${esc(t("overlay.tabNotes"))}</span></div>
          <button class="ov-card-action" data-ov-tab="notes">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-note">${esc(t("overlay.notesHint"))}</div>
      </div>

      <!-- Recent Screenshots Strip (shown if screenshots exist) -->
      ${shotsPreview.length > 0 ? `
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("camera", 14)} <span class="title-text">${esc(t("overlay.tabScreenshots"))}</span></div>
          <button class="ov-card-action" data-ov-tab="shots">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-shots-grid" style="grid-template-columns:repeat(4, 1fr);gap:8px">
          ${shotsPreview.map((s) => `
            <div class="ov-shot-item" data-ov-preview="${esc(s.data_url)}" title="${esc(s.date_str)}">
              <img src="${esc(s.data_url)}" alt="" loading="lazy" />
            </div>`).join("")}
        </div>
      </div>` : ""}
    </div>`;

  drawPerfCanvas();
  updatePerfEmptyStates();
}

/** Re-renders home only when it is the visible tab and nothing is being typed. */
export function renderHomeSafe(): void {
  if (D().activeTab() !== "home") return;
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
  renderHome();
}

/** Home while the overlay runs without a game: launcher actions + media + browser. */
function renderHomeLauncher(el: HTMLElement): void {
  el.innerHTML = `
    <div class="ov-dashboard">
      <div class="ov-card ov-span-12 ov-launcher-hero">
        <div class="ov-launcher-mark">${icon("layers", 28)}</div>
        <div class="ov-launcher-meta">
          <div class="ov-launcher-title">${esc(t("overlay.D().launcherMode()Title"))}</div>
          <div class="ov-launcher-desc">${esc(t("overlay.D().launcherMode()Desc"))}</div>
        </div>
        <div class="ov-launcher-actions">
          <button class="btn" data-ov="launcher">${icon("external", 14)} ${esc(t("overlay.openLauncher"))}</button>
          <button class="btn ghost" data-ov="browser-open">${icon("globe", 14)} ${esc(t("overlay.tabBrowser"))}</button>
          ${IS_WINDOWS ? `<button class="btn ghost" data-ov-tab="music">${icon("spotify", 14)} ${esc(t("overlay.tabSpotify"))}</button>` : ""}
        </div>
      </div>

      ${IS_WINDOWS ? `<div class="ov-card ov-span-6 ov-media-card">
        <div class="ov-card-head">
          <div class="ov-card-title" id="ov-media-card-title" data-kind="${D().media().isSpotify ? "spotify" : "media"}">${D().mediaTitleHtml()}</div>
          <button class="ov-card-action" data-ov-tab="music">${icon("chevron-right", 16)}</button>
        </div>
        ${D().mediaInnerHtml()}
      </div>` : ""}

      <!-- Quick Browser Card in Launcher Mode -->
      <div class="ov-card ov-span-6">
        <div class="ov-card-head">
          <div class="ov-card-title">${icon("globe", 14)} <span class="title-text">${esc(t("overlay.tabBrowser"))}</span></div>
          <button class="ov-card-action" data-ov-tab="browser">${icon("chevron-right", 16)}</button>
        </div>
        <div class="ov-home-browser-bar">
          <input id="ov-home-browser-input" class="input ov-home-browser-input" placeholder="${esc(t("overlay.browserAddress"))}" spellcheck="false" />
          <button class="btn primary small" data-ov="home-browser-go" title="${esc(t("overlay.tabBrowser"))}">${icon("chevron-right", 14)}</button>
        </div>
        <div class="ov-home-browser-chips">
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.google.com">${icon("search", 12)} <span>Google</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.youtube.com">${icon("play", 12)} <span>YouTube</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://www.reddit.com/r/gaming">${icon("globe", 12)} <span>Reddit</span></button>
          <button class="ov-chip-btn" data-ov="browser-open" data-url="https://discord.com/app">${icon("discord", 12)} <span>Discord</span></button>
        </div>
        <button class="btn ghost small full" data-ov="browser-open">
          ${icon("external", 13)} <span>${esc(t("overlay.tabBrowser"))}</span>
        </button>
      </div>
    </div>`;
}

