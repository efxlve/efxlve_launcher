/**
 * In-app notification center.
 *
 * Keeps a capped, persisted history of notable events (download finished,
 * update available, errors, social...). The bell lives in the sidebar footer;
 * the panel is a fixed dropdown anchored to it. The list is split into four
 * tabs — Updates, Achievements, System, Cloud — and the Updates/System tabs add
 * the live status on top of the history. Items are real buttons so the 10-foot
 * gamepad focus model keeps working.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EOS_OVERLAY_DECLINE_KEY, NOTIF_KEY, isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { pendingGameUpdates, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { AppNotification, NotifKind, NotifTab } from "../../core/types";
import type { EpicSummary } from "../../epic";
import { esc, relativeTime } from "../../core/utils";
import { toast } from "../../core/toast";
import { t } from "../../i18n";
import { storeLogoUrl } from "../store/store-logos";
import { embeddedContentShown, syncStoreViewSize } from "../store/store-view";
import { overlayThemeStyle } from "../../core/overlay-theme";

const MAX = 50;
/** Fixed dropdown width: the four tabs must fit without wrapping. */
const PANEL_WIDTH = 400;
/** Re-pushing the same event within this window refreshes instead of duplicating. */
const DEDUPE_MS = 10 * 60 * 1000;
/** Restored history older than this is dropped: it is news, not a mailbox. */
const RESTORE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Unlocks pushed after this moment happened in the running session. The
 * Achievements tab reads it, so a restored row from last night never claims to
 * be "unlocked this session".
 */
const SESSION_START = Date.now();

const KIND_ICON: Record<NotifKind, Parameters<typeof icon>[0]> = {
  download: "download",
  update: "refresh",
  app: "sparkles",
  error: "alert-triangle",
  info: "info",
  social: "users",
  achievement: "trophy",
  cloud: "cloud",
  "cloud-error": "alert-triangle",
};

/** Every persisted kind; an unknown value from an older build is dropped. */
const KNOWN_KINDS = new Set<string>(Object.keys(KIND_ICON));

/** Tab labels, in the order the header strip shows them. */
const TAB_LABEL: Record<NotifTab, string> = {
  updates: "notif.tabUpdates",
  achievements: "notif.tabAchievements",
  system: "notif.tabSystem",
  cloud: "notif.tabCloud",
};

/** Glyph that names each tab before its label. */
const TAB_ICON: Record<NotifTab, Parameters<typeof icon>[0]> = {
  updates: "refresh",
  achievements: "trophy",
  system: "monitor",
  cloud: "cloud",
};

const TAB_ORDER: readonly NotifTab[] = ["updates", "achievements", "system", "cloud"];

/** The tab that owns a notification kind. */
export function notifTabOf(kind: NotifKind): NotifTab {
  if (kind === "update" || kind === "download") return "updates";
  if (kind === "achievement") return "achievements";
  if (kind === "cloud" || kind === "cloud-error") return "cloud";
  return "system";
}

export function isNotifTab(value: string): value is NotifTab {
  return value === "updates" || value === "achievements" || value === "system" || value === "cloud";
}

/**
 * True while a game update row still has its game on disk. An update row
 * describes work on an install, so without one the row is neither news nor an
 * unread item, even while it is still in the persisted history. A store list
 * that has not loaded yet resolves nothing, so the row simply stays hidden
 * until its game does.
 */
function updateRowLive(n: AppNotification): boolean {
  if (n.kind !== "update" || !n.appName) return true;
  return Boolean(summaryOf(n.appName)?.installed);
}

/** Restores the persisted notification history (invalid entries are dropped). */
export function loadNotifications(): void {
  bindNotifOverlay();
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
        .filter(
          (n) =>
            n &&
            typeof n.id === "string" &&
            KNOWN_KINDS.has(n.kind) &&
            now - n.ts < RESTORE_TTL_MS,
        )
        .map((n) => ({
          ...n,
          // Launcher update rows written before the tab split carry kind
          // `update` and no game key. Restoring them as they are would keep
          // them in the Updates tab, which belongs to games.
          kind: n.kind === "update" && !n.appName ? "app" : n.kind,
          read: true,
        }))
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
  /** Game title or other subject shown before the timestamp. */
  context?: string;
  appName?: string;
  /** Optional `data-act` routed when the entry is clicked. */
  action?: string;
  /** Text the action needs, routed as `data-query`. */
  actionData?: string;
  /** Short label for that action, shown as a chip inside the entry. */
  actionLabel?: string;
  toast?: boolean;
}

