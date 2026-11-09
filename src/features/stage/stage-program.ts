/**
 * The program page: a playbill for one game. The primary action is always one
 * press away; the tabs only change the programme notes underneath it.
 */

import { icon } from "../../core/icons";
import { libraryItemOf, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { StageProgramTab } from "../../core/types";
import { esc, fmtAchDate, fmtBytes } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { shotThumbHtml } from "../screenshots/screenshots-view";
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

function achievementFilterBar(total: number, unlocked: number): string {
  const filters: Array<{ id: "all" | "unlocked" | "locked"; label: string; count: number }> = [
    { id: "all", label: t("stage.achAll"), count: total },
    { id: "unlocked", label: t("stage.achUnlocked"), count: unlocked },
    { id: "locked", label: t("stage.achLocked"), count: total - unlocked },
  ];
  return `<div class="stage-ach-filters" role="tablist">
    ${filters.map((filter) => `<button type="button" role="tab" aria-selected="${S.stage.achievementFilter === filter.id}" class="stage-ach-filter${S.stage.achievementFilter === filter.id ? " active" : ""}" data-stage-act="set-ach-filter" data-filter="${filter.id}" data-gp-item data-gp-key="ach-filter:${filter.id}">${esc(filter.label)}<span class="tabular-nums">${filter.count}</span></button>`).join("")}
  </div>`;
}

function achievementRow(item: import("../../epic").EpicAchievementItem): string {
  const hidden = item.hidden && !item.unlocked;
  const name = hidden ? t("stage.achHidden") : item.display_name || item.name;
  const description = hidden ? t("stage.achHiddenDesc") : item.description || "";
  const rarity = item.rarity?.percent;
  const date = item.unlocked ? fmtAchDate(item.unlock_date) : "";
  const iconMarkup = hidden
    ? icon("lock", 22)
    : item.icon_link
      ? `<img src="${esc(item.icon_link)}" alt="" loading="lazy" decoding="async" />`
      : icon(item.unlocked ? "trophy" : "lock", 22);
  return `<button type="button" class="stage-ach-row${item.unlocked ? " is-unlocked" : ""}${hidden ? " is-hidden" : ""}" data-gp-item data-gp-key="ach:${esc(item.name)}">
    <span class="stage-ach-icon">${iconMarkup}</span>
    <span class="stage-ach-copy">
      <strong>${esc(name)}</strong>
      <span>${esc(description)}</span>
    </span>
    <span class="stage-ach-meta">
      ${item.unlocked ? `<span class="stage-ach-unlocked">${icon("check", 12)} ${esc(t("stage.achUnlockedLabel"))}</span>` : ""}
      ${rarity !== undefined ? `<span class="tabular-nums">${rarity.toFixed(1)}%</span>` : ""}
      ${date ? `<span class="tabular-nums">${esc(date)}</span>` : ""}
      ${item.xp > 0 ? `<span class="tabular-nums">+${item.xp} XP</span>` : ""}
    </span>
  </button>`;
}

function achievementsTab(game: EpicSummary): string {
  const ach = stageAchievements(game);
  if (S.loadingAchFor.has(game.appName) && !S.loadedAchievements.has(game.appName)) {
    return `<div class="stage-program-empty">${icon("refresh", 34)}<h2>${esc(t("stage.achLoading"))}</h2><p>${esc(t("stage.achLoadingHint"))}</p></div>`;
  }
  const data = S.loadedAchievements.get(game.appName);
  if (!data) {
    return `<div class="stage-program-empty">${icon("trophy", 34)}<h2>${esc(t("stage.achievements"))}</h2><p>${esc(t("stage.achNotLoaded"))}</p><button type="button" class="stage-btn stage-btn-ghost" data-stage-act="refresh-achievements" data-key="${esc(game.appName)}" data-gp-item data-gp-key="ach:refresh">${icon("refresh", 16)}<span>${esc(t("stage.achRefresh"))}</span></button></div>`;
  }
  const byName = new Map<string, import("../../epic").EpicAchievementItem>();
  for (const item of [...(data.achievements ?? []), ...(data.hidden ?? [])]) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const items = [...byName.values()];
  if (items.length === 0) {
    return `<div class="stage-program-empty">${icon("trophy", 34)}<h2>${esc(t("stage.noAchievements"))}</h2><p>${esc(t("stage.noAchievementsHint"))}</p></div>`;
  }
  const total = Math.max(items.length, data.total_achievements);
  const unlocked = items.filter((item) => item.unlocked).length;
  const filter = S.stage.achievementFilter;
  const visible = items
    .filter((item) => filter === "all" || (filter === "unlocked" ? item.unlocked : !item.unlocked))
    .sort((a, b) => {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      return (a.display_name || a.name).localeCompare(b.display_name || b.name, currentLanguage());
    });
  const percent = Math.round((unlocked / Math.max(1, total)) * 100);
  return `<div class="stage-achievements-panel">
    <div class="stage-achievements-head">
      <span class="stage-achievements-medal">${icon(data.is_platinum ? "crown" : "trophy", 30)}</span>
      <div>
        <strong>${esc(data.is_platinum ? t("stage.achPlatinum") : t("stage.achievements"))}</strong>
        <span class="tabular-nums">${unlocked} / ${total}${data.platinum_rarity?.percent !== undefined ? ` · ${data.platinum_rarity.percent.toFixed(1)}%` : ""}</span>
      </div>
      <strong class="stage-achievements-pct tabular-nums">${percent}%</strong>
    </div>
    ${stageProgress(percent, "stage-progress-large")}
    ${achievementFilterBar(total, unlocked)}
    <div class="stage-ach-list">${visible.length > 0 ? visible.map(achievementRow).join("") : `<div class="stage-program-empty"><p>${esc(t("stage.achFilterEmpty"))}</p></div>`}</div>
    <div class="stage-settings-actions">
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="refresh-achievements" data-key="${esc(game.appName)}" data-gp-item data-gp-key="ach:refresh">${icon("refresh", 16)}<span>${esc(t("stage.achRefresh"))}</span></button>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="ach:manage">${icon("settings", 16)}<span>${esc(t("stage.manage"))}</span></button>
    </div>
  </div>`;
}

function extrasTab(game: EpicSummary): string {
  const cloud = Boolean(
    libraryItemOf(game.appName, sourceOfKey(game.appName))?.cloudSavesSupported,
  );
  const shots = S.loadedScreenshots.get(game.appName) || [];
  const loadingShots = S.loadingScreenshotsFor.has(game.appName);
  const stills = shots.slice(0, 12);
  const stillsBody = stills.length > 0
    ? `<div class="stage-stills-row" data-gp-row>${stills.map((item, index) => `<button type="button" class="stage-still" data-stage-act="open-still" data-index="${index}" data-gp-item data-gp-key="still:${index}">${shotThumbHtml(item)}<span>${esc(item.file_name)}</span></button>`).join("")}</div>`
    : `<div class="stage-extra-empty">${loadingShots ? esc(t("stage.stillsLoading")) : esc(t("stage.stillsEmpty"))}</div>`;
  return `<div class="stage-extras">
    <div class="stage-extra-row"><span>${icon("package", 18)} ${esc(t("stage.dlc"))}</span><strong class="tabular-nums">${game.dlcCount || 0}</strong></div>
    <div class="stage-extra-row"><span>${icon("cloud", 18)} ${esc(t("stage.cloud"))}</span><strong>${esc(cloud ? t("stage.cloudReady") : t("stage.cloudUnavailable"))}</strong></div>
    <div class="stage-extra-row"><span>${icon("folder", 18)} ${esc(t("stage.installFolder"))}</span><strong class="stage-extra-path">${esc(game.installPath || "—")}</strong></div>
    <div class="stage-extra-section">
      <div class="stage-extra-section-head">
        <span class="stage-kicker">${esc(t("stage.stills"))}</span>
        <span class="stage-extra-count tabular-nums">${shots.length}</span>
      </div>
      ${stillsBody}
    </div>
    <div class="stage-extra-actions">
      ${cloud ? `<button type="button" class="stage-btn stage-btn-ghost" data-stage-act="cloud-backup" data-key="${esc(game.appName)}" data-gp-item data-gp-key="extras:cloud">${icon("cloud", 16)}<span>${esc(t("stage.cloudBackupNow"))}</span></button>` : ""}
      ${cloud ? `<button type="button" class="stage-btn stage-btn-ghost" data-stage-act="desktop-settings-section" data-section="cloud" data-gp-item data-gp-key="extras:cloud-settings">${icon("cloud", 16)}<span>${esc(t("stage.cloudSettings"))}</span></button>` : ""}
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="extras:manage">${icon("settings", 16)}<span>${esc(t("stage.manage"))}</span></button>
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
      </div>
      <div class="stage-program-status">${stageStatus(game)}</div>
    </section>

    <div class="stage-program-actions" data-gp-default>
      <div class="stage-primary-action">${stagePrimaryAction(game)}</div>
      <button type="button" class="stage-btn stage-btn-ghost${favorite ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:favorite">${icon("heart", 18)}<span>${esc(favorite ? t("stage.favorited") : t("stage.favorite"))}</span></button>
      <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:manage">${icon("settings", 18)}<span>${esc(t("stage.manage"))}</span></button>
    </div>

    ${tabs()}
    <div class="stage-program-content">${content(game)}</div>
    <div class="stage-program-foot">${esc(t("stage.experimentalNote"))}</div>
  </div>`;
}
