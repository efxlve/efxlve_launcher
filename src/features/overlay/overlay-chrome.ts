/**
 * Overlay top-bar chrome: battery state, the recent-games pill and the shell
 * markup that places the dock, the floating widgets and the lightbox.
 *
 * One-way dependency: the page configures tab queries through
 * configureChrome; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { OVERLAY_HUD_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

interface ChromeContext {
  appName: string;
  title: string;
}

interface ChromeTab {
  id: string;
  icon: Parameters<typeof icon>[0];
  key: string;
}

interface ChromeDeps {
  context: () => ChromeContext;
  launcherMode: () => boolean;
  visibleTabs: () => ChromeTab[];
  allTabs: () => ChromeTab[];
  isWidgetOpen: (tab: string) => boolean;
  isWidgetPinned: (tab: string) => boolean;
}

let deps: ChromeDeps | null = null;

export function configureChrome(next: ChromeDeps): void {
  deps = next;
}

function D(): ChromeDeps {
  if (!deps) throw new Error("overlay chrome rendered before configuration");
  return deps;
}

const CLOCK_SECONDS_KEY = "efxlve-overlay-clock-seconds";
const BATTERY_PERCENT_KEY = "efxlve-overlay-battery-percent";

export function showClockSeconds(): boolean {
  return localStorage.getItem(CLOCK_SECONDS_KEY) === "true";
}

export function showBatteryPercent(): boolean {
  return localStorage.getItem(BATTERY_PERCENT_KEY) === "true";
}

/* ---------- Battery Monitoring ---------- */

interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
  addEventListener(type: "chargingchange" | "levelchange", listener: EventListener): void;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

let cachedBattery: { level: number; charging: boolean } | null = null;
let batteryListenerAttached = false;

export function initBatteryMonitoring(): void {
  const nav = navigator as NavigatorWithBattery;
  if (!nav.getBattery || batteryListenerAttached) return;
  batteryListenerAttached = true;
  nav.getBattery()
    .then((battery) => {
      const update = (): void => {
        cachedBattery = {
          level: Math.round(battery.level * 100),
          charging: battery.charging,
        };
        paintBattery();
      };
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    })
    .catch(() => undefined);
}

export function paintBattery(): void {
  const el = document.getElementById("ov-topbar-battery");
  if (!el) return;
  const showPct = showBatteryPercent();
  if (!cachedBattery) {
    el.innerHTML = `<span class="ov-battery-icon">${icon("battery", 15)}</span>`;
    el.title = t("common.battery");
    return;
  }
  const ic = cachedBattery.charging ? icon("battery-charging", 15) : icon("battery", 15);
  el.innerHTML = `
    <span class="ov-battery-icon">${ic}</span>
    ${showPct ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
  `;
  el.title = `${t("common.battery")}: ${cachedBattery.level}%`;
}


/* ---------- Recent Games (Top Bar Left) ---------- */

interface RecentGameInfo {
  appName: string;
  title: string;
  coverUrl?: string;
}

let recentMenuOpen = false;

export function inferStoreLabel(appName: string): string {
  if (appName.startsWith("steam::")) return "Steam";
  if (appName.startsWith("gog::")) return "GOG";
  if (appName.startsWith("amazon::")) return "Amazon";
  if (appName.startsWith("ubisoft::")) return "Ubisoft";
  if (appName.startsWith("ea::")) return "EA";
  if (appName.startsWith("xbox::")) return "Xbox";
  if (appName.startsWith("battlenet::")) return "Battle.net";
  if (appName.startsWith("riot::")) return "Riot";
  if (appName.startsWith("custom::")) return t("customGames.storeLabel");
  return "Epic Games";
}

export function getRecentGames(): RecentGameInfo[] {
  let list: RecentGameInfo[] = [];
  try {
    const raw = localStorage.getItem("efxlve-recent-games-cache");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) list = parsed;
    }
  } catch {
    // fallback
  }

  if (list.length === 0) {
    try {
      const raw = localStorage.getItem("efxlve-recent");
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length > 0) {
          list = ids.map((id: string) => {
            let title = id;
            let coverUrl = "";
            if (id.startsWith("steam::")) {
              const appId = id.slice(7);
              title = `Steam App ${appId}`;
              coverUrl = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
            }
            return { appName: id, title, coverUrl };
          });
        }
      }
    } catch {
      // fallback
    }
  }

  if (!D().launcherMode() && D().context().appName && D().context().title) {
    const idx = list.findIndex((g) => g.appName === D().context().appName);
    if (idx >= 0) {
      const [item] = list.splice(idx, 1);
      list.unshift(item);
    } else {
      list.unshift({ appName: D().context().appName, title: D().context().title });
    }
  }

  return list.slice(0, 5);
}

