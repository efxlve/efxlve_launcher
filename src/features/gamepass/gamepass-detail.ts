/**
 * Game Pass game page.
 *
 * Opens from a catalog card and fills in from Microsoft's product record:
 * hero art and wordmark, description, screenshots, age rating and genres, the
 * package to install, and every store where the player already has the game.
 * The page paints immediately with the catalog art it already has, then swaps
 * in the full record when it lands.
 */

import {
  companionLaunch,
  xboxGamePassDetail,
  xboxInstall,
  xboxOpenStore,
  type GamePassDetail,
  type GamePassTitle,
} from "../../companion";
import { confirmRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

let layer: HTMLElement | null = null;
let openId = "";
let lastRow: GamePassTitle | null = null;
let lastDetail: GamePassDetail | null = null;

/** Store labels for the "where you have it" list; brand names, not UI strings. */
const STORE_LABEL: Record<string, string> = {
  epic: "Epic Games",
  gog: "GOG",
  steam: "Steam",
  amazon: "Amazon Games",
  xbox: "Xbox",
  ea: "EA App",
  ubisoft: "Ubisoft Connect",
  battlenet: "Battle.net",
  custom: "Custom",
};

export function openGamePassDetail(row: GamePassTitle): void {
  closeGamePassDetail();
  openId = row.productId;
  lastRow = row;
  lastDetail = null;
  const el = document.createElement("div");
  el.className = "gp-layer";
  el.innerHTML = shell(row, null);
  confirmRoot.appendChild(el);
  layer = el;
  void xboxGamePassDetail(row.productId)
    .then((detail) => {
      // A second card may have been opened while this one was loading.
      if (!detail || !layer || openId !== row.productId) return;
      lastDetail = detail;
      paint();
    })
    .catch(() => {});
}

export function closeGamePassDetail(): void {
  layer?.remove();
  layer = null;
  openId = "";
  lastRow = null;
  lastDetail = null;
}

/** Repaints the open page, e.g. after an install starts or finishes. */
export function refreshGamePassDetail(): void {
  if (layer && lastRow) paint();
}

export function handleGamePassDetailAction(act: string | undefined, id: string | undefined): boolean {
  if (act === "gp-detail-close") {
    closeGamePassDetail();
    return true;
  }
  if (act === "gp-store" && id) {
    void xboxOpenStore(id).catch(() => {});
    return true;
  }
  if (act === "gp-install" && id) {
    void xboxInstall(id).catch(() => {});
    return true;
  }
  if (act === "gp-play" && id) {
    void companionLaunch("xbox", id).catch(() => {});
    return true;
  }
  return false;
}

function paint(): void {
  if (!layer || !lastRow) return;
  // Keep the scroll position: the page may be repainted while the reader is
  // halfway down the description.
  const scroller = layer.querySelector<HTMLElement>(".gp-detail");
  const top = scroller?.scrollTop ?? 0;
  layer.innerHTML = shell(lastRow, lastDetail);
  const next = layer.querySelector<HTMLElement>(".gp-detail");
  if (next) next.scrollTop = top;
}

function shell(row: GamePassTitle, detail: GamePassDetail | null): string {
  const title = detail?.title || row.title;
  const publisher = detail?.publisher || row.publisher;
  const hero = detail?.hero || row.hero || row.poster;
  const poster = detail?.poster || row.poster;
  const logo = detail?.logo || "";
  const chips = chipsHtml(detail, publisher);
  const description = detail?.description || "";
  const shots = detail?.screenshots ?? [];
  const where = whereToPlay(title);
  return `
    <div class="modal-backdrop" data-act="gp-detail-close">
      <div class="modal gp-detail" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <button type="button" class="manage-head-close gp-detail-x" data-act="gp-detail-close" title="${esc(t("common.close"))}">${icon("x", 18)}</button>
        <div class="gp-detail-hero">
          ${hero ? `<img class="gp-hero-art" src="${esc(hero)}" alt="" />` : ""}
          <div class="gp-detail-hero-fade"></div>
          <div class="gp-detail-hero-copy">
            ${logo ? `<img class="gp-detail-logo" src="${esc(logo)}" alt="${esc(title)}" />` : `<h2 class="gp-detail-title">${esc(title)}</h2>`}
            ${chips}
          </div>
        </div>
        <div class="gp-detail-body">
          <div class="gp-detail-main">
            ${
              detail
                ? `<p class="gp-desc">${esc(description)}</p>`
                : `<div class="gp-detail-loading"><span class="spinner"></span></div>`
            }
            ${
              shots.length > 0
                ? `<h4 class="gp-section">${esc(t("gp.screenshots"))}</h4>
                   <div class="gp-shots">${shots.map((src) => `<img src="${esc(src)}" alt="" loading="lazy" />`).join("")}</div>`
                : ""
            }
          </div>
          <aside class="gp-detail-side">
            ${poster ? `<div class="gp-detail-poster"><img src="${esc(poster)}" alt="" /></div>` : ""}
            <div class="gp-detail-actions">${actionsHtml(row, detail)}</div>
            ${
              where.length > 0
                ? `<h4 class="gp-section">${esc(t("gp.where"))}</h4>
                   <div class="gp-where">${where.map(whereRow).join("")}</div>`
                : ""
            }
          </aside>
        </div>
      </div>
    </div>`;
}

function chipsHtml(detail: GamePassDetail | null, publisher: string): string {
  const chips: string[] = [];
  const year = (detail?.releaseDate || "").slice(0, 4);
  if (year) chips.push(year);
  if (detail?.rating) chips.push(detail.rating);
  for (const genre of detail?.genres.slice(0, 2) ?? []) chips.push(genre);
  if (publisher) chips.push(publisher);
  if (chips.length === 0) return "";
  return `<div class="gp-detail-chips">${chips
    .map((chip) => `<span class="gp-chipmeta">${esc(chip)}</span>`)
    .join("")}</div>`;
}

function actionsHtml(row: GamePassTitle, detail: GamePassDetail | null): string {
  const pfn = detail?.pfn || row.pfn;
  const installed = pfn !== "" && installedFamilies().has(pfn);
  if (installed) {
    return `<button class="btn play" data-act="gp-play" data-id="${esc(pfn)}">${icon("play", 16)} ${t("common.play")}</button>`;
  }
  if (pfn !== "" && S.xboxWaiting.has(pfn)) {
    return `<button class="btn primary" data-act="xbox-install-cancel" data-id="${esc(pfn)}" title="${esc(t("xbox.installWaitingHint"))}">${icon("download", 16)} ${t("xbox.installWaiting")}</button>`;
  }
  const install =
    pfn !== ""
      ? `<button class="btn install" data-act="gp-install" data-id="${esc(pfn)}">${icon("download", 16)} ${t("common.install")}</button>`
      : "";
  const store = `<button class="btn ghost" data-act="gp-store" data-id="${esc(row.productId)}">${icon("external", 15)} ${t("ctx.storePage")}</button>`;
  return install + store;
}

function whereRow(entry: { store: string; installed: boolean }): string {
  const label = STORE_LABEL[entry.store] ?? entry.store;
  const state = entry.installed ? t("common.installed") : t("gp.owned");
  return `<div class="gp-where-row"><span>${esc(label)}</span><span class="gp-where-state">${esc(state)}</span></div>`;
}

/** Every store where the same title already exists in the player's library. */
function whereToPlay(title: string): { store: string; installed: boolean }[] {
  const needle = normTitle(title);
  if (!needle) return [];
  const hits: { store: string; installed: boolean }[] = [];
  const add = (store: string, name: string, installed: boolean) => {
    if (normTitle(name) !== needle) return;
    if (hits.some((hit) => hit.store === store)) return;
    hits.push({ store, installed });
  };
  for (const item of S.epicSummaries) add("epic", item.title, item.installed);
  for (const item of S.gogSummaries) add("gog", item.title, item.installed);
  for (const item of S.amazonSummaries) add("amazon", item.title, item.installed);
  for (const item of S.steamSummaries) add("steam", item.title, item.installed);
  for (const item of S.companionSummaries) {
    const store = item.key.slice(0, item.key.indexOf("::"));
    add(store, item.title, item.installed);
  }
  for (const game of S.customGames) add("custom", game.title, true);
  return hits;
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

/** Lowercase, trademark marks and punctuation removed: "S.T.A.L.K.E.R. 2" ≈ "stalker 2". */
function normTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !layer) return;
  closeGamePassDetail();
});
