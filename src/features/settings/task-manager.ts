/**
 * Settings → Task manager.
 *
 * A stat strip with a one-minute sparkline per metric, the launcher's process
 * tree (the app, its own helper processes and a collapsible WebView2 group)
 * and the background jobs as a card grid. The section polls every two seconds
 * and patches numbers, bars, states and sparklines in place, so nothing jumps;
 * a process row opens its detail card.
 *
 * The data comes from `task_manager_snapshot` in one call: rows, the system's
 * memory size and the history the sparklines draw.
 */

import { invoke } from "@tauri-apps/api/core";
import { TM_EXPANDED_KEY, isTauri } from "../../core/constants";
import { icon, type IconName } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

/* ---------- Wire types ---------- */

interface TaskRow {
  id: string;
  kind: string;
  name: string;
  role: string;
  pid: number;
  cpu: number;
  memoryMb: number;
  readMb: number;
  writtenMb: number;
  exe: string;
  startedAt: number;
  cmd: string;
  running: boolean;
  stoppable: boolean;
}

interface TaskSnapshot {
  rows: TaskRow[];
  totalMemoryMb: number;
  cpuHistory: number[];
  memoryHistory: number[];
  jobsHistory: number[];
}

/* ---------- State ---------- */

const EMPTY: TaskSnapshot = {
  rows: [],
  totalMemoryMb: 0,
  cpuHistory: [],
  memoryHistory: [],
  jobsHistory: [],
};

let snapshot: TaskSnapshot = EMPTY;
let timer: number | null = null;
let loaded = false;

type SortKey = "memory" | "cpu" | "disk" | "name";
let sortKey: SortKey = "memory";
let sortAsc = false;
/** The WebView2 group starts collapsed; the choice sticks. */
let webviewOpen = localStorage.getItem(TM_EXPANDED_KEY) === "1";

/** Sparkline box, in SVG units (the CSS stretches it to the tile). */
const SPARK_W = 108;
const SPARK_H = 26;

/* ---------- Labels ---------- */

