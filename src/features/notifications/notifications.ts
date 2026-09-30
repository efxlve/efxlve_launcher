/**
 * In-app notification center.
 *
 * Keeps a capped, persisted history of notable events (download finished,
 * update available, errors, social...). The bell lives in the sidebar footer;
 * the panel is a fixed dropdown anchored to it. Items are real buttons so the
 * 10-foot gamepad focus model keeps working.
 */

import { NOTIF_KEY, EOS_OVERLAY_DECLINE_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import type { AppNotification, NotifKind } from "../../core/types";
import { esc, relativeTime } from "../../core/utils";
import { t } from "../../i18n";

const MAX = 50;
/** Re-pushing the same event within this window refreshes instead of duplicating. */
const DEDUPE_MS = 10 * 60 * 1000;
/** Restored history older than this is dropped: it is news, not a mailbox. */
const RESTORE_TTL_MS = 24 * 60 * 60 * 1000;

const KIND_ICON: Record<NotifKind, Parameters<typeof icon>[0]> = {
  download: "download",
  update: "refresh",
  error: "alert-triangle",
  info: "info",
  social: "users",
};

/** Restores the persisted notification history (invalid entries are dropped). */
export function loadNotifications(): void {
  try {
    const raw = localStorage.getItem(NOTIF_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as AppNotification[];
    if (Array.isArray(parsed)) {
      const now = Date.now();
      // A restored entry is history, not a new event: an unread badge that survived
      // a restart announced old news (reported: "12 h ago" right after boot). Stale
      // entries past the TTL are dropped so the bell never shows yesterday's count.
      S.notifications = parsed
        .filter((n) => n && typeof n.id === "string" && now - n.ts < RESTORE_TTL_MS)
        .map((n) => ({ ...n, read: true }))
        .slice(0, MAX);
      if (!S.notifications.length) localStorage.removeItem(NOTIF_KEY);
    }
  } catch {
    // Corrupt history is not worth surfacing; start clean.
  }
}

function persist(): void {
  try {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(S.notifications.slice(0, MAX)));
  } catch {
    // Storage full/blocked: history stays in memory only.
  }
}

export interface NotifInput {
  kind: NotifKind;
  title: string;
  body?: string;
  appName?: string;
  /** Optional `data-act` routed when the entry is clicked. */
  action?: string;
  toast?: boolean;
}

/** Adds a notification (deduping identical recent events) and updates the badge. */
export function pushNotification(input: NotifInput): void {
  const now = Date.now();
  const existing = S.notifications.find(
    (n) =>
      n.kind === input.kind &&
      n.title === input.title &&
      n.appName === input.appName &&
      now - n.ts < DEDUPE_MS,
  );
  if (existing) {
    existing.ts = now;
    existing.read = false;
    existing.body = input.body ?? existing.body;
    existing.action = input.action ?? existing.action;
  } else {
    S.notifications.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      appName: input.appName,
      action: input.action,
      ts: now,
      read: false,
    });
    if (S.notifications.length > MAX) S.notifications.length = MAX;
  }
  persist();
  updateNotifBadge();
}

export function unreadCount(): number {
  let n = 0;
  for (const x of S.notifications) if (!x.read) n++;
  return n;
}

export function markAllRead(): void {
  for (const n of S.notifications) n.read = true;
  persist();
  updateNotifBadge();
}

/** Removes a single notification from the history. */
export function dismissNotification(id: string): void {
  S.notifications = S.notifications.filter((n) => n.id !== id);
  persist();
  updateNotifBadge();
}

export function clearNotifications(): void {
  S.notifications = [];
  persist();
  updateNotifBadge();
}

/**
 * One dot on the sidebar bell. A missing EOS overlay keeps it amber until the
 * user installs it or dismisses the notice.
 */
