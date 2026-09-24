/**
 * Shared game presentation helpers used by library cards and the detail drawer.
 *
 * These read shared state (S) and return HTML fragments. They are used by more
 * than one feature module, so they live in `core` rather than inside a single
 * feature.
 */

import { epicPortrait, getThirdPartyLauncher, requiresThirdPartyLauncher, type EpicSummary } from "../epic";
import { t } from "../i18n";
import { FAV_KEY } from "./constants";
import { icon } from "./icons";
import { openEpicModal, render } from "./render";
import { rawOf } from "./selectors";
import { S } from "./state";
import { esc } from "./utils";

/** Exception badge for a library tile (update / running only — never "Installed"). */
export function libraryCardBadge(s: EpicSummary): string {
  if (S.runningGames.has(s.appName)) {
    return `<span class="pbadge running">${t("lib.running")}</span>`;
  }
  if (s.updateAvailable || S.availableUpdates.has(s.appName)) {
    return `<span class="pbadge update">${t("lib.updateBadge")}</span>`;
  }
  return "";
}

/** Thin download bar shown on a library cover / list thumbnail. */
export function libraryDlBar(appName: string, p: number | null): string {
  return p !== null
    ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${appName}" style="width:${p}%"></div></div>`
    : "";
}

/**
 * Patch visible library items (grid cards and list rows) in place: badge,
 * installed dimming, primary action and download bar. Never rebuilds the
 * grid — a full library innerHTML is treated as a bug.
 */
export function patchLibraryCardDom(appName: string): boolean {
  const s = S.epicSummariesMap.get(appName);
  const items = document.querySelectorAll<HTMLElement>(`[data-lib-item="${appName}"]`);
  if (!s || items.length === 0) return false;
  const p = epicDlProgress(appName);
  const badgeHtml = libraryCardBadge(s);
  const actions = epicActionButtons(s, "full", { primaryOnly: true });
  items.forEach((item) => {
    item.classList.toggle("not-installed", !s.installed);
    const badgeHost = item.querySelector<HTMLElement>("[data-badge-host]");
    const badge = badgeHost?.querySelector(".pbadge");
    if (badgeHtml) {
      if (badge) badge.outerHTML = badgeHtml;
      else badgeHost?.insertAdjacentHTML("beforeend", badgeHtml);
    } else if (badge) {
      badge.remove();
    }
    const actionHost = item.querySelector<HTMLElement>("[data-card-action]");
    if (actionHost) actionHost.innerHTML = actions;
    const art = item.querySelector<HTMLElement>("[data-card-art]");
    const track = art?.querySelector(".card-dl-track");
    if (p !== null) {
      const bar = track?.querySelector<HTMLElement>(".card-dl-bar");
      if (bar) bar.style.width = `${p}%`;
      else art?.insertAdjacentHTML("beforeend", libraryDlBar(appName, p));
    } else if (track) {
      track.remove();
    }
  });
  return true;
}

/**
 * Repaints the action for a game after its download / running state changes.
 * Library cards are patched in place; the downloads view still needs a full paint.
 */
export function refreshGameActionUi(appName: string): void {
  if (S.view === "library") patchLibraryCardDom(appName);
  else if (S.view === "downloads") render();
  if (S.currentModalAppName === appName) openEpicModal(appName, false);
}

/** True when the game has the platinum trophy (100% achievements). */
export function isAppPlatinum(appName: string): boolean {
  return Boolean(S.demoPlatinumApps.has(appName) || S.epicAchSummaries[appName]?.is_platinum);
}

/** Active download progress for a game, or null when not downloading. */
export function epicDlProgress(appName: string): number | null {
  const dl = S.downloads.get(appName);
  if (dl && !dl.done) return dl.progress;
  if (S.dlQueueStatus.active === appName || S.dlQueueStatus.queue.includes(appName)) return 0;
  return null;
}

/** Portrait cover markup with custom cover -> Epic key art -> fallback. */
export function epicArt(s: EpicSummary): string {
  const custom = S.customCovers[s.appName];
  if (custom) return `<img src="${esc(custom)}" alt="" loading="lazy" decoding="async" />`;
  const g = rawOf(s.appName);
  const url = g ? epicPortrait(g) : s.cover;
  if (url) return `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" />`;
  return `<div class="pcover">${icon("gamepad-2", 32)}</div>`;
}

/**
 * Toggle a game's favorite state, persist it and update every visible favorite
 * button in place. Deliberately does NOT re-render the view: rebuilding a
 * 500-game library just to flip a heart is the single most expensive
 * interaction in the app.
 */
export function toggleFav(appName: string): void {
  const isNowFaved = !S.epicFav.has(appName);
  if (isNowFaved) S.epicFav.add(appName);
  else S.epicFav.delete(appName);
  localStorage.setItem(FAV_KEY, JSON.stringify([...S.epicFav]));

  document
    .querySelectorAll<HTMLElement>(`button[data-act="epic-fav"][data-id="${appName}"]`)
    .forEach((btn) => {
      btn.classList.toggle("faved", isNowFaved);
      if (btn.classList.contains("btn") && !btn.classList.contains("icon-only")) {
        btn.innerHTML = `${icon("heart", 14)} ${isNowFaved ? t("common.favorited") : t("common.favorite")}`;
      }
    });
}

/** Primary action buttons (play/install/update/cancel) for a game card. */
export function epicActionButtons(
  s: EpicSummary,
  size: "full" | "small" | "",
  opts: { primaryOnly?: boolean } = {},
): string {
  const btn = size ? ` ${size}` : "";
  const p = epicDlProgress(s.appName);
  if (p !== null) {
    const main = `<button class="btn primary${btn}" data-view="downloads" data-dlbtn="${s.appName}">${t("common.downloading", { p })}</button>`;
    if (opts.primaryOnly) return main;
    return `${main}
      <button class="btn danger small" data-act="epic-cancel" data-id="${s.appName}">${t("common.cancelShort")}</button>`;
  }
  const isRunning = S.runningGames.has(s.appName);
  if (isRunning) {
    return `<button class="btn play${btn}" data-act="epic-stop" data-id="${s.appName}" title="${t("common.stop")}">${icon("square", 12)} ${t("common.stop")}</button>`;
  }
  if (s.installed) {
    const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
    if (hasUpdate) {
      return `<button class="btn update${btn}" data-act="epic-install" data-id="${s.appName}" title="${t("common.updateDownload")}">${icon("download", 14)} ${t("common.update")}</button>`;
    }
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}">${icon("play", 14)} ${t("common.play")}</button>`;
  }
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);
  if (requiresThirdPartyLauncher(partner)) {
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}" title="${t("common.launchWith", { name: esc(partner!.name) })}">${icon("external", 14)} ${esc(partner!.shortName)}</button>`;
  }
  return `<button class="btn install${btn}" data-act="epic-install" data-id="${s.appName}">${icon("download", 14)} ${t("common.install")}</button>`;
}
