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
 * Standard status selection submenu (shared by the game card context menu and the
 * game page drawer More menu).
 */
export function statusSubmenuHtml(appName: string): { triggerHtml: string; submenuHtml: string } {
  const currentStatus = gameStatusOf(appName);
  const options = gameStatusOptions();
  const currentStatusOpt = currentStatus ? options.find((o) => o.value === currentStatus) : undefined;

  const triggerHtml = `
    <button type="button" class="ps5-context-item ctx-submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-act="status-submenu-noop">
      ${icon(currentStatusOpt ? currentStatusOpt.ic : "check-circle", 15)}
      <span class="ctx-item-name">${esc(t("status.label"))}</span>
      <span class="ctx-sub-tail">
        ${currentStatusOpt ? `<span class="ctx-sub-badge">${esc(currentStatusOpt.label)}</span>` : ""}
        <span class="ctx-chevron">${icon("chevron-right", 12)}</span>
      </span>
    </button>`;

  const submenuHtml = `
    <div class="ps5-context-menu ps5-context-submenu" role="menu">
      ${options.map(({ value, label, ic }) => {
        const active = currentStatus === value;
        return `
        <button type="button" class="ps5-context-item ctx-status-option${active ? " is-current active" : ""}" data-act="ctx-game-status" data-id="${esc(appName)}" data-status="${value}" role="menuitemradio" aria-checked="${active}" title="${esc(label)}">
          ${icon(ic, 14)}
          <span>${esc(label)}</span>
          <span class="ctx-check">${active ? icon("check", 14) : ""}</span>
        </button>`;
      }).join("")}
      ${currentStatus ? `
        <div class="ps5-context-sep"></div>
        <button type="button" class="ps5-context-item danger ctx-status-clear" data-act="ctx-game-status" data-id="${esc(appName)}" data-status="" role="menuitem" title="${esc(t("col.clear"))}">
          ${icon("x", 14)}
          <span>${esc(t("col.clear"))}</span>
        </button>` : ""}
    </div>`;

  return { triggerHtml, submenuHtml };
}

/**
 * Renders the status submenu wrapped in `.ctx-submenu-wrap` for inline menus
 * (such as the game page drawer More menu).
 */
export function statusMenuHtml(appName: string): string {
  const { triggerHtml, submenuHtml } = statusSubmenuHtml(appName);
  return `
    <div class="ctx-submenu-wrap">
      ${triggerHtml}
      ${submenuHtml}
    </div>`;
}
