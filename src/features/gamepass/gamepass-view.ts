/**
 * Game Pass page: the public PC catalog, browsable without an Xbox account.
 *
 * The list comes from Microsoft's own catalog endpoints (`xbox_catalog.rs`) and
 * is cached for six hours. Rows that also exist in the library report their
 * real state: installed titles play, the rest hand the install to the Store
 * through the same watcher the library card uses.
 */

import { xboxGamePassCatalog, type GamePassTitle } from "../../companion";
import { handleGamePassDetailAction, openGamePassDetail } from "./gamepass-detail";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/** Cards per page: the catalog is ~600 rows and the grid is built in one string. */
const PAGE = 150;

let titles: GamePassTitle[] = [];
let loaded = false;
let loading = false;
let failed = false;
let query = "";
let limit = PAGE;

export function renderGamePassPage(): string {
  const body = failed ? errorState() : loaded ? gridHtml() : loadingState();
  return `
    <div class="page gp-page">
      <div class="page-head">
        <div>
          <h1 class="page-title">${esc(t("nav.gamepass"))}</h1>
          <p class="page-sub">${loaded ? `${titles.length} · PC` : "PC"}</p>
        </div>
        <div class="page-actions">
          <label class="gp-search">
            ${icon("search", 14)}
            <input id="gp-search" class="input" type="search" value="${esc(query)}" placeholder="${esc(t("gp.search"))}" spellcheck="false" ${loaded ? "" : "disabled"} />
          </label>
        </div>
      </div>
      <div id="gp-body">${body}</div>
    </div>`;
}

/** Loads the catalog once. Called when the page is opened. */
export function ensureGamePassLoaded(): void {
  if (loaded || loading) return;
  loading = true;
  failed = false;
  void xboxGamePassCatalog()
    .then((rows) => {
      titles = rows;
      loaded = rows.length > 0;
      failed = rows.length === 0;
    })
    .catch(() => {
      failed = true;
    })
    .finally(() => {
      loading = false;
      scheduleRender();
    });
}

function loadingState(): string {
  return `<div class="empty-state"><span class="spinner"></span></div>`;
}

function errorState(): string {
  return `
    <div class="empty-state">
      <p>${esc(t("gp.error"))}</p>
      <button class="btn ghost" data-act="gp-retry">${t("gp.retry")}</button>
    </div>`;
}

function gridHtml(): string {
  const rows = visibleTitles();
  if (rows.length === 0) {
    return `<div class="empty-state"><p>${esc(t("gp.empty"))}</p></div>`;
  }
  const installed = installedFamilies();
  const cards = rows.slice(0, limit).map((row) => cardHtml(row, installed.has(row.pfn)));
  const rest = rows.length - Math.min(rows.length, limit);
  return `
    <div class="gp-grid">
      <div class="pgrid">${cards.join("")}</div>
    </div>
    ${rest > 0 ? `<div class="gp-more"><button class="btn ghost" data-act="gp-more">${t("gp.more")} (${rest})</button></div>` : ""}`;
}

function cardHtml(row: GamePassTitle, installed: boolean): string {
  const waiting = row.pfn !== "" && S.xboxWaiting.has(row.pfn);
  const action = installed
    ? `<button class="btn play small" data-act="gp-play" data-id="${esc(row.pfn)}">${icon("play", 12)} ${t("common.play")}</button>`
    : waiting
      ? `<button class="btn primary small" data-act="xbox-install-cancel" data-id="${esc(row.pfn)}" title="${esc(t("xbox.installWaitingHint"))}">${icon("download", 12)} ${t("xbox.installWaiting")}</button>`
      : row.pfn !== ""
        ? `<button class="btn install small" data-act="gp-install" data-id="${esc(row.pfn)}">${icon("download", 12)} ${t("common.install")}</button>`
        : `<button class="btn ghost small" data-act="gp-open" data-id="${esc(row.productId)}">${icon("external", 12)} ${t("ctx.storePage")}</button>`;
  const art = row.poster || row.hero;
  const media = art
    ? `<img src="${esc(art)}" alt="" loading="lazy" decoding="async" />`
    : `<div class="pcover">${icon("gamepad-2", 32)}</div>`;
  return `
    <div class="pcard gp-card" role="button" tabindex="0" data-act="gp-open" data-id="${esc(row.productId)}" aria-label="${esc(row.title)}">
      <div class="pcard-art">
        ${media}
        ${installed ? `<span class="gp-chip">${icon("check", 11)} ${t("common.installed")}</span>` : ""}
      </div>
      <div class="pcard-caption">
        <span class="pcard-title-row"><span class="pcard-title">${esc(row.title)}</span></span>
        <span class="gp-publisher">${esc(row.publisher)}</span>
        <span class="gp-actions">${action}</span>
      </div>
    </div>`;
}

function visibleTitles(): GamePassTitle[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return titles;
  return titles.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.publisher.toLowerCase().includes(needle) ||
      row.developer.toLowerCase().includes(needle),
  );
}

/** Family names the library already knows as installed. */
function installedFamilies(): Set<string> {
  const families = new Set<string>();
  for (const item of S.companionSummaries) {
    if (!item.installed || !item.key.startsWith("xbox::")) continue;
    families.add(item.key.slice("xbox::".length));
  }
  return families;
}

/** Rebuilds the grid in place so the search field keeps focus and its caret. */
function paintGrid(): void {
  const body = document.getElementById("gp-body");
  if (!body) return;
  body.innerHTML = gridHtml();
}

/** Loads more rows, retries a failed fetch, or opens a game page. */
export function handleGamePassAction(act: string | undefined, id: string | undefined): boolean {
  // The open game page answers its own buttons first.
  if (handleGamePassDetailAction(act, id)) return true;
  if (act === "gp-more") {
    limit += PAGE;
    paintGrid();
    return true;
  }
  if (act === "gp-retry") {
    loaded = false;
    failed = false;
    loading = false;
    ensureGamePassLoaded();
    scheduleRender();
    return true;
  }
  if (act === "gp-open" && id) {
    const row = titles.find((title) => title.productId === id);
    if (row) openGamePassDetail(row);
    return true;
  }
  return false;
}

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.id !== "gp-search") return;
  query = target.value;
  limit = PAGE;
  paintGrid();
});