const GENERAL_NOTIF_PREFS_KEY = "efxlve.notifPrefs.v1";

export interface GeneralNotificationPrefs {
  enabled: boolean;
  toasts: boolean;
  downloads: boolean;
  updates: boolean;
  social: boolean;
  errors: boolean;
  disabledStores: string[];
}

const DEFAULT_GENERAL_NOTIF_PREFS: GeneralNotificationPrefs = {
  enabled: true,
  toasts: true,
  downloads: true,
  updates: true,
  social: true,
  errors: true,
  disabledStores: [],
};

let cachedGeneralPrefs: GeneralNotificationPrefs | null = null;

export function getGeneralNotifPrefs(): GeneralNotificationPrefs {
  if (cachedGeneralPrefs) return cachedGeneralPrefs;
  try {
    const raw = localStorage.getItem(GENERAL_NOTIF_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GeneralNotificationPrefs>;
      cachedGeneralPrefs = {
        enabled: parsed.enabled !== false,
        toasts: parsed.toasts !== false,
        downloads: parsed.downloads !== false,
        updates: parsed.updates !== false,
        social: parsed.social !== false,
        errors: parsed.errors !== false,
        disabledStores: Array.isArray(parsed.disabledStores)
          ? parsed.disabledStores.filter((s): s is string => typeof s === "string")
          : [],
      };
      return cachedGeneralPrefs;
    }
  } catch {
    /* ignore */
  }
  cachedGeneralPrefs = { ...DEFAULT_GENERAL_NOTIF_PREFS, disabledStores: [] };
  return cachedGeneralPrefs;
}

export function setGeneralNotifPrefs(next: Partial<GeneralNotificationPrefs>): GeneralNotificationPrefs {
  const cur = getGeneralNotifPrefs();
  cachedGeneralPrefs = {
    enabled: next.enabled ?? cur.enabled,
    toasts: next.toasts ?? cur.toasts,
    downloads: next.downloads ?? cur.downloads,
    updates: next.updates ?? cur.updates,
    social: next.social ?? cur.social,
    errors: next.errors ?? cur.errors,
    disabledStores: next.disabledStores ? [...next.disabledStores] : [...cur.disabledStores],
  };
  try {
    localStorage.setItem(GENERAL_NOTIF_PREFS_KEY, JSON.stringify(cachedGeneralPrefs));
  } catch {
    /* ignore */
  }
  return cachedGeneralPrefs;
}

export function storeKeyFromAppName(appName?: string): string | null {
  if (!appName) return null;
  if (appName.startsWith("steam::")) return "steam";
  if (appName.startsWith("gog::")) return "gog";
  if (appName.startsWith("ubisoft::")) return "ubisoft";
  if (appName.startsWith("ea::")) return "ea";
  if (appName.startsWith("xbox::")) return "xbox";
  if (appName.startsWith("amazon::")) return "amazon";
  if (appName.startsWith("custom::")) return "custom";
  if (appName.startsWith("battlenet::")) return "battlenet";
  if (appName.startsWith("riot::")) return "riot";
  return "epic";
}

