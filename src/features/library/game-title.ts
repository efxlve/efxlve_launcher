/**
 * Player-chosen game names.
 *
 * A rename changes only what the launcher shows. Store ids, install folders,
 * saves and achievement lookups keep the original title, so a nickname can be
 * as short as the player wants without breaking a single backend call.
 */

import { CUSTOM_TITLES_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { notify, openEpicModal, scheduleRender } from "../../core/render";
import { customTitleOf, rebuildAllGamesMap, storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

const TITLE_LIMIT = 120;

function persistCustomTitles(): void {
  try {
    const entries = Object.entries(S.customTitles)
      .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
      .map(([key, value]) => [key, value.trim()]);
    if (entries.length === 0) {
      localStorage.removeItem(CUSTOM_TITLES_KEY);
    } else {
      localStorage.setItem(CUSTOM_TITLES_KEY, JSON.stringify(Object.fromEntries(entries)));
    }
  } catch {
    // Storage quota/errors leave the in-memory name intact for this session.
  }
}

/**
 * Saves or clears a display name. Every loaded store copy of the same game gets
 * the same alias while copies are combined, so switching the preferred store
 * does not silently bring the old name back.
 */
export function setCustomGameTitle(appName: string, rawValue: string): void {
  if (!appName) return;
  const summary = summaryOf(appName);
  const originalTitle = summary?.originalTitle || summary?.title || "";
  const next = rawValue.trim().replace(/\s+/g, " ").slice(0, TITLE_LIMIT);
  const reset = !next || (originalTitle.length > 0 && next === originalTitle.trim());

  const keys = new Set<string>([appName]);
  if (!S.separateCopies && originalTitle) {
    for (const key of storeKeysForTitle(originalTitle)) keys.add(key);
  }
  for (const key of keys) {
    if (reset) delete S.customTitles[key];
    else S.customTitles[key] = next;
  }

  persistCustomTitles();
  // The cross-store title index now needs the alias as well as the real title.
  rebuildAllGamesMap();
  S.libraryDataRev++;

  // The Manage panel can stay open above the game page; repaint its own copy of
  // the heading instead of waiting for the next open.
  const manageDesc = document.getElementById("manage-name-desc");
  if (manageDesc?.dataset.app === appName) {
    const visible = customTitleOf(appName, originalTitle) || originalTitle;
    const sideTitle = document.getElementById("manage-side-title");
    if (sideTitle) sideTitle.textContent = visible;
    const active = customTitleOf(appName, originalTitle);
    manageDesc.innerHTML = active
      ? `${esc(t("manage.nameActive"))}: <strong>${esc(active)}</strong>`
      : t("manage.nameDesc");
  }

  scheduleRender();
  if (S.currentModalAppName === appName) openEpicModal(appName, false, false);
}

export function closeRenameGameModal(): void {
  S.renameModalAppName = null;
  const root = document.getElementById("rename-game-root");
  if (root) root.innerHTML = "";
}

export function openRenameGameModal(appName: string): void {
  if (!appName) return;
  S.renameModalAppName = appName;
  renderRenameGameModal();
}

export function saveRenameGameModal(): void {
  const appName = S.renameModalAppName;
  if (!appName) return;
  const input = document.getElementById("rename-game-modal-input") as HTMLInputElement | null;
  const nextValue = input ? input.value : "";
  closeRenameGameModal();
  setCustomGameTitle(appName, nextValue);
  notify({ kind: "info", title: t("lib.renameSaved"), appName });
}

export function resetRenameGameModal(): void {
  const appName = S.renameModalAppName;
  if (!appName) return;
  closeRenameGameModal();
  setCustomGameTitle(appName, "");
  notify({ kind: "info", title: t("lib.renameResetDone"), appName });
}

export function renderRenameGameModal(): void {
  const root = document.getElementById("rename-game-root");
  const appName = S.renameModalAppName;
  if (!root || !appName) {
    if (root) root.innerHTML = "";
    return;
  }
  const summary = summaryOf(appName);
  const originalTitle = summary?.originalTitle || summary?.title || appName;
  const currentTitle = customTitleOf(appName, originalTitle);

  root.innerHTML = `
    <div class="playtime-overlay" data-act="close-rename-game-backdrop">
      <div class="playtime-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-game-dialog-title">
        <div class="playtime-header">
          <div class="playtime-header-title">
            <span class="playtime-header-icon">${icon("edit", 18)}</span>
            <div style="min-width:0">
              <h2 id="rename-game-dialog-title">${esc(t("lib.renameTitle"))}</h2>
              <div class="playtime-header-sub">${esc(originalTitle)}</div>
            </div>
          </div>
          <button type="button" class="icon-btn" data-act="close-rename-game-modal" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="playtime-body">
          <p style="margin:0;font-size:13px;line-height:1.5;color:var(--text-2)">
            ${esc(t("lib.renameDesc"))}
          </p>
          <div style="display:flex;flex-direction:column;gap:6px">
            <label for="rename-game-modal-input" style="font-size:12px;font-weight:600;color:var(--text-2)">
              ${esc(t("lib.renameLabel"))}
            </label>
            <input
              id="rename-game-modal-input"
              type="text"
              class="input"
              maxlength="${TITLE_LIMIT}"
              value="${esc(currentTitle || originalTitle)}"
              placeholder="${esc(originalTitle)}"
              autocomplete="off"
              spellcheck="false"
            />
            <div style="font-size:11.5px;color:var(--text-3);line-height:1.45">
              ${esc(t("lib.renameHint"))}
            </div>
          </div>
        </div>
        <div class="playtime-footer" style="justify-content:space-between">
          <div>
            ${
              currentTitle
                ? `<button type="button" class="btn ghost" data-act="reset-rename-game-modal">${icon("refresh", 14)}<span>${esc(t("common.reset"))}</span></button>`
                : ""
            }
          </div>
          <div style="display:flex;gap:8px">
            <button type="button" class="btn ghost" data-act="close-rename-game-modal">${esc(t("common.cancel"))}</button>
            <button type="button" class="btn primary" data-act="save-rename-game-modal">${icon("check", 14)}<span>${esc(t("common.save"))}</span></button>
          </div>
        </div>
      </div>
    </div>
  `;

  const input = document.getElementById("rename-game-modal-input") as HTMLInputElement | null;
  if (input) {
    input.focus();
    input.select();
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveRenameGameModal();
      }
    });
  }
}
