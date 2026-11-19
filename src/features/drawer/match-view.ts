/**
 * "Fix metadata": choose the IGDB entry and the HowLongToBeat entry for one
 * game when the automatic title match lands on the wrong game.
 *
 * A store title can be the name of another year's game ("Portal" 1986 next to
 * Valve's 2007 one), and HowLongToBeat answers a search with the base game and
 * its DLC chapters together. The picker shows both lists as the services name
 * them, and the choice is stored per game: the page, the library sort and the
 * next boot all read it.
 */

import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { recordLiveIgdbGame } from "../../core/game-ratings";
import { recordLiveHltb } from "../../core/hltb-times";
import {
  epicClearHltbMatch,
  epicGetHltb,
  epicSearchHltb,
  epicSetHltbMatch,
  type HltbSearchHit,
} from "../../epic";
import { localizeMessage, t } from "../../i18n";
import {
  gameMatchGet,
  igdbChooseMatch,
  igdbClearMatch,
  igdbImage,
  igdbSearch,
  type GameMatchChoice,
  type IgdbSearchHit,
} from "../../igdb";
import { gameReleaseYear, paintGameMeta, repaintIgdbBlocks, updateHltbUI } from "./drawer-view";
import { ensureIgdbOverview, forgetIgdbGame, igdbGameFor, setIgdbGameFor } from "./igdb-view";

interface MatchState {
  appName: string;
  choice: GameMatchChoice;
  igdbQuery: string;
  igdbHits: IgdbSearchHit[];
  igdbLoading: boolean;
  igdbError: string;
  hltbQuery: string;
  hltbHits: HltbSearchHit[];
  hltbLoading: boolean;
  hltbError: string;
}

let state: MatchState | null = null;
let igdbSeq = 0;
let hltbSeq = 0;

function matchRoot(): HTMLElement {
  let root = document.getElementById("match-modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "match-modal-root";
    document.body.appendChild(root);
  }
  return root;
}

function messageOf(error: unknown): string {
  const raw = String(error);
  return raw.startsWith("@t:") ? localizeMessage(raw) : raw;
}

function hoursLabel(value?: number | null): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? t("hltb.hours", { n: value })
    : "—";
}

function currentIgdbLine(): string {
  if (!state) return "";
  const chosen = state.choice.igdbId;
  const game = igdbGameFor(state.appName);
  const label = game
    ? `${game.name}${game.releaseYear ? ` · ${game.releaseYear}` : ""}`
    : "";
  if (chosen) return label ? `${t("match.manual")}: ${esc(label)}` : t("match.manual");
  return label ? esc(label) : t("match.none");
}

function currentHltbLine(): string {
  if (!state) return "";
  const chosen = state.choice.hltb;
  if (chosen) {
    return `${t("match.manual")}: ${esc(chosen.name)}${chosen.year ? ` · ${chosen.year}` : ""} · ${hoursLabel(chosen.main_story)}`;
  }
  const data = S.loadedHltb.get(state.appName);
  return data?.supported ? hoursLabel(data.main_story) : t("match.none");
}

function igdbRowHtml(hit: IgdbSearchHit): string {
  if (!state) return "";
  const thumb = hit.coverId ? igdbImage(hit.coverId, "cover_small") : "";
  const rating = typeof hit.rating === "number" ? ` · ${Math.round(hit.rating)}` : "";
  const selected = state.choice.igdbId === hit.id;
  return `<button type="button" class="search-result-item match-row${selected ? " is-selected" : ""}" data-act="match-igdb-use" data-game="${hit.id}">
    ${thumb ? `<img class="result-thumb" src="${esc(thumb)}" alt="" loading="lazy" />` : `<span class="result-thumb match-thumb-empty">${icon("image", 14)}</span>`}
    <span class="result-info">
      <span class="result-name">${esc(hit.name)}</span>
      <span class="result-sub">${hit.year ?? "—"}${rating}</span>
    </span>
    ${selected ? `<span class="match-check">${icon("check", 14)}</span>` : ""}
  </button>`;
}