/** Adds a notification (deduping identical recent events) and updates the badge. */
export function pushNotification(input: NotifInput): void {
  const prefs = getGeneralNotifPrefs();
  if (!prefs.enabled) return;
  if (input.kind === "download" && !prefs.downloads) return;
  if ((input.kind === "update" || input.kind === "app") && !prefs.updates) return;
  if (input.kind === "social" && !prefs.social) return;
  if ((input.kind === "error" || input.kind === "cloud-error") && !prefs.errors) return;
  const storeKey = storeKeyFromAppName(input.appName);
  if (storeKey && prefs.disabledStores.includes(storeKey)) return;

  const now = Date.now();
  let isNew = false;
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
    existing.context = input.context ?? existing.context;
    existing.action = input.action ?? existing.action;
    existing.actionData = input.actionData ?? existing.actionData;
    existing.actionLabel = input.actionLabel ?? existing.actionLabel;
  } else {
    S.notifications.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: input.kind,
      title: input.title,
      body: input.body ?? "",
      context: input.context,
      appName: input.appName,
      action: input.action,
      actionData: input.actionData,
      actionLabel: input.actionLabel,
      ts: now,
      read: false,
    });
    if (S.notifications.length > MAX) S.notifications.length = MAX;
    isNew = true;
  }
  persist();
  updateNotifBadge();
  // Some events (an achievement unlock) also want a short visible toast, not
  // only a new row in the bell's history.
  if (input.toast && isNew && prefs.toasts) toast(input.title, input.kind === "error" ? "err" : "ok");
}

export function unreadCount(): number {
  let n = 0;
  for (const x of S.notifications) if (!x.read && updateRowLive(x)) n++;
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
/** The dropdown is a child webview above the store, not HTML under it. */
let notifOverlayOn = false;
let notifOverlayBox = { w: PANEL_WIDTH, h: 320 };
let notifOverlayBound = false;

/** True while a native store child would paint over an HTML dropdown. */
function storeCoversUi(): boolean {
  // The storefront and the Spotify page are native children: the dropdown goes
  // into the child overlay for both, so it can paint above them.
  return embeddedContentShown();
}

/** History rows per tab, plus the live status the status tabs add on top. */
interface NotifPanelData {
  /** Installed games with a newer build waiting. */
  pending: EpicSummary[];
  /** Update/download history that is not already named by a pending row. */
  updates: AppNotification[];
  /** Unlocks from the running session, newest first. */
  session: AppNotification[];
  /** Everything the System tab lists after the launcher status. */
  system: AppNotification[];
  counts: Record<NotifTab, number>;
}

/** True while the launcher has an update the user can start or install. */
function launcherUpdatePending(): boolean {
  return S.appUpdateStatus === "ready" || S.appUpdateStatus === "available";
}

function notifPanelData(): NotifPanelData {
  // One alphabetical list: stores return their own order, and the bell is a
  // single dropdown, not a per-store shelf.
  const pending = pendingGameUpdates().sort((a, b) => a.title.localeCompare(b.title));
  const pendingKeys = new Set(pending.map((s) => s.appName));
  const updates = S.notifications.filter(
    (n) =>
      notifTabOf(n.kind) === "updates" &&
      // A live row already names the game; its older one-liner would repeat it.
      !(n.kind === "update" && n.appName && pendingKeys.has(n.appName)) &&
      updateRowLive(n),
  );
  // The Achievements tab is the session log: a restored row from yesterday is
  // history, not something unlocked while the launcher was running.
  const session = S.notifications
    .filter((n) => n.kind === "achievement" && n.ts >= SESSION_START)
    .slice(0, 5);
  const launcher = launcherUpdatePending() ? 1 : 0;
  // The live status row says the same thing as the pushed notification.
  const system = S.notifications.filter(
    (n) => notifTabOf(n.kind) === "system" && !(launcher > 0 && n.kind === "app"),
  );
  return {
    pending,
    updates,
    session,
    system,
    // The chip reports work, not history: games waiting for an update, unlocks
    // from this session, and a launcher update the user can start or install.
    counts: {
      updates: pending.length,
      achievements: session.length,
      system: launcher,
      cloud: 0,
    },
  };
}

/**
 * The 28px tile in front of a row. A game-facing row shows the game's own art
 * (the same cover the library paints) and falls back to the kind glyph when the
 * store has no picture; the glyph stays visible under a cover that fails to
 * load, because it is painted by the tile itself and the art sits above it.
 */
function artTile(appName: string | undefined, glyph: Parameters<typeof icon>[0], kindClass: string): string {
  const cover = appName ? summaryOf(appName)?.cover : null;
  return `<span class="notif-item-icon notif-item-art ${kindClass}">${icon(glyph, 14)}${cover ? `<span class="notif-art" style="background-image:url('${esc(cover)}')"></span>` : ""}</span>`;
}

/**
 * The dropdown is also written into the store overlay, which has no base URL:
 * an asset path must be absolute there or the mark never loads.
 */
function assetUrl(url: string): string {
  if (!url || /^(?:[a-z]+:|\/\/)/i.test(url)) return url;
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return url;
  }
}

