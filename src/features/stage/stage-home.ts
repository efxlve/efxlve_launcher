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
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtPlaytime, relativeTime } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary, GameCollection } from "../../epic";
import { fetchAndRenderAchievements } from "../drawer/drawer-view";
import { fetchAndRenderScreenshots, shotThumbHtml } from "../screenshots/screenshots-view";
import { stageCoverMarkup, stageHeroMarkup, stagePrefetch, stageWideArt } from "./stage-art";
import { swapStageArt } from "./stage-art-swap";
import { updateStageBackdrop } from "./stage-backdrop";
import { stageIdleGreeting } from "./stage-idle";
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
import { stageMetaLine, stageControllerChip, stageProgress, stageStoreName } from "./stage-ui";

function ribbonCard(s: EpicSummary, isDefault = false): string {
  const isRunning = S.runningGames.has(s.appName);
  const hasDl = epicDlProgress(s.appName) !== null;
  const isUpdating = s.updateAvailable && !S.ignoredUpdates.has(s.appName);
  return `<button type="button" class="stage-ribbon-card${isRunning ? " is-running" : ""}" data-stage-act="open-program" data-key="${esc(s.appName)}" data-gp-item data-gp-key="game:${esc(s.appName)}"${isDefault ? " data-gp-default" : ""} aria-label="${esc(s.title)}">
    <span class="stage-ribbon-art">${stageCoverMarkup(s, "stage-ribbon-image")}</span>
    ${isRunning ? `<span class="stage-ribbon-running"></span>` : hasDl || isUpdating ? `<span class="stage-ribbon-indicator"></span>` : ""}
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

function welcomeBackBannerHtml(): string {
  const sess = S.stage.lastSession;
  if (!sess || Date.now() - sess.timestamp > 10 * 60 * 1000) return "";
  const timeText = fmtPlaytime(sess.seconds);
  const summaryText = t("stage.sessionSummary", { title: sess.title, time: timeText });
  const achCount = sess.achUnlocked && sess.achUnlocked > 0 ? sess.achUnlocked : 0;
  const achText = achCount > 0
    ? ` · ${icon("trophy", 13)} ${achCount} ${esc(t("stage.achievements"))}`
    : "";
  return `<div class="stage-welcome-banner" data-gp-row>
    <div class="stage-welcome-glow"></div>
    <div class="stage-welcome-icon">${icon("sparkles", 18)}</div>
    <div class="stage-welcome-content">
      <span class="stage-welcome-title">${esc(t("stage.welcomeBack"))}</span>
      <span class="stage-welcome-desc">${esc(summaryText)}${achText}</span>
    </div>
    <button type="button" class="stage-welcome-dismiss" data-stage-act="dismiss-welcome" data-gp-item data-gp-key="welcome:dismiss" aria-label="${esc(t("common.close"))}">
      ${icon("x", 14)}
    </button>
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
      <button type="button" class="stage-home-more" data-stage-act="scroll-to-hub" data-gp-key="hero:details" aria-label="${esc(t("stage.details"))}">
        <span>${esc(t("stage.details"))}</span>${icon("chevron-down", 15)}
      </button>
      <div class="stage-actions-divider" aria-hidden="true"></div>
      <div class="stage-home-utility">
        <button type="button" class="stage-hero-btn" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:manage" aria-label="${esc(t("stage.manage"))}">
          ${icon("dots", 18)}
        </button>
        <button type="button" class="stage-hero-btn${isFav ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="hero:favorite" aria-label="${esc(t("stage.favorite"))}">
          ${icon("heart", 18)}
        </button>
      </div>
    </div>
  </div>`;
}

function resumeActivityCard(game: EpicSummary): string {
  const isRunning = S.runningGames.has(game.appName);
  const play = stageGamePlaytime(game);
  return `<button type="button" class="stage-activity-card stage-act-resume${isRunning ? " is-running" : ""}" data-stage-act="open-program" data-key="${esc(game.appName)}" data-gp-item data-gp-key="act:resume">
    <div class="stage-act-media">${stageHeroMarkup(game, "stage-act-bg")}</div>
    <div class="stage-act-scrim"></div>
    <div class="stage-act-body">
      <span class="stage-kicker${isRunning ? " is-running" : ""}">${isRunning ? `<span class="stage-dot-pulse"></span>${esc(t("common.playing"))}` : esc(t("stage.continue"))}</span>
      <h3 class="stage-act-title">${esc(game.title)}</h3>
      <span class="stage-act-meta">${play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(1) })) : esc(t("playtime.notPlayed"))}</span>
    </div>
    <div class="stage-act-foot">
      <span class="stage-act-pill">${icon("play", 14)} <span>${esc(isRunning ? t("stage.continue") : t("stage.open"))}</span></span>
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
        <span class="stage-act-meta">${esc(play.lastPlayed > 0 ? relativeTime(play.lastPlayed) : t("playtime.notPlayed"))}</span>
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
      <h3 class="stage-act-title">${percent === 100 ? `${icon("trophy", 15)} ${esc(t("stage.achUnlockedLabel"))}` : esc(nextLocked?.display_name || nextLocked?.name || t("stage.tabAchievements"))}</h3>
      <span class="stage-act-meta">${esc(percent === 100 ? ach.total_achievements + " / " + ach.total_achievements : (nextLocked?.description || t("stage.achUnlockedLabel")))}</span>
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
        <h3 class="stage-act-title">${esc(t("stage.stills"))}</h3>
        <span class="stage-act-meta">${esc(t("stage.noScreenshots"))}</span>
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
      <span class="stage-act-meta">${esc(game.installed ? t("stage.installed") : t("stage.notInstalled"))} · ${esc(stageStoreName(sourceOfKey(game.appName)))}</span>
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
      <span class="stage-stat">${icon("layers", 13)}<span>${esc(t("stage.collections"))}</span><b class="tabular-nums">${collections.length}</b></span>
    </div>
    <div class="stage-card-row stage-collection-row" data-gp-row>
      ${collections.map(collectionCard).join("")}
    </div>
  </div>`;
}

export function stageHomeActivitiesHtml(game: EpicSummary): string {
  return `<div class="stage-shelf-header">
    <h2 class="stage-shelf-title">${esc(t("stage.details"))}</h2>
    <span class="stage-stat">${icon("gamepad-2", 13)}<span>${esc(game.title)}</span></span>
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
  // Only the explicit display name is shown; an account e-mail is not a
  // greeting.
  const profileName = S.customProfileName.trim();

  const focusKey = S.stage.focusKey;
  const focusedGame = focusKey.startsWith("game:")
    ? stageGameByKey(focusKey.slice(5))
    : undefined;
  const remembered = S.stage.homeHeroKey ? stageGameByKey(S.stage.homeHeroKey) : undefined;
  const hero = focusedGame ?? remembered ?? stageHeroSummary() ?? ribbon[0];
  if (hero) S.stage.homeHeroKey = hero.appName;

  stagePrefetch([stageWideArt(hero), ...ribbon.slice(0, 4).map((s) => stageWideArt(s))], 5);

  return `<div class="stage-home">
    <section class="stage-home-stage">
      <div id="stage-home-art" class="stage-home-art">${stageHeroMarkup(hero, "stage-home-art-image")}</div>
      <div class="stage-home-scrim"></div>
      <div class="stage-home-ambient" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="stage-home-grain" aria-hidden="true"></div>

      ${welcomeBackBannerHtml()}

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

/**
 * Attract-mode overlay. It lives outside the page layer on purpose: the layer
 * carries a transform for its entrance, which would turn `position: fixed`
 * into a box the height of the whole Home page and push the clock off screen.
 */
export function stageHomeIdleMarkup(): string {
  const profileName = S.customProfileName.trim();
  return `<div id="stage-home-idle" class="stage-home-idle" aria-hidden="true">
    <div class="stage-idle-top">
      <span class="stage-idle-brand">EFXLVE <b>STAGE</b></span>
      <span class="stage-idle-greeting">${esc(stageIdleGreeting())}${profileName ? ` · ${esc(profileName)}` : ""}</span>
      ${stageControllerChip()}
    </div>
    <div class="stage-idle-bottom">
      <span class="stage-idle-clock tabular-nums"></span>
      <span class="stage-idle-hint">${esc(t("stage.idleHint"))}</span>
    </div>
  </div>`;
}

/** In-place focus patch for Home: switches hero, backdrop and activities without full rebuild. */
let warmTimer = 0;
let roomTimer = 0;

/** An overlay owns the ring; the Home shelf behind it must not be re-marked. */
function homeOverlayOpen(): boolean {
  return Boolean(
    S.stage.quickMenu ||
    S.stage.powerOpen ||
    S.stage.browserOpen ||
    S.stage.spotifyOpen ||
    S.stage.discordOpen ||
    S.stage.notifOpen ||
    S.stage.controlsOpen ||
    S.stage.searchOpen ||
    S.stage.manageKey ||
    S.stage.launch ||
    S.stage.launchError ||
    S.stage.stillIndex !== null ||
    document.querySelector("#stage-root .stage-overlay"),
  );
}

export function stageHomeFocus(key: string): void {
  if (!key.startsWith("game:")) return;
  // An overlay owns the screen: a late focus event from the Home shelf behind
  // it must not re-mark the hero/activity buttons and break the focus trap.
  if (homeOverlayOpen()) return;
  const appName = key.slice(5);
  const game = stageGameByKey(appName);
  if (!game) return;
  S.stage.homeHeroKey = game.appName;

  // 1. Patch the art and hero copy in place. The first focus lands on the
  // already-rendered hero, so skip the identical rebuild.
  const heroEl = document.getElementById("stage-home-hero");
  const heroChanged = heroEl?.dataset.key !== game.appName;
  if (heroChanged) {
    const artEl = document.getElementById("stage-home-art");
    if (artEl) {
      swapStageArt(artEl, {
        url: stageWideArt(game),
        key: game.appName,
        className: "stage-home-art-image",
        fallback: stageHeroMarkup(game, "stage-home-art-image"),
      });
    }
    if (heroEl) {
      heroEl.dataset.key = game.appName;
      heroEl.innerHTML = stageHomeHeroHtml(game);
      heroEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((btn) => {
        if (!btn.closest("[data-gp-skip]")) btn.setAttribute("data-gp-item", "");
      });
    }

    // 2. Patch Activity Shelf in place. It stays synchronous: Down moves the
    // ring straight into these cards, so they must already belong to the hero.
    const actEl = document.getElementById("stage-home-activities");
    if (actEl) {
      actEl.innerHTML = stageHomeActivitiesHtml(game);
      actEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((el) => el.setAttribute("data-gp-item", ""));
    }
  }

  // 3. The room follows once the sweep settles. A held D-pad moves up to 26
  // steps a second, and a full-screen crossfade plus a colour extraction per
  // step is a strobe, not a transition.
  window.clearTimeout(roomTimer);
  roomTimer = window.setTimeout(() => {
    roomTimer = 0;
    if (!S.stage.active || S.stage.route !== "home") return;
    if (S.stage.homeHeroKey !== game.appName) return;
    updateStageBackdrop(stageWideArt(game));
  }, 140);

  // 4. Warm the activity cards only after the focus settles: sweeping across
  // the ribbon must not fire a store request for every card it passes.
  window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => {
    if (!S.stage.active || S.stage.route !== "home") return;
    const current = S.stage.homeHeroKey ? stageGameByKey(S.stage.homeHeroKey) : undefined;
    if (!current || current.appName !== game.appName) return;
    if (!S.loadedAchievements.has(game.appName)) {
      void fetchAndRenderAchievements(game.appName).then(() => {
        if (!S.stage.active || S.stage.route !== "home" || S.stage.homeHeroKey !== game.appName) return;
        // The sheet may have opened while the achievements request was in
        // flight; never re-mark the shelf under it.
        if (homeOverlayOpen()) return;
        const actEl = document.getElementById("stage-home-activities");
        if (actEl) {
          actEl.innerHTML = stageHomeActivitiesHtml(game);
          actEl.querySelectorAll<HTMLElement>("button, [data-gp-item]").forEach((el) => el.setAttribute("data-gp-item", ""));
        }
      });
    }
    if (!S.loadedScreenshots.has(game.appName)) {
      void fetchAndRenderScreenshots(game.appName, game.title);
    }
  }, 320);
}
