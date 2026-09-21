/**
 * Shared game presentation helpers used by library cards, shelves and the hero.
 *
 * These read shared state (S) and return HTML fragments. They are used by more
 * than one feature module, so they live in `core` rather than inside a single
 * feature.
 */

import { getThirdPartyLauncher, epicPortrait, type EpicSummary } from "../epic";
import { icon } from "./icons";
import { rawOf } from "./selectors";
import { S } from "./state";
import { esc } from "./utils";

/** True when the game has the platinum trophy (100% achievements). */
export function isAppPlatinum(appName: string): boolean {
  return Boolean(S.demoPlatinumApps.has(appName) || S.epicAchSummaries[appName]?.is_platinum);
}

/** Active download progress for a game, or null when not downloading. */
export function epicDlProgress(appName: string): number | null {
  const dl = S.downloads.get(appName);
  return dl && !dl.done ? dl.progress : null;
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

/** Primary action buttons (play/install/update/cancel) for a game card. */
export function epicActionButtons(s: EpicSummary, size: "full" | "small" | ""): string {
  const btn = size ? ` ${size}` : "";
  const p = epicDlProgress(s.appName);
  if (p !== null) {
    return `<button class="btn primary${btn}" disabled data-dlbtn="${s.appName}">%${p}</button>
      <button class="btn danger small" data-act="epic-cancel" data-id="${s.appName}">İptal</button>`;
  }
  const isRunning = S.runningGames.has(s.appName);
  if (isRunning) {
    return `<button class="btn primary${btn} running" data-act="epic-play" data-id="${s.appName}" title="Oyun Çalışıyor"><span class="running-dot"></span> Oynanıyor…</button>`;
  }
  if (s.installed) {
    const hasUpdate = s.updateAvailable || S.availableUpdates.has(s.appName);
    if (hasUpdate) {
      return `<button class="btn primary${btn}" data-act="epic-install" data-id="${s.appName}" title="Güncellemeyi İndir">${icon("download", 14)} Güncelle</button>`;
    }
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}">${icon("play", 14)} Oyna</button>`;
  }
  const g = rawOf(s.appName);
  const partner = getThirdPartyLauncher(g);
  if (partner) {
    return `<button class="btn play${btn}" data-act="epic-play" data-id="${s.appName}" title="${esc(partner.name)} ile Başlat">${icon("external", 14)} ${esc(partner.shortName)}</button>`;
  }
  return `<button class="btn primary${btn}" data-act="epic-install" data-id="${s.appName}">${icon("download", 14)} Yükle</button>`;
}
