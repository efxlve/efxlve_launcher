/**
 * Settings → Task manager.
 *
 * A stat strip with a recent-history sparkline per metric, the running game,
 * the launcher's process tree grouped by ownership (CLI tools, web pages, web
 * infrastructure, other helpers) and the background jobs as a card grid. The
 * section polls on a chosen interval, pauses when the window is hidden and
 * patches numbers, bars, states and sparklines in place. A process row opens a
 * live detail drawer.
 *
 * The data comes from `task_manager_snapshot` in one call: rows, the running
 * game, the system's memory size and the history the sparklines draw.
 */

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { TM_GROUPS_KEY, TM_PREFS_KEY, isTauri } from "../../core/constants";
import { askConfirm } from "../../core/confirm-dialog";
import { icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";

/* ---------- Wire types ---------- */

interface TaskRow {
  id: string;
  kind: string;
  name: string;
  role: string;
  group: string;
  owner: string;
  parentPid: number;
  pid: number;
  cpu: number;
  memoryMb: number;
  readMb: number;
  writtenMb: number;
  readRate: number;
  writeRate: number;
  exe: string;
  startedAt: number;
  cmd: string;
  running: boolean;
  stoppable: boolean;
  endable: boolean;
}

interface TaskGame {
  key: string;
  title: string;
  store: string;
  cpu: number;
  memoryMb: number;
  processCount: number;
  startedAt: number;
  closable: boolean;
}

interface TaskSnapshot {
  rows: TaskRow[];
  games: TaskGame[];
  totalMemoryMb: number;
  cpuHistory: number[];
  memoryHistory: number[];
  jobsHistory: number[];
}

/* ---------- State ---------- */

const EMPTY: TaskSnapshot = {
  rows: [],
  games: [],
  totalMemoryMb: 0,
  cpuHistory: [],
  memoryHistory: [],
  jobsHistory: [],
};

let snapshot: TaskSnapshot = EMPTY;
let timer: number | null = null;
let pollBusy = false;
let loaded = false;
let lastRefreshAt = 0;

type SortKey = "memory" | "cpu" | "disk" | "name";
let sortKey: SortKey = "memory";
let sortAsc = false;

type GroupKey = "cli" | "webview" | "infra" | "other";
const DEFAULT_GROUPS: Record<GroupKey, boolean> = {
  cli: true,
  webview: true,
  infra: false,
  other: false,
};
let groupOpen = loadGroups();

interface TaskPrefs {
  intervalMs: number;
  paused: boolean;
  hideIdle: boolean;
}

const DEFAULT_PREFS: TaskPrefs = { intervalMs: 2000, paused: false, hideIdle: false };
let prefs = loadPrefs();

let taskQuery = "";
let taskQueryFold = "";
let detailTaskId: string | null = null;
/** Denominator for the memory bars: the launcher's own total, games excluded. */
let launcherMemTotal = 1;

/** Sparkline box, in SVG units (the CSS stretches it to the tile). */
const SPARK_W = 108;
const SPARK_H = 26;

function loadGroups(): Record<GroupKey, boolean> {
  try {
    const raw = localStorage.getItem(TM_GROUPS_KEY);
    if (!raw) return { ...DEFAULT_GROUPS };
    const parsed = JSON.parse(raw) as Partial<Record<GroupKey, unknown>>;
    return {
      cli: typeof parsed.cli === "boolean" ? parsed.cli : DEFAULT_GROUPS.cli,
      webview: typeof parsed.webview === "boolean" ? parsed.webview : DEFAULT_GROUPS.webview,
      infra: typeof parsed.infra === "boolean" ? parsed.infra : DEFAULT_GROUPS.infra,
      other: typeof parsed.other === "boolean" ? parsed.other : DEFAULT_GROUPS.other,
    };
  } catch {
    return { ...DEFAULT_GROUPS };
  }
}

function saveGroups(): void {
  try {
    localStorage.setItem(TM_GROUPS_KEY, JSON.stringify(groupOpen));
  } catch {
    /* storage can be unavailable; the panel still works for this session */
  }
}

function loadPrefs(): TaskPrefs {
  try {
    const raw = localStorage.getItem(TM_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<TaskPrefs>;
    const interval = Number(parsed.intervalMs);
    return {
      intervalMs: interval === 1000 || interval === 2000 || interval === 5000 ? interval : 2000,
      paused: parsed.paused === true,
      hideIdle: parsed.hideIdle === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(TM_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage can be unavailable; the panel still works for this session */
  }
}

/* ---------- Labels ---------- */

function taskRoleLabel(role: string): string {
  switch (role) {
    case "app": return t("task.roleApp");
    case "helper": return t("task.roleHelper");
    case "cli": return t("task.roleCli");
    case "game": return t("task.games");
    case "browser": return t("task.roleBrowser");
    case "renderer": return t("task.roleRenderer");
    case "gpu": return t("task.roleGpu");
    case "network": return t("task.roleNetwork");
    case "storage": return t("task.roleStorage");
    case "audio": return t("task.roleAudio");
    case "crashpad": return t("task.roleCrashpad");
    case "utility": return t("task.roleUtility");
    default: return t("task.roleOther");
  }
}

/** One mark per role, so the table reads by shape before by name. */
function taskRoleIcon(role: string, group: string): IconName {
  if (group === "cli") return "terminal";
  if (group === "other") return "package";
  if (group === "app") return "monitor";
  switch (role) {
    case "browser": return "globe";
    case "renderer": return "layers";
    case "gpu": return "zap";
    case "network": return "wifi";
    case "storage": return "hard-drive";
    case "audio": return "volume-2";
    case "crashpad": return "alert-triangle";
    case "utility": return "server";
    default: return "layers";
  }
}

/** Each background job gets its own mark, so the grid scans by shape. */
function taskJobIcon(id: string): IconName {
  switch (id) {
    case "metrics": return "activity";
    case "spotify":
    case "spotify_player": return "music";
    case "controller_bridge": return "gamepad-2";
    case "discord_voice": return "mic";
    case "discord_sdk":
    case "discord_page": return "discord";
    case "presence": return "wifi";
    case "game_watch": return "eye";
    case "screenshots": return "camera";
    case "store_page": return "package";
    case "overlay_browser": return "globe";
    default: return "server";
  }
}

function formatTaskMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatTaskRate(mbPerSec: number): string {
  if (mbPerSec <= 0.0005) return "0 MB/s";
  if (mbPerSec < 0.1) return `${Math.max(1, Math.round(mbPerSec * 1024))} KB/s`;
  if (mbPerSec < 10) return `${mbPerSec.toFixed(1)} MB/s`;
  return `${mbPerSec.toFixed(0)} MB/s`;
}

/** h:mm:ss (or m:ss under an hour); the same shape in every locale. */
function formatTaskUptime(startedAt: number): string {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`;
}

function gameStoreLabel(store: string): string {
  switch (store) {
    case "epic": return "Epic Games";
    case "gog": return "GOG";
    case "amazon": return "Amazon Games";
    case "steam": return "Steam";
    case "battlenet": return "Battle.net";
    case "ubisoft": return "Ubisoft";
    case "ea": return "EA";
    case "riot": return "Riot Games";
    case "xbox": return "Xbox";
    case "custom": return t("settings.customKey");
    default: return store.charAt(0).toUpperCase() + store.slice(1);
  }
}

function processRows(): TaskRow[] {
  return snapshot.rows.filter((row) => row.kind === "process");
}

/** The launcher's own processes; the game is a separate section and total. */
function launcherRows(): TaskRow[] {
  return processRows().filter((row) => row.group !== "game");
}

function jobsOf(): TaskRow[] {
  return snapshot.rows.filter((row) => row.kind === "job");
}

/** The rows the UI puts under one ownership group. The backend keeps every
 * WebView2 process in one `webview` group; the panel splits the renderers
 * (pages) from the browser/GPU/network infrastructure. */
function rowsForGroup(rows: TaskRow[], key: GroupKey): TaskRow[] {
  if (key === "webview") {
    return rows.filter((row) => row.group === "webview" && row.role === "renderer");
  }
  if (key === "infra") {
    return rows.filter((row) => row.group === "webview" && row.role !== "renderer");
  }
  return rows.filter((row) => row.group === key);
}

function rowIsIdle(row: TaskRow): boolean {
  return row.group !== "app" && row.cpu < 0.15 && row.readRate + row.writeRate < 0.02;
}

function rowTitle(row: TaskRow, override = ""): string {
  if (row.group === "app") return t("task.mainProcess");
  if (override) return override;
  if (row.group === "cli" || row.group === "other") return row.name || taskRoleLabel(row.role);
  return taskRoleLabel(row.role);
}

/* ---------- Sparklines ---------- */

/** SVG points for a series, always from a zero baseline so a small change
 * cannot look like a spike. */
function sparkPoints(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 0.0001);
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const y = height - 2 - (value / max) * (height - 4);
      return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function sparkHtml(values: number[], cls: string): string {
  return `<svg class="tm-spark ${cls}" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${sparkPoints(values, SPARK_W, SPARK_H)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

/* ---------- Stat strip ---------- */

function statsHtml(): string {
  const rows = launcherRows();
  const jobs = jobsOf();
  const totalCpu = rows.reduce((sum, row) => sum + row.cpu, 0);
  const totalMem = rows.reduce((sum, row) => sum + row.memoryMb, 0);
  const readRate = rows.reduce((sum, row) => sum + row.readRate, 0);
  const writeRate = rows.reduce((sum, row) => sum + row.writeRate, 0);
  const runningJobs = jobs.filter((row) => row.running).length;
  const share = snapshot.totalMemoryMb > 0 ? (totalMem / snapshot.totalMemoryMb) * 100 : 0;
  const gameMemory = snapshot.games.reduce((sum, game) => sum + game.memoryMb, 0);
  return `
    <div class="tm-stats">
      <div class="tm-stat">
        <span class="tm-stat-label">${icon("cpu", 12)} ${esc(t("task.colCpu"))}</span>
        <span class="tm-stat-value task-total-cpu">${totalCpu.toFixed(1)}%</span>
        <span class="tm-stat-sub">${esc(t("task.statCpuSub"))}</span>
        ${sparkHtml(snapshot.cpuHistory, "task-cpu-spark")}
      </div>
      <div class="tm-stat">
        <span class="tm-stat-label">${icon("hard-drive", 12)} ${esc(t("task.colRam"))}</span>
        <span class="tm-stat-value"><span class="task-total-mem">${formatTaskMb(totalMem)}</span><span class="tm-stat-of task-mem-total"> / ${formatTaskMb(snapshot.totalMemoryMb)}</span></span>
        <span class="tm-stat-sub task-ram-sub">${esc(t("task.statRamSub", { count: String(rows.length), percent: share.toFixed(1) }))}</span>
        ${sparkHtml(snapshot.memoryHistory, "task-mem-spark")}
      </div>
      <div class="tm-stat">
        <span class="tm-stat-label">${icon("activity", 12)} ${esc(t("task.diskSpeed"))}</span>
        <span class="tm-stat-value"><span class="task-disk-rate">${formatTaskRate(readRate + writeRate)}</span></span>
        <span class="tm-stat-sub"><span class="task-disk-read-rate">↓ ${formatTaskRate(readRate)}</span> · <span class="task-disk-write-rate">↑ ${formatTaskRate(writeRate)}</span></span>
      </div>
      <div class="tm-stat">
        <span class="tm-stat-label">${icon("gamepad-2", 12)} ${esc(t("task.games"))}</span>
        <span class="tm-stat-value"><span class="task-games-count">${snapshot.games.length}</span><span class="tm-stat-of task-games-mem">${snapshot.games.length ? ` · ${formatTaskMb(gameMemory)}` : ""}</span></span>
        <span class="tm-stat-sub task-games-sub">${esc(snapshot.games[0]?.title ?? t("task.noGame"))}</span>
      </div>
    </div>`;
}

/* ---------- Toolbar ---------- */

function toolbarHtml(): string {
  const intervals = [1000, 2000, 5000];
  return `
    <div class="tm-toolbar">
      <label class="tm-search">
        ${icon("search", 13)}
        <input id="tm-search" class="input tm-search-input" type="search"
          placeholder="${esc(t("task.searchPlaceholder"))}" aria-label="${esc(t("task.searchPlaceholder"))}" value="${esc(taskQuery)}"
          autocomplete="off" spellcheck="false" />
      </label>
      <button type="button" class="btn ghost small${prefs.hideIdle ? " is-on" : ""}" data-act="task-toggle-idle" aria-pressed="${prefs.hideIdle}">
        ${icon(prefs.hideIdle ? "eye-off" : "eye", 12)} ${esc(t("task.hideIdle"))}
      </button>
      <div class="tm-interval" role="group" aria-label="${esc(t("task.interval"))}">
        ${intervals
          .map(
            (ms) =>
              `<button type="button" class="tm-interval-btn${prefs.intervalMs === ms ? " active" : ""}" data-act="task-interval" data-ms="${ms}" aria-pressed="${prefs.intervalMs === ms}">${ms / 1000}s</button>`,
          )
          .join("")}
      </div>
      <button type="button" class="btn ghost small" data-act="task-toggle-pause" aria-pressed="${prefs.paused}">
        ${icon(prefs.paused ? "play" : "pause", 12)} ${esc(prefs.paused ? t("task.resume") : t("task.pause"))}
      </button>
    </div>`;
}

/* ---------- Games ---------- */

function gameCover(game: TaskGame): string {
  const custom = S.customCovers[game.key];
  if (custom) return custom;
  const item =
    S.allGamesMap.get(game.key) ??
    (game.store === "epic" ? S.allGamesMap.get(`epic::${game.key}`) : undefined);
  return item?.coverUrl ?? "";
}

function gameCardHtml(game: TaskGame): string {
  const uptime = game.startedAt > 0 ? formatTaskUptime(game.startedAt) : "—";
  const cover = gameCover(game);
  const art = cover
    ? `<span class="tm-game-art"><img src="${esc(cover)}" alt="" loading="lazy" decoding="async" /></span>`
    : `<span class="tm-game-art is-icon">${icon("gamepad-2", 18)}</span>`;
  return `
    <div class="tm-game-card" data-game="${esc(game.key)}" data-search="${esc(`${game.title} ${game.key} ${gameStoreLabel(game.store)}`)}">
      ${art}
      <div class="tm-game-main">
        <div class="tm-game-title">${esc(game.title)}</div>
        <div class="tm-game-sub">
          <span class="tm-badge">${esc(gameStoreLabel(game.store))}</span>
          <span class="task-game-processes">${esc(t("task.gameProcesses", { count: String(game.processCount) }))}</span>
          <span class="tm-sub-sep">·</span>
          <span class="task-game-cpu" title="${esc(t("task.colCpu"))}">${game.cpu.toFixed(1)}%</span>
          <span class="task-game-mem" title="${esc(t("task.colRam"))}">${formatTaskMb(game.memoryMb)}</span>
          <span class="tm-sub-sep">·</span>
          <span class="task-game-uptime" title="${esc(t("task.detailUptime"))}">${icon("clock", 11)} ${uptime}</span>
        </div>
      </div>
      <button type="button" class="btn danger small" data-act="task-close-game" ${game.closable ? "" : "disabled"}>
        ${icon("square", 12)} ${esc(t("task.closeGame"))}
      </button>
    </div>`;
}

function gamesHtml(): string {
  if (!snapshot.games.length) return "";
  return `
    <section class="tm-games-section">
      <h3 class="section-title">${esc(t("task.games"))}</h3>
      <div class="tm-games">${snapshot.games.map(gameCardHtml).join("")}</div>
    </section>`;
}

/* ---------- Process table ---------- */

function sortRows(rows: TaskRow[]): TaskRow[] {
  const direction = sortAsc ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (sortKey) {
      case "cpu": return (a.cpu - b.cpu) * direction;
      case "disk": return (a.readRate + a.writeRate - (b.readRate + b.writeRate)) * direction;
      case "name": return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * direction;
      default: return (a.memoryMb - b.memoryMb) * direction;
    }
  });
  return sorted;
}

/** CPU as the machine's own percent, memory as a share of system RAM: both
 * bars use a fixed 0-100 scale, so a small value stays small. */
function cpuBarPct(cpu: number): number {
  const pct = Math.min(100, Math.max(0, cpu));
  return pct > 0 ? Math.max(0.6, pct) : 0;
}

function memBarPct(mb: number): number {
  if (launcherMemTotal <= 0) return 0;
  const pct = Math.min(100, (mb / launcherMemTotal) * 100);
  return pct > 0 ? Math.max(0.6, pct) : 0;
}

/** A nonzero value gets a 2px marker in CSS, so a 0.4% process is still
 * visible without pretending the bar is full. */
function barActive(value: number): string {
  return value > 0.0001 ? " is-active" : "";
}

/** Live read/write rates; the lifetime totals stay in the detail drawer. */
function diskCellHtml(row: TaskRow): string {
  if (row.readRate + row.writeRate <= 0.0005) {
    return `<span class="tm-num tm-disk-empty">—</span>`;
  }
  return `
    <span class="tm-num task-disk-read">↓ ${formatTaskRate(row.readRate)}</span>
    <span class="tm-num task-disk-write">↑ ${formatTaskRate(row.writeRate)}</span>`;
}

/** One process line: role mark, its title, exe and PID under it, then CPU and
 * memory with fixed-scale bars and the live disk rates. */
function processRowHtml(row: TaskRow, override = "", isChild = false): string {
  const isMain = row.group === "app";
  const title = rowTitle(row, override);
  const idle = rowIsIdle(row);
  const role = row.role === "app" ? t("task.roleApp") : taskRoleLabel(row.role);
  return `
    <div class="tm-row${isMain ? " is-main" : ""}${isChild ? " is-child" : ""}" role="button" tabindex="0"
      data-task="${esc(row.id)}" data-act="task-detail" data-task-id="${esc(row.id)}"
      data-idle="${idle ? "1" : "0"}"
      data-search="${esc(`${title} ${row.name} ${role} PID ${row.pid}`)}">
      <span class="tm-row-icon${isMain ? " is-main" : ""}">${icon(taskRoleIcon(row.role, row.group), 14)}</span>
      <div class="tm-row-main">
        <div class="tm-row-title">${esc(title)}</div>
        <div class="tm-row-sub">
          ${isMain ? `<span class="tm-badge">${esc(t("task.roleApp"))}</span>` : ""}
          ${!isMain && row.group === "cli" ? `<span class="tm-badge">${esc(t("task.roleCli"))}</span>` : ""}
          ${
            isMain || row.group === "webview"
              ? `<span class="tm-row-exe">${esc(row.name)}</span><span class="tm-sub-sep">·</span>`
              : ""
          }
          <span>PID ${row.pid}</span>
          ${row.group === "webview" && row.role !== "renderer" ? `<span class="tm-row-lock" title="${esc(t("task.alwaysOn"))}">${icon("lock", 10)}</span>` : ""}
        </div>
      </div>
      <div class="tm-metric" title="${esc(t("task.cpuShare"))}">
        <span class="tm-bar"><span class="tm-bar-fill task-cpu-bar${barActive(row.cpu)}" style="width:${cpuBarPct(row.cpu)}%"></span></span>
        <span class="tm-num task-cpu">${row.cpu.toFixed(1)}%</span>
      </div>
      <div class="tm-metric" title="${esc(t("task.ramShare"))}">
        <span class="tm-bar"><span class="tm-bar-fill mem task-mem-bar${barActive(row.memoryMb)}" style="width:${memBarPct(row.memoryMb)}%"></span></span>
        <span class="tm-num task-mem">${formatTaskMb(row.memoryMb)}</span>
      </div>
      <div class="tm-disk" title="${esc(t("task.diskSpeed"))}">${diskCellHtml(row)}</div>
    </div>`;
}

/** Renderer rows share their title; number them so four "Interface (renderer)"
 * lines are at least distinguishable. */
function rendererTitles(rows: TaskRow[]): Map<string, string> {
  const map = new Map<string, string>();
  const renderers = rows
    .filter((row) => row.role === "renderer")
    .sort((a, b) => b.memoryMb - a.memoryMb);
  renderers.forEach((row, index) => {
    map.set(row.id, `${taskRoleLabel("renderer")} ${index + 1}`);
  });
  return map;
}

/** A collapsible group whose header uses the same column grid as its rows. */
function groupBlockHtml(
  key: GroupKey,
  label: string,
  rows: TaskRow[],
  titles: Map<string, string>,
): string {
  if (!rows.length) return "";
  const open = groupOpen[key];
  const cpu = rows.reduce((sum, row) => sum + row.cpu, 0);
  const memory = rows.reduce((sum, row) => sum + row.memoryMb, 0);
  const read = rows.reduce((sum, row) => sum + row.readRate, 0);
  const write = rows.reduce((sum, row) => sum + row.writeRate, 0);
  return `
    <div class="tm-group-block" data-group="${key}">
      <button type="button" class="tm-group" data-act="task-toggle-group" data-group="${key}" aria-expanded="${open}">
        <span class="tm-group-chevron">${icon(open ? "chevron-down" : "chevron-right", 14)}</span>
        <span class="tm-group-title">${esc(label)}${key === "infra" ? `<span class="tm-group-lock" title="${esc(t("task.alwaysOn"))}">${icon("lock", 10)}</span>` : ""}<span class="tm-group-meta"><span class="task-group-count">${rows.length}</span> ${esc(t("task.processCount"))}</span></span>
        <span class="tm-metric" title="${esc(t("task.cpuShare"))}">
          <span class="tm-bar"><span class="tm-bar-fill task-group-cpu-bar${barActive(cpu)}" style="width:${cpuBarPct(cpu)}%"></span></span>
          <span class="tm-num task-group-cpu">${cpu.toFixed(1)}%</span>
        </span>
        <span class="tm-metric" title="${esc(t("task.ramShare"))}">
          <span class="tm-bar"><span class="tm-bar-fill mem task-group-mem-bar${barActive(memory)}" style="width:${memBarPct(memory)}%"></span></span>
          <span class="tm-num task-group-mem">${formatTaskMb(memory)}</span>
        </span>
        <span class="tm-disk" title="${esc(t("task.diskSpeed"))}">
          ${read + write <= 0.0005 ? `<span class="tm-num tm-disk-empty">—</span>` : `<span class="tm-num task-disk-read">↓ ${formatTaskRate(read)}</span><span class="tm-num task-disk-write">↑ ${formatTaskRate(write)}</span>`}
        </span>
      </button>
      <div class="tm-group-rows"${open ? "" : " hidden"}>
        ${sortRows(rows).map((row) => processRowHtml(row, titles.get(row.id) ?? "", true)).join("")}
      </div>
    </div>`;
}

function theadHtml(): string {
  const sortButton = (key: SortKey, label: string, cls = ""): string => {
    const active = sortKey === key;
    return `<button type="button" class="tm-sort${active ? " active" : ""}${cls}" data-act="task-sort" data-key="${key}">
      <span>${esc(label)}</span>${active ? icon(sortAsc ? "chevron-up" : "chevron-down", 11) : ""}
    </button>`;
  };
  return `
    <div class="tm-thead">
      <span></span>
      ${sortButton("name", t("task.colProcess"), " tm-sort-left")}
      ${sortButton("cpu", t("task.colCpu"))}
      ${sortButton("memory", t("task.colRam"))}
      ${sortButton("disk", t("task.diskSpeed"))}
    </div>`;
}

function processTableHtml(): string {
  const processes = launcherRows();
  if (!snapshot.rows.length) {
    return `<div class="list settings-group tm-table"><div class="tm-empty">${esc(t("task.loading"))}</div></div>`;
  }
  const main = processes.find((row) => row.group === "app");
  const cli = processes.filter((row) => row.group === "cli");
  const webviews = processes.filter((row) => row.group === "webview");
  const pages = webviews.filter((row) => row.role === "renderer");
  const infra = webviews.filter((row) => row.role !== "renderer");
  const other = processes.filter((row) => row.group === "other");
  const titles = rendererTitles(pages);
  return `
    <div class="list settings-group tm-table">
      ${theadHtml()}
      ${main ? processRowHtml(main) : ""}
      ${groupBlockHtml("cli", t("task.groupCli"), cli, titles)}
      ${groupBlockHtml("webview", t("task.groupPages"), pages, titles)}
      ${groupBlockHtml("infra", t("task.groupInfra"), infra, titles)}
      ${groupBlockHtml("other", t("task.groupOther"), other, titles)}
      <div class="tm-empty tm-filter-empty" hidden>${esc(t("task.noMatches"))}</div>
    </div>`;
}

/* ---------- Jobs ---------- */

/** One background job: mark, name, live dot, and the stop action when stopping
 * is safe. Jobs are threads, so they carry no CPU or memory of their own. */
function jobRowHtml(row: TaskRow): string {
  const name = t(`task.job.${row.id}`);
  return `
    <div class="tm-job${row.running ? " is-running" : ""}" data-task="${esc(row.id)}" data-search="${esc(`${name} ${row.id}`)}">
      <div class="tm-job-head">
        <span class="tm-job-icon">${icon(taskJobIcon(row.id), 14)}</span>
        <span class="tm-job-name">${esc(name)}</span>
        <span class="tm-dot${row.running ? " on" : ""}"></span>
      </div>
      <div class="tm-job-foot">
        <span class="tm-job-state task-status">${esc(row.running ? t("task.running") : t("task.stopped"))}</span>
        ${
          row.stoppable
            ? `<button type="button" class="btn ghost small" data-act="task-stop" data-id="${esc(row.id)}" ${row.running ? "" : "disabled"}>${esc(t("task.stop"))}</button>`
            : `<span class="tm-job-lock" title="${esc(t("task.alwaysOn"))}">${icon("lock", 11)} ${esc(t("task.alwaysOnShort"))}</span>`
        }
      </div>
    </div>`;
}

const JOB_GROUPS: { key: string; labelKey: string; ids: string[] }[] = [
  {
    key: "always",
    labelKey: "task.jobsAlways",
    ids: ["game_watch", "screenshots", "discord_sdk"],
  },
  {
    key: "optional",
    labelKey: "task.jobsOptional",
    ids: ["metrics", "spotify", "controller_bridge", "discord_voice", "presence"],
  },
  {
    key: "pages",
    labelKey: "task.jobsPages",
    ids: ["store_page", "discord_page", "spotify_player", "overlay_browser"],
  },
];

function jobsGridHtml(): string {
  const jobs = jobsOf();
  if (jobs.length === 0) {
    return `<div class="settings-group tm-jobs"><div class="tm-empty">${esc(t("task.loading"))}</div></div>`;
  }
  const byId = new Map(jobs.map((row) => [row.id, row]));
  const used = new Set<string>();
  const groups = JOB_GROUPS.map((group) => {
    const cards = group.ids
      .map((id) => byId.get(id))
      .filter((row): row is TaskRow => Boolean(row));
    for (const row of cards) used.add(row.id);
    return { ...group, cards };
  }).filter((group) => group.cards.length);
  const rest = jobs.filter((row) => !used.has(row.id));
  if (rest.length) {
    groups.push({ key: "more", labelKey: "task.jobsOptional", ids: [], cards: rest });
  }
  return `<div class="tm-jobs-wrap">${groups
    .map(
      (group) => `
        <section class="tm-job-group" data-job-group="${group.key}">
          <h4 class="tm-job-group-title">${esc(t(group.labelKey))}</h4>
          <div class="tm-jobs">${group.cards.map(jobRowHtml).join("")}</div>
        </section>`,
    )
    .join("")}</div>`;
}

/* ---------- Section ---------- */

export function renderTasks(): string {
  if (!isTauri) {
    return `<div class="info-box">${icon("info", 14)}<span>${t("task.desktopOnly")}</span></div>`;
  }
  launcherMemTotal = Math.max(1, launcherRows().reduce((sum, row) => sum + row.memoryMb, 0));
  if (!loaded) {
    loaded = true;
    void refreshTasks();
  } else if (Date.now() - lastRefreshAt > 5000) {
    // The panel was closed for a while: do not show a stale tree until the
    // next tick.
    void refreshTasks();
  }
  ensurePolling();
  queueMicrotask(() => applyTaskVisibility());
  return `
    <div class="info-box">${icon("info", 14)}<span>${t("task.info")}</span></div>
    ${statsHtml()}
    ${gamesHtml()}
    <h3 class="section-title">${t("task.processes")}</h3>
    ${toolbarHtml()}
    ${processTableHtml()}
    <h3 class="section-title">${t("task.jobs")}</h3>
    ${jobsGridHtml()}
    <div class="tm-foot">
      <span class="tm-updated">${esc(prefs.paused ? t("task.paused") : t("task.autoRefreshEvery", { seconds: String(prefs.intervalMs / 1000) }))}</span>
      <button type="button" class="btn ghost small" data-act="task-refresh">${icon("refresh", 13)} ${t("task.refresh")}</button>
    </div>`;
}

export async function refreshTasks(repaint = true): Promise<void> {
  if (!isTauri) return;
  try {
    snapshot = await invoke<TaskSnapshot>("task_manager_snapshot");
    lastRefreshAt = Date.now();
  } catch {
    // Keep the last snapshot: a failed poll must not blank the panel.
    return;
  }
  if (repaint && S.view === "settings" && S.settingsSection === "tasks") render();
}

/* ---------- Polling ---------- */

function schedulePoll(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(tick, prefs.intervalMs);
}

/** Polls while the section is on screen; the loop stops itself when the
 * section is left. Hidden windows and the pause button skip the IPC call but
 * keep the loop alive. */
function ensurePolling(): void {
  if (prefs.paused) return;
  if (timer !== null || pollBusy) return;
  schedulePoll();
}

function restartPolling(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  if (!prefs.paused) ensurePolling();
}

function tick(): void {
  timer = null;
  if (S.view !== "settings" || S.settingsSection !== "tasks") return;
  // Hidden windows stop the loop; the visibility listener restarts it. Paused
  // keeps it stopped until the user resumes.
  if (prefs.paused || document.hidden || pollBusy) return;
  pollBusy = true;
  void refreshTasks(false)
    .then(() => patchTaskRows())
    .finally(() => {
      pollBusy = false;
      if (!prefs.paused && S.view === "settings" && S.settingsSection === "tasks") {
        schedulePoll();
      }
    });
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden || prefs.paused) return;
  if (S.view !== "settings" || S.settingsSection !== "tasks") return;
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  tick();
});

/* ---------- Live patching ---------- */

function patchSpark(panel: HTMLElement, cls: string, values: number[]): void {
  const line = panel.querySelector<SVGPolylineElement>(`.${cls} polyline`);
  if (line) line.setAttribute("points", sparkPoints(values, SPARK_W, SPARK_H));
}

/** Re-render the panel but keep the scroll position; used only when the row
 * set itself changes (a game starts, a page closes, a CLI tool exits). */
function repaintKeepingScroll(): void {
  const scroller = document.getElementById("view");
  const top = scroller?.scrollTop ?? 0;
  render();
  if (scroller) scroller.scrollTop = top;
  refreshTaskDrawer();
  applyTaskVisibility();
}

function patchRow(el: HTMLElement, row: TaskRow): void {
  if (row.kind === "job") {
    el.classList.toggle("is-running", row.running);
    const status = el.querySelector<HTMLElement>(".task-status");
    if (status) status.textContent = row.running ? t("task.running") : t("task.stopped");
    const dot = el.querySelector<HTMLElement>(".tm-dot");
    if (dot) dot.classList.toggle("on", row.running);
    const stop = el.querySelector<HTMLButtonElement>('[data-act="task-stop"]');
    if (stop) stop.disabled = !row.running;
    return;
  }

  el.dataset.idle = rowIsIdle(row) ? "1" : "0";
  const cpu = el.querySelector<HTMLElement>(".task-cpu");
  if (cpu) cpu.textContent = `${row.cpu.toFixed(1)}%`;
  const cpuBar = el.querySelector<HTMLElement>(".task-cpu-bar");
  if (cpuBar) {
    cpuBar.style.width = `${cpuBarPct(row.cpu)}%`;
    cpuBar.classList.toggle("is-active", row.cpu > 0.0001);
  }
  const mem = el.querySelector<HTMLElement>(".task-mem");
  if (mem) mem.textContent = formatTaskMb(row.memoryMb);
  const memBar = el.querySelector<HTMLElement>(".task-mem-bar");
  if (memBar) {
    memBar.style.width = `${memBarPct(row.memoryMb)}%`;
    memBar.classList.toggle("is-active", row.memoryMb > 0.0001);
  }
  const disk = el.querySelector<HTMLElement>(".tm-disk");
  if (disk) disk.innerHTML = diskCellHtml(row);
}

/** Rebuilds only the ownership groups whose row set changed, so a WebView page
 * opening or a CLI tool exiting does not repaint the whole panel. Returns false
 * when the change is structural enough to need a full render (a new group, a
 * game starting or stopping). */
function patchStructure(panel: HTMLElement): boolean {
  const visibleRows = snapshot.rows.filter((row) => row.group !== "game");
  const processRows = visibleRows.filter((row) => row.kind === "process");
  const jobRows = visibleRows.filter((row) => row.kind === "job");

  const domJobs = new Set(
    [...panel.querySelectorAll<HTMLElement>(".tm-job[data-task]")].map(
      (el) => el.dataset.task ?? "",
    ),
  );
  if (jobRows.length !== domJobs.size || jobRows.some((row) => !domJobs.has(row.id))) {
    return false;
  }

  const domGames = new Set(
    [...panel.querySelectorAll<HTMLElement>(".tm-game-card")].map((el) => el.dataset.game ?? ""),
  );
  const expectedGames = new Set(snapshot.games.map((game) => game.key));
  if (
    domGames.size !== expectedGames.size ||
    [...expectedGames].some((key) => !domGames.has(key))
  ) {
    return false;
  }

  const appRow = processRows.find((row) => row.group === "app");
  const standalone = [...panel.querySelectorAll<HTMLElement>(".tm-row")].filter(
    (el) => !el.closest(".tm-group-block"),
  );
  if ((appRow ? 1 : 0) !== standalone.length) return false;
  if (appRow && standalone[0]?.dataset.task !== appRow.id) return false;

  for (const key of ["cli", "webview", "infra", "other"] as GroupKey[]) {
    const desired = rowsForGroup(processRows, key);
    const block = panel.querySelector<HTMLElement>(`.tm-group-block[data-group="${key}"]`);
    if (!desired.length) {
      block?.remove();
      continue;
    }
    if (!block) return false;
    const container = block.querySelector<HTMLElement>(".tm-group-rows");
    if (!container) return false;
    const titles = key === "webview" ? rendererTitles(desired) : new Map<string, string>();
    container.innerHTML = sortRows(desired)
      .map((row) => processRowHtml(row, titles.get(row.id) ?? "", true))
      .join("");
  }
  return true;
}

/** Live patch: numbers, bars, states, group totals and sparklines update in
 * place. A changed row set rebuilds only the affected group. */
function patchTaskRows(): void {
  if (S.view !== "settings" || S.settingsSection !== "tasks") return;
  const panel = document.querySelector<HTMLElement>(".settings-panel");
  if (!panel || !panel.querySelector(".tm-table")) return;

  launcherMemTotal = Math.max(1, launcherRows().reduce((sum, row) => sum + row.memoryMb, 0));
  const visibleRows = snapshot.rows.filter((row) => row.group !== "game");
  const expected = new Set(visibleRows.map((row) => row.id));
  const shown = new Set(
    [...panel.querySelectorAll<HTMLElement>("[data-task]")].map((el) => el.dataset.task ?? ""),
  );
  if (shown.size !== expected.size || [...expected].some((id) => !shown.has(id))) {
    if (!patchStructure(panel)) {
      repaintKeepingScroll();
      return;
    }
  }

  const elements = [...panel.querySelectorAll<HTMLElement>("[data-task]")];
  const byId = new Map(snapshot.rows.map((row) => [row.id, row]));
  for (const el of elements) {
    const row = byId.get(el.dataset.task ?? "");
    if (row) patchRow(el, row);
  }

  const rows = launcherRows();
  const totalCpu = rows.reduce((sum, row) => sum + row.cpu, 0);
  const totalMem = rows.reduce((sum, row) => sum + row.memoryMb, 0);
  const share = snapshot.totalMemoryMb > 0 ? (totalMem / snapshot.totalMemoryMb) * 100 : 0;
  const readRate = rows.reduce((sum, row) => sum + row.readRate, 0);
  const writeRate = rows.reduce((sum, row) => sum + row.writeRate, 0);

  const cpuTotal = panel.querySelector<HTMLElement>(".task-total-cpu");
  if (cpuTotal) cpuTotal.textContent = `${totalCpu.toFixed(1)}%`;
  const memTotal = panel.querySelector<HTMLElement>(".task-total-mem");
  if (memTotal) memTotal.textContent = formatTaskMb(totalMem);
  const memSystem = panel.querySelector<HTMLElement>(".task-mem-total");
  if (memSystem) memSystem.textContent = ` / ${formatTaskMb(snapshot.totalMemoryMb)}`;
  const ramSub = panel.querySelector<HTMLElement>(".task-ram-sub");
  if (ramSub) {
    ramSub.textContent = t("task.statRamSub", {
      count: String(rows.length),
      percent: share.toFixed(1),
    });
  }
  const diskRate = panel.querySelector<HTMLElement>(".task-disk-rate");
  if (diskRate) diskRate.textContent = formatTaskRate(readRate + writeRate);
  const diskRead = panel.querySelector<HTMLElement>(".task-disk-read-rate");
  if (diskRead) diskRead.textContent = `↓ ${formatTaskRate(readRate)}`;
  const diskWrite = panel.querySelector<HTMLElement>(".task-disk-write-rate");
  if (diskWrite) diskWrite.textContent = `↑ ${formatTaskRate(writeRate)}`;
  const jobsCount = panel.querySelector<HTMLElement>(".task-jobs-count");
  if (jobsCount) jobsCount.textContent = String(jobsOf().filter((row) => row.running).length);

  const gameMemory = snapshot.games.reduce((sum, game) => sum + game.memoryMb, 0);
  const gamesCount = panel.querySelector<HTMLElement>(".task-games-count");
  if (gamesCount) gamesCount.textContent = String(snapshot.games.length);
  const gamesMem = panel.querySelector<HTMLElement>(".task-games-mem");
  if (gamesMem) {
    gamesMem.textContent = snapshot.games.length ? ` · ${formatTaskMb(gameMemory)}` : "";
  }
  const gamesSub = panel.querySelector<HTMLElement>(".task-games-sub");
  if (gamesSub) gamesSub.textContent = snapshot.games[0]?.title ?? t("task.noGame");

  for (const game of snapshot.games) {
    const card = panel.querySelector<HTMLElement>(`[data-game="${CSS.escape(game.key)}"]`);
    if (!card) continue;
    const processes = card.querySelector<HTMLElement>(".task-game-processes");
    if (processes) {
      processes.textContent = t("task.gameProcesses", { count: String(game.processCount) });
    }
    const cpu = card.querySelector<HTMLElement>(".task-game-cpu");
    if (cpu) cpu.textContent = `${game.cpu.toFixed(1)}%`;
    const mem = card.querySelector<HTMLElement>(".task-game-mem");
    if (mem) mem.textContent = formatTaskMb(game.memoryMb);
    const uptime = card.querySelector<HTMLElement>(".task-game-uptime");
    if (uptime) {
      uptime.innerHTML = `${icon("clock", 11)} ${game.startedAt > 0 ? formatTaskUptime(game.startedAt) : "—"}`;
    }
  }

  for (const key of ["cli", "webview", "infra", "other"] as GroupKey[]) {
    const block = panel.querySelector<HTMLElement>(`.tm-group-block[data-group="${key}"]`);
    if (!block) continue;
    const groupRows = rowsForGroup(rows, key);
    const cpu = groupRows.reduce((sum, row) => sum + row.cpu, 0);
    const memory = groupRows.reduce((sum, row) => sum + row.memoryMb, 0);
    const read = groupRows.reduce((sum, row) => sum + row.readRate, 0);
    const write = groupRows.reduce((sum, row) => sum + row.writeRate, 0);
    const count = block.querySelector<HTMLElement>(".task-group-count");
    if (count) count.textContent = String(groupRows.length);
    const cpuEl = block.querySelector<HTMLElement>(".task-group-cpu");
    if (cpuEl) cpuEl.textContent = `${cpu.toFixed(1)}%`;
    const cpuBar = block.querySelector<HTMLElement>(".task-group-cpu-bar");
    if (cpuBar) {
      cpuBar.style.width = `${cpuBarPct(cpu)}%`;
      cpuBar.classList.toggle("is-active", cpu > 0.0001);
    }
    const memEl = block.querySelector<HTMLElement>(".task-group-mem");
    if (memEl) memEl.textContent = formatTaskMb(memory);
    const memBar = block.querySelector<HTMLElement>(".task-group-mem-bar");
    if (memBar) {
      memBar.style.width = `${memBarPct(memory)}%`;
      memBar.classList.toggle("is-active", memory > 0.0001);
    }
    const disk = block.querySelector<HTMLElement>(".tm-disk");
    if (disk) {
      disk.innerHTML =
        read + write <= 0.0005
          ? `<span class="tm-num tm-disk-empty">—</span>`
          : `<span class="tm-num task-disk-read">↓ ${formatTaskRate(read)}</span><span class="tm-num task-disk-write">↑ ${formatTaskRate(write)}</span>`;
    }
  }

  patchSpark(panel, "task-cpu-spark", snapshot.cpuHistory);
  patchSpark(panel, "task-mem-spark", snapshot.memoryHistory);
  patchSpark(panel, "task-jobs-spark", snapshot.jobsHistory);
  refreshTaskDrawer();
  applyTaskVisibility();
}

/* ---------- Search / idle filter ---------- */

/** Case- and accent-insensitive fold, so "sayfasi" finds "sayfası". */
function foldTaskSearch(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function applyTaskFilter(query: string): void {
  taskQuery = query;
  taskQueryFold = foldTaskSearch(query.trim());
  applyTaskVisibility();
}

function applyTaskVisibility(): void {
  const panel = document.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  let visibleTableRows = 0;
  for (const el of panel.querySelectorAll<HTMLElement>("[data-task]")) {
    const queryOk =
      !taskQueryFold || foldTaskSearch(el.dataset.search ?? "").includes(taskQueryFold);
    const idleOk = !prefs.hideIdle || el.dataset.idle !== "1";
    el.hidden = !(queryOk && idleOk);
    if (!el.hidden && el.classList.contains("tm-row")) visibleTableRows += 1;
  }
  for (const block of panel.querySelectorAll<HTMLElement>(".tm-group-block")) {
    block.hidden = ![...block.querySelectorAll<HTMLElement>(".tm-row[data-task]")].some(
      (row) => !row.hidden,
    );
  }
  for (const group of panel.querySelectorAll<HTMLElement>(".tm-job-group")) {
    group.hidden = ![...group.querySelectorAll<HTMLElement>(".tm-job[data-task]")].some(
      (row) => !row.hidden,
    );
  }
  for (const card of panel.querySelectorAll<HTMLElement>(".tm-game-card")) {
    card.hidden =
      Boolean(taskQueryFold) &&
      !foldTaskSearch(card.dataset.search ?? "").includes(taskQueryFold);
  }
  const gamesSection = panel.querySelector<HTMLElement>(".tm-games-section");
  if (gamesSection) {
    gamesSection.hidden = ![...gamesSection.querySelectorAll<HTMLElement>(".tm-game-card")].some(
      (card) => !card.hidden,
    );
  }
  const empty = panel.querySelector<HTMLElement>(".tm-filter-empty");
  if (empty) empty.hidden = visibleTableRows > 0 || !snapshot.rows.length;
}

/* ---------- Detail drawer ---------- */

function parentLabel(row: TaskRow): string {
  if (!row.parentPid) return "—";
  const parent = snapshot.rows.find(
    (item) => item.kind === "process" && item.pid === row.parentPid,
  );
  return parent ? `${parent.name} · PID ${parent.pid}` : `PID ${row.parentPid}`;
}

function startedLabel(startedAt: number): string {
  return startedAt > 0 ? new Date(startedAt * 1000).toLocaleString() : "—";
}

function detailFields(row: TaskRow): string {
  const fields: [string, string][] = [
    ["PID", String(row.pid)],
    [t("task.detailRole"), row.role === "app" ? t("task.roleApp") : taskRoleLabel(row.role)],
    [t("task.detailParent"), esc(parentLabel(row))],
    [t("task.detailStarted"), startedLabel(row.startedAt)],
    [t("task.detailUptime"), `<span class="task-detail-uptime">${formatTaskUptime(row.startedAt)}</span>`],
    [t("task.colCpu"), `<span class="task-detail-cpu">${row.cpu.toFixed(1)}%</span>`],
    [t("task.colRam"), `<span class="task-detail-mem">${formatTaskMb(row.memoryMb)}</span>`],
    [
      t("task.diskSpeed"),
      `<span class="task-detail-rate">${diskCellHtml(row)}</span>`,
    ],
    [
      t("task.detailDisk"),
      `<span class="task-detail-total">${esc(t("task.detailDiskValue", { read: formatTaskMb(row.readMb), written: formatTaskMb(row.writtenMb) }))}</span>`,
    ],
  ];
  return fields
    .map(
      ([label, value]) =>
        `<div class="tm-detail-field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`,
    )
    .join("");
}

/** The row's live detail drawer: paths, parent, start time and actions. */
function openTaskDetail(id: string): void {
  const row = snapshot.rows.find((item) => item.id === id && item.kind === "process");
  if (!row) return;
  detailTaskId = id;
  let root = document.getElementById("tm-detail-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "tm-detail-root";
    document.body.appendChild(root);
  }
  const title = rowTitle(row);
  const subtitle =
    row.group === "app"
      ? row.name
      : row.group === "cli" || row.group === "other"
        ? `${taskRoleLabel(row.role)} · PID ${row.pid}`
        : `${row.name} · PID ${row.pid}`;
  root.innerHTML = `
    <div class="tm-drawer-layer" data-act="task-detail-backdrop">
      <aside class="tm-drawer" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <header class="tm-drawer-head">
          <span class="tm-row-icon${row.group === "app" ? " is-main" : ""}">${icon(taskRoleIcon(row.role, row.group), 15)}</span>
          <div class="tm-drawer-title-wrap">
            <h2 class="tm-drawer-title">${esc(title)}</h2>
            <div class="tm-drawer-sub">${esc(subtitle)}</div>
          </div>
          <button type="button" class="manage-head-close" data-act="task-detail-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </header>
        <div class="tm-drawer-body">
          <dl class="tm-detail-grid">${detailFields(row)}</dl>
          <div class="tm-detail-block">
            <div class="tm-detail-label">${esc(t("task.detailExe"))}</div>
            <code class="tm-detail-code">${esc(row.exe || "—")}</code>
          </div>
          <div class="tm-detail-block">
            <div class="tm-detail-label">${esc(t("task.detailCmd"))}</div>
            <code class="tm-detail-code tm-detail-cmd">${esc(row.cmd || "—")}</code>
          </div>
        </div>
        <footer class="tm-drawer-foot">
          ${
            row.endable
              ? `<button type="button" class="btn danger small" data-act="task-end-process">${icon("square", 12)} ${esc(t("task.endProcess"))}</button>`
              : ""
          }
          <span class="tm-drawer-foot-spacer"></span>
          ${
            row.exe
              ? `<button type="button" class="btn ghost small" data-act="task-detail-reveal">${icon("folder", 12)} ${esc(t("task.openFolder"))}</button>`
              : ""
          }
          <button type="button" class="btn ghost small" data-act="task-detail-copy-path" ${row.exe ? "" : "disabled"}>${icon("copy", 12)} ${esc(t("task.copyPath"))}</button>
          <button type="button" class="btn ghost small" data-act="task-detail-copy-cmd" ${row.cmd ? "" : "disabled"}>${icon("terminal", 12)} ${esc(t("task.copyCommand"))}</button>
        </footer>
      </aside>
    </div>`;
  root.querySelector<HTMLElement>('[data-act="task-detail-close"]')?.focus();
}

export function closeTaskDetail(): void {
  detailTaskId = null;
  document.getElementById("tm-detail-root")?.remove();
}

/** Updates the open drawer with the latest snapshot; closes it when the
 * process has exited. */
function refreshTaskDrawer(): void {
  const root = document.getElementById("tm-detail-root");
  if (!root || !detailTaskId) return;
  const row = snapshot.rows.find(
    (item) => item.id === detailTaskId && item.kind === "process",
  );
  if (!row) {
    closeTaskDetail();
    return;
  }
  const set = (selector: string, text: string): void => {
    const el = root.querySelector<HTMLElement>(selector);
    if (el) el.textContent = text;
  };
  set(".task-detail-cpu", `${row.cpu.toFixed(1)}%`);
  set(".task-detail-mem", formatTaskMb(row.memoryMb));
  set(".task-detail-uptime", formatTaskUptime(row.startedAt));
  set(".task-detail-parent", parentLabel(row));
  set(
    ".task-detail-total",
    t("task.detailDiskValue", {
      read: formatTaskMb(row.readMb),
      written: formatTaskMb(row.writtenMb),
    }),
  );
  const rate = root.querySelector<HTMLElement>(".task-detail-rate");
  if (rate) rate.innerHTML = diskCellHtml(row);
}

/* ---------- Confirmed actions ---------- */

async function endProcessById(id: string): Promise<void> {
  const row = snapshot.rows.find((item) => item.id === id && item.kind === "process");
  if (!row || !row.endable) return;
  const ok = await askConfirm({
    title: t("task.endProcess"),
    name: row.name,
    body: t("task.endProcessWarning"),
    confirm: t("task.endProcess"),
    cancel: t("common.cancel"),
  });
  if (!ok) return;
  try {
    await invoke("task_manager_end_process", { pid: row.pid, startedAt: row.startedAt });
    toast(t("task.endProcessDone", { name: row.name }), "ok");
    if (detailTaskId === id) closeTaskDetail();
    await refreshTasks(false);
    patchTaskRows();
  } catch (error) {
    toast(t("task.endProcessFailed", { error: localizeMessage(String(error)) }), "err");
  }
}

async function closeGame(): Promise<void> {
  const game = snapshot.games[0];
  if (!game) return;
  const ok = await askConfirm({
    title: t("task.closeGame"),
    name: game.title,
    body: t("task.closeGameWarning"),
    confirm: t("task.closeGame"),
    cancel: t("common.cancel"),
  });
  if (!ok) return;
  try {
    await invoke("task_manager_close_game");
    toast(t("task.closeGameDone", { name: game.title }), "ok");
    await refreshTasks(false);
    patchTaskRows();
  } catch (error) {
    toast(t("task.closeGameFailed", { error: localizeMessage(String(error)) }), "err");
  }
}

function copyText(text: string): void {
  if (!text) return;
  void navigator.clipboard
    .writeText(text)
    .then(() => toast(t("task.copied"), "ok"))
    .catch((error) => toast(String(error), "err"));
}

/* ---------- Actions ---------- */

/** The task manager's click actions, routed from the settings handler. */
export function handleTaskAction(act: string | undefined, el: HTMLElement, targetEl?: HTMLElement): boolean {
  switch (act) {
    case "task-refresh":
      void refreshTasks(false).then(() => patchTaskRows());
      return true;

    case "task-sort": {
      const key = el.dataset.key as SortKey | undefined;
      if (!key) return true;
      if (sortKey === key) sortAsc = !sortAsc;
      else {
        sortKey = key;
        sortAsc = key === "name";
      }
      render();
      return true;
    }

    case "task-toggle-group": {
      const key = el.dataset.group as GroupKey | undefined;
      if (!key || !(key in groupOpen)) return true;
      groupOpen = { ...groupOpen, [key]: !groupOpen[key] };
      saveGroups();
      render();
      return true;
    }

    case "task-toggle-idle":
      prefs = { ...prefs, hideIdle: !prefs.hideIdle };
      savePrefs();
      render();
      return true;

    case "task-toggle-pause":
      prefs = { ...prefs, paused: !prefs.paused };
      savePrefs();
      restartPolling();
      render();
      return true;

    case "task-interval": {
      const ms = Number(el.dataset.ms);
      if (ms !== 1000 && ms !== 2000 && ms !== 5000) return true;
      prefs = { ...prefs, intervalMs: ms };
      savePrefs();
      restartPolling();
      render();
      return true;
    }

    case "task-detail": {
      // The row is the button; its own controls must not open the card.
      if (targetEl?.closest('[data-act="task-stop"]')) return true;
      openTaskDetail(el.dataset.taskId ?? "");
      return true;
    }

    case "task-detail-close":
      closeTaskDetail();
      return true;

    case "task-detail-backdrop":
      if (targetEl === el) closeTaskDetail();
      return true;

    case "task-end-process": {
      const id = detailTaskId;
      if (id) void endProcessById(id);
      return true;
    }

    case "task-close-game":
      void closeGame();
      return true;

    case "task-detail-copy-path": {
      const row = snapshot.rows.find((item) => item.id === detailTaskId);
      if (row) copyText(row.exe);
      return true;
    }

    case "task-detail-copy-cmd": {
      const row = snapshot.rows.find((item) => item.id === detailTaskId);
      if (row) copyText(row.cmd || row.exe);
      return true;
    }

    case "task-detail-reveal": {
      const row = snapshot.rows.find((item) => item.id === detailTaskId);
      if (row?.exe) {
        void revealItemInDir(row.exe).catch((error) => toast(String(error), "err"));
      }
      return true;
    }

    case "task-stop": {
      const id = el.dataset.id ?? "";
      void invoke("task_manager_stop", { id })
        .then(() => {
          toast(t("task.stoppedToast", { name: t(`task.job.${id}`) }), "ok");
          void refreshTasks(false).then(() => patchTaskRows());
        })
        .catch((error) => {
          toast(t("task.stopFailed", { error: localizeMessage(String(error)) }), "err");
        });
      return true;
    }

    default:
      return false;
  }
}
