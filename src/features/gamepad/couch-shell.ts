/**
 * The Full Screen Mode couch shell.
 *
 * Full Screen Mode keeps the desktop pages, but presents them at living-room
 * distance: a top bar replaces the window chrome and the hidden sidebar, a
 * controller menu gathers every page and action, and the hint bar explains the
 * pad. The shell never owns navigation state; every button still goes through
 * the ordinary `data-view` / `data-act` router.
 */

import { icon, type IconName } from "../../core/icons";
import {
  discordPageVisible,
  notesSidebarVisible,
  screenshotsSidebarVisible,
  spotifyPageVisible,
} from "../../core/page-visibility";
import { S } from "../../core/state";
import { getActiveAppIconUrl } from "../../core/app-icon";
import { downloadBadgeCounts } from "../../core/download-badge";
import { esc } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import { releaseStoreOverlay, holdStoreOverlay } from "../store/store-view";
import {
  isControllerKeyboardOpen,
  closeControllerKeyboard,
} from "./on-screen-keyboard";
import {
  bumperGlyph,
  faceGlyph,
  hudItem,
  systemGlyph,
  triggerGlyph,
} from "./pad-hints";

const HOLD_REASON = "couch-overlay";

let clockTimer = 0;
let controlsReturnToMenu = false;
let titleObserver: MutationObserver | null = null;

function host(): HTMLElement | null {
  return document.getElementById("couch-root");
}

function bar(): HTMLElement | null {
  return document.getElementById("couch-bar");
}

function menuLayer(): HTMLElement | null {
  return document.getElementById("couch-menu-layer");
}

function controlsLayer(): HTMLElement | null {
  return document.getElementById("couch-controls-layer");
}

function holdOverlay(): void {
  if (S.view === "store") void holdStoreOverlay(HOLD_REASON);
}

function releaseOverlayIfIdle(): void {
  if (!menuLayer() && !controlsLayer()) releaseStoreOverlay(HOLD_REASON);
}

function pageTitle(): string {
  const live = document.getElementById("page-title")?.textContent?.trim();
  if (live) return live;
  if (S.view === "store") return t("nav.store");
  const key: Record<string, string> = {
    library: "nav.library",
    downloads: "nav.downloads",
    profile: "palette.cmdProfile",
    settings: "nav.settings",
  };
  return t(key[S.view] ?? "nav.library");
}

