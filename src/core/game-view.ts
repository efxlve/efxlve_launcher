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
import { rawOf, sharedOwnerOf, storeKeysForTitle, summaryOf } from "./selectors";
import { S } from "./state";
import { esc, fmtPlaytime } from "./utils";

/** O(1) achievement lookup supporting both composite (`gog::id`) and raw (`id`) keys. */
export function achSummaryOf(appName: string) {
  return S.epicAchSummaries[appName] || (appName.startsWith("gog::") ? S.epicAchSummaries[appName.slice(5)] : S.epicAchSummaries[`gog::${appName}`]);
}

/** Achievement count for a library list row. Dash when the game has no tracked set. */
export function listAchievementCell(appName: string): string {
  const ach = achSummaryOf(appName);
  const done = isAppPlatinum(appName) || (Boolean(ach?.total_achievements) && ach!.user_unlocked >= ach!.total_achievements);
  if (ach?.supported && ach.total_achievements > 0) {
    return `<span class="lrow-ach${done ? " done" : ""}">${icon("trophy", 13)}<span class="tabular-nums">${ach.user_unlocked}/${ach.total_achievements}</span></span>`;
  }
  return `<span class="lrow-ach">—</span>`;
}

/** Compact playtime + achievement chips for a library cover. Empty when the setting is off or there is nothing to show. */
export function libraryCoverStats(appName: string): string {
  if (!S.showCoverStats) return "";
  const chips: string[] = [];
  const secs = S.playtimeMap.get(appName)?.total_seconds ?? 0;
  if (secs > 0) {
    chips.push(`<span class="cover-stat">${icon("clock", 12)}<span>${esc(fmtPlaytime(secs))}</span></span>`);
  }
  const ach = achSummaryOf(appName);
  const done = isAppPlatinum(appName) || (Boolean(ach?.total_achievements) && ach!.user_unlocked >= ach!.total_achievements);
  if (ach?.supported && ach.total_achievements > 0) {
    const label = `${ach.user_unlocked}/${ach.total_achievements}`;
    chips.push(
      `<span class="cover-stat${done ? " done" : ""}">${icon("trophy", 12)}<span>${label}</span></span>`,
    );
  } else if (done) {
    chips.push(`<span class="cover-stat done">${icon("trophy", 12)}</span>`);
  }
  if (chips.length === 0) return "";
  return `<div class="cover-stats" data-cover-stats>${chips.join("")}</div>`;
}

/** Live state on a library tile. Updates stay on the downloads page. */
export function libraryCardBadge(s: EpicSummary): string {
  if (S.runningGames.has(s.appName)) {
    return `<span class="pbadge running">${t("lib.running")}</span>`;
  }
  return "";
}

/** Thin download bar shown on a library cover / list thumbnail. */
export function libraryDlBar(appName: string, p: number | null): string {
  return p !== null
    ? `<div class="card-dl-track"><div class="card-dl-bar" data-dlbar="${appName}" style="width:${p}%"></div></div>`
    : "";
}

function storeHasPendingUpdate(appName: string): boolean {
  const s = summaryOf(appName);
  if (!s) return false;
  return Boolean(s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName));
}

/** Store copy that should receive the cover Update chip, including cross-store siblings. */
function libraryUpdateTarget(appName: string): string | null {
  if (storeHasPendingUpdate(appName)) return appName;
  const s = summaryOf(appName);
  if (!s) return null;
  for (const key of storeKeysForTitle(s.title)) {
    if (key !== appName && storeHasPendingUpdate(key)) return key;
  }
  return null;
}

/** Play chip next to the cover title; swaps to Update when that copy (or a sibling) has a pending update. */
export function libraryInstalledIcon(appName: string, installed: boolean): string {
  if (!S.showInstalledIcon || !installed) return "";
  const updateId = libraryUpdateTarget(appName);
  if (updateId) {
    const label = t("common.update");
    const glyph = icon("download", 9);
    if (updateId.startsWith("steam::")) {
      return `<button type="button" class="pcard-play-btn is-update" data-act="steam-action" data-id="${esc(updateId.slice(7))}" data-mode="update" aria-label="${esc(label)}">${glyph}</button>`;
    }
    return `<button type="button" class="pcard-play-btn is-update" data-act="epic-install" data-id="${esc(updateId)}" aria-label="${esc(label)}">${glyph}</button>`;
  }
  const playLabel = t("palette.play");
  // Steam games are launched by the client, never by our own launch path.
  if (appName.startsWith("steam::")) {
    return `<button type="button" class="pcard-play-btn" data-act="steam-action" data-id="${esc(appName.slice(7))}" data-mode="launch" aria-label="${esc(playLabel)}">${icon("play", 9)}</button>`;
  }
  return `<button type="button" class="pcard-play-btn" data-act="epic-play" data-id="${esc(appName)}" aria-label="${esc(playLabel)}">${icon("play", 9)}</button>`;
}

