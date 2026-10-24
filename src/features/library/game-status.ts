/** Reads and writes the per-game status map in shared state. */

import { saveGameStatus, type GameStatus } from "../../core/game-status";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { esc } from "../../core/utils";
import { icon } from "../../core/icons";

export type { GameStatus };

export function gameStatusOf(appName: string): GameStatus | undefined {
  return S.gameStatus.get(appName);
}

export function setGameStatus(appName: string, status: GameStatus | null): void {
  if (status) S.gameStatus.set(appName, status);
  else S.gameStatus.delete(appName);
  saveGameStatus(S.gameStatus);
  // Smart collections and the status menu read this map: the library's visible
  // cache must miss after a change, not only when the page is rebuilt.
  S.libraryDataRev++;
}

/** The four personal labels, in menu order, with their icon. */
export function gameStatusOptions(): Array<{ value: GameStatus; label: string; ic: "play" | "check" | "pause" | "x" }> {
  return [
    { value: "playing", label: t("drawer.statePlaying"), ic: "play" },
    { value: "completed", label: t("drawer.stateCompleted"), ic: "check" },
    { value: "onhold", label: t("status.onHold"), ic: "pause" },
    { value: "dropped", label: t("status.dropped"), ic: "x" },
  ];
}

/**
 * Standard status selection menu (shared by the game card context menu and the
 * game page drawer More menu).
 */
export function statusMenuHtml(appName: string): string {
  const current = gameStatusOf(appName);
  const options = gameStatusOptions();
  return `
    <div class="gp-more-status-box">
      <div class="gp-more-status-head">
        <span>${esc(t("status.label"))}</span>
        ${current ? `<button type="button" class="gp-more-status-clear" data-act="ctx-game-status" data-id="${esc(appName)}" data-status="" role="menuitem" title="${esc(t("col.clear"))}">${icon("x", 11)}<span>${esc(t("col.clear"))}</span></button>` : ""}
      </div>
      <div class="gp-more-status-list" role="group">
        ${options.map(({ value, label, ic }) => {
          const on = current === value;
          return `
          <button type="button" class="ps5-context-item gp-more-status-btn${on ? " active" : ""}" data-act="ctx-game-status" data-id="${esc(appName)}" data-status="${value}" role="menuitemradio" aria-checked="${on}" title="${esc(label)}">
            <span class="gp-more-status-ico">${icon(ic, 14)}</span>
            <span class="gp-more-status-name">${esc(label)}</span>
            <span class="gp-more-status-mark">${on ? icon("check", 14) : ""}</span>
          </button>`;
        }).join("")}
      </div>
    </div>`;
}
