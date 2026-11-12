/**
 * The program page: a playbill for one game. The primary action is always one
 * press away; the tabs only change the programme notes underneath it.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { libraryItemOf, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import type { StageProgramTab } from "../../core/types";
import { esc, fmtAchDate, fmtBytes } from "../../core/utils";
import { epicGetCritic, epicGetHltb } from "../../epic-commands";
import { currentLanguage, t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { renderMarkdownLite } from "../notes/markdown";
import { loadNotes, notesForScope, onNotesChanged } from "../notes/notes-client";
import { shotThumbHtml } from "../screenshots/screenshots-view";
import { stageEnsureScreenshots } from "./stage-actions";
import { stageHeroMarkup } from "./stage-art";
import { loadStageAudioFiles, stageAudioLabel } from "./stage-audio-library";
import { stageAchievements, stageGameByKey, stageGamePlaytime, stagePrimaryAction } from "./stage-model";
import { stageMetaLine, stageProgress, stageStoreName } from "./stage-ui";

const TABS: StageProgramTab[] = ["overview", "achievements", "media", "notes", "extras"];
/** One request per session; the notes client owns the cache after that. */
let notesRequested = false;

// Another window (the overlay or the desktop notes page) can write a note while
// Stage is open. Reload its cache and repaint the tab instead of showing stale
// text until the next route change.
onNotesChanged(() => {
  if (S.stage.active && S.stage.route === "program" && S.stage.programTab === "notes") {
    scheduleRender();
  }
});

function tabLabel(tab: StageProgramTab): string {
  switch (tab) {
    case "achievements": return t("stage.tabAchievements");
    case "media": return t("drawer.screenshots");
    case "notes": return t("drawer.notes");
    case "extras": return t("stage.tabExtras");
    default: return t("stage.tabOverview");
  }
}

function tabs(): string {
  return `<div class="stage-program-tabs" role="tablist" data-gp-row>
    ${TABS.map((tab) => `<button type="button" role="tab" aria-selected="${S.stage.programTab === tab}" class="stage-program-tab${S.stage.programTab === tab ? " active" : ""}" data-stage-act="set-tab" data-tab="${tab}" data-gp-item data-gp-key="tab:${tab}">${esc(tabLabel(tab))}</button>`).join("")}
  </div>`;
}

