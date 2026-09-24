/**
 * TV Mode: a separate full-screen, controller-first view (Playnite / Big
 * Picture model) so the desktop UI can stay dense and mouse-first.
 *
 * Layout: a hero for the focused game (wide art, title, primary action) above
 * horizontal cover rows. Focus is tracked as (row, col) in this module and
 * moving it only patches the hero text/image and two card classes; the rows
 * are never rebuilt while navigating.
 */

import { epicActionButtons, epicArt } from "../../core/game-view";
import { icon } from "../../core/icons";
import { openEpicModal, render } from "../../core/render";
import { epicWideArt, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { toastsEl } from "../../core/dom";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { setView } from "../store/store-view";

/** Rows are capped so the TV view never mounts the whole 500-game library. */
const ROW_LIMIT = 40;

let rows: { title: string; apps: string[] }[] = [];
let focusRow = 0;
let focusCol = 0;

function buildRows(): void {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (const id of S.epicRecent) {
    if (summaryOf(id)) {
      recent.push(id);
      seen.add(id);
    }
  }
  const installed = S.epicSummaries.filter((s) => s.installed && !seen.has(s.appName)).map((s) => s.appName);
  const library = S.epicSummaries.filter((s) => !s.installed).slice(0, ROW_LIMIT).map((s) => s.appName);
  rows = [
    { title: t("tv.rowRecent"), apps: recent.slice(0, ROW_LIMIT) },
    { title: t("tv.rowInstalled"), apps: installed.slice(0, ROW_LIMIT) },
    { title: t("tv.rowLibrary"), apps: library },
  ].filter((r) => r.apps.length > 0);
  focusRow = Math.min(focusRow, Math.max(0, rows.length - 1));
  focusCol = Math.min(focusCol, Math.max(0, (rows[focusRow]?.apps.length ?? 1) - 1));
}

function focusedGame(): EpicSummary | undefined {
  const id = rows[focusRow]?.apps[focusCol];
  return id ? summaryOf(id) : undefined;
}

function heroInner(s: EpicSummary | undefined): string {
  if (!s) return "";
  const art = epicWideArt(s) || s.cover;
  const pt = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const meta = [s.installed ? t("common.installed") : t("common.notInstalled"), pt > 0 ? fmtPlaytime(pt) : ""].filter(Boolean).join(" · ");
  return `
    ${art ? `<img class="tv-hero-img" src="${esc(art)}" alt="" decoding="async" />` : ""}
    <div class="gp-hero-scrim"></div>
    <div class="tv-hero-body">
      <h1 class="tv-hero-title">${esc(s.title)}</h1>
      <div class="tv-hero-meta">${esc(meta)}</div>
      <div class="tv-hero-action">${epicActionButtons(s, "", { primaryOnly: true })}</div>
    </div>`;
}

export function renderTvMode(): string {
  buildRows();
  const rowsHtml = rows.map((row, r) => `
    <section class="tv-row" data-row="${r}">
      <h2 class="tv-row-title">${esc(row.title)}</h2>
      <div class="tv-row-track">
        ${row.apps.map((id, c) => {
          const s = summaryOf(id);
          if (!s) return "";
          const focused = r === focusRow && c === focusCol;
          return `<button class="tv-card${focused ? " focused" : ""}" data-row="${r}" data-col="${c}" data-act="epic-detail" data-id="${esc(id)}" tabindex="-1" title="${esc(s.title)}">${epicArt(s)}</button>`;
        }).join("")}
      </div>
    </section>`).join("");

  return `
    <div class="tv-screen">
      <div class="tv-top">
        <span class="tv-brand"><span class="sb-logo">${icon("gamepad-2", 17)}</span>Efxlve</span>
        <button class="btn ghost small" data-act="close-tv-mode">${icon("minimize-2", 14)} ${t("tv.exit")}</button>
      </div>
      <div class="tv-hero" id="tv-hero">${heroInner(focusedGame())}</div>
      <div class="tv-rows">${rowsHtml || `<p class="tv-empty">${t("lib.noGames")}</p>`}</div>
    </div>`;
}

/** Applies the current (row, col) focus without rebuilding the rows. */
function applyFocus(): void {
  document.querySelectorAll<HTMLElement>(".tv-card.focused").forEach((el) => el.classList.remove("focused"));
  const card = document.querySelector<HTMLElement>(`.tv-card[data-row="${focusRow}"][data-col="${focusCol}"]`);
  if (card) {
    card.classList.add("focused");
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const hero = document.getElementById("tv-hero");
  if (hero) hero.innerHTML = heroInner(focusedGame());
}

export function tvMove(dir: "up" | "down" | "left" | "right"): void {
  if (rows.length === 0) return;
  if (dir === "left") focusCol = Math.max(0, focusCol - 1);
  else if (dir === "right") focusCol = Math.min(rows[focusRow].apps.length - 1, focusCol + 1);
  else {
    focusRow = Math.max(0, Math.min(rows.length - 1, focusRow + (dir === "down" ? 1 : -1)));
    focusCol = Math.min(focusCol, rows[focusRow].apps.length - 1);
  }
  applyFocus();
}

/** LB/RB jump between rows. */
export function tvRowJump(step: number): void {
  tvMove(step > 0 ? "down" : "up");
}

/** A: run the focused game's primary action (play / install / update). */
export function tvActivate(): void {
  document.querySelector<HTMLElement>("#tv-hero .tv-hero-action .btn")?.click();
}

/** X: open the focused game's page. */
export function tvOpenDetails(): void {
  const s = focusedGame();
  if (s) openEpicModal(s.appName);
}

export function openTvMode(): void {
  focusRow = 0;
  focusCol = 0;
  setView("tv");
  render();
  requestAnimationFrame(applyFocus);
}

export function closeTvMode(): void {
  setView("library");
  render();
}

/** Non-blocking suggestion shown when a controller connects on the desktop UI. */
export function showTvPrompt(name: string): void {
  if (S.view === "tv" || !S.epicAccount || S.epicPhase !== "library") return;
  const el = document.createElement("div");
  el.className = "toast ok tv-prompt";
  el.innerHTML = `<span>${esc(t("gamepad.connected", { name }))}</span><button class="btn primary small" data-act="open-tv-mode">${t("tv.prompt")}</button>`;
  toastsEl.appendChild(el);
  el.addEventListener("click", () => el.remove());
  window.setTimeout(() => el.remove(), 8000);
}

// Keyboard parity with the controller while TV Mode is active.
document.addEventListener("keydown", (e) => {
  if (S.view !== "tv" || S.currentModalAppName || document.getElementById("palette-root")?.firstElementChild) return;
  const map: Record<string, "up" | "down" | "left" | "right"> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  if (map[e.key]) {
    e.preventDefault();
    tvMove(map[e.key]);
  } else if (e.key === "Enter") {
    e.preventDefault();
    tvActivate();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeTvMode();
  }
});

// Mouse hover moves focus too, so the hero always describes what is under the cursor.
document.addEventListener("mouseover", (e) => {
  if (S.view !== "tv") return;
  const card = (e.target as HTMLElement).closest?.<HTMLElement>(".tv-card");
  if (!card) return;
  const r = Number(card.dataset.row);
  const c = Number(card.dataset.col);
  if (r !== focusRow || c !== focusCol) {
    focusRow = r;
    focusCol = c;
    applyFocus();
  }
}, { passive: true });