function patchCoverPlayChip(item: HTMLElement, cardAppName: string, installed: boolean): void {
  const titleRow = item.querySelector<HTMLElement>(".pcard-title-row");
  if (!titleRow) return;
  const playBtn = titleRow.querySelector<HTMLElement>(".pcard-play-btn");
  const playBtnHtml = libraryInstalledIcon(cardAppName, installed);
  if (playBtnHtml) {
    if (playBtn) playBtn.outerHTML = playBtnHtml;
    else titleRow.insertAdjacentHTML("beforeend", playBtnHtml);
  } else if (playBtn) {
    playBtn.remove();
  }
}

/**
 * Patch visible library items (grid cards and list rows) in place: badge,
 * installed dimming, primary action and download bar. Never rebuilds the
 * grid — a full library innerHTML is treated as a bug.
 */
export function patchLibraryCardDom(appName: string): boolean {
  const s = summaryOf(appName);
  if (!s) return false;
  const clean = appName.replace(/^gog::/, "");
  const items = document.querySelectorAll<HTMLElement>(
    `[data-lib-item="${appName}"], [data-lib-item="gog::${clean}"], [data-lib-item="${clean}"]`
  );
  const p = epicDlProgress(appName);
  const badgeHtml = libraryCardBadge(s);
  const actions = epicActionButtons(s, "full", { primaryOnly: true });
  items.forEach((item) => {
    const dim = item.classList.contains("lrow") ? libraryListDimmed(s) : !s.installed;
    item.classList.toggle("not-installed", dim);
    const badgeHost = item.querySelector<HTMLElement>("[data-badge-host]");
    const badge = badgeHost?.querySelector(".pbadge");
    if (badgeHtml) {
      if (badge) badge.outerHTML = badgeHtml;
      else badgeHost?.insertAdjacentHTML("beforeend", badgeHtml);
    } else if (badge) {
      badge.remove();
    }
    const art = item.querySelector<HTMLElement>(".pcard-art");
    const statsHtml = libraryCoverStats(appName);
    const stats = art?.querySelector<HTMLElement>("[data-cover-stats]");
    if (art && statsHtml) {
      if (stats) stats.outerHTML = statsHtml;
      else art.insertAdjacentHTML("afterbegin", statsHtml);
    } else if (stats) {
      stats.remove();
    }
    patchCoverPlayChip(item, appName, s.installed);
    const achHost = item.querySelector<HTMLElement>("[data-lib-ach]");
    if (achHost) achHost.innerHTML = listAchievementCell(appName);
    const actionHost = item.querySelector<HTMLElement>("[data-card-action]");
    if (actionHost) actionHost.innerHTML = actions;
    const cardArt = item.querySelector<HTMLElement>("[data-card-art]");
    const track = cardArt?.querySelector(".card-dl-track");
    if (p !== null) {
      const bar = track?.querySelector<HTMLElement>(".card-dl-bar");
      if (bar) bar.style.width = `${p}%`;
      else cardArt?.insertAdjacentHTML("beforeend", libraryDlBar(appName, p));
    } else if (track) {
      track.remove();
    }
  });
  // Merged tiles keep the other store's key; refresh their cover chip without rewriting the card.
  const seen = new Set(items);
  for (const key of storeKeysForTitle(s.title)) {
    document.querySelectorAll<HTMLElement>(`[data-lib-item="${key}"]`).forEach((item) => {
      if (seen.has(item)) return;
      seen.add(item);
      patchCoverPlayChip(item, key, Boolean(summaryOf(key)?.installed));
    });
  }
  return seen.size > 0;
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
  return Boolean(S.demoPlatinumApps.has(appName) || achSummaryOf(appName)?.is_platinum);
}