function hltbRowHtml(hit: HltbSearchHit, index: number): string {
  if (!state) return "";
  const type = hit.dlc ? t("match.dlc") : t("match.game");
  const selected = state.choice.hltb?.id === hit.id;
  return `<button type="button" class="search-result-item match-row${selected ? " is-selected" : ""}" data-act="match-hltb-use" data-hit="${index}">
    <span class="result-info">
      <span class="result-name">${esc(hit.name)}</span>
      <span class="result-sub">${hit.year ?? "—"} · ${type} · ${t("hltb.mainStory")}: ${hoursLabel(hit.main_story)}</span>
    </span>
    ${selected ? `<span class="match-check">${icon("check", 14)}</span>` : ""}
  </button>`;
}

function resultsHtml(loading: boolean, error: string, rows: string): string {
  if (loading) {
    return `<div class="match-empty"><span class="hltb-spinner"></span> ${t("match.searching")}</div>`;
  }
  if (error) return `<div class="match-empty">${esc(error)}</div>`;
  return rows || `<div class="match-empty">${t("common.noResults")}</div>`;
}

export function openMatchModal(appName: string): void {
  const s = summaryOf(appName);
  if (!s) return;
  state = {
    appName,
    choice: {},
    igdbQuery: s.title,
    igdbHits: [],
    igdbLoading: true,
    igdbError: "",
    hltbQuery: s.title,
    hltbHits: [],
    hltbLoading: true,
    hltbError: "",
  };
  renderMatchModal();
  void gameMatchGet(appName)
    .then((choice) => {
      if (!state || state.appName !== appName) return;
      state.choice = choice ?? {};
      renderMatchModal();
    })
    .catch(() => undefined);
  void runIgdbSearch(s.title);
  void runHltbSearch(s.title);
}

export function closeMatchModal(): void {
  state = null;
  matchRoot().innerHTML = "";
}

export function matchModalOpen(): boolean {
  return state !== null;
}

export function renderMatchModal(): void {
  if (!state) return;
  const s = summaryOf(state.appName);
  const title = s?.title ?? state.appName;
  const igdbRows = state.igdbHits.map(igdbRowHtml).join("");
  const hltbRows = state.hltbHits.map(hltbRowHtml).join("");
  const root = matchRoot();
  root.innerHTML = `
    <div class="cover-overlay" data-act="match-backdrop">
      <div class="cover-dialog wide match-dialog" data-act="prevent-modal-close">
        <div class="cover-dialog-header">
          <div class="cover-dialog-title-group">
            <div class="cover-dialog-icon">${icon("search", 18)}</div>
            <div>
              <h2>${t("match.title")}</h2>
              <div class="cover-dialog-sub">${esc(title)}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-match-modal" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="cover-dialog-body">
          <p class="match-hint">${t("match.hint")}</p>
          <div class="match-grid">
            <section class="match-pane">
              <div class="match-pane-head">
                <span class="match-pane-title">${icon("globe", 14)} IGDB</span>
                <span class="match-current">${t("match.current")}: ${currentIgdbLine()}</span>
              </div>
              <div class="match-search">
                <input id="match-igdb-query" class="match-input" type="text" value="${esc(state.igdbQuery)}" placeholder="${t("common.search")}" />
                <button type="button" class="btn ghost small" data-act="match-igdb-search">${icon("search", 13)}</button>
              </div>
              <div class="match-results">${resultsHtml(state.igdbLoading, state.igdbError, igdbRows)}</div>
              <div class="match-foot">
                ${state.choice.igdbId ? `<button type="button" class="btn ghost small" data-act="match-igdb-auto">${icon("refresh", 13)} ${t("match.automatic")}</button>` : ""}
              </div>
            </section>
            <section class="match-pane">
              <div class="match-pane-head">
                <span class="match-pane-title">${icon("clock", 14)} HowLongToBeat</span>
                <span class="match-current">${t("match.current")}: ${currentHltbLine()}</span>
              </div>
              <div class="match-search">
                <input id="match-hltb-query" class="match-input" type="text" value="${esc(state.hltbQuery)}" placeholder="${t("common.search")}" />
                <button type="button" class="btn ghost small" data-act="match-hltb-search">${icon("search", 13)}</button>
              </div>
              <div class="match-results">${resultsHtml(state.hltbLoading, state.hltbError, hltbRows)}</div>
              <div class="match-foot">
                <button type="button" class="btn ghost small" data-act="match-hltb-auto">${icon("refresh", 13)} ${t("match.automatic")}</button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>`;

  const igdbInput = root.querySelector<HTMLInputElement>("#match-igdb-query");
  const hltbInput = root.querySelector<HTMLInputElement>("#match-hltb-query");
  igdbInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runIgdbSearch(igdbInput.value);
    }
  });
  hltbInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runHltbSearch(hltbInput.value);
    }
  });
  root.onkeydown = (event) => {
    if (event.key === "Escape") closeMatchModal();
  };
}

