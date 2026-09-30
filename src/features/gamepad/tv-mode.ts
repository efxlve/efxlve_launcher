/**
 * TV Mode: fullscreen Big Picture shell (Steam Deck / 10-ft).
 *
 * Home is a full-bleed hero of the focused game with cover shelves underneath.
 * A opens a cinematic game page in this shell (not the desktop drawer). Enter
 * plays a short boot, then the OS window goes fullscreen.
 */

import { invoke } from "@tauri-apps/api/core";
import { isSteamDeckDevice, isTauri, NO_DESC } from "../../core/constants";
import { toastsEl } from "../../core/dom";
import { achSummaryOf, epicActionButtons, epicArt, toggleFav } from "../../core/game-view";
import { icon } from "../../core/icons";
import { closeModal } from "../../core/dom";
import { render } from "../../core/render";
import { epicWideArt, gogToEpicSummary, libraryItemToSummary, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc, fmtPlaytime } from "../../core/utils";
import { handleWindowResize } from "../../core/window";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import { setView } from "../store/store-view";

const ROW_LIMIT = 40;
const SKIP = 5;
const BOOT_MS = 1700;

let rows: { title: string; apps: string[] }[] = [];
let focusRow = 0;
let focusCol = 0;
let autoEntered = false;
let lastBgUrl = "";
let detailApp: string | null = null;
let bootTimer = 0;

export { isSteamDeckDevice };

export function tvDetailOpen(): boolean {
  return detailApp !== null;
}

function bumpHud(): void {
  document.dispatchEvent(new Event("efxlve-hud"));
}

function allItems(): EpicSummary[] {
  const out: EpicSummary[] = [];
  for (const s of S.epicSummaries) {
    if (!S.hiddenGames.has(s.appName)) out.push(s);
  }
  for (const g of S.gogSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(gogToEpicSummary(g));
  }
  for (const g of S.steamSummaries) {
    if (!S.hiddenGames.has(g.key)) out.push(libraryItemToSummary(g));
  }
  return out;
}

function hasPendingUpdate(s: EpicSummary): boolean {
  return Boolean(s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName));
}

