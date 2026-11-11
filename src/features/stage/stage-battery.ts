/**
 * Real-time Device and Controller Battery Monitor for Stage mode.
 *
 * Essential for handheld gaming PCs (Steam Deck, ROG Ally, Legion Go, Claw, etc.).
 * Reads the native battery level and charging state via navigator.getBattery(),
 * falling back gracefully to controller battery or staying hidden on wall-powered desktops.
 */

import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

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

export interface StageBatteryInfo {
  level: number;
  charging: boolean;
  available: boolean;
  isDevice: boolean;
}

let deviceBattery: { level: number; charging: boolean } | null = null;
let initialized = false;

export function initStageBattery(): void {
  if (initialized || typeof navigator === "undefined") return;
  initialized = true;
  const nav = navigator as NavigatorWithBattery;
  if (!nav.getBattery) return;

  nav.getBattery()
    .then((battery) => {
      const update = () => {
        const nextLevel = Math.round(battery.level * 100);
        const nextCharging = Boolean(battery.charging);
        const changed =
          !deviceBattery ||
          deviceBattery.level !== nextLevel ||
          deviceBattery.charging !== nextCharging;
        deviceBattery = { level: nextLevel, charging: nextCharging };
        const rootEl = document.getElementById("stage-root");
        if (rootEl) {
          rootEl.classList.toggle("is-battery-saver", nextLevel <= 20 && !nextCharging);
        }
        if (changed && S.stage.active) {
          scheduleRender();
        }
      };
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    })
    .catch(() => undefined);
}

export function stageBatteryInfo(): StageBatteryInfo {
  if (deviceBattery) {
    return {
      level: deviceBattery.level,
      charging: deviceBattery.charging,
      available: true,
      isDevice: true,
    };
  }
  const ctrl = S.stage.controllerBattery;
  if (ctrl !== null && Number.isFinite(ctrl)) {
    return {
      level: Math.round(ctrl * 100),
      charging: false,
      available: true,
      isDevice: false,
    };
  }
  return {
    level: 100,
    charging: false,
    available: false,
    isDevice: false,
  };
}

export function stageBatteryMarkup(): string {
  const info = stageBatteryInfo();
  if (!info.available) return "";

  const isLow = info.level <= 20 && !info.charging;
  const isCritical = info.level <= 10 && !info.charging;
  const iconName = info.charging ? "battery-charging" : "battery";

  return `<button
    type="button"
    class="stage-battery-pill${info.charging ? " is-charging" : ""}${isCritical ? " is-critical" : isLow ? " is-low" : ""}"
    data-stage-act="open-power-sheet"
    data-gp-item
    data-gp-key="top:power"
    aria-label="${esc(t("common.battery"))}: ${info.level}%"
    title="${esc(t("common.battery"))}: ${info.level}%"
  >
    <span class="stage-battery-icon">${icon(iconName, 15)}</span>
    <span class="stage-battery-pct tabular-nums">${info.level}%</span>
  </button>`;
}