async function runIgdbSearch(query: string): Promise<void> {
  if (!state) return;
  const seq = ++igdbSeq;
  state.igdbQuery = query;
  state.igdbLoading = true;
  state.igdbError = "";
  renderMatchModal();
  try {
    const hits = await igdbSearch(query, 20);
    if (seq !== igdbSeq || !state) return;
    state.igdbHits = hits;
  } catch (error) {
    if (seq !== igdbSeq || !state) return;
    state.igdbHits = [];
    state.igdbError = messageOf(error);
  } finally {
    if (seq === igdbSeq && state) {
      state.igdbLoading = false;
      renderMatchModal();
    }
  }
}

async function runHltbSearch(query: string): Promise<void> {
  if (!state) return;
  const seq = ++hltbSeq;
  state.hltbQuery = query;
  state.hltbLoading = true;
  state.hltbError = "";
  renderMatchModal();
  try {
    const hits = await epicSearchHltb(query);
    if (seq !== hltbSeq || !state) return;
    state.hltbHits = hits;
  } catch (error) {
    if (seq !== hltbSeq || !state) return;
    state.hltbHits = [];
    state.hltbError = messageOf(error);
  } finally {
    if (seq === hltbSeq && state) {
      state.hltbLoading = false;
      renderMatchModal();
    }
  }
}

export function searchIgdbFromDialog(): void {
  const input = document.getElementById("match-igdb-query") as HTMLInputElement | null;
  if (input) void runIgdbSearch(input.value);
}

export function searchHltbFromDialog(): void {
  const input = document.getElementById("match-hltb-query") as HTMLInputElement | null;
  if (input) void runHltbSearch(input.value);
}

export async function useIgdbHit(id: number): Promise<void> {
  if (!state) return;
  const appName = state.appName;
  const s = summaryOf(appName);
  if (!s) return;
  try {
    const game = await igdbChooseMatch(appName, id);
    setIgdbGameFor(appName, game);
    recordLiveIgdbGame(appName, s.title, game);
    paintGameMeta(s);
    repaintIgdbBlocks(appName);
    scheduleRender();
    toast(t("match.savedIgdb"), "ok");
    closeMatchModal();
  } catch (error) {
    toast(messageOf(error), "err");
  }
}

export async function useHltbHit(index: number): Promise<void> {
  if (!state) return;
  const hit = state.hltbHits[index];
  if (!hit) return;
  const appName = state.appName;
  const s = summaryOf(appName);
  if (!s) return;
  try {
    const data = await epicSetHltbMatch(appName, s.title, hit);
    S.loadedHltb.set(appName, data);
    recordLiveHltb(appName, s.title, data);
    updateHltbUI(appName, data);
    scheduleRender();
    toast(t("match.savedHltb"), "ok");
    closeMatchModal();
  } catch (error) {
    toast(messageOf(error), "err");
  }
}

export async function restoreAutomaticIgdb(): Promise<void> {
  if (!state) return;
  const appName = state.appName;
  const s = summaryOf(appName);
  try {
    await igdbClearMatch(appName);
    forgetIgdbGame(appName);
    if (s) {
      const year = gameReleaseYear(s);
      ensureIgdbOverview(s, year, () => {
        paintGameMeta(s);
        repaintIgdbBlocks(appName);
      });
    }
    toast(t("match.autoRestored"), "ok");
    state.choice = await gameMatchGet(appName);
    renderMatchModal();
  } catch (error) {
    toast(messageOf(error), "err");
  }
}

export async function restoreAutomaticHltb(): Promise<void> {
  if (!state) return;
  const appName = state.appName;
  const s = summaryOf(appName);
  try {
    await epicClearHltbMatch(appName);
    S.loadedHltb.delete(appName);
    if (s) {
      const data = await epicGetHltb(s.title, appName, true, gameReleaseYear(s));
      S.loadedHltb.set(appName, data);
      recordLiveHltb(appName, s.title, data);
      updateHltbUI(appName, data);
      scheduleRender();
    }
    toast(t("match.autoRestored"), "ok");
    state.choice = await gameMatchGet(appName);
    renderMatchModal();
  } catch (error) {
    toast(messageOf(error), "err");
  }
}
