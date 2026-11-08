/**
 * Stage Home: The premier console dashboard.
 *
 * Built around a fluid horizontal game ribbon, a panoramic hero showcase,
 * a dynamic atmospheric backdrop and a slide-down activity shelf.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { fullShotSrc, fetchAndRenderScreenshots } from "../screenshots/screenshots-view";
import { stageCoverMarkup, stageHeroMarkup, stagePrefetch, stageWideArt } from "./stage-art";
import { updateStageBackdrop } from "./stage-backdrop";
import {
  stageAchievements,
  stageGameByKey,
  stageGamePlaytime,
  stageHeroSummary,
  stagePrimaryAction,
  stageRibbonSummaries,
} from "./stage-model";
import { stageFaceGlyph, stageMetaLine, stageProgress, stageStatus, stageStoreName } from "./stage-ui";

function ribbonCard(s: EpicSummary, isDefault = false): string {
  const store = stageStoreName(sourceOfKey(s.appName));
  return `<button type="button" class="stage-ribbon-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="game:${esc(s.appName)}"${isDefault ? " data-gp-default" : ""}>
    <span class="stage-ribbon-art">${stageCoverMarkup(s, "stage-ribbon-image")}</span>
    <span class="stage-ribbon-glow"></span>
    <span class="stage-ribbon-badge">${esc(store)}</span>
    ${stageStatus(s)}
  </button>`;
}

function emptyStage(): string {
  return `<div class="stage-empty">
    <span class="stage-empty-icon">${icon("gamepad-2", 48)}</span>
    <h1>${esc(t("stage.emptyTitle"))}</h1>
    <p>${esc(t("stage.emptyBody"))}</p>
    <div class="stage-empty-actions">
      <button type="button" class="stage-btn stage-btn-primary" data-stage-act="desktop" data-gp-item data-gp-key="empty:desktop">${esc(t("stage.openDesktop"))}</button>
    </div>
  </div>`;
}

export function stageHomeHeroHtml(game: EpicSummary): string {
  const play = stageGamePlaytime(game);
  const store = stageStoreName(sourceOfKey(game.appName));
  const isFav = S.epicFav.has(game.appName);

  return `<div class="stage-home-hero-meta">
    <span class="stage-home-store-chip">${esc(store)}</span>
    <span class="stage-home-meta-line">${stageMetaLine(game, { withStore: false })}</span>
  </div>
  <h1 class="stage-home-hero-title">${esc(game.title)}</h1>
  <div class="stage-home-hero-actions">
    <div class="stage-primary-action">${stagePrimaryAction(game)}</div>
    <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:details">
      ${icon("dots", 18)}<span>${esc(t("stage.details"))}</span>
    </button>
    <button type="button" class="stage-icon-btn${isFav ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:favorite" aria-label="${esc(t("stage.favorite"))}">
      ${icon("heart", 18)}
    </button>
  </div>
  <div class="stage-home-down-hint">
    ${icon("chevron-down", 16)}<span>${esc(t("stage.details"))}</span>
  </div>`;
}

function resumeActivityCard(game: EpicSummary): string {
  const play = stageGamePlaytime(game);
  return `<div class="stage-activity-card stage-act-resume" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:resume">
    <div class="stage-act-media">${stageHeroMarkup(game, "stage-act-bg")}</div>
    <div class="stage-act-scrim"></div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.continue"))}</span>
      <h3 class="stage-act-title">${esc(game.title)}</h3>
      <span class="stage-act-meta">${play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(1) })) : esc(t("playtime.notPlayed"))}</span>
      <div class="stage-act-action">
        <span class="stage-btn stage-btn-sm stage-btn-primary">${icon("play", 14)} <span>${esc(t("stage.open"))}</span></span>
      </div>
    </div>
  </div>`;
}

function achievementsActivityCard(game: EpicSummary): string {
  const ach = stageAchievements(game);
  if (!ach || !ach.supported || ach.total_achievements <= 0) {
    const play = stageGamePlaytime(game);
    return `<div class="stage-activity-card stage-act-stats" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:stats">
      <div class="stage-act-icon-wrap">${icon("clock", 28)}</div>
      <div class="stage-act-body">
        <span class="stage-kicker">${esc(t("stage.playtimeLabel"))}</span>
        <h3 class="stage-act-title">${play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(1) })) : esc(t("playtime.notPlayed"))}</h3>
        <span class="stage-act-meta">${esc(t("stage.sideHint"))}</span>
      </div>
    </div>`;
  }

  const percent = ach.progress_known !== false && ach.total_achievements > 0
    ? Math.round((ach.user_unlocked / ach.total_achievements) * 100)
    : 0;
  const loaded = S.loadedAchievements.get(game.appName);
  const nextLocked = loaded?.achievements.find((item) => !item.unlocked);

  return `<div class="stage-activity-card stage-act-trophies" data-stage-act="open-program" data-key="${esc(game.appName)}" data-tab="achievements" data-gp-item data-gp-key="act:trophies">
    <div class="stage-act-trophy-head">
      <div class="stage-act-icon-wrap">${icon("trophy", 24)}</div>
      <div class="stage-act-trophy-count tabular-nums">${ach.user_unlocked} / ${ach.total_achievements}</div>
    </div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.achievements"))} (${percent}%)</span>
      ${stageProgress(percent, "stage-act-progress")}
      <h3 class="stage-act-title">${esc(nextLocked?.display_name || nextLocked?.name || t("stage.tabAchievements"))}</h3>
      <span class="stage-act-meta">${esc(nextLocked?.description || t("stage.achUnlockedLabel"))}</span>
    </div>
  </div>`;
}

function capturesActivityCard(game: EpicSummary): string {
  const shots = S.loadedScreenshots.get(game.appName) || [];
  const first = shots[0];

  if (!first) {
    return `<div class="stage-activity-card stage-act-info" data-stage-act="open-program" data-key="${esc(game.appName)}" data-tab="extras" data-gp-item data-gp-key="act:extras">
      <div class="stage-act-icon-wrap">${icon("image", 28)}</div>
      <div class="stage-act-body">
        <span class="stage-kicker">${esc(t("stage.stills"))}</span>
        <h3 class="stage-act-title">${esc(t("stage.tabExtras"))}</h3>
        <span class="stage-act-meta">${esc(t("stage.cloudReady"))}</span>
      </div>
    </div>`;
  }

  return `<div class="stage-activity-card stage-act-capture" data-stage-act="open-still" data-key="${esc(game.appName)}" data-index="0" data-gp-item data-gp-key="act:still">
    <div class="stage-act-media"><img src="${esc(fullShotSrc(first))}" alt="" class="stage-act-bg" /></div>
    <div class="stage-act-scrim"></div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.stills"))} (${shots.length})</span>
      <h3 class="stage-act-title">${esc(first.file_name)}</h3>
      <span class="stage-act-meta">${esc(t("stage.stillsNext"))}</span>
    </div>
  </div>`;
}

function detailsActivityCard(game: EpicSummary): string {
  return `<div class="stage-activity-card stage-act-hub" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:hub">
    <div class="stage-act-icon-wrap">${icon("hard-drive", 28)}</div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.installSize"))}</span>
      <h3 class="stage-act-title">${game.installSize > 0 ? esc(fmtBytes(game.installSize)) : "—"}</h3>
      <span class="stage-act-meta">${esc(stageStoreName(sourceOfKey(game.appName)))} · ${esc(t("stage.details"))}</span>
    </div>
  </div>`;
}

export function stageHomeActivitiesHtml(game: EpicSummary): string {
  return `<div class="stage-row-head">
    <h2 class="stage-row-title">${esc(t("stage.details"))}</h2>
    <span class="stage-row-count">${esc(game.title)}</span>
  </div>
  <div class="stage-card-row stage-activity-row" data-gp-row>
    ${resumeActivityCard(game)}
    ${achievementsActivityCard(game)}
    ${capturesActivityCard(game)}
    ${detailsActivityCard(game)}
  </div>`;
}

export function renderStageHome(): string {
  const ribbon = stageRibbonSummaries(24);
  if (ribbon.length === 0) return emptyStage();

  // Selected game on ribbon: active focus or hero default
  const focusKey = S.stage.focusKey;
  const focusedGame = focusKey.startsWith("game:")
    ? stageGameByKey(focusKey.slice(5))
    : undefined;
  const hero = focusedGame ?? stageHeroSummary() ?? ribbon[0];

  // Warm art for backdrop and immediate shelf
  stagePrefetch([stageWideArt(hero), ...ribbon.slice(0, 4).map((s) => stageWideArt(s))], 5);
  updateStageBackdrop(stageWideArt(hero));

  return `<div class="stage-home">
    <!-- Top Horizontal Ribbon: The signature console game strip -->
    <section class="stage-ribbon-section">
      <div class="stage-ribbon-track" data-gp-row>
        <button type="button" class="stage-ribbon-card stage-ribbon-all" data-stage-act="go" data-route="library" data-gp-item data-gp-key="home:all-games" title="${esc(t("stage.navLibrary"))}">
          <span class="stage-ribbon-all-art">${icon("layout-grid", 32)}</span>
          <span class="stage-ribbon-title">${esc(t("stage.navLibrary"))}</span>
        </button>
        ${ribbon.map((s, idx) => ribbonCard(s, idx === 0)).join("")}
      </div>
    </section>

    <!-- Panoramic Hero Showcase -->
    <section id="stage-home-hero" class="stage-home-hero">
      ${stageHomeHeroHtml(hero)}
    </section>

    <!-- Activity & Details Shelf -->
    <section id="stage-home-activities" class="stage-home-activities">
      ${stageHomeActivitiesHtml(hero)}
    </section>
  </div>`;
}

/** In-place focus patch for Home: switches hero, backdrop and activities without full rebuild. */
export function stageHomeFocus(key: string): void {
  if (!key.startsWith("game:")) return;
  const appName = key.slice(5);
  const game = stageGameByKey(appName);
  if (!game) return;

  // 1. Crossfade backdrop
  updateStageBackdrop(stageWideArt(game));

  // 2. Patch Hero Showcase in place
  const heroEl = document.getElementById("stage-home-hero");
  if (heroEl) {
    heroEl.innerHTML = stageHomeHeroHtml(game);
    heroEl.querySelectorAll<HTMLElement>("button").forEach((btn) => btn.setAttribute("data-gp-item", ""));
  }

  // 3. Patch Activity Shelf in place
  const actEl = document.getElementById("stage-home-activities");
  if (actEl) {
    actEl.innerHTML = stageHomeActivitiesHtml(game);
    actEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((el) => el.setAttribute("data-gp-item", ""));
  }

  // 4. Background warm metadata
  if (!S.loadedAchievements.has(game.appName)) {
    void fetchAndRenderAchievements(game.appName);
  }
  if (!S.loadedScreenshots.has(game.appName)) {
    void fetchAndRenderScreenshots(game.appName, game.title);
  }
}
