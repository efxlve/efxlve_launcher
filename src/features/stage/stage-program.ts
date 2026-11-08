/**
 * The program page: a playbill for one game. The primary action is always one
 * press away; the tabs only change the programme notes underneath it.
 */

import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { StageProgramTab } from "../../core/types";
import { esc, fmtBytes } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { stageHeroMarkup } from "./stage-art";
import { stageAchievements, stageGameByKey, stageGamePlaytime, stagePrimaryAction } from "./stage-model";
import { stageMetaLine, stageProgress, stageStatus, stageStoreName } from "./stage-ui";

const TABS: StageProgramTab[] = ["overview", "achievements", "extras"];

function tabLabel(tab: StageProgramTab): string {
  switch (tab) {
    case "achievements": return t("stage.tabAchievements");
    case "extras": return t("stage.tabExtras");
    default: return t("stage.tabOverview");
  }
}

function tabs(): string {
  return `<div class="stage-program-tabs" role="tablist">
    ${TABS.map((tab) => `<button type="button" role="tab" aria-selected="${S.stage.programTab === tab}" class="stage-program-tab${S.stage.programTab === tab ? " active" : ""}" data-stage-act="set-tab" data-tab="${tab}" data-gp-item data-gp-key="tab:${tab}">${esc(tabLabel(tab))}</button>`).join("")}
  </div>`;
}