export function recentGamesPillHtml(): string {
  const list = getRecentGames();
  const isPlaying = !D().launcherMode() && Boolean(D().context().title);
  const activeTitle = isPlaying ? D().context().title : "";
  const pillTitle = activeTitle.split(/\s+[–—-]\s+/)[0].trim() || activeTitle;
  const activeGame = isPlaying
    ? list.find((g) => g.appName === D().context().appName) || { appName: D().context().appName, title: D().context().title, coverUrl: "" }
    : null;

  return `
    <button class="ov-topbar-game-hub-btn ${isPlaying ? "is-playing" : ""}" id="ov-topbar-game-hub-btn" data-ov="toggle-recent-menu" title="${esc(t("profile.recentGamesTitle"))}">
      ${isPlaying ? `
        <span class="ov-hub-art-wrap">
          ${activeGame?.coverUrl
            ? `<img class="ov-hub-art" src="${esc(activeGame.coverUrl)}" alt="" />`
            : `<span class="ov-hub-art ov-ph">${icon("gamepad-2", 13)}</span>`
          }
          <span class="ov-hub-live-dot" title="${esc(t("overlay.running"))}"></span>
        </span>
        <span class="ov-hub-title" title="${esc(activeTitle)}">${esc(pillTitle)}</span>
      ` : `
        <span class="ov-hub-icon">${icon("gamepad-2", 14)}</span>
        <span class="ov-hub-title">${esc(t("profile.recentGamesTitle"))}</span>
        <span class="ov-hub-chip">${list.length}</span>
      `}
      <span class="ov-hub-arrow">${icon("chevron-down", 11)}</span>
    </button>
    <div class="ov-quick-launch-popover" id="ov-recent-dropdown"${recentMenuOpen ? "" : ' style="display:none"'}>
      <div class="ov-quick-header">
        <div class="ov-quick-header-title">
          ${icon("sparkles", 13)}
          <span>${esc(t("profile.recentGamesTitle"))}</span>
        </div>
        <span class="ov-quick-header-badge">${list.length} ${esc(t("profile.games"))}</span>
      </div>
      <div class="ov-quick-cards">
        ${list.length > 0 ? list.map((g) => {
          const isCurrent = !D().launcherMode() && D().context().appName === g.appName;
          const storeLabel = inferStoreLabel(g.appName);
          return `
            <button class="ov-quick-card ${isCurrent ? "is-current" : ""}" data-ov="launch-recent-game" data-id="${esc(g.appName)}" title="${esc(g.title)}">
              <div class="ov-quick-card-art-wrap">
                ${g.coverUrl ? `<img class="ov-quick-card-art" src="${esc(g.coverUrl)}" alt="" loading="lazy" />` : `<div class="ov-quick-card-art ov-ph">${icon("gamepad-2", 16)}</div>`}
                ${isCurrent ? `<span class="ov-quick-live-indicator" title="${esc(t("overlay.running"))}"></span>` : ""}
              </div>
              <div class="ov-quick-card-info">
                <span class="ov-quick-card-title">${esc(g.title)}</span>
                <div class="ov-quick-card-tags">
                  ${isCurrent
                    ? `<span class="ov-quick-tag is-running">● ${esc(t("overlay.running"))}</span>`
                    : `<span class="ov-quick-tag is-store">${esc(storeLabel)}</span>`
                  }
                </div>
              </div>
              <div class="ov-quick-card-action">
                <span class="ov-quick-play-btn">${icon("play", 11)}</span>
              </div>
            </button>
          `;
        }).join("") : `
          <div class="ov-quick-empty">${esc(t("profile.noRecentGames"))}</div>
        `}
      </div>
    </div>`;
}

export function refreshRecentGamesPill(): void {
  const wrap = document.getElementById("ov-topbar-recent-wrap");
  if (wrap) wrap.innerHTML = recentGamesPillHtml();
}

export function toggleRecentMenu(): void {
  recentMenuOpen = !recentMenuOpen;
  const menu = document.getElementById("ov-recent-dropdown");
  if (menu) menu.style.display = recentMenuOpen ? "flex" : "none";
}

export function closeRecentMenu(): void {
  recentMenuOpen = false;
  const menu = document.getElementById("ov-recent-dropdown");
  if (menu) menu.style.display = "none";
}

export async function launchRecentGame(appName: string): Promise<void> {
  closeRecentMenu();
  if (!D().launcherMode() && D().context().appName === appName) {
    void invoke("overlay_hide");
    return;
  }
  const separator = appName.indexOf("::");
  const store = separator >= 0 ? appName.slice(0, separator) : "";
  const id = separator >= 0 ? appName.slice(separator + 2) : appName;
  try {
    if (store === "steam") {
      // The opener plugin only allows mailto/tel/http(s); steam:// dies there
      // and the old code still closed the panel, so the click looked dead.
      await invoke("steam_game_action", { appId: id, action: "launch" });
    } else if (store === "amazon") {
      await invoke("nile_launch", { id });
    } else if (store === "custom") {
      await invoke("custom_games_launch", { id });
    } else if (store === "ea" || store === "ubisoft" || store === "xbox" || store === "battlenet" || store === "riot") {
      await invoke("companion_launch", { store, id });
    } else if (store === "gog") {
      await invoke("gog_launch_game", { gameId: appName });
    } else {
      await invoke("epic_launch_game", { appName });
    }
  } catch {
    void invoke("overlay_show_launcher");
  }
  void invoke("overlay_hide");
}


/* ---------- Shell HTML Template ---------- */