/** Small store mark that closes a game-facing row. */
function storeMark(appName: string | undefined): string {
  const url = storeLogoUrl(storeKeyFromAppName(appName) ?? "");
  if (!url) return "";
  return `<span class="notif-item-store"><img src="${esc(assetUrl(url))}" width="14" height="14" alt="" draggable="false" /></span>`;
}

/** One pending update: the game title, its version line and the store mark. */
function pendingUpdateMarkup(s: EpicSummary): string {
  const info = S.availableUpdates.get(s.appName);
  const gog = S.gogUpdates.get(s.appName);
  const latest = info?.latestVersion || gog?.latestVersion || "";
  const installed = info?.installedVersion || gog?.installedBuildId || "";
  const version = latest ? `${installed ? `${installed} → ` : ""}${latest}` : "";
  return `
    <button class="notif-item" data-act="notif-open" data-id="${esc(s.appName)}">
      ${artTile(s.appName, "refresh", "kind-update")}
      <span class="notif-item-body">
        <span class="notif-item-title">${esc(s.title)}</span>
        <span class="notif-item-text">${esc(version || t("drawer.updateAvailable"))}</span>
      </span>
      ${storeMark(s.appName)}
    </button>`;
}

/** Live launcher update status; the action installs it or starts the download. */
function launcherUpdateMarkup(): string {
  const ready = S.appUpdateStatus === "ready";
  if (!ready && S.appUpdateStatus !== "available") return "";
  const title = ready
    ? t("appUpdate.ready", { version: S.appUpdateVersion })
    : t("appUpdate.available", { version: S.appUpdateVersion });
  const body = ready ? t("appUpdate.readyBody") : t("appUpdate.availableBody");
  const act = ready ? "app-update-install" : "app-update-download";
  const label = ready ? t("appUpdate.installNow") : t("appUpdate.downloadNow");
  return `
    <button class="notif-item" data-act="${act}">
      <span class="notif-item-icon kind-app">${icon("sparkles", 14)}</span>
      <span class="notif-item-body">
        <span class="notif-item-title">${esc(title)}</span>
        <span class="notif-item-text">${esc(body)}</span>
        <span class="notif-item-act">${esc(label)}</span>
      </span>
    </button>`;
}

function notificationMarkup(n: AppNotification): string {
  const action = n.action
    ? `data-act="${esc(n.action)}"`
    : n.appName
      ? `data-act="notif-open" data-id="${esc(n.appName)}"`
      : `data-act="notif-dismiss" data-id="${esc(n.id)}"`;
  const actionData = n.actionData
    ? ` data-query="${esc(n.actionData)}" data-id="${esc(n.actionData)}"`
    : "";
  // The subject (a game title) sits in the dim line before the timestamp.
  const meta = esc([n.context, relativeTime(n.ts)].filter(Boolean).join(" · "));
  // An unlock belongs to a game; its cover reads better than a repeated glyph.
  const tile =
    n.kind === "achievement"
      ? artTile(n.appName, "trophy", "kind-achievement")
      : `<span class="notif-item-icon kind-${n.kind}">${icon(KIND_ICON[n.kind], 14)}</span>`;
  const mark = n.kind === "achievement" && n.appName ? storeMark(n.appName) : "";
  return `
    <button class="notif-item${n.read ? "" : " unread"}" ${action}${actionData} data-nid="${esc(n.id)}">
      ${tile}
      <span class="notif-item-body">
        <span class="notif-item-title">${esc(n.title)}</span>
        ${n.body ? `<span class="notif-item-text">${esc(n.body)}</span>` : ""}
        ${n.actionLabel ? `<span class="notif-item-act">${esc(n.actionLabel)}${icon("external", 12)}</span>` : ""}
        <span class="notif-item-time">${meta}</span>
      </span>
      ${mark}
    </button>`;
}