function clockText(): string {
  try {
    return new Intl.DateTimeFormat(currentLanguage(), {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  } catch {
    return "";
  }
}

function navButton(
  view: string,
  iconName: IconName,
  label: string,
  gpKey: string,
  badge = false,
): string {
  return `<button type="button" class="couch-nav-item" data-view="${view}" data-couch-view="${view}" data-gp-item data-gp-key="couch:nav:${gpKey}">
    ${icon(iconName, 17)}<span>${esc(label)}</span>${badge ? `<span class="couch-badge hidden" data-couch-dl></span><span class="couch-update-pill hidden" data-couch-update></span>` : ""}
  </button>`;
}

/** Edit or refresh the top bar. Mounting is separate so a render can patch it. */
export function refreshCouchBar(): void {
  const el = bar();
  if (!el) return;

  const title = el.querySelector<HTMLElement>("[data-couch-title]");
  if (title) {
    const next = pageTitle();
    if (title.textContent !== next) title.textContent = next;
    // The nav already names the active page; repeating it next to the brand is
    // noise. A game page title still differs and stays visible.
    const activeItem = el.querySelector<HTMLElement>("[data-couch-view].active, [data-couch-store].active");
    const activeLabel = activeItem?.querySelector<HTMLElement>("span")?.textContent?.trim() ?? "";
    const duplicate = Boolean(activeLabel) && activeLabel === next;
    title.hidden = duplicate;
    const sep = el.querySelector<HTMLElement>(".couch-brand-sep");
    if (sep) sep.hidden = duplicate;
  }

  el.querySelectorAll<HTMLElement>("[data-couch-view]").forEach((item) => {
    const active = item.dataset.couchView === S.view;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
    item.removeAttribute("data-gp-default");
  });
  const store = el.querySelector<HTMLElement>("[data-couch-store]");
  if (store) {
    const active = S.view === "store";
    store.classList.toggle("active", active);
    if (active) store.setAttribute("aria-current", "page");
    else store.removeAttribute("aria-current");
    store.removeAttribute("data-gp-default");
  }
  const brandIcon = el.querySelector<HTMLImageElement>("[data-couch-brand-icon]");
  const brandUrl = getActiveAppIconUrl();
  if (brandIcon && brandIcon.getAttribute("src") !== brandUrl) brandIcon.src = brandUrl;
  // Entering a non-library page should start on its tab, not on the Back
  // button. The library keeps its first cover as the default stop.
  if (S.view !== "library") {
    const activeNav = el.querySelector<HTMLElement>(
      "[data-couch-view].active, [data-couch-store].active",
    );
    activeNav?.setAttribute("data-gp-default", "");
  }

  // The hidden sidebar counts downloads and waiting updates together. The top
  // bar separates them: a number badge only for moving/queued work, and an
  // amber refresh chip for a pending update so "1" never means "no download".
  const counts = downloadBadgeCounts("progress");
  const dlBadge = el.querySelector<HTMLElement>("[data-couch-dl]");
  if (dlBadge) {
    dlBadge.textContent = counts.downloads > 0 ? String(counts.downloads) : "";
    dlBadge.classList.toggle("hidden", counts.downloads === 0);
  }
  const dlUpdate = el.querySelector<HTMLElement>("[data-couch-update]");
  if (dlUpdate) {
    dlUpdate.classList.toggle("hidden", counts.updates === 0);
    if (counts.updates > 0) {
      dlUpdate.innerHTML = `${icon("refresh", 9)}<b>${counts.updates}</b>`;
    }
  }
  const downloadsNav = el.querySelector<HTMLElement>('[data-gp-key="couch:nav:downloads"]');
  if (downloadsNav) {
    const parts: string[] = [];
    if (counts.downloads > 0) parts.push(t("downloads.activeDownloads", { count: counts.downloads }));
    if (counts.updates > 0) parts.push(t("downloads.updatesReady", { count: counts.updates }));
    const title = parts.join(" · ");
    downloadsNav.title = title || t("nav.downloadsTitle");
    downloadsNav.setAttribute("aria-label", [t("nav.downloads"), title].filter(Boolean).join(" · "));
  }

  // The hidden sidebar still owns the notification counter.
  const mirror = (sourceId: string, targetSelector: string): void => {
    const source = document.getElementById(sourceId);
    const target = el.querySelector<HTMLElement>(targetSelector);
    if (!target) return;
    const count = source?.textContent?.trim() ?? "";
    const hidden = source?.classList.contains("hidden") ?? true;
    target.textContent = count;
    target.classList.toggle("hidden", hidden || !count);
  };
  mirror("notif-badge", "[data-couch-notif]");

  const controller = el.querySelector<HTMLElement>("[data-couch-controller]");
  if (controller) {
    const connected = S.gamepadPolling && Boolean(S.gamepadName);
    controller.classList.toggle("hidden", !connected);
    if (connected) {
      const name = controller.querySelector<HTMLElement>("[data-couch-pad-name]");
      if (name && name.textContent !== S.gamepadName) name.textContent = S.gamepadName;
      controller.title = S.gamepadName;
      const battery = S.stage.controllerBattery;
      const batteryEl = controller.querySelector<HTMLElement>("[data-couch-battery]");
      if (batteryEl) {
        const show = battery !== null && Number.isFinite(battery);
        batteryEl.classList.toggle("hidden", !show);
        if (show) {
          batteryEl.textContent = `${Math.max(0, Math.min(100, Math.round((battery ?? 0) * 100)))}%`;
        }
      }
    }
  }

  const running = el.querySelector<HTMLElement>("[data-couch-running]");
  if (running) {
    const count = S.runningGames.size;
    running.classList.toggle("hidden", count === 0);
    if (count > 0) running.textContent = count > 1 ? `${t("common.playing")} · ${count}` : t("common.playing");
  }

  const net = el.querySelector<HTMLElement>("[data-couch-net]");
  if (net) {
    net.classList.toggle("offline", S.offlineMode);
    net.title = S.offlineMode ? t("nav.offline") : t("nav.online");
    const label = net.querySelector<HTMLElement>("[data-couch-net-label]");
    const next = S.offlineMode ? t("nav.offline") : t("nav.online");
    if (label && label.textContent !== next) label.textContent = next;
  }

  const clock = el.querySelector<HTMLElement>("[data-couch-clock]");
  if (clock) {
    const next = clockText();
    if (next && clock.textContent !== next) clock.textContent = next;
  }
}

function mountBar(): void {
  if (bar()) return;
  const root = host();
  if (!root) return;
  const el = document.createElement("header");
  el.id = "couch-bar";
  el.className = "couch-bar";
  el.innerHTML = `
    <div class="couch-brand" aria-hidden="true">
      <span class="couch-brand-mark"><img class="couch-brand-icon" data-couch-brand-icon src="${esc(getActiveAppIconUrl())}" alt="" /></span>
      <span class="couch-brand-name">EFXLVE</span>
      <span class="couch-brand-sep"></span>
      <span class="couch-page-title" data-couch-title></span>
    </div>
    <nav class="couch-nav" aria-label="${esc(t("couch.pages"))}">
      <button type="button" class="couch-nav-item" data-act="open-store" data-couch-store data-gp-item data-gp-key="couch:nav:store">
        ${icon("store", 17)}<span>${esc(t("nav.store"))}</span>
      </button>
      ${navButton("library", "layout-grid", t("nav.library"), "library")}
      ${navButton("downloads", "download", t("nav.downloads"), "downloads", true)}
      ${navButton("profile", "user", t("palette.cmdProfile"), "profile")}
      ${navButton("settings", "settings", t("nav.settings"), "settings")}
    </nav>
    <div class="couch-status">
      <span class="couch-status-chip couch-running hidden" data-couch-running></span>
      <button type="button" class="couch-status-chip couch-net online" data-couch-net data-act="toggle-offline-mode" data-gp-item data-gp-key="couch:net">
        <span class="couch-net-dot" aria-hidden="true"></span><span data-couch-net-label>${esc(t("nav.online"))}</span>
      </button>
      <span class="couch-status-chip couch-controller hidden" data-couch-controller>
        ${icon("gamepad-2", 14)}
        <span class="couch-pad-name" data-couch-pad-name></span>
        <span class="couch-pad-battery hidden" data-couch-battery></span>
      </span>
      <span class="couch-clock tabular-nums" data-couch-clock></span>
      <button type="button" id="couch-notif-btn" class="couch-icon-btn couch-bell" data-act="toggle-notifications" data-gp-item data-gp-key="couch:notifications" title="${esc(t("notif.title"))}" aria-label="${esc(t("notif.title"))}">
        ${icon("bell", 18)}<span class="couch-badge hidden" data-couch-notif></span>
      </button>
      <button type="button" class="couch-icon-btn couch-menu-btn" data-act="open-couch-menu" data-gp-item data-gp-key="couch:menu" title="${esc(t("couch.menu"))}" aria-label="${esc(t("couch.menu"))}">
        ${icon("menu", 17)}<span>${esc(t("couch.menuButton"))}</span>
      </button>
      <button type="button" class="couch-icon-btn couch-exit-btn" data-act="toggle-fullscreen-mode" data-gp-item data-gp-key="couch:exit" title="${esc(t("fullscreen.exit"))}" aria-label="${esc(t("fullscreen.exit"))}">
        ${icon("minimize-2", 16)}
      </button>
    </div>`;
  root.appendChild(el);
  if (!clockTimer) clockTimer = window.setInterval(refreshCouchBar, 15_000);
  if (!titleObserver) {
    const title = document.getElementById("page-title");
    if (title) {
      titleObserver = new MutationObserver(refreshCouchBar);
      titleObserver.observe(title, { childList: true, characterData: true, subtree: true });
    }
  }
  refreshCouchBar();
}

/** Mount or tear down the couch presentation with Full Screen Mode itself. */
export function setCouchUiActive(on: boolean): void {
  if (on) {
    mountBar();
    document.body.classList.add("couch-ui");
    refreshCouchBar();
    return;
  }
  // Leaving the mode must never reopen a sheet: the map's back-to-menu flag is
  // an in-session affordance, not a reason to paint a menu over the desktop.
  controlsReturnToMenu = false;
  closeCouchMenu();
  closeCouchControls();
  closeControllerKeyboard();
  bar()?.remove();
  if (clockTimer) {
    window.clearInterval(clockTimer);
    clockTimer = 0;
  }
  document.body.classList.remove("couch-ui");
}

/* ----------------------------------------------------------------------- */
/*  Controller menu                                                        */
/* ----------------------------------------------------------------------- */

function menuItem(opts: {
  label: string;
  desc?: string;
  iconName: IconName;
  view?: string;
  act?: string;
  attrs?: string;
  gpKey: string;
  active?: boolean;
  defaultFocus?: boolean;
}): string {
  const target = opts.view ? `data-view="${opts.view}"` : `data-act="${opts.act ?? ""}"`;
  return `<button type="button" class="couch-menu-item${opts.active ? " is-active" : ""}" ${target} ${opts.attrs ?? ""} data-gp-item data-gp-key="couch:menu:${opts.gpKey}"${opts.defaultFocus ? " data-gp-default" : ""}>
    <span class="couch-menu-icon">${icon(opts.iconName, 20)}</span>
    <span class="couch-menu-label"><b>${esc(opts.label)}</b>${opts.desc ? `<small>${esc(opts.desc)}</small>` : ""}</span>
    ${opts.active ? `<span class="couch-menu-active">${icon("check", 14)}</span>` : ""}
  </button>`;
}

function menuPages(): string {
  const items = [
    menuItem({ label: t("nav.store"), iconName: "store", act: "open-store", gpKey: "store", active: S.view === "store" }),
    menuItem({ label: t("nav.library"), iconName: "layout-grid", view: "library", gpKey: "library", active: S.view === "library" }),
    menuItem({ label: t("nav.downloads"), iconName: "download", view: "downloads", gpKey: "downloads", active: S.view === "downloads" }),
    menuItem({ label: t("palette.cmdProfile"), iconName: "user", view: "profile", gpKey: "profile", active: S.view === "profile" }),
    menuItem({ label: t("nav.settings"), iconName: "settings", view: "settings", gpKey: "settings", active: S.view === "settings" }),
    menuItem({ label: t("accounts.title"), iconName: "users", view: "accounts", gpKey: "accounts", active: S.view === "accounts" }),
    menuItem({ label: t("calendar.title"), iconName: "calendar", act: "open-release-calendar", gpKey: "calendar" }),
  ];
  if (notesSidebarVisible()) {
    items.push(menuItem({ label: t("notes.title"), iconName: "edit", view: "notes", gpKey: "notes", active: S.view === "notes" }));
  }
  if (screenshotsSidebarVisible()) {
    items.push(menuItem({ label: t("ss.title"), iconName: "clapperboard", view: "screenshots", gpKey: "screenshots", active: S.view === "screenshots" }));
  }
  if (spotifyPageVisible()) {
    items.push(menuItem({ label: t("overlay.tabSpotify"), iconName: "spotify", view: "music", gpKey: "music", active: S.view === "music" }));
  }
  if (discordPageVisible()) {
    items.push(menuItem({ label: t("discord.title"), iconName: "discord", view: "discord", gpKey: "discord", active: S.view === "discord" }));
  }
  return items.join("");
}

export function isCouchMenuOpen(): boolean {
  return Boolean(menuLayer());
}

export function openCouchMenu(): void {
  if (S.stage.active) return;
  const root = host();
  if (!root) return;
  closeControllerKeyboard();
  // A map opened from the menu returns to it, but opening the menu directly
  // must not bounce back through that flag. Remove the map in place so the
  // store parking hold is not released between the two sheets.
  controlsReturnToMenu = false;
  controlsLayer()?.remove();
  holdOverlay();
  menuLayer()?.remove();
  const layer = document.createElement("div");
  layer.id = "couch-menu-layer";
  layer.className = "couch-layer couch-menu-layer";
  layer.innerHTML = `
    <button type="button" class="couch-backdrop" data-act="close-couch-menu" tabindex="-1" aria-hidden="true"></button>
    <div class="couch-sheet couch-menu" role="dialog" aria-modal="true" aria-label="${esc(t("couch.menu"))}">
      <header class="couch-sheet-head">
        <span class="couch-sheet-title">${icon("menu", 20)}<span>${esc(t("couch.menu"))}</span></span>
        <span class="couch-sheet-sub">${esc(clockText())}</span>
      </header>
      <div class="couch-menu-body">
        <div class="couch-menu-group">
          <div class="couch-menu-group-title">${esc(t("couch.actions"))}</div>
          <div class="couch-menu-grid">
            ${menuItem({ label: t("palette.searchGames"), desc: t("couch.searchHint"), iconName: "search", act: "open-palette", gpKey: "search", defaultFocus: S.runningGames.size === 0 })}
            ${menuItem({ label: t("couch.controls"), desc: t("couch.controlsHint"), iconName: "keyboard", act: "open-couch-controls", attrs: `data-return-menu="1"`, gpKey: "controls" })}
            ${menuItem({ label: t("palette.cmdOffline"), desc: S.offlineMode ? t("nav.offline") : t("nav.online"), iconName: S.offlineMode ? "wifi" : "wifi-off", act: "toggle-offline-mode", gpKey: "offline" })}
            ${menuItem({ label: t("fullscreen.exit"), desc: t("couch.exitDesc"), iconName: "minimize-2", act: "toggle-fullscreen-mode", gpKey: "exit" })}
          </div>
        </div>
        <div class="couch-menu-group">
          <div class="couch-menu-group-title">${esc(t("couch.pages"))}</div>
          <div class="couch-menu-grid couch-menu-pages">${menuPages()}</div>
        </div>
      </div>
      <footer class="couch-sheet-foot">
        ${hudItem(faceGlyph(S.gamepadKind, S.fullscreenSwapAB ? "b" : "a"), t("gamepad.select"))}
        ${hudItem(faceGlyph(S.gamepadKind, S.fullscreenSwapAB ? "a" : "b"), t("common.close"))}
        ${hudItem(systemGlyph("D-Pad"), t("gamepad.navigate"))}
        <span class="couch-sheet-hint">${esc(t("couch.menuHint"))}</span>
      </footer>
    </div>`;
  root.appendChild(layer);
}

export function closeCouchMenu(): void {
  menuLayer()?.remove();
  releaseOverlayIfIdle();
}

/* ----------------------------------------------------------------------- */
/*  Controller map                                                         */
/* ----------------------------------------------------------------------- */

function controlRow(glyph: string, label: string, desc: string): string {
  return `<div class="couch-control-row">
    <span class="couch-control-glyph">${glyph}</span>
    <span class="couch-control-copy"><b>${esc(label)}</b><small>${esc(desc)}</small></span>
  </div>`;
}

function controlsMarkup(): string {
  const kind = S.gamepadKind;
  const confirm = faceGlyph(kind, S.fullscreenSwapAB ? "b" : "a");
  const back = faceGlyph(kind, S.fullscreenSwapAB ? "a" : "b");
  const rows = [
    controlRow(`${systemGlyph("D-Pad")}${systemGlyph("Stick")}`, t("gamepad.navigate"), t("couch.navigateDesc")),
    controlRow(confirm, t("gamepad.select"), t("couch.selectDesc")),
    controlRow(back, t("common.back"), t("couch.backDesc")),
    controlRow(faceGlyph(kind, "x"), t("gamepad.favorite"), t("couch.favoriteDesc")),
    controlRow(faceGlyph(kind, "y"), t("palette.searchGames"), t("couch.searchHint")),
    controlRow(`${bumperGlyph(kind, "l")}${bumperGlyph(kind, "r")}`, t("gamepad.tabs"), t("couch.tabsHint")),
    controlRow(`${triggerGlyph(kind, "l")}${triggerGlyph(kind, "r")}`, t("couch.pages"), t("couch.pageHint")),
    controlRow(systemGlyph("Menu"), t("couch.menuButton"), t("couch.menuDesc")),
  ];
  return rows.join("");
}

export function isCouchControlsOpen(): boolean {
  return Boolean(controlsLayer());
}

export function openCouchControls(returnToMenu = false): void {
  const root = host();
  if (!root) return;
  closeControllerKeyboard();
  controlsReturnToMenu = returnToMenu;
  // A menu -> map transition keeps the native store parked: the map replaces
  // the menu instead of opening a second covering surface.
  menuLayer()?.remove();
  holdOverlay();
  controlsLayer()?.remove();
  const layer = document.createElement("div");
  layer.id = "couch-controls-layer";
  layer.className = "couch-layer couch-controls-layer";
  layer.innerHTML = `
    <button type="button" class="couch-backdrop" data-act="close-couch-controls" tabindex="-1" aria-hidden="true"></button>
    <div class="couch-sheet couch-controls" role="dialog" aria-modal="true" aria-label="${esc(t("couch.controls"))}">
      <header class="couch-sheet-head">
        <span class="couch-sheet-title">${icon("keyboard", 20)}<span>${esc(t("couch.controls"))}</span></span>
        <button type="button" class="couch-icon-btn" data-act="close-couch-controls" data-gp-item data-gp-key="couch:controls:close" data-gp-default aria-label="${esc(t("common.close"))}">${icon("x", 18)}</button>
      </header>
      <div class="couch-control-list">${controlsMarkup()}</div>
      <footer class="couch-sheet-foot">
        ${hudItem(faceGlyph(S.gamepadKind, S.fullscreenSwapAB ? "a" : "b"), t("common.back"))}
        <span class="couch-sheet-hint">${esc(t("couch.controlsHint"))}</span>
      </footer>
    </div>`;
  root.appendChild(layer);
}

export function closeCouchControls(): void {
  const had = Boolean(controlsLayer());
  controlsLayer()?.remove();
  if (had && controlsReturnToMenu && S.isFullscreen && !isCouchMenuOpen()) {
    controlsReturnToMenu = false;
    openCouchMenu();
    return;
  }
  controlsReturnToMenu = false;
  releaseOverlayIfIdle();
}

/**
 * One Back press through the couch surfaces. Returns true when the press was
 * consumed, so the gamepad loop and Escape handler can fall through to the
 * desktop rules only when nothing is open.
 */
export function couchBack(): boolean {
  if (isControllerKeyboardOpen()) {
    closeControllerKeyboard();
    return true;
  }
  if (isCouchControlsOpen()) {
    closeCouchControls();
    return true;
  }
  if (isCouchMenuOpen()) {
    closeCouchMenu();
    return true;
  }
  return false;
}

// Download counters change without a render in the desktop shell. A progress
// event can arrive several times per second, so batch the bar patch per frame.
let refreshRaf = 0;
function scheduleCouchRefresh(): void {
  if (refreshRaf) return;
  refreshRaf = window.requestAnimationFrame(() => {
    refreshRaf = 0;
    refreshCouchBar();
  });
}

window.addEventListener("couch-refresh", scheduleCouchRefresh);
// The palette is a higher-level search surface. Opening it from a keyboard
// shortcut must not leave a couch menu or map underneath.
window.addEventListener("palette-open", () => {
  controlsReturnToMenu = false;
  closeCouchMenu();
  closeCouchControls();
  closeControllerKeyboard();
});