function take(ids: Iterable<string>, byId: Map<string, EpicSummary>, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function buildRows(): void {
  const items = allItems();
  const byId = new Map(items.map((s) => [s.appName, s]));
  rows = [
    { title: t("tv.rowRecent"), apps: take(S.epicRecent, byId, ROW_LIMIT) },
    { title: t("tv.rowUpdates"), apps: take(items.filter(hasPendingUpdate).map((s) => s.appName), byId, ROW_LIMIT) },
    { title: t("tv.rowFavorites"), apps: take(S.epicFav, byId, ROW_LIMIT) },
    { title: t("tv.rowInstalled"), apps: take(items.filter((s) => s.installed).map((s) => s.appName), byId, ROW_LIMIT) },
    { title: t("tv.rowLibrary"), apps: take(items.filter((s) => !s.installed).map((s) => s.appName), byId, ROW_LIMIT) },
  ].filter((r) => r.apps.length > 0);
  focusRow = Math.min(focusRow, Math.max(0, rows.length - 1));
  focusCol = Math.min(focusCol, Math.max(0, (rows[focusRow]?.apps.length ?? 1) - 1));
}

function focusedGame(): EpicSummary | undefined {
  const id = rows[focusRow]?.apps[focusCol];
  return id ? summaryOf(id) : undefined;
}

function storeLabel(id: string): string {
  if (id.startsWith("gog::")) return "GOG";
  if (id.startsWith("steam::")) return "Steam";
  return "Epic";
}

function tvBlurb(s: EpicSummary): string {
  const raw = s.description;
  if (!raw || raw === NO_DESC) return "";
  const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function artUrl(s: EpicSummary | undefined): string {
  if (!s) return "";
  return epicWideArt(s) || s.cover || "";
}

function homeCopy(s: EpicSummary | undefined): string {
  if (!s) return `<p class="tv-empty">${esc(t("lib.noGames"))}</p>`;
  const pt = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const bits = [
    storeLabel(s.appName),
    s.installed ? t("common.installed") : t("common.notInstalled"),
    hasPendingUpdate(s) ? t("common.update") : "",
    pt > 0 ? fmtPlaytime(pt) : "",
  ].filter(Boolean);
  return `
    <h1 class="tv-home-title">${esc(s.title)}</h1>
    <div class="tv-home-meta">${esc(bits.join("  /  "))}</div>
    <div class="tv-home-cta">${epicActionButtons(s, "", { primaryOnly: true })}</div>`;
}

function paintBg(url: string): void {
  const layer = document.getElementById("tv-bg");
  if (!layer) return;
  if (!url) {
    lastBgUrl = "";
    return;
  }
  if (url === lastBgUrl) return;
  const shown = layer.querySelector<HTMLImageElement>(".tv-bg-img.is-show");
  const hidden = layer.querySelector<HTMLImageElement>(".tv-bg-img:not(.is-show)");
  if (!hidden) return;
  hidden.src = url;
  const reveal = (): void => {
    hidden.classList.add("is-show");
    shown?.classList.remove("is-show");
    lastBgUrl = url;
  };
  if (hidden.complete && hidden.naturalWidth > 0) reveal();
  else hidden.onload = reveal;
}

function paintHomeCopy(): void {
  const host = document.getElementById("tv-home-copy");
  if (host) host.innerHTML = homeCopy(focusedGame());
}

function applyFocus(): void {
  document.querySelectorAll<HTMLElement>(".tv-card.focused").forEach((el) => el.classList.remove("focused"));
  const card = document.querySelector<HTMLElement>(`.tv-card[data-row="${focusRow}"][data-col="${focusCol}"]`);
  if (card) {
    card.classList.add("focused");
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  const game = focusedGame();
  paintBg(artUrl(game));
  paintHomeCopy();
  if (detailApp) paintDetail();
}

export function renderTvMode(): string {
  buildRows();
  lastBgUrl = "";
  const game = focusedGame();
  const bg = artUrl(game);
  const rowsHtml = rows
    .map(
      (row, r) => `
    <section class="tv-row" data-row="${r}">
      <h2 class="tv-row-title">${esc(row.title)}</h2>
      <div class="tv-row-track">
        ${row.apps
          .map((id, c) => {
            const s = summaryOf(id);
            if (!s) return "";
            const focused = r === focusRow && c === focusCol;
            return `<button type="button" class="tv-card${focused ? " focused" : ""}" data-row="${r}" data-col="${c}" data-id="${esc(id)}" tabindex="-1" title="${esc(s.title)}">${epicArt(s)}</button>`;
          })
          .join("")}
      </div>
    </section>`,
    )
    .join("");

  return `
    <div class="tv-screen" id="tv-screen">
      <div class="tv-bg" id="tv-bg">
        <img class="tv-bg-img is-show" alt="" decoding="async" ${bg ? `src="${esc(bg)}"` : ""} />
        <img class="tv-bg-img" alt="" decoding="async" />
        <div class="tv-bg-scrim"></div>
      </div>
      <button type="button" class="tv-exit" data-act="close-tv-mode">${icon("x", 16)} ${t("tv.exit")}</button>
      <div class="tv-home" id="tv-home">
        <div class="tv-home-copy" id="tv-home-copy">${homeCopy(game)}</div>
        <div class="tv-rows">${rowsHtml || `<p class="tv-empty">${t("lib.noGames")}</p>`}</div>
      </div>
      <div class="tv-detail" id="tv-detail" hidden></div>
    </div>`;
}

/** Re-bind focus after a full view render so a library sync does not drop the cursor. */
export function hydrateTvMode(): void {
  lastBgUrl = "";
  applyFocus();
  if (detailApp) paintDetail();
}

function detailHtml(s: EpicSummary): string {
  const pt = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const ach = achSummaryOf(s.appName);
  const faved = S.epicFav.has(s.appName);
  const blurb = tvBlurb(s);
  const cover = s.cover;
  const bits = [
    storeLabel(s.appName),
    s.installed ? t("common.installed") : t("common.notInstalled"),
    hasPendingUpdate(s) ? t("common.update") : "",
    pt > 0 ? fmtPlaytime(pt) : "",
    ach?.supported && ach.total_achievements > 0 ? `${ach.user_unlocked}/${ach.total_achievements}` : "",
  ].filter(Boolean);
  return `
    <div class="tv-detail-inner">
      <div class="tv-detail-copy">
        <h1 class="tv-detail-title">${esc(s.title)}</h1>
        <div class="tv-detail-meta">${esc(bits.join("  /  "))}</div>
        ${blurb ? `<p class="tv-detail-blurb">${esc(blurb)}</p>` : ""}
        <div class="tv-detail-cta">
          ${epicActionButtons(s, "", { primaryOnly: true })}
          <button type="button" class="btn ghost${faved ? " faved" : ""}" data-act="epic-fav" data-id="${esc(s.appName)}">${icon("heart", 16)} ${faved ? t("common.favorited") : t("common.favorite")}</button>
        </div>
      </div>
      ${cover ? `<div class="tv-detail-cover">${epicArt(s)}</div>` : ""}
    </div>`;
}

function paintDetail(): void {
  const el = document.getElementById("tv-detail");
  if (!el) return;
  const s = detailApp ? summaryOf(detailApp) : focusedGame();
  if (!s) {
    closeDetail();
    return;
  }
  detailApp = s.appName;
  el.hidden = false;
  el.innerHTML = detailHtml(s);
  document.body.classList.add("tv-detail-open");
  paintBg(artUrl(s));
  bumpHud();
}

function closeDetail(): void {
  detailApp = null;
  document.body.classList.remove("tv-detail-open");
  const el = document.getElementById("tv-detail");
  if (el) {
    el.hidden = true;
    el.innerHTML = "";
  }
  bumpHud();
  applyFocus();
}

export function tvMove(dir: "up" | "down" | "left" | "right"): void {
  if (rows.length === 0) return;
  if (detailApp) {
    if (dir === "left" || dir === "right") tvNeighbor(dir === "right" ? 1 : -1);
    return;
  }
  if (dir === "left") focusCol = Math.max(0, focusCol - 1);
  else if (dir === "right") focusCol = Math.min(rows[focusRow].apps.length - 1, focusCol + 1);
  else {
    focusRow = Math.max(0, Math.min(rows.length - 1, focusRow + (dir === "down" ? 1 : -1)));
    focusCol = Math.min(focusCol, rows[focusRow].apps.length - 1);
  }
  applyFocus();
}

export function tvSkip(dir: 1 | -1): void {
  if (!rows[focusRow]) return;
  const n = rows[focusRow].apps.length;
  focusCol = Math.max(0, Math.min(n - 1, focusCol + dir * SKIP));
  applyFocus();
}

export function tvRowJump(step: number): void {
  if (detailApp) {
    tvNeighbor(step);
    return;
  }
  tvMove(step > 0 ? "down" : "up");
}

/** Step to the next/previous cover in the current shelf (detail page). */
export function tvNeighbor(step: number): void {
  if (!rows[focusRow]) return;
  const n = rows[focusRow].apps.length;
  focusCol = Math.max(0, Math.min(n - 1, focusCol + step));
  applyFocus();
}

/** A: open the game page on the home, play from the game page. */
export function tvActivate(): void {
  if (detailApp) {
    document.querySelector<HTMLElement>("#tv-detail .tv-detail-cta .btn")?.click();
    return;
  }
  tvOpenDetails();
}

export function tvOpenDetails(): void {
  const s = focusedGame();
  if (!s) return;
  detailApp = s.appName;
  paintDetail();
}

export function tvFavorite(): void {
  const s = detailApp ? summaryOf(detailApp) : focusedGame();
  if (s) toggleFav(s.appName);
}

export function tvBack(): void {
  if (detailApp) {
    closeDetail();
    return;
  }
  if (S.currentModalAppName) {
    closeModal();
    return;
  }
  closeTvMode();
}

async function setOsFullscreen(on: boolean): Promise<void> {
  if (isTauri) {
    try {
      await invoke("app_set_fullscreen", { enabled: on });
      handleWindowResize();
      return;
    } catch {
      /* fall through to the browser fullscreen API */
    }
  }
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* ignored: some shells block fullscreen without a gesture */
  }
}

function spawnBoot(): void {
  window.clearTimeout(bootTimer);
  document.getElementById("tv-boot")?.remove();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.createElement("div");
  el.id = "tv-boot";
  el.className = "tv-boot";
  el.innerHTML = `<div class="tv-boot-line"></div><div class="tv-boot-mark">Efxlve</div>`;
  document.body.appendChild(el);
  const done = (): void => el.remove();
  el.addEventListener("animationend", (e) => {
    if ((e as AnimationEvent).animationName === "tv-boot-fade") done();
  });
  bootTimer = window.setTimeout(done, BOOT_MS);
}

export function openTvMode(): void {
  if (S.view === "tv") return;
  focusRow = 0;
  focusCol = 0;
  detailApp = null;
  lastBgUrl = "";
  setView("tv");
  render();
  spawnBoot();
  void setOsFullscreen(true);
  requestAnimationFrame(hydrateTvMode);
}

export function closeTvMode(): void {
  if (S.view !== "tv") return;
  window.clearTimeout(bootTimer);
  document.getElementById("tv-boot")?.remove();
  closeDetail();
  void setOsFullscreen(false);
  setView("library");
  render();
}

export function toggleTvMode(): void {
  if (S.view === "tv") closeTvMode();
  else openTvMode();
}

export function showTvPrompt(name: string): boolean {
  if (S.view === "tv") return false;
  const el = document.createElement("div");
  el.className = "toast ok tv-prompt";
  el.innerHTML = `<span>${esc(t("gamepad.connected", { name }))}</span><button class="btn primary small" data-act="open-tv-mode">${t("tv.prompt")}</button>`;
  toastsEl.appendChild(el);
  el.addEventListener("click", () => el.remove());
  window.setTimeout(() => el.remove(), 8000);
  return true;
}

export function onControllerConnected(name: string): boolean {
  if (S.view === "tv") return false;
  if (S.tvAutoEnter && !autoEntered) {
    autoEntered = true;
    openTvMode();
    return true;
  }
  return showTvPrompt(name);
}

export function markDeckChrome(): void {
  document.documentElement.classList.toggle("is-steam-deck", isSteamDeckDevice());
}

document.addEventListener("click", (e) => {
  if (S.view !== "tv") return;
  const tEl = e.target as HTMLElement;
  if (tEl.closest(".tv-home-cta, .tv-detail-cta, .tv-exit")) return;
  const card = tEl.closest<HTMLElement>(".tv-card");
  if (!card) return;
  e.preventDefault();
  e.stopPropagation();
  focusRow = Number(card.dataset.row);
  focusCol = Number(card.dataset.col);
  applyFocus();
  tvOpenDetails();
}, true);

document.addEventListener("keydown", (e) => {
  if (S.view !== "tv" || document.getElementById("palette-root")?.firstElementChild) return;
  const map: Record<string, "up" | "down" | "left" | "right"> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  if (map[e.key]) {
    e.preventDefault();
    e.stopPropagation();
    tvMove(map[e.key]);
  } else if (e.key === "Enter") {
    e.preventDefault();
    tvActivate();
  } else if (e.key === "Escape" || e.key === "Backspace") {
    e.preventDefault();
    tvBack();
  } else if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    tvFavorite();
  } else if (e.key === "i" || e.key === "I") {
    e.preventDefault();
    tvOpenDetails();
  } else if (e.key === "PageDown") {
    e.preventDefault();
    tvSkip(1);
  } else if (e.key === "PageUp") {
    e.preventDefault();
    tvSkip(-1);
  }
}, true);

document.addEventListener("mouseover", (e) => {
  if (S.view !== "tv" || detailApp) return;
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