export function updateNotifBadge(): void {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;
  const n = unreadCount();
  const eosMissing = S.eosOverlay !== null && !S.eosOverlay.installed
    && localStorage.getItem(EOS_OVERLAY_DECLINE_KEY) !== "1";
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.classList.toggle("warn", eosMissing);
  badge.classList.toggle("hidden", !eosMissing && n === 0);
}

/** Signature of the last painted panel; renders stay no-op while nothing changes. */
let notifPanelSig = "";

/** Renders the dropdown into #notif-root (or clears it when closed). */
export function renderNotificationPanel(): void {
  const root = document.getElementById("notif-root");
  updateNotifBadge();
  if (!root) return;
  if (!S.notifOpen) {
    notifPanelSig = "";
    if (root.firstChild) root.innerHTML = "";
    return;
  }

  const unread = unreadCount();
  // `render()` runs on every download progress event; rebuilding the open panel
  // each time was pure DOM churn. Skip when the visible content is unchanged.
  const first = S.notifications[0];
  const sig = `${S.notifications.length}|${unread}|${first?.ts ?? 0}|${first?.read ?? false}|${S.appLanguage}`;
  if (sig === notifPanelSig && root.firstChild) return;
  notifPanelSig = sig;

  const items = S.notifications
    .map((n) => {
      const action = n.action
        ? `data-act="${esc(n.action)}"`
        : n.appName
          ? `data-act="notif-open" data-id="${esc(n.appName)}"`
          : `data-act="notif-dismiss" data-id="${esc(n.id)}"`;
      return `
        <button class="notif-item${n.read ? "" : " unread"}" ${action} data-nid="${esc(n.id)}">
          <span class="notif-item-icon kind-${n.kind}">${icon(KIND_ICON[n.kind], 14)}</span>
          <span class="notif-item-body">
            <span class="notif-item-title">${esc(n.title)}</span>
            ${n.body ? `<span class="notif-item-text">${esc(n.body)}</span>` : ""}
            <span class="notif-item-time">${esc(relativeTime(n.ts))}</span>
          </span>
        </button>`;
    })
    .join("");

  const body =
    S.notifications.length === 0
      ? `<div class="notif-empty">${icon("bell", 26)}<p>${t("notif.empty")}</p></div>`
      : `<div class="notif-list">${items}</div>`;

  root.innerHTML = `
    <div class="notif-panel" role="dialog" aria-label="${esc(t("notif.title"))}">
      <div class="notif-head">
        <span class="notif-title">${icon("bell", 14)} ${t("notif.title")}</span>
        <div class="notif-head-actions">
          ${unread > 0 ? `<button class="notif-action" data-act="notif-read-all">${t("notif.readAll")}</button>` : ""}
          ${S.notifications.length > 0 ? `<button class="notif-action" data-act="notif-clear">${t("notif.clear")}</button>` : ""}
        </div>
      </div>
      ${body}
    </div>`;
  positionNotifPanel();
}

/**
 * Anchors the panel to the sidebar bell. Opens below the icon, or above
 * when the window does not have room underneath.
 */
export function positionNotifPanel(): void {
  const panel = document.querySelector<HTMLElement>("#notif-root .notif-panel");
  const anchor = document.getElementById("notif-btn")?.getBoundingClientRect();
  if (!panel || !anchor) return;
  const left = Math.min(anchor.left, Math.max(8, window.innerWidth - panel.offsetWidth - 8));
  panel.style.left = `${left}px`;
  const gap = 8;
  const spaceBelow = window.innerHeight - anchor.bottom;
  const openUp = spaceBelow < panel.offsetHeight + gap + 8 && anchor.top > spaceBelow;
  panel.style.top = `${openUp ? Math.max(8, anchor.top - panel.offsetHeight - gap) : anchor.bottom + gap}px`;
}

/** Opens the notification panel (and marks everything as read). */
export function openNotifPanel(): void {
  S.notifOpen = true;
  renderNotificationPanel();
  markAllRead();
}

export function closeNotifPanel(): void {
  if (!S.notifOpen) return;
  S.notifOpen = false;
  renderNotificationPanel();
}