/** Active download progress for a game, or null when not downloading. */
export function epicDlProgress(appName: string): number | null {
  const dl = S.downloads.get(appName);
  if (dl && !dl.done) return dl.progress;
  if (S.dlQueueStatus.active === appName || S.dlQueueStatus.queue.includes(appName)) return 0;
  if (appName.startsWith("steam::")) {
    const item = S.steamSummariesMap.get(appName) || S.allGamesMap.get(appName);
    if (!item?.downloading) return null;
    const total = item.bytesToDownload ?? 0;
    const got = item.bytesDownloaded ?? 0;
    if (total > 0) return Math.min(100, Math.round((got / total) * 100));
    return 0;
  }
  return null;
}

/** Portrait cover markup with custom cover -> Epic key art -> fallback. */
export function epicArt(s: EpicSummary): string {
  const custom = S.customCovers[s.appName];
  if (custom) return `<img src="${esc(custom)}" alt="" loading="lazy" decoding="async" />`;
  const g = rawOf(s.appName);
  let url = g ? epicPortrait(g) : s.cover;
  if (url && url.includes("_product_card_v2_mobile_slider_639.jpg")) {
    url = url.replace("_product_card_v2_mobile_slider_639.jpg", "_glx_vertical_cover.jpg");
  }
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
  // Favorites are part of the library filter signature; force the cache to miss.
  S.libraryDataRev++;

  document
    .querySelectorAll<HTMLElement>(`button[data-act="epic-fav"][data-id="${appName}"]`)
    .forEach((btn) => {
      btn.classList.toggle("faved", isNowFaved);
      if (btn.classList.contains("btn") && !btn.classList.contains("icon-only")) {
        btn.innerHTML = `${icon("heart", 14)} ${isNowFaved ? t("common.favorited") : t("common.favorite")}`;
      }
    });
}

/** Uninstalled Epic titles are dimmed in the list. EA and Ubisoft stay full color. */
export function libraryListDimmed(s: EpicSummary): boolean {
  if (s.installed) return false;
  return !requiresThirdPartyLauncher(getThirdPartyLauncher(rawOf(s.appName)));
}

/** Primary action buttons (play/install/update/cancel) for a game card. */
export function epicActionButtons(
  s: EpicSummary,
  size: "full" | "small" | "",
  opts: { primaryOnly?: boolean } = {},
): string {
  const btn = size ? ` ${size}` : "";
  // Games from another saved account cannot be installed with the active one:
  // the card offers the one-click account switch instead.
  const sharedOwner = sharedOwnerOf(s.appName);
  if (sharedOwner) {
    return `<button class="btn ghost${btn}" data-act="shared-switch" data-id="${sharedOwner.ownerKey}" title="${t("shared.switchTo", { name: esc(sharedOwner.ownerName) })}">${icon("arrow-left-right", 14)} ${t("shared.switch")}</button>`;
  }
  // Steam games belong to the Steam client: play/install/update all go through it.
  if (s.appName.startsWith("steam::")) {
    const steamId = s.appName.slice(7);
    if (s.downloading) {
      const p = epicDlProgress(s.appName);
      const label = p !== null ? t("common.downloading", { p }) : t("steam.downloading");
      return `<button class="btn primary${btn}" data-view="downloads" data-dlbtn="${s.appName}" title="${esc(t("steam.downloadingHint"))}">${icon("download", 12)} ${label}</button>`;
    }
    if (!s.installed) {
      return `<button class="btn install${btn}" data-act="steam-action" data-id="${steamId}" data-mode="install" title="${t("steam.install")}">${icon("download", 14)} ${t("common.install")}</button>`;
    }
    if (s.updateAvailable) {
      return `<button class="btn update${btn}" data-act="steam-action" data-id="${steamId}" data-mode="update" title="${t("steam.updateRequired")}">${icon("download", 14)} ${t("common.update")}</button>`;
    }
    return `<button class="btn play${btn}" data-act="steam-action" data-id="${steamId}" data-mode="launch" title="${t("steam.launch")}">${icon("play", 14)} ${t("common.play")}</button>`;
  }
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
    const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName) || S.gogUpdates.has(s.appName);
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
