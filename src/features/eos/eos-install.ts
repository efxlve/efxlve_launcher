/**
 * Epic Online Services redistributable install.
 *
 * Checked once at startup and again when Settings opens or the user refreshes.
 * There is no background poll and no ignore path. Clearing the list does not
 * hide the notice: if EOS is still missing, it is added again on the next
 * startup check and when Settings opens. The notification and the Settings
 * button start the same download; nothing installs without that click. The
 * settings row keeps stating that EOS is required, and the sidebar bell keeps
 * an amber dot, until the service folder exists.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { eosOverlayStatus } from "../../epic";
import { localizeMessage, t } from "../../i18n";
import {
  closeNotifPanel,
  dismissNotification,
  pushNotification,
  renderNotificationPanel,
  updateNotifBadge,
} from "../notifications/notifications";

const INSTALL_ACT = "install-eos";
/** Older builds stored a dismissal here. It no longer suppresses the notice. */
const LEGACY_DISMISS_KEY = "efxlve-eos-notice-dismissed";

type EosPhase = "idle" | "downloading" | "launching";

let started = false;
let phase: EosPhase = "idle";
let progress = 0;

function eosDescHtml(): string {
  const on = !!S.eosOverlay?.installed;
  const detail = on
    ? t("settings.eosInstalledDesc")
    : `<span class="settings-note-warn">${t("settings.eosMissingDesc")}</span>`;
  let html = `<span class="eos-dot inline ${on ? "on" : "off"}"></span>${detail}`;
  if (on && S.eosOverlay && !S.eosOverlay.overlaySupported) {
    html += `<br /><span class="settings-note-warn">${t("settings.eosNotSupported")}</span>`;
  }
  if (on && S.eosOverlay?.path) {
    html += `<br /><code>${esc(S.eosOverlay.path)}</code>`;
  }
  return html;
}

function refreshButton(): string {
  const busy = phase !== "idle";
  return `<button type="button" class="btn ghost small${busy ? " disabled" : ""}" data-act="refresh-eos"${busy ? " disabled" : ""}>${t("settings.eosRefresh")}</button>`;
}

function controlInner(): string {
  const installed = !!S.eosOverlay?.installed && phase === "idle";
  const chip = `<span id="eos-status-chip" class="chip ${installed ? "ok" : "warn"}">${installed ? t("settings.eosStatusInstalled") : t("settings.eosStatusMissing")}</span>`;
  const refresh = refreshButton();
  if (installed) {
    const open = S.eosOverlay?.path
      ? `<button type="button" class="btn ghost small" data-act="open-eos-folder">${t("settings.eosOpenFolder")}</button>`
      : "";
    return `${chip}${open}${refresh}`;
  }
  const busy = phase !== "idle";
  const label = phase === "launching"
    ? t("settings.eosLaunching")
    : phase === "downloading"
      ? t("settings.eosDownloading")
      : t("settings.eosDownload");
  const bar = phase === "downloading"
    ? `<div class="progress eos-install-bar" aria-hidden="true"><span style="width:${progress}%"></span></div><span class="tabular-nums eos-install-pct">${progress}%</span>`
    : "";
  return `${chip}${bar}<button type="button" class="btn primary small" data-act="install-eos"${busy ? " disabled" : ""}>${label}</button>${refresh}`;
}

/** Settings > Integrations row. Status plus the download control. */
export function renderEosSettingsRow(): string {
  const version = S.eosOverlay?.installed && S.eosOverlay.version
    ? ` <span class="eos-version">${esc(S.eosOverlay.version)}</span>`
    : "";
  return `
    <div class="row settings-row" id="eos-settings-row">
      <div class="row-main">
        <div class="settings-row-title">${t("settings.eosTitle")}${version}</div>
        <div class="settings-row-desc" id="eos-row-desc">${eosDescHtml()}</div>
      </div>
      <div class="settings-row-control" id="eos-row-control">${controlInner()}</div>
    </div>`;
}

