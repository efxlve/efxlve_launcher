/**
 * PS5/Steam-style custom right-click context menu.
 *
 * Replaces the default browser context menu on game cards/rows with a console
 * action menu. Menu items reuse the global `data-act` delegation router in
 * `main.ts`, so clicking an item triggers the same handlers as the UI buttons.
 */

import { ctxRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { t } from "../../i18n";
import { esc } from "../../core/utils";

/** Remove the open menu, if any. */
export function hideContextMenu(): void {
  if (S.ctxMenuEl) {
    S.ctxMenuEl.remove();
    S.ctxMenuEl = null;
  }
}

/** Build and position the context menu at the given viewport coordinates. */
export function showContextMenu(x: number, y: number, appName: string): void {
  hideContextMenu();
  const s = summaryOf(appName);
  if (!s) return;
  const installed = !!s.installed;
  const faved = S.epicFav.has(appName);

  const item = (
    act: string,
    label: string,
    iconName: Parameters<typeof icon>[0],
    danger = false,
  ): string =>
    `<button class="ps5-context-item${danger ? " danger" : ""}" role="menuitem" data-act="${act}" data-id="${esc(appName)}">${icon(iconName, 15)}<span>${label}</span></button>`;

  const menu = document.createElement("div");
  menu.className = "ps5-context-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `
    <div class="ps5-context-head" title="${esc(s.title)}">${esc(s.title)}</div>
    ${installed ? item("play", t("common.play"), "play") : item("install", t("common.install"), "download")}
    ${item("manage-game", t("common.manage"), "settings")}
    <div class="ps5-context-sep"></div>
    ${installed ? item("manage-create-shortcut", t("ctx.shortcut"), "external") : ""}
    ${installed ? item("epic-open-folder", t("ctx.openFolder"), "folder") : ""}
    ${installed ? item("manage-create-backup", t("ctx.backup"), "cloud") : ""}
    ${item("epic-fav", faved ? t("ctx.favRemove") : t("ctx.favAdd"), "heart")}
    ${item("hide-game", t("ctx.hide"), "eye-off")}
    ${installed ? `<div class="ps5-context-sep"></div>${item("uninstall", t("common.uninstall"), "trash", true)}` : ""}
  `;

  const root = ctxRoot || document.body;
  root.appendChild(menu);
  S.ctxMenuEl = menu;

  // Clamp to the viewport. Measure once to avoid layout thrashing.
  const rect = menu.getBoundingClientRect();
  const px = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
  const py = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;
  menu.querySelector<HTMLElement>(".ps5-context-item")?.focus();
}

/** Right-click a collection tab to edit it. All and Favorites have no menu. */
function showCollectionTabMenu(x: number, y: number, colId: string): void {
  hideContextMenu();
  const col = S.epicCollections.find((c) => c.id === colId);
  if (!col) return;
  const menu = document.createElement("div");
  menu.className = "ps5-context-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<button class="ps5-context-item" role="menuitem" data-act="edit-collection" data-col-id="${esc(colId)}">${icon("edit", 15)}<span>${t("col.edit")}</span></button>`;
  const root = ctxRoot || document.body;
  root.appendChild(menu);
  S.ctxMenuEl = menu;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

/** Register the global listeners that open and dismiss the context menu. */
export function initContextMenu(): void {
  document.addEventListener(
    "contextmenu",
    (e) => {
      // Disables default Chromium/Edge context menu across the desktop app.
      e.preventDefault();
      const colTab = (e.target as HTMLElement).closest<HTMLElement>(".lib-col-tab");
      if (colTab?.dataset.colId) {
        showCollectionTabMenu(e.clientX, e.clientY, colTab.dataset.colId);
        return;
      }
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act="epic-detail"][data-id]');
      if (!target) {
        hideContextMenu();
        return;
      }
      const id = target.dataset.id;
      if (id) showContextMenu(e.clientX, e.clientY, id);
    },
    true,
  );

  // Clicking outside closes the menu. Clicking a menu item lets the global
  // `data-act` router run first, then closes on the next tick.
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".ps5-context-menu")) {
        window.setTimeout(hideContextMenu, 0);
        return;
      }
      hideContextMenu();
    },
    true,
  );

  window.addEventListener("scroll", hideContextMenu, true);
  window.addEventListener("resize", hideContextMenu, { passive: true });
}