function taskRoleLabel(role: string): string {
  switch (role) {
    case "app": return t("task.roleApp");
    case "helper": return t("task.roleHelper");
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
function taskRoleIcon(role: string): IconName {
  switch (role) {
    case "helper": return "package";
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

function isWebviewRole(role: string): boolean {
  return role !== "app" && role !== "helper";
}

function processesOf(): TaskRow[] {
  return snapshot.rows.filter((row) => row.kind === "process");
}

function jobsOf(): TaskRow[] {
  return snapshot.rows.filter((row) => row.kind === "job");
}

/* ---------- Sparklines ---------- */

/** SVG points for a series, auto-scaled to its own range (shape over values). */
function sparkPoints(values: number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min > 0.0001 ? max - min : Math.max(Math.abs(max), 1) * 0.1;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const y = height - 3 - ((value - min) / span) * (height - 6);
      return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function sparkHtml(values: number[], cls: string): string {
  return `<svg class="tm-spark ${cls}" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${sparkPoints(values, SPARK_W, SPARK_H)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

/* ---------- Stat strip ---------- */

function statsHtml(): string {
  const processes = processesOf();
  const jobs = jobsOf();
  const totalCpu = processes.reduce((sum, row) => sum + row.cpu, 0);
  const totalMem = processes.reduce((sum, row) => sum + row.memoryMb, 0);
  const runningJobs = jobs.filter((row) => row.running).length;
  const share = snapshot.totalMemoryMb > 0 ? (totalMem / snapshot.totalMemoryMb) * 100 : 0;
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
        <span class="tm-stat-sub task-ram-sub">${esc(t("task.statRamSub", { count: String(processes.length), percent: share.toFixed(1) }))}</span>
        ${sparkHtml(snapshot.memoryHistory, "task-mem-spark")}
      </div>
      <div class="tm-stat">
        <span class="tm-stat-label">${icon("activity", 12)} ${esc(t("task.jobs"))}</span>
        <span class="tm-stat-value"><span class="task-jobs-count">${runningJobs}</span><span class="tm-stat-of"> / ${jobs.length}</span></span>
        <span class="tm-stat-sub">${esc(t("task.statJobsSub"))}</span>
        ${sparkHtml(snapshot.jobsHistory, "task-jobs-spark")}
      </div>
    </div>`;
}

/* ---------- Process table ---------- */

function sortRows(rows: TaskRow[]): TaskRow[] {
  const direction = sortAsc ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (sortKey) {
      case "cpu": return (a.cpu - b.cpu) * direction;
      case "disk": return (a.readMb + a.writtenMb - (b.readMb + b.writtenMb)) * direction;
      case "name": return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * direction;
      default: return (a.memoryMb - b.memoryMb) * direction;
    }
  });
  return sorted;
}

/** Read/written totals; `—` when the process never touched the disk. */
function diskCellHtml(row: TaskRow): string {
  if (row.readMb + row.writtenMb <= 0) {
    return `<span class="tm-num tm-disk-empty">—</span>`;
  }
  return `
    <span class="tm-num task-disk-read">↓ ${formatTaskMb(row.readMb)}</span>
    <span class="tm-num task-disk-write">↑ ${formatTaskMb(row.writtenMb)}</span>`;
}

/** One process line: role mark, the role as the title, the exe name and PID
 * under it, then CPU and memory with bars scaled to the biggest row. */
function processRowHtml(row: TaskRow, cpuPeak: number, memPeak: number): string {
  const isMain = row.role === "app";
  const title = isMain ? t("task.mainProcess") : taskRoleLabel(row.role);
  const cpuPct = Math.max(2, Math.round((row.cpu / cpuPeak) * 100));
  const memPct = Math.max(2, Math.round((row.memoryMb / memPeak) * 100));
  return `
    <div class="tm-row" data-task="${esc(row.id)}" data-act="task-detail" data-task-id="${esc(row.id)}" data-search="${esc(title)} ${esc(row.name)} PID ${row.pid}">
      <span class="tm-row-icon${isMain ? " is-main" : ""}">${icon(isMain ? "monitor" : taskRoleIcon(row.role), 14)}</span>
      <div class="tm-row-main">
        <div class="tm-row-title">${esc(title)}</div>
        <div class="tm-row-sub">
          ${isMain ? `<span class="tm-badge">${esc(t("task.roleApp"))}</span>` : ""}
          <span class="tm-row-exe">${esc(row.name)}</span>
          <span class="tm-sub-sep">·</span>
          <span>PID ${row.pid}</span>
        </div>
      </div>
      <div class="tm-metric" title="${esc(t("task.colCpu"))}">
        <span class="tm-bar"><span class="tm-bar-fill task-cpu-bar" style="width:${cpuPct}%"></span></span>
        <span class="tm-num task-cpu">${row.cpu.toFixed(1)}%</span>
      </div>
      <div class="tm-metric" title="${esc(t("task.colRam"))}">
        <span class="tm-bar"><span class="tm-bar-fill mem task-mem-bar" style="width:${memPct}%"></span></span>
        <span class="tm-num task-mem">${formatTaskMb(row.memoryMb)}</span>
      </div>
      <div class="tm-disk" title="${esc(t("task.detailDisk"))}">${diskCellHtml(row)}</div>
    </div>`;
}

/** The WebView2 children folded into one row: the list stays short and the
 * group's totals stay visible while collapsed. */
function webviewGroupHtml(rows: TaskRow[], cpuPeak: number, memPeak: number): string {
  const memory = rows.reduce((sum, row) => sum + row.memoryMb, 0);
  const cpu = rows.reduce((sum, row) => sum + row.cpu, 0);
  return `
    <button type="button" class="tm-group" data-act="task-toggle-webview" aria-expanded="${webviewOpen ? "true" : "false"}">
      <span class="tm-group-chevron">${icon(webviewOpen ? "chevron-down" : "chevron-right", 14)}</span>
      <span class="tm-group-title">WebView2<span class="tm-group-meta"><span class="task-webview-count">${rows.length}</span> ${esc(t("task.processCount"))}</span></span>
      <span class="tm-num task-webview-cpu">${cpu.toFixed(1)}%</span>
      <span class="tm-num task-webview-mem">${formatTaskMb(memory)}</span>
      <span></span>
    </button>
    <div class="tm-group-rows"${webviewOpen ? "" : " hidden"}>
      ${sortRows(rows).map((row) => processRowHtml(row, cpuPeak, memPeak)).join("")}
    </div>`;
}

function theadHtml(): string {
  const sortButton = (key: SortKey, label: string): string => {
    const active = sortKey === key;
    return `<button type="button" class="tm-sort${active ? " active" : ""}" data-act="task-sort" data-key="${key}">
      <span>${esc(label)}</span>${active ? icon(sortAsc ? "chevron-up" : "chevron-down", 11) : ""}
    </button>`;
  };
  return `
    <div class="tm-thead">
      <span></span>
      <span>${esc(t("task.colProcess"))}</span>
      ${sortButton("cpu", t("task.colCpu"))}
      ${sortButton("memory", t("task.colRam"))}
      ${sortButton("disk", t("task.colDisk"))}
    </div>`;
}

function processTableHtml(): string {
  const processes = processesOf();
  if (processes.length === 0) {
    return `<div class="list settings-group tm-table"><div class="tm-empty">${esc(t("task.loading"))}</div></div>`;
  }
  const main = processes.find((row) => row.role === "app");
  const helpers = processes.filter((row) => row.role === "helper");
  const webview = processes.filter((row) => isWebviewRole(row.role));
  const cpuPeak = Math.max(...processes.map((row) => row.cpu), 0.1);
  const memPeak = Math.max(...processes.map((row) => row.memoryMb), 1);
  return `
    <div class="list settings-group tm-table">
      ${theadHtml()}
      ${main ? processRowHtml(main, cpuPeak, memPeak) : ""}
      ${sortRows(helpers).map((row) => processRowHtml(row, cpuPeak, memPeak)).join("")}
      ${webview.length ? webviewGroupHtml(webview, cpuPeak, memPeak) : ""}
    </div>`;
}

/* ---------- Jobs ---------- */

/** One background job: mark, name, live dot, and the stop action when stopping
 * is safe. Jobs are threads, so they carry no CPU or memory of their own. */
function jobRowHtml(row: TaskRow): string {
  const name = t(`task.job.${row.id}`);
  return `
    <div class="tm-job${row.running ? " is-running" : ""}" data-task="${esc(row.id)}" data-search="${esc(name)}">
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

function jobsGridHtml(): string {
  const jobs = jobsOf();
  if (jobs.length === 0) {
    return `<div class="settings-group tm-jobs"><div class="tm-empty">${esc(t("task.loading"))}</div></div>`;
  }
  return `<div class="settings-group tm-jobs">${jobs.map(jobRowHtml).join("")}</div>`;
}

/* ---------- Section ---------- */

export function renderTasks(): string {
  if (!isTauri) {
    return `<div class="info-box">${icon("info", 14)}<span>${t("task.desktopOnly")}</span></div>`;
  }
  if (!loaded) {
    loaded = true;
    void refreshTasks();
  }
  ensurePolling();
  return `
    <div class="info-box">${icon("info", 14)}<span>${t("task.info")}</span></div>
    ${statsHtml()}
    <h3 class="section-title">${t("task.processes")}</h3>
    ${processTableHtml()}
    <h3 class="section-title">${t("task.jobs")}</h3>
    ${jobsGridHtml()}
    <div class="tm-foot">
      <span class="tm-updated">${esc(t("task.autoRefresh"))}</span>
      <button type="button" class="btn ghost small" data-act="task-refresh">${icon("refresh", 13)} ${t("task.refresh")}</button>
    </div>`;
}

export async function refreshTasks(repaint = true): Promise<void> {
  if (!isTauri) return;
  try {
    snapshot = await invoke<TaskSnapshot>("task_manager_snapshot");
  } catch {
    // Keep the last snapshot: a failed poll must not blank the panel.
  }
  if (repaint && S.view === "settings" && S.settingsSection === "tasks") render();
}

/** Polls while the section is on screen; patches numbers in place. The
 * interval stops itself when the section is left. */
function ensurePolling(): void {
  if (timer !== null) return;
  timer = window.setInterval(() => {
    if (S.view !== "settings" || S.settingsSection !== "tasks") {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      return;
    }
    void refreshTasks(false).then(() => patchTaskRows());
  }, 2000);
}

function patchSpark(panel: HTMLElement, cls: string, values: number[]): void {
  const line = panel.querySelector<SVGPolylineElement>(`.${cls} polyline`);
  if (line) line.setAttribute("points", sparkPoints(values, SPARK_W, SPARK_H));
}

/** Live patch: numbers, bars, states, group totals and sparklines update in
 * place; a changed row set repaints the section. */
function patchTaskRows(): void {
  const panel = document.querySelector<HTMLElement>(".settings-panel");
  if (!panel) return;
  const processes = processesOf();
  const jobs = jobsOf();
  const cpuPeak = Math.max(...processes.map((row) => row.cpu), 0.1);
  const memPeak = Math.max(...processes.map((row) => row.memoryMb), 1);
  const known = new Set<string>();
  for (const row of snapshot.rows) {
    known.add(row.id);
    const el = panel.querySelector<HTMLElement>(`[data-task="${CSS.escape(row.id)}"]`);
    if (!el) {
      render();
      return;
    }
    const cpu = el.querySelector<HTMLElement>(".task-cpu");
    if (cpu) cpu.textContent = `${row.cpu.toFixed(1)}%`;
    const cpuBar = el.querySelector<HTMLElement>(".task-cpu-bar");
    if (cpuBar) cpuBar.style.width = `${Math.max(2, Math.round((row.cpu / cpuPeak) * 100))}%`;
    const mem = el.querySelector<HTMLElement>(".task-mem");
    if (mem) mem.textContent = formatTaskMb(row.memoryMb);
    const memBar = el.querySelector<HTMLElement>(".task-mem-bar");
    if (memBar) memBar.style.width = `${Math.max(2, Math.round((row.memoryMb / memPeak) * 100))}%`;
    const disk = el.querySelector<HTMLElement>(".tm-disk");
    if (disk) disk.innerHTML = diskCellHtml(row);
    const status = el.querySelector<HTMLElement>(".task-status");
    if (status) status.textContent = row.running ? t("task.running") : t("task.stopped");
    el.classList.toggle("is-running", row.running);
    const dot = el.querySelector<HTMLElement>(".tm-dot");
    if (dot) dot.classList.toggle("on", row.running);
    const stop = el.querySelector<HTMLButtonElement>('[data-act="task-stop"]');
    if (stop) stop.disabled = !row.running;
  }

  // Totals and the group header drift with the rows.
  const totalCpu = processes.reduce((sum, row) => sum + row.cpu, 0);
  const totalMem = processes.reduce((sum, row) => sum + row.memoryMb, 0);
  const share = snapshot.totalMemoryMb > 0 ? (totalMem / snapshot.totalMemoryMb) * 100 : 0;
  const cpuTotal = panel.querySelector<HTMLElement>(".task-total-cpu");
  if (cpuTotal) cpuTotal.textContent = `${totalCpu.toFixed(1)}%`;
  const memTotal = panel.querySelector<HTMLElement>(".task-total-mem");
  if (memTotal) memTotal.textContent = formatTaskMb(totalMem);
  const memSystem = panel.querySelector<HTMLElement>(".task-mem-total");
  if (memSystem) memSystem.textContent = ` / ${formatTaskMb(snapshot.totalMemoryMb)}`;
  const ramSub = panel.querySelector<HTMLElement>(".task-ram-sub");
  if (ramSub) {
    ramSub.textContent = t("task.statRamSub", {
      count: String(processes.length),
      percent: share.toFixed(1),
    });
  }
  const jobsCount = panel.querySelector<HTMLElement>(".task-jobs-count");
  if (jobsCount) jobsCount.textContent = String(jobs.filter((row) => row.running).length);
  const webviewRows = processes.filter((row) => isWebviewRole(row.role));
  const webviewCount = panel.querySelector<HTMLElement>(".task-webview-count");
  if (webviewCount) webviewCount.textContent = String(webviewRows.length);
  const webviewCpu = panel.querySelector<HTMLElement>(".task-webview-cpu");
  if (webviewCpu) {
    webviewCpu.textContent = `${webviewRows.reduce((sum, row) => sum + row.cpu, 0).toFixed(1)}%`;
  }
  const webviewMem = panel.querySelector<HTMLElement>(".task-webview-mem");
  if (webviewMem) {
    webviewMem.textContent = formatTaskMb(webviewRows.reduce((sum, row) => sum + row.memoryMb, 0));
  }
  patchSpark(panel, "task-cpu-spark", snapshot.cpuHistory);
  patchSpark(panel, "task-mem-spark", snapshot.memoryHistory);
  patchSpark(panel, "task-jobs-spark", snapshot.jobsHistory);

  const shown = [...panel.querySelectorAll<HTMLElement>("[data-task]")].map((el) => el.dataset.task ?? "");
  if (shown.length !== known.size || shown.some((id) => !known.has(id))) render();
}

/* ---------- Detail card ---------- */

/** The row's detail card: paths, start time and the command line. */
function openTaskDetail(id: string): void {
  const row = snapshot.rows.find((item) => item.id === id);
  if (!row || row.kind !== "process") return;
  let root = document.getElementById("tm-detail-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "tm-detail-root";
    document.body.appendChild(root);
  }
  const started = row.startedAt > 0 ? new Date(row.startedAt * 1000).toLocaleString() : "—";
  const fields: [string, string][] = [
    [t("task.colProcess"), esc(row.name)],
    [t("task.detailRole"), esc(row.role === "app" ? t("task.roleApp") : taskRoleLabel(row.role))],
    ["PID", String(row.pid)],
    [t("task.detailStarted"), esc(started)],
    [t("task.colCpu"), `${row.cpu.toFixed(1)}%`],
    [t("task.colRam"), formatTaskMb(row.memoryMb)],
    [
      t("task.detailDisk"),
      esc(t("task.detailDiskValue", { read: formatTaskMb(row.readMb), written: formatTaskMb(row.writtenMb) })),
    ],
  ];
  root.innerHTML = `
    <div class="modal-backdrop" data-act="task-detail-backdrop">
      <div class="modal tm-detail-card" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2 class="modal-title">${esc(row.role === "app" ? t("task.mainProcess") : taskRoleLabel(row.role))}</h2>
          <button type="button" class="manage-head-close" data-act="task-detail-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </div>
        <div class="tm-detail-body">
          <dl class="tm-detail-grid">
            ${fields
              .map(
                ([label, value]) =>
                  `<div class="tm-detail-field"><dt>${esc(label)}</dt><dd>${value}</dd></div>`,
              )
              .join("")}
          </dl>
          <div class="tm-detail-block">
            <div class="tm-detail-label">${esc(t("task.detailExe"))}</div>
            <code class="tm-detail-code">${esc(row.exe || "—")}</code>
          </div>
          <div class="tm-detail-block">
            <div class="tm-detail-label">${esc(t("task.detailCmd"))}</div>
            <code class="tm-detail-code tm-detail-cmd">${esc(row.cmd || "—")}</code>
          </div>
        </div>
      </div>
    </div>`;
}

export function closeTaskDetail(): void {
  document.getElementById("tm-detail-root")?.remove();
}

/* ---------- Actions ---------- */

/** The task manager's click actions, routed from the settings handler. */
export function handleTaskAction(act: string | undefined, el: HTMLElement, targetEl?: HTMLElement): boolean {
  switch (act) {
    case "task-refresh":
      void refreshTasks();
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

    case "task-toggle-webview":
      webviewOpen = !webviewOpen;
      localStorage.setItem(TM_EXPANDED_KEY, webviewOpen ? "1" : "0");
      render();
      return true;

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

    case "task-stop": {
      const id = el.dataset.id ?? "";
      void invoke("task_manager_stop", { id })
        .then(() => {
          toast(t("task.stoppedToast", { name: t(`task.job.${id}`) }), "ok");
          void refreshTasks();
        })
        .catch((error) => {
          toast(t("task.stopFailed", { error: String(error) }), "err");
        });
      return true;
    }

    default:
      return false;
  }
}
