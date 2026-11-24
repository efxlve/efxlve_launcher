/**
 * Compact recent-unlock cards: the row capacity, and the hover card that
 * carries the description the compact card has no room for. Built like the
 * play-activity day popover instead of a native title bubble.
 */

import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

export type UnlockPopoverAlign = "left" | "center" | "right";

export interface UnlockPopoverData {
  title: string;
  game: string;
  date: string;
  /** Formatted rarity label, or "" when the store reported none. */
  rarity: string;
  rare: boolean;
  /** True for a launcher-only mark; shown when there is no store rarity. */
  manual: boolean;
  description: string;
  /** A souvenir screenshot exists for the unlock. */
  shot: boolean;
  /** Achievement art URL, when the store reported one. */
  art: string;
  /** Rendered store mark HTML, when the caller wants one. */
  storeMark?: string;
  align: UnlockPopoverAlign;
}

/** Columns the unlock strip fits at the current page width. */
export function unlockRowCapacity(): number {
  if (typeof window === "undefined") return 5;
  const view = document.getElementById("view");
  // Available row width inside .profile-page (max-width: 1560px, padding: 28px each side)
  const available = (view?.clientWidth || window.innerWidth - 64) - 56;
  const rowWidth = Math.max(300, Math.min(1560, available));
  const minCardWidth = 280;
  const gap = 12;
  return Math.max(1, Math.floor((rowWidth + gap) / (minCardWidth + gap)));
}

/** Keeps the panel inside the page at the first and last column. */
export function unlockPopoverAlign(index: number, columns: number): UnlockPopoverAlign {
  if (columns <= 1) return "left";
  const column = index % columns;
  if (column === 0) return "left";
  if (column === columns - 1) return "right";
  return "center";
}

export function unlockPopoverHtml(data: UnlockPopoverData): string {
  const badge = data.rarity
    ? `<span class="profile-unlock-badge${data.rare ? " is-rare" : ""} tabular-nums">${data.rare ? icon("trophy", 10) : ""}<span>${esc(data.rarity)}</span></span>`
    : data.manual
      ? `<span class="profile-unlock-badge is-manual">${esc(t("profile.unlockManual"))}</span>`
      : "";
  const head = data.date || badge
    ? `<div class="profile-unlock-pop-head">
        <span class="profile-unlock-pop-date tabular-nums">${esc(data.date)}</span>
        ${badge}
      </div>`
    : "";
  const shot = data.shot
    ? `<div class="profile-unlock-pop-foot">
        <span class="profile-unlock-pop-shot">${icon("camera", 10)}<span>${esc(t("profile.unlockShot"))}</span></span>
      </div>`
    : "";

  return `<div class="profile-unlock-pop is-${data.align}" role="tooltip" aria-hidden="true">
    ${head}
    <div class="profile-unlock-pop-body">
      ${data.art ? `<img class="profile-unlock-pop-art" src="${esc(data.art)}" alt="" loading="lazy" decoding="async" />` : ""}
      <div class="profile-unlock-pop-main">
        <span class="profile-unlock-pop-title">${esc(data.title)}</span>
        <span class="profile-unlock-pop-game">${data.storeMark || ""}<span class="profile-unlock-pop-game-name">${esc(data.game)}</span></span>
      </div>
    </div>
    ${data.description ? `<p class="profile-unlock-pop-desc">${esc(data.description)}</p>` : ""}
    ${shot}
  </div>`;
}