function fact(label: string, value: string): string {
  return `<div class="stage-fact"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function overview(game: EpicSummary): string {
  const play = stageGamePlaytime(game);
  const ach = stageAchievements(game);
  const achKnown = ach?.progress_known !== false;
  const achPercent = ach?.supported && ach.total_achievements > 0 && achKnown
    ? Math.round((ach.user_unlocked / ach.total_achievements) * 100)
    : 0;
  return `<div class="stage-program-grid">
    <div class="stage-program-copy">
      <span class="stage-kicker">${esc(t("stage.about"))}</span>
      <p>${esc(game.description || t("stage.noDescription"))}</p>
    </div>
    <div class="stage-program-facts">
      ${fact(t("stage.store"), esc(stageStoreName(sourceOfKey(game.appName))))}
      ${fact(t("stage.installSize"), game.installSize > 0 ? esc(fmtBytes(game.installSize)) : "—")}
      ${fact(t("stage.playtimeLabel"), play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(play.seconds >= 36000 ? 0 : 1) })) : esc(t("playtime.notPlayed")))}
      ${fact(t("stage.achievements"), ach?.supported && ach.total_achievements > 0 ? `<span class="tabular-nums">${achKnown ? `${ach.user_unlocked} / ${ach.total_achievements}` : String(ach.total_achievements)}</span>` : "—")}
      ${fact(t("stage.releaseYear"), game.releaseYear ? String(game.releaseYear) : "—")}
      ${fact(t("stage.genre"), (game.genres ?? []).length > 0 ? esc((game.genres ?? []).join(", ")) : "—")}
    </div>
    ${ach?.supported && ach.total_achievements > 0 && achKnown
      ? `<div class="stage-program-ach">${icon("trophy", 18)}<span>${esc(t("stage.achievements"))}</span>${stageProgress(achPercent)}<strong class="tabular-nums">${ach.user_unlocked} / ${ach.total_achievements}</strong></div>`
      : ""}
  </div>`;
}

function achievementsTab(game: EpicSummary): string {
  const ach = stageAchievements(game);
  if (!ach || !ach.supported || ach.total_achievements <= 0) {
    return `<div class="stage-program-empty">${icon("trophy", 34)}<h2>${esc(t("stage.noAchievements"))}</h2><p>${esc(t("stage.noAchievementsHint"))}</p></div>`;
  }
  if (ach.progress_known === false) {
    return `<div class="stage-program-empty">${icon("trophy", 34)}<h2>${esc(t("stage.achievements"))}</h2><p>${esc(t("stage.progressUnknown", { n: ach.total_achievements }))}</p></div>`;
  }
  const percent = Math.round((ach.user_unlocked / ach.total_achievements) * 100);
  return `<div class="stage-achievements-panel">
    <div class="stage-achievements-head">
      <span class="stage-achievements-medal">${icon("trophy", 30)}</span>
      <div>
        <strong>${esc(t("stage.achievements"))}</strong>
        <span class="tabular-nums">${ach.user_unlocked} / ${ach.total_achievements}</span>
      </div>
      <strong class="stage-achievements-pct tabular-nums">${percent}%</strong>
    </div>
    ${stageProgress(percent, "stage-progress-large")}
    <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="ach:desktop">${icon("external", 16)}<span>${esc(t("stage.openInDesktop"))}</span></button>
  </div>`;
}

function extrasTab(game: EpicSummary): string {
  return `<div class="stage-extras">
    <div class="stage-extra-row"><span>${icon("package", 18)} ${esc(t("stage.dlc"))}</span><strong class="tabular-nums">${game.dlcCount || 0}</strong></div>
    <div class="stage-extra-row"><span>${icon("cloud", 18)} ${esc(t("stage.cloud"))}</span><strong>${esc(S.allGamesMap.get(game.appName)?.cloudSavesSupported ? t("stage.cloudReady") : t("stage.cloudUnavailable"))}</strong></div>
    <div class="stage-extra-row"><span>${icon("folder", 18)} ${esc(t("stage.installFolder"))}</span><strong class="stage-extra-path">${esc(game.installPath || "—")}</strong></div>
    <div class="stage-extra-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="extras:desktop">${icon("settings", 16)}<span>${esc(t("stage.manageInDesktop"))}</span></button>
    </div>
  </div>`;
}

function content(game: EpicSummary): string {
  switch (S.stage.programTab) {
    case "achievements": return achievementsTab(game);
    case "extras": return extrasTab(game);
    default: return overview(game);
  }
}

export function renderStageProgram(): string {
  const game = stageGameByKey(S.stage.gameKey);
  if (!game) {
    return `<div class="stage-program-missing" >
      <span class="stage-empty-icon">${icon("gamepad-2", 42)}</span>
      <h1>${esc(t("stage.gameMissing"))}</h1>
      <button type="button" class="stage-btn stage-btn-primary" data-stage-act="back" data-gp-item data-gp-key="missing:back">${esc(t("common.back"))}</button>
    </div>`;
  }
  const favorite = S.epicFav.has(game.appName);
  return `<div class="stage-program" >
    <section class="stage-program-hero">
      <span class="stage-program-media">${stageHeroMarkup(game)}</span>
      <span class="stage-program-scrim"></span>
      <div class="stage-program-head">
        <button type="button" class="stage-back" data-stage-act="back" data-gp-item data-gp-key="prog:back">${icon("arrow-left", 18)}<span>${esc(t("common.back"))}</span></button>
        <div class="stage-program-titles">
          <span class="stage-program-kicker">${esc(stageStoreName(sourceOfKey(game.appName)))}</span>
          <h1>${esc(game.title)}</h1>
          <div class="stage-program-meta">${stageMetaLine(game, { withStore: false })}</div>
        </div>
        <div class="stage-program-status">${stageStatus(game)}</div>
      </div>
    </section>

    <div class="stage-program-actions" data-gp-default>
      <div class="stage-primary-action">${stagePrimaryAction(game)}</div>
      <button type="button" class="stage-btn stage-btn-ghost${favorite ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:favorite">${icon("heart", 18)}<span>${esc(favorite ? t("stage.favorited") : t("stage.favorite"))}</span></button>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:manage">${icon("settings", 18)}<span>${esc(t("stage.manage"))}</span></button>
    </div>

    ${tabs()}
    <div class="stage-program-content">${content(game)}</div>
    <div class="stage-program-foot">${esc(t("stage.experimentalNote"))}</div>
  </div>`;
}