function tabButton(tab: NotifTab, count: number): string {
  const active = S.notifTab === tab;
  return `<button class="tab${active ? " active" : ""}" role="tab" aria-selected="${active}" data-act="notif-tab" data-id="${tab}">${icon(TAB_ICON[tab], 13)}<span>${esc(t(TAB_LABEL[tab]))}</span>${count > 0 ? `<span class="count">${count}</span>` : ""}</button>`;
}

/** Nothing to show in this tab; each tab explains what it would have listed. */
function emptyState(tab: NotifTab): string {
  const [glyph, key] =
    tab === "updates"
      ? (["download", "notif.emptyUpdates"] as const)
      : tab === "achievements"
        ? (["trophy", "notif.emptyAchievements"] as const)
        : tab === "cloud"
          ? (["cloud", "notif.emptyCloud"] as const)
          : (["info", "notif.emptySystem"] as const);
  return `<div class="notif-empty">${icon(glyph, 26)}<p>${esc(t(key))}</p></div>`;
}

function panelMarkup(data: NotifPanelData, unread: number): string {
  const tab = S.notifTab;
  const history = tab === "updates" ? data.updates : tab === "achievements" ? [] : data.system;
  // Live status first, then the event log behind it.
  const live =
    tab === "updates"
      ? data.pending.map(pendingUpdateMarkup).join("")
      : tab === "achievements"
        ? data.session.map(notificationMarkup).join("")
        : launcherUpdateMarkup();
  const rows = live + history.map(notificationMarkup).join("");
  const body = rows
    ? `<div class="notif-list" role="tabpanel">${rows}</div>`
    : `<div class="notif-list" role="tabpanel">${emptyState(tab)}</div>`;
  return `
    <div class="notif-panel" role="dialog" aria-label="${esc(t("notif.title"))}">
      <div class="notif-head">
        <span class="notif-title">${icon("bell", 14)} ${esc(t("notif.title"))}</span>
        <div class="notif-head-actions">
          ${unread > 0 ? `<button class="notif-action" data-act="notif-read-all">${esc(t("notif.readAll"))}</button>` : ""}
          ${S.notifications.length > 0 ? `<button class="notif-action" data-act="notif-clear">${esc(t("notif.clear"))}</button>` : ""}
        </div>
      </div>
      <div class="notif-tabs" role="tablist" aria-label="${esc(t("notif.title"))}">
        ${TAB_ORDER.map((key) => tabButton(key, data.counts[key])).join("")}
      </div>
      ${body}
    </div>`;
}

function overlayOrigin(width: number, height: number): { x: number; y: number } {
  const anchor = document.getElementById("notif-btn")?.getBoundingClientRect();
  let x = anchor ? anchor.left : 8;
  let y = anchor ? anchor.bottom + 8 : 40;
  if (x + width > window.innerWidth - 8) x = window.innerWidth - width - 8;
  if (x < 8) x = 8;
  if (y + height > window.innerHeight - 8) y = Math.max(8, (anchor?.top ?? 40) - height - 8);
  return { x, y };
}

