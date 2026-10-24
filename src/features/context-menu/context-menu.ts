/**
 * PS5/Steam-style custom right-click context menu.
 *
 * Replaces the default browser context menu on game cards/rows with a console
 * action menu. Menu items reuse the global `data-act` delegation router in
 * `main.ts`, so clicking an item triggers the same handlers as the UI buttons.
 */

import { ctxRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { IS_WINDOWS } from "../../core/platform";
import { gameVersionsOf, sourceOfKey, summaryOf, sharedOwnerOf } from "../../core/selectors";
import { storeVersionLabel } from "../drawer/external-versions";
import { storeLogo } from "../store/store-logos";
import { S } from "../../core/state";
import { gameStatusOf, gameStatusOptions } from "../library/game-status";
import { t } from "../../i18n";
import { esc } from "../../core/utils";

let activeSubmenuEl: HTMLElement | null = null;

/** Remove the open menu and any open submenu, if any. */
export function hideContextMenu(): void {
  if (activeSubmenuEl) {
    activeSubmenuEl.remove();
    activeSubmenuEl = null;
  }
  if (S.ctxMenuEl) {
    S.ctxMenuEl.remove();
    S.ctxMenuEl = null;
  }
}

/** Position cascading submenu relative to trigger button with viewport edge awareness. */
function positionSubmenu(trigger: HTMLElement, sub: HTMLElement): void {
  sub.style.display = "block";
  trigger.setAttribute("aria-expanded", "true");
  const tRect = trigger.getBoundingClientRect();
  const sRect = sub.getBoundingClientRect();

  // Prefer opening on the right side:
  let left = tRect.right + 2;
  // If not enough room on the right, flip to the left of the main menu
  if (left + sRect.width > window.innerWidth - 8) {
    left = tRect.left - sRect.width - 2;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - sRect.width - 8));

  // Align vertical top with trigger top, offset slightly for padding match
  let top = tRect.top - 4;
  if (top + sRect.height > window.innerHeight - 8) {
    top = window.innerHeight - sRect.height - 8;
  }
  top = Math.max(8, top);

  sub.style.left = `${Math.round(left)}px`;
  sub.style.top = `${Math.round(top)}px`;
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
  // Games from another saved account: no install/manage, only the switch.
  const shared = sharedOwnerOf(appName);
  // Steam games: every file action belongs to the Steam client.
  const isSteam = appName.startsWith("steam::");
  // Companion games: install/uninstall go through their own client. Amazon
  // Games is launcher-managed (Nile), so it gets its own items below.
  const source = sourceOfKey(appName);
  const isAmazon = source === "amazon";
  const isCustom = source === "custom";
  const isCompanion = source !== "epic" && source !== "gog" && source !== "steam" && !isAmazon && !isCustom;
/** Riot games have no web storefront: the client owns its shop. */
const isRiot = source === "riot";
  const companionItem = (act: string, label: string, iconName: Parameters<typeof icon>[0], danger = false): string =>
    `<button class="ps5-context-item${danger ? " danger" : ""}" role="menuitem" data-act="${act}" data-id="${esc(appName)}" data-store="${source}">${icon(iconName, 15)}<span>${label}</span></button>`;
  // Amazon items carry the bare product id the Nile commands take.
  const amazonItem = (act: string, label: string, iconName: Parameters<typeof icon>[0], danger = false): string =>
    `<button class="ps5-context-item${danger ? " danger" : ""}" role="menuitem" data-act="${act}" data-id="${esc(appName.slice(8))}">${icon(iconName, 15)}<span>${label}</span></button>`;
  const steamItem = (mode: string, label: string, iconName: Parameters<typeof icon>[0], danger = false): string =>
    `<button class="ps5-context-item${danger ? " danger" : ""}" role="menuitem" data-act="steam-action" data-id="${esc(appName.slice(7))}" data-mode="${mode}">${icon(iconName, 15)}<span>${label}</span></button>`;
  const versions = gameVersionsOf(appName);
  const versionBlock = versions.length < 2
    ? ""
    : `${versions.map((version) => {
        const active = version.appName === appName;
        return `<button class="ps5-context-item${active ? " is-current" : ""}" role="menuitemradio" aria-checked="${active}" data-act="prefer-version" data-id="${esc(version.appName)}">${storeLogo(version.source, 15)}<span>${esc(storeVersionLabel(version.source))}</span><span class="ctx-check">${active ? icon("check", 14) : ""}</span></button>`;
      }).join("")}<div class="ps5-context-sep"></div>`;

  const currentStatus = gameStatusOf(appName);
  const statusOptions = gameStatusOptions();
  const currentStatusOpt = currentStatus ? statusOptions.find((o) => o.value === currentStatus) : undefined;
  const statusTrigger = `
    <button type="button" class="ps5-context-item ctx-submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-act="status-submenu-noop">
      ${icon(currentStatusOpt ? currentStatusOpt.ic : "check-circle", 15)}
      <span class="ctx-item-name">${esc(t("status.label"))}</span>
      <span class="ctx-sub-tail">
        ${currentStatusOpt ? `<span class="ctx-sub-badge">${esc(currentStatusOpt.label)}</span>` : ""}
        <span class="ctx-chevron">${icon("chevron-right", 12)}</span>
      </span>
    </button>`;

  menu.innerHTML = `
    <div class="ps5-context-head" title="${esc(s.title)}">${esc(s.title)}</div>
    ${versionBlock}
    ${shared
      ? `<button class="ps5-context-item" role="menuitem" data-act="shared-switch" data-id="${esc(shared.ownerKey)}">${icon("arrow-left-right", 15)}<span>${t("shared.switchTo", { name: esc(shared.ownerName) })}</span></button>`
      : isSteam
        ? `${!s.installed ? steamItem("install", t("common.install"), "download") : s.updateAvailable ? steamItem("update", t("common.update"), "download") : steamItem("launch", t("common.play"), "play")}
    ${s.installed ? steamItem("validate", t("steam.validate"), "shield") : ""}
    ${item("manage-game", t("common.manage"), "settings")}`
        : isAmazon
          ? `${!installed ? amazonItem("amazon-install", t("common.install"), "download") : s.updateAvailable ? amazonItem("amazon-install", t("common.update"), "download") : amazonItem("amazon-play", t("common.play"), "play")}
    ${item("manage-game", t("common.manage"), "settings")}`
          : isCustom
            ? `${S.runningGames.has(appName)
                ? item("epic-stop", t("common.stop"), "square")
                : installed
                  ? item("epic-play", t("common.play"), "play")
                  : item("pick-custom-exe-for", t("customGames.setExe"), "folder")}
    ${item("edit-custom-game", t("common.edit"), "edit")}`
            : `${installed
                ? item("epic-play", t("common.play"), "play")
                : isCompanion
                  ? companionItem("companion-install", t("common.install"), "download")
                  : item("epic-install", t("common.install"), "download")}
    ${!isCustom ? item("manage-game", t("common.manage"), "settings") : ""}`}
    ${!shared && !isSteam && installed && (s.updateAvailable || S.availableUpdates.has(appName))
      ? item("toggle-ignore-update", S.ignoredUpdates.has(appName) ? t("ctx.restoreIndicator") : t("ctx.ignoreIndicator"), S.ignoredUpdates.has(appName) ? "bell" : "bell-off")
      : ""}
    <div class="ps5-context-sep"></div>
    ${!shared && !isSteam && !isCustom && installed && IS_WINDOWS ? item("manage-create-shortcut", t("ctx.shortcut"), "external") : ""}
    ${!shared && installed ? item("epic-open-folder", t("ctx.openFolder"), "folder") : ""}
    ${!shared && !isSteam && !isCustom && installed ? item("manage-create-backup", t("ctx.backup"), "cloud") : ""}
    ${item("epic-fav", faved ? t("ctx.favRemove") : t("ctx.favAdd"), "heart")}
    ${!shared ? item("manage-game-collections", t("ctx.addToCollection"), "layers") : ""}
    ${statusTrigger}
    ${!isRiot && !isAmazon && !isCustom ? item("epic-store-page", t("ctx.storePage"), "globe") : ""}
    ${item("hide-game", t("ctx.hide"), "eye-off")}
    ${!shared && (installed || isCustom)
      ? `<div class="ps5-context-sep"></div>${isSteam
          ? steamItem("uninstall", t("steam.uninstall"), "trash", true)
          : isAmazon
            ? amazonItem("amazon-uninstall", t("common.uninstall"), "trash", true)
            : isCompanion
              ? companionItem("companion-uninstall", t("common.uninstall"), "trash", true)
              : isCustom
                ? item("custom-game-remove", t("customGames.delete"), "trash", true)
                : item("epic-uninstall", t("common.uninstall"), "trash", true)}`
      : ""}
  `;

  const root = ctxRoot || document.body;
  root.appendChild(menu);
  S.ctxMenuEl = menu;

  const submenu = document.createElement("div");
  submenu.className = "ps5-context-menu ps5-context-submenu";
  submenu.setAttribute("role", "menu");
  submenu.style.display = "none";
  submenu.innerHTML = `
    ${statusOptions.map(({ value, label, ic }) => {
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
  `;
  root.appendChild(submenu);
  activeSubmenuEl = submenu;

  const triggerEl = menu.querySelector<HTMLElement>(".ctx-submenu-trigger");
  if (triggerEl) {
    let closeTimer: number | null = null;
    const cancelClose = (): void => {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
    };
    const scheduleClose = (): void => {
      cancelClose();
      closeTimer = window.setTimeout(() => {
        submenu.style.display = "none";
        triggerEl.setAttribute("aria-expanded", "false");
      }, 160);
    };
    const showSub = (): void => {
      cancelClose();
      positionSubmenu(triggerEl, submenu);
    };

    triggerEl.addEventListener("mouseenter", showSub);
    triggerEl.addEventListener("mouseleave", scheduleClose);
    triggerEl.addEventListener("click", () => {
      if (submenu.style.display === "block") {
        submenu.style.display = "none";
        triggerEl.setAttribute("aria-expanded", "false");
      } else {
        showSub();
      }
    });

    submenu.addEventListener("mouseenter", cancelClose);
    submenu.addEventListener("mouseleave", scheduleClose);

    menu.querySelectorAll(".ps5-context-item:not(.ctx-submenu-trigger)").forEach((otherItem) => {
      otherItem.addEventListener("mouseenter", () => {
        cancelClose();
        submenu.style.display = "none";
        triggerEl.setAttribute("aria-expanded", "false");
      });
    });
  }

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
        if (target.closest(".ctx-submenu-trigger")) {
          return;
        }
        window.setTimeout(hideContextMenu, 0);
        return;
      }
      hideContextMenu();
    },
    true,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (S.ctxMenuEl || activeSubmenuEl)) {
      hideContextMenu();
    }
  });

  window.addEventListener("scroll", hideContextMenu, true);
  window.addEventListener("resize", hideContextMenu, { passive: true });
}
