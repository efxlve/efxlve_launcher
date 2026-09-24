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
function libraryCardBadge(s: EpicSummary): string {
  if (S.runningGames.has(s.appName)) {
    return `<span class="pbadge running">${t("lib.running")}</span>`;
  }
  if (s.updateAvailable || S.availableUpdates.has(s.appName)) {
    return `<span class="pbadge update">${t("lib.updateBadge")}</span>`;
  }
  return "";
}

/**
 * Patch a visible library card in place (badge, hover action, download bar).
 * Never rebuilds the grid — a full library innerHTML is treated as a bug.
 */
export function patchLibraryCardDom(appName: string): boolean {
  const s = S.epicSummariesMap.get(appName);
  const cards = document.querySelectorAll<HTMLElement>(`.pcard[data-id="${appName}"]`);
  if (!s || cards.length === 0) return false;
  const p = epicDlProgress(appName);
  const badgeHtml = libraryCardBadge(s);
  const actions = epicActionButtons(s, "full", { primaryOnly: true });
  cards.forEach((card) => {
    const badge = card.querySelector(".pbadge");
    if (badgeHtml) {
      if (badge) badge.outerHTML = badgeHtml;
      else card.insertAdjacentHTML("beforeend", badgeHtml);
    } else if (badge) {
      badge.remove();
    }
    const bottom = card.querySelector(".poverlay .bottom");
    if (bottom) {
      const title = bottom.querySelector(".ptitle");
      bottom.innerHTML = `${title ? title.outerHTML : ""}${actions}`;
    }
    const track = card.querySelector(".card-dl-track");
    if (p !== null) {
      if (track) {
        const bar = track.querySelector<HTMLElement>(".card-dl-bar");
        if (bar) bar.style.width = `${p}%`;
      } else {
        card.insertAdjacentHTML(
          "beforeend",
          `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${appName}" style="width:${p}%"></div></div>`,
        );
      }
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
  return `<div class="pcover" style="background:linear-gradient(135deg,#1f202c,#3b3d52);color:#94a3b8">${icon("gamepad-2", 40)}</div>`;
}

/**
 * Toggle a game's favorite state, persist it and update every visible favorite
 * button in place. Deliberately does NOT re-render the view: rebuilding a
 * 500-game library just to flip a heart is the single most expensive
 * interaction in the app.
 */
export function toggleFav(appName: string, triggerBtn?: HTMLElement | null): void {
  const isNowFaved = !S.epicFav.has(appName);
  if (isNowFaved) S.epicFav.add(appName);
  else S.epicFav.delete(appName);
  localStorage.setItem(FAV_KEY, JSON.stringify([...S.epicFav]));

  document
    .querySelectorAll<HTMLElement>(`button[data-act="epic-fav"][data-id="${appName}"]`)
    .forEach((btn) => {
      btn.classList.toggle("faved", isNowFaved);
      if (btn.classList.contains("btn")) {
        btn.innerHTML = `${icon("heart", 14)} ${isNowFaved ? t("common.favorited") : t("common.favorite")}`;
      }
    });

  if (triggerBtn) {
    triggerBtn.classList.add("heart-burst");
    setTimeout(() => triggerBtn.classList.remove("heart-burst"), 600);
  }
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
    return `<button class="btn running${btn}" data-act="epic-play" data-id="${s.appName}" title="${t("common.gameRunning")}"><span class="running-dot"></span> ${t("common.playing")}</button>`;
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