/** Shows the list in a child webview that paints above the store. */
async function presentStoreOverlay(panelHtml: string): Promise<void> {
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;left:-4000px;top:0;width:${PANEL_WIDTH}px;visibility:hidden;`;
  holder.innerHTML = panelHtml;
  document.body.appendChild(holder);
  const panel = holder.querySelector<HTMLElement>(".notif-panel");
  const height = Math.max(120, Math.min(panel?.offsetHeight ?? 320, Math.round(window.innerHeight * 0.7)));
  const width = Math.min(PANEL_WIDTH, Math.max(160, window.innerWidth - 16));
  holder.remove();
  notifOverlayBox = { w: width, h: height };
  const { x, y } = overlayOrigin(width, height);
  const payload = { x, y, width, height, html: overlayThemeStyle() + panelHtml };
  try {
    await invoke("show_notif_overlay", payload);
  } catch {
    // The host webview is built on first use: a failed or slow first creation
    // must not leave the dropdown invisible behind an embedded page.
    await invoke("show_notif_overlay", payload);
  }
}

function hideStoreOverlay(): void {
  if (!isTauri) return;
  void invoke("hide_notif_overlay").catch(() => undefined);
}

/** Forwards a click inside the overlay into the same button path as the HTML panel. */
function deliverOverlayAct(act: string, id: string): void {
  if (act === "overlay-close") {
    closeNotifPanel();
    return;
  }
  const root = document.getElementById("notif-root");
  if (!root || !act) return;
  const btn = document.createElement("button");
  btn.dataset.act = act;
  if (id) btn.dataset.id = id;
  root.appendChild(btn);
  btn.click();
  btn.remove();
}

function bindNotifOverlay(): void {
  if (notifOverlayBound || !isTauri) return;
  notifOverlayBound = true;
  void listen<{ act?: string; id?: string }>("notif-overlay-act", (event) => {
    deliverOverlayAct(event.payload.act || "", event.payload.id || "");
  });
}

/** Renders the dropdown into #notif-root (or clears it when closed). */
export function renderNotificationPanel(): void {
  const root = document.getElementById("notif-root");
  updateNotifBadge();
  if (!root) return;
  if (!S.notifOpen) {
    notifPanelSig = "";
    notifOverlayOn = false;
    if (root.firstChild) root.innerHTML = "";
    hideStoreOverlay();
    syncStoreViewSize();
    return;
  }

  const unread = unreadCount();
  const data = notifPanelData();
  // `render()` runs on every download progress event; rebuilding the open panel
  // each time was pure DOM churn. Skip when the visible content is unchanged.
  const first = S.notifications[0];
  const pendingNames = data.pending.map((s) => s.appName).join(",");
  // `updates.length` moves when a row's game leaves or joins the library while
  // the panel is open: the row is gated on the game still being installed.
  const sig = `${S.notifications.length}|${unread}|${first?.ts ?? 0}|${first?.read ?? false}|${S.appLanguage}|${S.notifTab}|${pendingNames}|${data.updates.length}|${data.counts.updates}|${data.counts.achievements}|${data.counts.system}|${S.appUpdateStatus}|${S.appUpdateVersion}`;
  const covers = storeCoversUi();
  if (sig === notifPanelSig && (root.firstChild || (covers && notifOverlayOn))) return;
  notifPanelSig = sig;

  const markup = panelMarkup(data, unread);
  if (covers) {
    root.innerHTML = "";
    notifOverlayOn = true;
    void presentStoreOverlay(markup).catch(() => {
      notifOverlayOn = false;
      root.innerHTML = markup;
      positionNotifPanel();
    });
    return;
  }
  if (notifOverlayOn) hideStoreOverlay();
  notifOverlayOn = false;
  root.innerHTML = markup;
  positionNotifPanel();
}

/**
 * Anchors the panel to the sidebar bell. Opens below the icon, or above
 * when the window does not have room underneath.
 */
export function positionNotifPanel(): void {
  if (notifOverlayOn) {
    const { x, y } = overlayOrigin(notifOverlayBox.w, notifOverlayBox.h);
    void invoke("move_notif_overlay", {
      x,
      y,
      width: notifOverlayBox.w,
      height: notifOverlayBox.h,
    }).catch(() => undefined);
    return;
  }
  const panel = document.querySelector<HTMLElement>("#notif-root .notif-panel");
  const anchor = document.getElementById("notif-btn")?.getBoundingClientRect();
  if (!panel || !anchor) return;
  panel.style.width = "";
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
  // Open on whatever is new: the newest unread entry decides the tab, so the
  // first click after an achievement lands on that achievement.
  const newestUnread = S.notifications.find((n) => !n.read);
  if (newestUnread) S.notifTab = notifTabOf(newestUnread.kind);
  // Mark first: the panel is painted from these flags, so painting before the
  // clear showed every item as unread with a "Read all" button that did nothing.
  markAllRead();
  renderNotificationPanel();
  syncStoreViewSize();
}

/** Switches the dropdown tab; unknown ids are ignored. */
export function selectNotifTab(tab: string): void {
  if (!isNotifTab(tab) || S.notifTab === tab) return;
  S.notifTab = tab;
  renderNotificationPanel();
}

export function closeNotifPanel(): void {
  if (!S.notifOpen) return;
  S.notifOpen = false;
  renderNotificationPanel();
}