function patchEosControl(): void {
  const slot = document.getElementById("eos-row-control");
  if (slot) slot.innerHTML = controlInner();
}

function paintEosText(): void {
  const title = document.querySelector("#eos-settings-row .settings-row-title");
  if (title) {
    const version = S.eosOverlay?.installed && S.eosOverlay.version
      ? ` <span class="eos-version">${esc(S.eosOverlay.version)}</span>`
      : "";
    title.innerHTML = `${t("settings.eosTitle")}${version}`;
  }
  const desc = document.getElementById("eos-row-desc");
  if (desc) desc.innerHTML = eosDescHtml();
}

function removeEosNotifications(): void {
  for (const n of [...S.notifications]) {
    if (n.action === INSTALL_ACT) dismissNotification(n.id);
  }
  if (S.notifOpen) renderNotificationPanel();
}

/** Shows the missing-EOS notice, or clears it when the service is back. */
export function syncEosNotice(): void {
  if (!S.eosOverlay) return;
  localStorage.removeItem(LEGACY_DISMISS_KEY);
  if (S.eosOverlay.installed) {
    removeEosNotifications();
    updateNotifBadge();
    return;
  }
  updateNotifBadge();
  if (S.notifications.some((n) => n.action === INSTALL_ACT)) return;
  pushNotification({
    kind: "info",
    title: t("notif.eosMissingTitle"),
    body: t("notif.eosMissingBody"),
    action: INSTALL_ACT,
  });
  if (S.notifOpen) renderNotificationPanel();
}

export async function checkEosOnce(): Promise<void> {
  if (!isTauri) return;
  const status = await eosOverlayStatus().catch(() => null);
  if (!status) return;
  S.eosOverlay = status;
  syncEosNotice();
}

/** Settings refresh. One check, then the row is redrawn with the new status. */
export async function refreshEosStatus(): Promise<void> {
  if (!isTauri) return;
  const status = await eosOverlayStatus().catch(() => null);
  if (status) S.eosOverlay = status;
  syncEosNotice();
  render();
}

function onProgress(payload: { state: string; progress: number }): void {
  if (phase === "idle") return;
  if (payload.state === "downloading") {
    phase = "downloading";
    progress = Math.max(0, Math.min(100, payload.progress | 0));
    patchEosControl();
  } else if (payload.state === "launching") {
    phase = "launching";
    progress = 100;
    patchEosControl();
  }
}

async function markInstalled(): Promise<void> {
  phase = "idle";
  progress = 0;
  const status = await eosOverlayStatus().catch(() => null);
  if (status) S.eosOverlay = status;
  removeEosNotifications();
  paintEosText();
  patchEosControl();
  updateNotifBadge();
  toast(t("eos.installed"), "ok");
}

/** Shared by the notification action and the Settings button. */
export async function startEosInstall(): Promise<void> {
  if (!isTauri) return;
  if (phase !== "idle") {
    toast(t("eos.busy"), "");
    return;
  }
  closeNotifPanel();
  phase = "downloading";
  progress = 0;
  patchEosControl();
  try {
    const result = await invoke<{ outcome: string }>("eos_install_redistributable");
    if (result?.outcome === "installed") {
      await markInstalled();
      return;
    }
    phase = "idle";
    progress = 0;
    patchEosControl();
    toast(t("eos.cancelled"), "");
  } catch (err) {
    phase = "idle";
    progress = 0;
    patchEosControl();
    const raw = String(err);
    toast(raw.startsWith("@t:") ? localizeMessage(raw) : t("eos.failed"), "err");
  }
}

/** One startup check and the progress listener. No timer, no poll. */
export async function initEosInstall(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  await listen<{ state: string; progress: number }>("eos-install", (event) => {
    onProgress(event.payload);
  }).catch(() => {});
  await checkEosOnce();
}