export function shellHtml(): string {
  const hudActive = localStorage.getItem(OVERLAY_HUD_KEY) === "true";
  const tabs = D().visibleTabs();
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  const padConnected = Boolean(gamepads.find((p) => p && p.connected));
  return `
    <div class="ov" id="ov-shell">
      <!-- Floating Top Widget Bar (Xbox Game Bar style) -->
      <header class="ov-topbar" id="ov-topbar">
        <div class="ov-topbar-recent-wrap" id="ov-topbar-recent-wrap">
          ${recentGamesPillHtml()}
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-widgets" id="ov-topbar-widgets">
          ${tabs.map((tab) => `
            <button class="ov-topbar-btn ${D().isWidgetOpen(tab.id) ? "active" : ""}" data-ov-widget-toggle="${tab.id}" title="${esc(t(tab.key))}">
              ${icon(tab.icon, 15)}
              <span class="ov-topbar-btn-label">${esc(t(tab.key))}</span>
            </button>
          `).join("")}
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-clock">
          <span id="ov-clock-time">00:00</span><span class="ov-clock-sec" id="ov-clock-sec" style="${showClockSeconds() ? "" : "display:none"}">:00</span>
        </div>

        <div class="ov-topbar-divider"></div>

        <div class="ov-topbar-battery" id="ov-topbar-battery" title="${esc(t("common.battery"))}">
          <span class="ov-battery-icon">${icon("battery", 15)}</span>
          ${showBatteryPercent() && cachedBattery ? `<span class="ov-battery-level">${cachedBattery.level}%</span>` : ""}
        </div>

        <div class="ov-topbar-gamepad" id="ov-topbar-gamepad" style="${padConnected ? "" : "display:none"}" title="${esc(t("settings.secController"))}">
          ${icon("gamepad-2", 15)}
        </div>

        <button class="ov-topbar-btn ov-topbar-settings-btn ${D().isWidgetOpen("settings") ? "active" : ""}" data-ov-widget-toggle="settings" title="${esc(t("overlay.tabSettings"))}">
          ${icon("settings", 15)}
        </button>

        <button class="ov-topbar-btn ov-topbar-close-btn" data-ov="close" title="${esc(t("common.close"))}">
          ${icon("x", 15)}
        </button>
      </header>

      <!-- Floating Widgets Container -->
      <div class="ov-widgets-container" id="ov-widgets-container">
        ${D().allTabs().filter((tab) => tab.id !== "browser").map((tab) => `
          <section class="ov-widget" id="ov-widget-${tab.id}" data-widget-id="${tab.id}">
            <header class="ov-widget-header" data-widget-drag="${tab.id}">
              <div class="ov-widget-title">
                ${icon(tab.icon, 14)}
                <span>${esc(tab.id === "discord" ? t("overlay.discordSocial") : tab.id === "chat" ? t("overlay.discordChat") : t(tab.key))}</span>
              </div>
              <div class="ov-widget-header-actions">
                ${tab.id === "music" ? `
                  <button class="ov-widget-tool-btn ov-sp-mini-toggle-btn" id="ov-sp-mini-toggle-btn" data-ov="sp-toggle-mini-view" title="${esc(t("overlay.library"))}">
                    ${icon("list", 12)}
                  </button>
                ` : ""}
                <button class="ov-widget-tool-btn ov-widget-pin-btn${D().isWidgetPinned(tab.id) ? " is-pinned" : ""}" data-ov-widget-pin="${tab.id}" title="${esc(D().isWidgetPinned(tab.id) ? t("overlay.widgetUnpin") : t("overlay.widgetPin"))}">
                  ${icon("pin", 12)}
                </button>
                <button class="ov-widget-tool-btn ov-widget-close-btn" data-ov-widget-close="${tab.id}" title="${esc(t("common.close"))}">
                  ${icon("x", 13)}
                </button>
              </div>
            </header>
            <div class="ov-widget-body" id="ov-widget-${tab.id}-body" data-ov-view="${tab.id}"></div>
            <div class="ov-widget-resizer" data-widget-resize="${tab.id}" title="${esc(t("overlay.widgetResize"))}"></div>
          </section>
        `).join("")}
      </div>

      <!-- Screenshot Lightbox Modal -->
      <div class="ov-lightbox" id="ov-lightbox" style="display:none">
        <button class="ov-lightbox-nav ov-lightbox-prev" data-ov="lightbox-prev" title="${esc(t("overlay.previous"))}">${icon("chevron-left", 26)}</button>
        <div class="ov-lightbox-content">
          <img id="ov-lightbox-img" src="" alt="" />
          <div class="ov-lightbox-counter" id="ov-lightbox-counter"></div>
          <button class="ov-lightbox-close" data-ov="close-lightbox">${icon("x", 18)}</button>
        </div>
        <button class="ov-lightbox-nav ov-lightbox-next" data-ov="lightbox-next" title="${esc(t("overlay.next"))}">${icon("chevron-right", 26)}</button>
      </div>
    </div>`;
}


/** The controller asks whether the quick-launch popover owns the ring. */
export function isRecentMenuOpen(): boolean {
  return recentMenuOpen;
}
