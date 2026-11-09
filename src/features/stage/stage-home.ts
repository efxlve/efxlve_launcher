/**
 * Stage Home: the first screen of the controller shell.
 *
 * One full-bleed game stage, a labelled 16:9 ribbon above it, and a
 * second-floor activity hub with resume, achievements, stills, install details
 * and collections. Focus swaps the stage in place instead of rebuilding it.
 */

import { collectionGameCount } from "../../core/game-collections";
import { epicDlProgress } from "../../core/game-view";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary, GameCollection } from "../../epic";
import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { fetchAndRenderScreenshots, shotThumbHtml } from "../screenshots/screenshots-view";
import { stageCoverMarkup, stageHeroMarkup, stagePrefetch, stageWideArt } from "./stage-art";
import { updateStageBackdrop } from "./stage-backdrop";
import {
  stageAchievements,
  stageCollectionCoverKeys,
  stageGameByKey,
  stageGamePlaytime,
  stageHeroSummary,
  stagePrimaryAction,
  stageRibbonSummaries,
  stageUserCollections,
} from "./stage-model";
import { stageMetaLine, stageProgress, stageStoreName } from "./stage-ui";

function ribbonCard(s: EpicSummary, isDefault = false): string {
  const hasDl = epicDlProgress(s.appName) !== null;
  const isUpdating = s.updateAvailable && !S.ignoredUpdates.has(s.appName);
  return `<button type="button" class="stage-ribbon-card" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="game:${esc(s.appName)}"${isDefault ? " data-gp-default" : ""} aria-label="${esc(s.title)}">
    <span class="stage-ribbon-art">${stageHeroMarkup(s, "stage-ribbon-image")}</span>
    ${hasDl || isUpdating ? `<span class="stage-ribbon-indicator"></span>` : ""}
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
  const store = stageStoreName(sourceOfKey(game.appName));
  const isFav = S.epicFav.has(game.appName);

  return `<div class="stage-home-copy">
    <div class="stage-home-eyebrow">
      <span class="stage-hero-store">${esc(store)}</span>
      <span class="stage-home-meta">${stageMetaLine(game, { withStore: false })}</span>
    </div>
    <h1 class="stage-home-title">${esc(game.title)}</h1>
    <div class="stage-home-actions">
      <div class="stage-primary-action">${stagePrimaryAction(game)}</div>
      <button type="button" class="stage-home-more" data-stage-act="scroll-to-hub" data-gp-skip aria-label="${esc(t("stage.details"))}">
        <span>${esc(t("stage.details"))}</span>${icon("chevron-down", 15)}
      </button>
    </div>
  </div>
  <div class="stage-home-side">
    <div class="stage-home-utility">
      <button type="button" class="stage-hero-btn" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:manage" aria-label="${esc(t("stage.manage"))}">
        ${icon("dots", 20)}
      </button>
      <button type="button" class="stage-hero-btn${isFav ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:favorite" aria-label="${esc(t("stage.favorite"))}">
        ${icon("heart", 20)}
      </button>
    </div>
  </div>`;
}

function resumeActivityCard(game: EpicSummary): string {
  const play = stageGamePlaytime(game);
  return `<button type="button" class="stage-activity-card stage-act-resume" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:resume">
    <div class="stage-act-media">${stageHeroMarkup(game, "stage-act-bg")}</div>
    <div class="stage-act-scrim"></div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.continue"))}</span>
      <h3 class="stage-act-title">${esc(game.title)}</h3>
      <span class="stage-act-meta">${play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(1) })) : esc(t("playtime.notPlayed"))}</span>
    </div>
    <div class="stage-act-foot">
      <span class="stage-act-pill">${icon("play", 14)} <span>${esc(t("stage.open"))}</span></span>
    </div>
  </button>`;
}

function achievementsActivityCard(game: EpicSummary): string {
  const ach = stageAchievements(game);
  if (!ach || !ach.supported || ach.total_achievements <= 0) {
    const play = stageGamePlaytime(game);
    return `<button type="button" class="stage-activity-card stage-act-stats" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:achievements">
      <div class="stage-act-icon-wrap">${icon("clock", 26)}</div>
      <div class="stage-act-body">
        <span class="stage-kicker">${esc(t("stage.playtimeLabel"))}</span>
        <h3 class="stage-act-title">${play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(1) })) : esc(t("playtime.notPlayed"))}</h3>
        <span class="stage-act-meta">${esc(t("stage.sideHint"))}</span>
      </div>
    </button>`;
  }

  const percent = ach.progress_known !== false && ach.total_achievements > 0
    ? Math.round((ach.user_unlocked / ach.total_achievements) * 100)
    : 0;
  const loaded = S.loadedAchievements.get(game.appName);
  const nextLocked = loaded?.achievements.find((item) => !item.unlocked);

  return `<button type="button" class="stage-activity-card stage-act-trophies" data-stage-act="open-program" data-key="${esc(game.appName)}" data-tab="achievements" data-gp-item data-gp-key="act:achievements">
    <div class="stage-act-trophy-head">
      <div class="stage-act-icon-wrap">${icon("trophy", 22)}</div>
      <div class="stage-act-trophy-count tabular-nums">${ach.user_unlocked} / ${ach.total_achievements}</div>
    </div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.achievements"))} (${percent}%)</span>
      ${stageProgress(percent, "stage-act-progress")}
      <h3 class="stage-act-title">${esc(nextLocked?.display_name || nextLocked?.name || t("stage.tabAchievements"))}</h3>
      <span class="stage-act-meta">${esc(nextLocked?.description || t("stage.achUnlockedLabel"))}</span>
    </div>
  </button>`;
}

function capturesActivityCard(game: EpicSummary): string {
  const shots = S.loadedScreenshots.get(game.appName) || [];
  const first = shots[0];

  if (!first) {
    return `<button type="button" class="stage-activity-card stage-act-info" data-stage-act="open-program" data-key="${esc(game.appName)}" data-tab="extras" data-gp-item data-gp-key="act:captures">
      <div class="stage-act-icon-wrap">${icon("image", 26)}</div>
      <div class="stage-act-body">
        <span class="stage-kicker">${esc(t("stage.stills"))}</span>
        <h3 class="stage-act-title">${esc(t("stage.tabExtras"))}</h3>
        <span class="stage-act-meta">${esc(t("stage.cloudReady"))}</span>
      </div>
    </button>`;
  }

  return `<button type="button" class="stage-activity-card stage-act-capture" data-stage-act="open-still" data-key="${esc(game.appName)}" data-index="0" data-gp-item data-gp-key="act:captures">
    <div class="stage-act-media">${shotThumbHtml(first)}</div>
    <div class="stage-act-scrim"></div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.stills"))} (${shots.length})</span>
      <h3 class="stage-act-title">${esc(first.file_name)}</h3>
      <span class="stage-act-meta">${esc(t("stage.stillsNext"))}</span>
    </div>
  </button>`;
}

function detailsActivityCard(game: EpicSummary): string {
  return `<button type="button" class="stage-activity-card stage-act-hub" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:hub">
    <div class="stage-act-icon-wrap">${icon("hard-drive", 26)}</div>
    <div class="stage-act-body">
      <span class="stage-kicker">${esc(t("stage.installSize"))}</span>
      <h3 class="stage-act-title">${game.installSize > 0 ? esc(fmtBytes(game.installSize)) : "—"}</h3>
      <span class="stage-act-meta">${esc(stageStoreName(sourceOfKey(game.appName)))} · ${esc(t("stage.details"))}</span>
    </div>
  </button>`;
}

function collectionCard(collection: GameCollection): string {
  const summaries = stageCollectionCoverKeys(collection)
    .map((key) => stageGameByKey(key))
    .filter((summary): summary is EpicSummary => Boolean(summary));
  const covers = summaries
    .slice(0, 4)
    .map((summary) => `<span class="stage-collection-cover">${stageCoverMarkup(summary, "stage-cover-art", true)}</span>`)
    .join("");
  return `<button type="button" class="stage-collection-card" data-stage-act="open-collection" data-id="${esc(collection.id)}" data-gp-item data-gp-key="collection:${esc(collection.id)}">
    <span class="stage-collection-mosaic stage-collection-mosaic-${Math.max(1, Math.min(4, summaries.length))}">${covers || `<span class="stage-collection-empty">${icon("layers", 22)}</span>`}</span>
    <span class="stage-collection-copy">
      <strong>${esc(collection.name)}</strong>
      <small>${esc(t("stage.collectionCount", { n: collectionGameCount(collection) }))}</small>
    </span>
  </button>`;
}

function collectionsRow(): string {
  const collections = stageUserCollections();
  if (collections.length === 0) return "";
  return `<div class="stage-collection-section">
    <div class="stage-shelf-header">
      <h2 class="stage-shelf-title">${esc(t("stage.collections"))}</h2>
      <span class="stage-shelf-subtitle">${collections.length}</span>
    </div>
    <div class="stage-card-row stage-collection-row" data-gp-row>
      ${collections.map(collectionCard).join("")}
    </div>
  </div>`;
}

export function stageHomeActivitiesHtml(game: EpicSummary): string {
  return `<div class="stage-shelf-header">
    <h2 class="stage-shelf-title">${esc(t("stage.details"))}</h2>
    <span class="stage-shelf-subtitle">${esc(game.title)}</span>
  </div>
  <div class="stage-card-row stage-activity-row" data-gp-row>
    ${resumeActivityCard(game)}
    ${achievementsActivityCard(game)}
    ${capturesActivityCard(game)}
    ${detailsActivityCard(game)}
  </div>
  ${collectionsRow()}`;
}

export function renderStageHome(): string {
  const ribbon = stageRibbonSummaries(24);
  if (ribbon.length === 0) return emptyStage();

  const focusKey = S.stage.focusKey;
  const focusedGame = focusKey.startsWith("game:")
    ? stageGameByKey(focusKey.slice(5))
    : undefined;
  const remembered = S.stage.homeHeroKey ? stageGameByKey(S.stage.homeHeroKey) : undefined;
  const hero = focusedGame ?? remembered ?? stageHeroSummary() ?? ribbon[0];
  if (hero) S.stage.homeHeroKey = hero.appName;

  stagePrefetch([stageWideArt(hero), ...ribbon.slice(0, 4).map((s) => stageWideArt(s))], 5);
  updateStageBackdrop(stageWideArt(hero));

  return `<div class="stage-home">
    <section class="stage-home-stage">
      <div id="stage-home-art" class="stage-home-art">${stageHeroMarkup(hero, "stage-home-art-image")}</div>
      <div class="stage-home-scrim"></div>

      <div class="stage-home-ribbon">
        <div class="stage-ribbon-track" data-gp-row>
          <button type="button" class="stage-ribbon-card stage-ribbon-library" data-stage-act="go" data-route="library" data-gp-item data-gp-key="home:all-games" aria-label="${esc(t("stage.navLibrary"))}">
            <span class="stage-ribbon-library-icon">${icon("layout-grid", 26)}</span>
            <span class="stage-ribbon-label">${esc(t("stage.navLibrary"))}</span>
          </button>
          ${ribbon.map((s, idx) => ribbonCard(s, idx === 0)).join("")}
        </div>
      </div>

      <div id="stage-home-hero" class="stage-home-hero stage-hero-animated" data-key="${esc(hero.appName)}">
        ${stageHomeHeroHtml(hero)}
      </div>
    </section>

    <section id="stage-home-activities" class="stage-home-hub">
      ${stageHomeActivitiesHtml(hero)}
    </section>
  </div>`;
}

/** In-place focus patch for Home: switches hero, backdrop and activities without full rebuild. */
let warmTimer = 0;

export function stageHomeFocus(key: string): void {
  if (!key.startsWith("game:")) return;
  const appName = key.slice(5);
  const game = stageGameByKey(appName);
  if (!game) return;
  S.stage.homeHeroKey = game.appName;

  // 1. Crossfade backdrop
  updateStageBackdrop(stageWideArt(game));

  // 2. Patch the art and hero copy in place. The first focus lands on the
  // already-rendered hero, so skip the identical rebuild.
  const heroEl = document.getElementById("stage-home-hero");
  const heroChanged = heroEl?.dataset.key !== game.appName;
  if (heroChanged) {
    const artEl = document.getElementById("stage-home-art");
    if (artEl) artEl.innerHTML = stageHeroMarkup(game, "stage-home-art-image");
    if (heroEl) {
      heroEl.dataset.key = game.appName;
      heroEl.innerHTML = stageHomeHeroHtml(game);
      heroEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((btn) => {
        if (!btn.closest("[data-gp-skip]")) btn.setAttribute("data-gp-item", "");
      });
      heroEl.classList.remove("stage-hero-animated");
      void heroEl.offsetWidth;
      heroEl.classList.add("stage-hero-animated");
    }

    // 3. Patch Activity Shelf in place
    const actEl = document.getElementById("stage-home-activities");
    if (actEl) {
      actEl.innerHTML = stageHomeActivitiesHtml(game);
      actEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((el) => el.setAttribute("data-gp-item", ""));
    }
  }

  // 4. Warm the activity cards only after the focus settles: sweeping across
  // the ribbon must not fire a store request for every card it passes.
  window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => {
    if (!S.stage.active || S.stage.route !== "home") return;
    const current = S.stage.homeHeroKey ? stageGameByKey(S.stage.homeHeroKey) : undefined;
    if (!current || current.appName !== game.appName) return;
    if (!S.loadedAchievements.has(game.appName)) {
      void fetchAndRenderAchievements(game.appName).then(() => {
        if (S.stage.active && S.stage.route === "home") scheduleRender();
      });
    }
    if (!S.loadedScreenshots.has(game.appName)) {
      void fetchAndRenderScreenshots(game.appName, game.title);
    }
  }, 320);
}