function fact(label: string, value: string): string {
  return `<div class="stage-fact"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

type ProgramStatIcon = Parameters<typeof icon>[0];

/** Compact facts for an empty tab: what the tab is scoped to and what it found. */
function programStats(items: Array<{ icon: ProgramStatIcon; label: string; value?: string }>): string {
  return `<div class="stage-stat-row stage-program-stats">
    ${items.map((item) => `<span class="stage-stat">${icon(item.icon, 13)}<span>${esc(item.label)}</span>${item.value !== undefined ? `<b class="tabular-nums">${esc(item.value)}</b>` : ""}</span>`).join("")}
  </div>`;
}

/** One empty-state card for every programme tab, so they share a shape. */
function programEmpty(opts: {
  icon: ProgramStatIcon;
  title: string;
  hint: string;
  stats: string;
  action?: string;
}): string {
  return `<div class="stage-program-empty">
    <span class="stage-empty-icon">${icon(opts.icon, 36)}</span>
    <h2>${esc(opts.title)}</h2>
    <p>${esc(opts.hint)}</p>
    ${opts.stats}
    ${opts.action ?? ""}
  </div>`;
}

function ensureStageProgramData(game: EpicSummary): void {
  const appName = game.appName;
  const lookupTitle = S.allGamesMap.get(appName)?.title ?? game.title;
  const year = game.releaseYear ?? null;

  if (!S.loadedHltb.has(appName) && !S.loadingHltbFor.has(appName)) {
    if (!isTauri) {
      S.loadedHltb.set(appName, { app_name: appName, title: lookupTitle, supported: false });
    } else {
      S.loadingHltbFor.add(appName);
      epicGetHltb(lookupTitle, appName, false, year)
        .then((data) => {
          S.loadedHltb.set(appName, data);
          if (S.stage.active && S.stage.route === "program" && S.stage.gameKey === appName) {
            scheduleRender();
          }
        })
        .catch(() => {
          S.loadedHltb.set(appName, { app_name: appName, title: lookupTitle, supported: false });
        })
        .finally(() => { S.loadingHltbFor.delete(appName); });
    }
  }

  if (!S.loadedCritic.has(appName) && !S.loadingCriticFor.has(appName)) {
    if (!isTauri) {
      S.loadedCritic.set(appName, { app_name: appName, title: lookupTitle, supported: false });
    } else {
      S.loadingCriticFor.add(appName);
      epicGetCritic(lookupTitle, appName, false, year)
        .then((data) => {
          S.loadedCritic.set(appName, data);
          if (S.stage.active && S.stage.route === "program" && S.stage.gameKey === appName) {
            scheduleRender();
          }
        })
        .catch(() => {
          S.loadedCritic.set(appName, { app_name: appName, title: lookupTitle, supported: false });
        })
        .finally(() => { S.loadingCriticFor.delete(appName); });
    }
  }

  stageEnsureScreenshots(appName);
  void loadNotes();
}

function overview(game: EpicSummary): string {
  ensureStageProgramData(game);
  const play = stageGamePlaytime(game);
  const ach = stageAchievements(game);
  const achKnown = ach?.progress_known !== false;
  const achPercent = ach?.supported && ach.total_achievements > 0 && achKnown
    ? Math.round((ach.user_unlocked / ach.total_achievements) * 100)
    : 0;

  const hltb = S.loadedHltb.get(game.appName);
  const critic = S.loadedCritic.get(game.appName);
  const hours = (n?: number | null) => (n ? t("stage.hoursValue", { h: n.toFixed(n >= 100 ? 0 : 1) }) : "—");

  const hltbCard = hltb && (hltb.main_story || hltb.main_extra || hltb.completionist)
    ? `<div class="stage-program-card stage-card-hltb">
        <div class="stage-card-head">
          <span class="stage-card-icon">${icon("clock", 16)}</span>
          <span class="stage-card-title">${esc(t("settings.storeAugmentedSteamOptHltb"))}</span>
        </div>
        <div class="stage-hltb-grid">
          <div class="stage-hltb-item">
            <span class="stage-card-label">${esc(t("hltb.mainStory"))}</span>
            <strong class="stage-card-value tabular-nums">${hours(hltb.main_story)}</strong>
          </div>
          <div class="stage-hltb-item">
            <span class="stage-card-label">${esc(t("hltb.mainExtra"))}</span>
            <strong class="stage-card-value tabular-nums">${hours(hltb.main_extra)}</strong>
          </div>
          <div class="stage-hltb-item">
            <span class="stage-card-label">${esc(t("hltb.completionist"))}</span>
            <strong class="stage-card-value tabular-nums">${hours(hltb.completionist)}</strong>
          </div>
        </div>
      </div>`
    : "";

  const meta = critic?.metacritic_score;
  const open = critic?.opencritic_score;
  const igdb = critic?.igdb_score;

  const criticCard = meta || open || igdb
    ? `<div class="stage-program-card stage-card-critic">
        <div class="stage-card-head">
          <span class="stage-card-icon">${icon("star", 16)}</span>
          <span class="stage-card-title">${esc(t("drawer.statReview"))}</span>
        </div>
        <div class="stage-critic-grid">
          ${meta ? `<div class="stage-critic-item">
            <div class="stage-critic-score ${meta >= 75 ? "score-good" : meta >= 50 ? "score-avg" : "score-bad"} tabular-nums">${meta}</div>
            <span class="stage-card-label">Metacritic</span>
          </div>` : ""}
          ${open ? `<div class="stage-critic-item">
            <div class="stage-critic-score ${open >= 75 ? "score-good" : open >= 50 ? "score-avg" : "score-bad"} tabular-nums">${open}</div>
            <span class="stage-card-label">OpenCritic</span>
          </div>` : ""}
          ${igdb ? `<div class="stage-critic-item">
            <div class="stage-critic-score score-steam tabular-nums">${igdb}%</div>
            <span class="stage-card-label">IGDB</span>
          </div>` : ""}
        </div>
      </div>`
    : "";

  const loadedAch = S.loadedAchievements.get(game.appName);
  const nextLocked = loadedAch?.achievements.find((item) => !item.unlocked);

  const trophySpotlight = ach?.supported && ach.total_achievements > 0 && achKnown
    ? `<div class="stage-program-card stage-card-trophy">
        <div class="stage-card-head">
          <span class="stage-card-icon">${icon(loadedAch?.is_platinum ? "crown" : "trophy", 16)}</span>
          <span class="stage-card-title">${esc(t("stage.achievements"))}</span>
          <span class="stage-card-badge tabular-nums">${achPercent}%</span>
        </div>
        ${stageProgress(achPercent, "stage-progress-hub")}
        <div class="stage-trophy-stats">
          <span class="tabular-nums">${ach.user_unlocked} / ${ach.total_achievements}</span>
          ${nextLocked ? `<span class="stage-trophy-next">${icon("lock", 12)} ${esc(nextLocked.display_name || nextLocked.name)}</span>` : ""}
        </div>
      </div>`
    : "";

  return `<div class="stage-program-grid">
    <div class="stage-program-main-col">
      <div class="stage-program-copy">
        <span class="stage-kicker">${esc(t("stage.about"))}</span>
        <p>${esc(game.description || t("stage.noDescription"))}</p>
      </div>
      ${hltbCard || criticCard ? `<div class="stage-program-cards-row">${hltbCard}${criticCard}</div>` : ""}
      ${trophySpotlight}
    </div>
    <div class="stage-program-facts">
      ${fact(t("stage.store"), esc(stageStoreName(sourceOfKey(game.appName))))}
      ${fact(t("stage.installSize"), game.installSize > 0 ? esc(fmtBytes(game.installSize)) : "—")}
      ${fact(t("stage.playtimeLabel"), play.seconds > 0 ? esc(t("stage.hoursValue", { h: (play.seconds / 3600).toFixed(play.seconds >= 36000 ? 0 : 1) })) : esc(t("playtime.notPlayed")))}
      ${fact(t("stage.achievements"), ach?.supported && ach.total_achievements > 0 ? `<span class="tabular-nums">${achKnown ? `${ach.user_unlocked} / ${ach.total_achievements}` : String(ach.total_achievements)}</span>` : "—")}
      ${fact(t("stage.releaseYear"), game.releaseYear ? String(game.releaseYear) : "—")}
      ${fact(t("stage.genre"), (game.genres ?? []).length > 0 ? esc((game.genres ?? []).join(", ")) : "—")}
    </div>
  </div>`;
}

function achievementFilterBar(total: number, unlocked: number): string {
  const filters: Array<{ id: "all" | "unlocked" | "locked"; label: string; count: number }> = [
    { id: "all", label: t("stage.achAll"), count: total },
    { id: "unlocked", label: t("stage.achUnlocked"), count: unlocked },
    { id: "locked", label: t("stage.achLocked"), count: total - unlocked },
  ];
  return `<div class="stage-ach-filters" role="tablist" data-gp-row>
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
  const filterLabel = S.stage.achievementFilter === "unlocked"
    ? t("stage.achUnlocked")
    : S.stage.achievementFilter === "locked"
      ? t("stage.achLocked")
      : t("stage.achAll");
  if (S.loadingAchFor.has(game.appName) && !S.loadedAchievements.has(game.appName)) {
    return programEmpty({
      icon: "refresh",
      title: t("stage.achLoading"),
      hint: t("stage.achLoadingHint"),
      stats: programStats([
        { icon: "sliders", label: filterLabel },
        { icon: "trophy", label: t("stage.achievements"), value: "—" },
      ]),
    });
  }
  const data = S.loadedAchievements.get(game.appName);
  if (!data) {
    return programEmpty({
      icon: "trophy",
      title: t("stage.achievements"),
      hint: t("stage.achNotLoaded"),
      stats: programStats([
        { icon: "sliders", label: filterLabel },
        { icon: "trophy", label: t("stage.achievements"), value: "—" },
      ]),
      action: `<button type="button" class="stage-btn stage-btn-ghost" data-stage-act="refresh-achievements" data-key="${esc(game.appName)}" data-gp-item data-gp-key="ach:refresh">${icon("refresh", 16)}<span>${esc(t("stage.achRefresh"))}</span></button>`,
    });
  }
  const byName = new Map<string, import("../../epic").EpicAchievementItem>();
  for (const item of [...(data.achievements ?? []), ...(data.hidden ?? [])]) {
    if (!byName.has(item.name)) byName.set(item.name, item);
  }
  const items = [...byName.values()];
  const total = Math.max(items.length, data.total_achievements);
  if (items.length === 0) {
    return programEmpty({
      icon: "trophy",
      title: t("stage.noAchievements"),
      hint: t("stage.noAchievementsHint"),
      stats: programStats([
        { icon: "sliders", label: filterLabel },
        { icon: "trophy", label: t("stage.achievements"), value: `0 / ${total}` },
      ]),
    });
  }
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

function mediaTab(game: EpicSummary): string {
  stageEnsureScreenshots(game.appName);
  const shots = S.loadedScreenshots.get(game.appName) || [];
  const loading = S.loadingScreenshotsFor.has(game.appName);

  if (shots.length === 0) {
    return programEmpty({
      icon: "camera",
      title: t("drawer.screenshots"),
      hint: loading ? t("stage.stillsLoading") : t("stage.stillsEmpty"),
      stats: programStats([
        { icon: "camera", label: t("stage.stills"), value: String(shots.length) },
        { icon: "layers", label: stageStoreName(sourceOfKey(game.appName)) },
      ]),
    });
  }

  return `<div class="stage-media-gallery">
    <div class="stage-media-grid" data-gp-row>
      ${shots.map((item, index) => `
        <button type="button" class="stage-still-card" data-stage-act="open-still" data-index="${index}" data-gp-item data-gp-key="still:${index}" aria-label="${esc(item.file_name)}">
          <div class="stage-still-art">${shotThumbHtml(item)}</div>
          <div class="stage-still-overlay">
            <span class="stage-still-icon">${icon("maximize-2", 18)}</span>
            <span class="stage-still-title">${esc(item.file_name)}</span>
          </div>
        </button>
      `).join("")}
    </div>
  </div>`;
}

function notesTab(game: EpicSummary): string {
  if (!notesRequested) {
    notesRequested = true;
    void loadNotes().then(() => {
      if (S.stage.active && S.stage.route === "program" && S.stage.programTab === "notes") {
        scheduleRender();
      }
    });
  }
  const notes = notesForScope(game.appName);

  if (notes.length === 0) {
    return programEmpty({
      icon: "edit",
      title: t("drawer.notes"),
      hint: t("notes.emptyList"),
      stats: programStats([
        { icon: "edit", label: t("drawer.notes"), value: String(notes.length) },
        { icon: "gamepad-2", label: game.title },
      ]),
    });
  }

  return `<div class="stage-notes-panel">
    <div class="stage-notes-grid" data-gp-row>
      ${notes.map((note, index) => `
        <div class="stage-note-card${note.pinned ? " is-pinned" : ""}" data-gp-item data-gp-key="note:${index}">
          <div class="stage-note-head">
            <span class="stage-note-icon">${icon("edit", 16)}</span>
            <h3 class="stage-note-title">${esc(note.title || t("notes.untitled"))}</h3>
            ${note.pinned ? `<span class="stage-note-pin">${icon("pin", 14)}</span>` : ""}
          </div>
          <div class="stage-note-body">
            ${renderMarkdownLite(note.body, note.images || []).html}
          </div>
        </div>
      `).join("")}
    </div>
  </div>`;
}

function extrasTab(game: EpicSummary): string {
  void loadStageAudioFiles();
  const cloud = Boolean(
    libraryItemOf(game.appName, sourceOfKey(game.appName))?.cloudSavesSupported,
  );
  const gameTrack = S.stage.gameTracks[game.appName] || "";
  const shots = S.loadedScreenshots.get(game.appName) || [];
  const loadingShots = S.loadingScreenshotsFor.has(game.appName);
  const stills = shots.slice(0, 12);
  const stillsBody = stills.length > 0
    ? `<div class="stage-stills-row" data-gp-row>${stills.map((item, index) => `<button type="button" class="stage-still" data-stage-act="open-still" data-index="${index}" data-gp-item data-gp-key="still:${index}">${shotThumbHtml(item)}<span>${esc(item.file_name)}</span></button>`).join("")}</div>`
    : `<div class="stage-extra-stills-empty">
        <span class="stage-empty-icon">${icon("camera", 22)}</span>
        <div class="stage-extra-stills-copy">
          <strong>${esc(loadingShots ? t("stage.stillsLoading") : t("stage.stillsEmpty"))}</strong>
        </div>
        <div class="stage-stat-row">
          <span class="stage-stat">${icon("camera", 13)}<span>${esc(t("stage.stills"))}</span><b class="tabular-nums">${shots.length}</b></span>
        </div>
      </div>`;
  return `<div class="stage-extras">
    <div class="stage-extra-facts">
      <span class="stage-stat">${icon("package", 13)}<span>${esc(t("stage.dlc"))}</span><b class="tabular-nums">${game.dlcCount || 0}</b></span>
      <span class="stage-stat"><i class="${cloud ? "is-ready" : "is-off"}" aria-hidden="true"></i><span>${esc(t("stage.cloud"))}</span><b>${esc(cloud ? t("stage.cloudReady") : t("stage.cloudUnavailable"))}</b></span>
    </div>
    <div class="stage-extra-row"><span>${icon("folder", 18)} ${esc(t("stage.installFolder"))}</span><strong class="stage-extra-path">${esc(game.installPath || "—")}</strong></div>
    <div class="stage-extra-section">
      <div class="stage-extra-section-head">
        <span class="stage-kicker">${esc(t("stage.settingsGameMusic"))}</span>
        <span class="stage-extra-count">${esc(gameTrack ? stageAudioLabel(gameTrack) : t("stage.settingsAmbience"))}</span>
      </div>
      <div class="stage-extra-actions">
        <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="choose-game-track" data-key="${esc(game.appName)}" data-gp-item data-gp-key="extras:music-choose">${icon("music", 16)}<span>${esc(t("stage.settingsMusicChoose"))}</span></button>
        ${gameTrack ? `<button type="button" class="stage-btn stage-btn-ghost" data-stage-act="clear-game-track" data-key="${esc(game.appName)}" data-gp-item data-gp-key="extras:music-clear">${icon("x", 16)}<span>${esc(t("stage.settingsMusicClear"))}</span></button>` : ""}
      </div>
      <div class="stage-extra-empty">${esc(t("stage.settingsGameMusicDesc"))}</div>
    </div>
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
    case "media": return mediaTab(game);
    case "notes": return notesTab(game);
    case "extras": return extrasTab(game);
    default: return overview(game);
  }
}

export function renderStageProgram(): string {
  const game = stageGameByKey(S.stage.gameKey);
  if (!game) {
    return `<div class="stage-program-missing">
      <div class="stage-program-empty">
        <span class="stage-empty-icon">${icon("gamepad-2", 36)}</span>
        <h1>${esc(t("stage.gameMissing"))}</h1>
        <p>${esc(t("stage.gameMissingHint"))}</p>
        <button type="button" class="stage-btn stage-btn-primary" data-stage-act="back" data-gp-item data-gp-key="missing:back">${icon("arrow-left", 16)}<span>${esc(t("common.back"))}</span></button>
      </div>
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
        <div class="stage-program-actions" data-gp-default>
          <div class="stage-primary-action">${stagePrimaryAction(game)}</div>
          <button type="button" class="stage-btn stage-btn-ghost${favorite ? " faved" : ""}" data-stage-act="favorite" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:favorite">${icon("heart", 18)}<span>${esc(favorite ? t("stage.favorited") : t("stage.favorite"))}</span></button>
          <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="manage-game" data-key="${esc(game.appName)}" data-gp-item data-gp-key="prog:manage">${icon("settings", 18)}<span>${esc(t("stage.manage"))}</span></button>
        </div>
      </div>
    </section>

    ${tabs()}
    <div class="stage-program-content">${content(game)}</div>
  </div>`;
}
