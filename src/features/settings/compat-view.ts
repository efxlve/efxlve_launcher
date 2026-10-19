/**
 * Settings > Compatibility: the Linux/macOS runtime toolbox.
 *
 * Windows plays its games directly; Linux and macOS need a Wine/Proton runner,
 * a prefix and often DXVK/VKD3D. The backend owns the catalogue and downloads;
 * this file renders it, remembers which platform the user is preparing for, and
 * patches a download's progress bar in place (no full repaint per chunk).
 *
 * The target selector is deliberate: on a Windows build it still lets the user
 * stage a `linux-x86_64` or `macos-aarch64` tree, which is how the cross-platform
 * work is prepared before those bundles exist.
 */

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { askConfirm } from "../../core/confirm-dialog";
import { icon } from "../../core/icons";
import { localizeMessage, t } from "../../i18n";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { epicOpenFolderPath, epicSelectFolderDialog } from "../../epic";
import {
  compatCancel,
  compatCatalog,
  compatGetLaunchConfig,
  compatInstall,
  compatRemove,
  compatSetLaunchConfig,
  compatToolsDir,
  type CompatCatalog,
  type CompatLaunchConfig,
  type CompatProgress,
  type CompatToolInfo,
} from "../../compat";

const TARGET_KEY = "efxlve-compat-target";

const NAMES: Record<string, string> = {
  legendary: "Legendary",
  gogdl: "GOGdl",
  nile: "Nile",
  comet: "Comet",
  "ge-proton": "GE-Proton",
  "proton-cachyos": "Proton-CachyOS",
  "umu-launcher": "umu-launcher",
  dxvk: "DXVK",
  "vkd3d-proton": "VKD3D-Proton",
  "game-porting-toolkit": "Game Porting Toolkit",
  "wine-staging": "Wine-Staging",
  "wine-crossover": "CrossOver (Wine-CX)",
  "dxvk-macos": "DXVK-macOS",
  dxmt: "DXMT",
  "heroic-epic-integration": "Heroic Epic Integration",
  "vulkan-helper-rs": "vulkan-helper-rs",
};

const GROUP_ORDER = ["store", "runner", "runtime", "translation", "helper"];
const GROUP_KEYS: Record<string, string> = {
  store: "compat.groupStores",
  runner: "compat.groupRunners",
  runtime: "compat.groupRuntimes",
  translation: "compat.groupTranslations",
  helper: "compat.groupHelpers",
};
const KIND_KEYS: Record<string, string> = {
  store: "compat.kind.store",
  runner: "compat.kind.runner",
  runtime: "compat.kind.runtime",
  translation: "compat.kind.translation",
  helper: "compat.kind.helper",
};

let catalog: CompatCatalog | null = null;
let launchConfig: CompatLaunchConfig | null = null;
let loading = false;
let refreshing = false;
let listenerBound = false;
/** Ignores a catalogue answer that belongs to a target the user already left. */
let loadGeneration = 0;
let target = readTarget();
const progress = new Map<string, CompatProgress>();

function readTarget(): string {
  try {
    const saved = localStorage.getItem(TARGET_KEY);
    if (saved && (saved === "current" || /^(windows|linux|macos)-(x86_64|aarch64)$/.test(saved))) {
      return saved;
    }
  } catch {
    // Storage blocked: this PC is still the safe default.
  }
  return "current";
}

function toolName(id: string): string {
  return NAMES[id] ?? id;
}

function toolOf(id: string): CompatToolInfo | undefined {
  return catalog?.tools.find((tool) => tool.id === id);
}

function targetOptions(): Array<{ value: string; label: string }> {
  const options = [
    { value: "current", label: t("compat.targetCurrent") },
    { value: "linux-x86_64", label: "Linux x86_64" },
    { value: "linux-aarch64", label: "Linux aarch64" },
    { value: "macos-x86_64", label: "macOS x86_64" },
    { value: "macos-aarch64", label: "macOS aarch64" },
  ];
  if (catalog && !(catalog.currentOs === "windows" && catalog.currentArch === "x86_64")) {
    options.unshift({ value: "windows-x86_64", label: "Windows x86_64" });
  }
  return options;
}

function badges(tool: CompatToolInfo): string {
  const chips: string[] = [];
  for (const platform of tool.platforms) {
    chips.push(`<span class="compat-chip">${esc(t(`compat.os.${platform}`))}</span>`);
  }
  return chips.join("");
}

function statusLine(tool: CompatToolInfo): string {
  if (tool.installed.length > 0) {
    const tag = tool.installed[0].tag;
    return `<span class="compat-state ok">${icon("check", 11)} ${esc(tag === "managed" ? t("compat.managedByApp") : tag)}</span>`;
  }
  if (tool.detected.length > 0) {
    return `<span class="compat-state">${icon("search", 11)} ${esc(t("compat.detected", { count: String(tool.detected.length) }))}</span>`;
  }
  if (!tool.supported) {
    return `<span class="compat-state muted">${esc(t("compat.notForTarget"))}</span>`;
  }
  return `<span class="compat-state muted">${esc(t("compat.notInstalled"))}</span>`;
}

function latestLine(tool: CompatToolInfo): string {
  if (!tool.latest) {
    return tool.source === "external" ? `<span class="compat-meta">${esc(t("compat.externalOnly"))}</span>` : "";
  }
  return `<span class="compat-meta">${esc(t("compat.latest", { tag: tool.latest.tag, size: fmtBytes(tool.latest.size) }))}</span>`;
}

function actions(tool: CompatToolInfo): string {
  const running = progress.has(tool.id);
  if (running) {
    return `<button type="button" class="btn ghost small" data-act="compat-cancel" data-id="${esc(tool.id)}">${esc(t("compat.cancel"))}</button>`;
  }
  const parts: string[] = [];
  if (tool.installable && tool.supported) {
    const label =
      tool.installed.length > 0
        ? t("compat.update")
        : tool.source === "module"
          ? t("compat.prepare")
          : t("compat.install");
    parts.push(
      `<button type="button" class="btn primary small" data-act="compat-install" data-id="${esc(tool.id)}">${esc(label)}</button>`,
    );
  }
  if (tool.removable) {
    parts.push(
      `<button type="button" class="btn ghost small" data-act="compat-remove" data-id="${esc(tool.id)}">${esc(t("compat.remove"))}</button>`,
    );
  }
  if (tool.homepage) {
    parts.push(
      `<button type="button" class="btn ghost small" data-act="open-external-url" data-url="${esc(tool.homepage)}">${icon("external", 12)} ${esc(t("compat.projectPage"))}</button>`,
    );
  }
  return parts.join("");
}

function progressBar(tool: CompatToolInfo): string {
  const entry = progress.get(tool.id);
  const percent = entry ? Math.max(0, Math.min(100, Math.round(entry.percent))) : 0;
  const label = entry
    ? entry.phase === "extract"
      ? t("compat.extracting")
      : t("compat.downloading", { p: String(percent) })
    : "";
  return `
    <div class="compat-progress-wrap" data-compat-progress="${esc(tool.id)}"${entry ? "" : " hidden"}>
      <div class="compat-progress"><span style="width:${percent}%"></span></div>
      <span class="compat-progress-label">${esc(label)}</span>
    </div>`;
}

function renderTool(tool: CompatToolInfo): string {
  const search = `${toolName(tool.id)} ${tool.kind} ${tool.repo}`;
  return `
    <div class="row settings-row compat-tool" data-search="${esc(search)}">
      <div class="row-main">
        <div class="settings-row-title">${esc(toolName(tool.id))}</div>
        <div class="settings-row-desc">${esc(t(KIND_KEYS[tool.kind] ?? "compat.kind.helper"))}${tool.repo ? ` · <code>${esc(tool.repo)}</code>` : ""}</div>
        <div class="compat-badges">${badges(tool)}</div>
        <div class="compat-status">${statusLine(tool)}${latestLine(tool)}</div>
        ${progressBar(tool)}
      </div>
      <div class="settings-row-control">${actions(tool)}</div>
    </div>`;
}

function renderGroups(): string {
  if (!catalog) {
    return `<div class="settings-group"><div class="row settings-row"><div class="row-main"><div class="settings-row-desc">${esc(t(loading ? "compat.loading" : "compat.empty"))}</div></div></div></div>`;
  }
  return GROUP_ORDER.map((kind) => {
    const tools = catalog?.tools.filter((tool) => tool.kind === kind) ?? [];
    if (tools.length === 0) return "";
    return `<h3 class="section-title">${esc(t(GROUP_KEYS[kind] ?? "compat.groupHelpers"))}</h3>
      <div class="list settings-group">${tools.map(renderTool).join("")}</div>`;
  }).join("");
}

function detectedOptionValue(id: string, path: string): string {
  return `@path:${id}:${path}`;
}

function parseRunnerValue(value: string): { runner: string | null; runnerPath: string | null } {
  if (!value) return { runner: null, runnerPath: null };
  if (value.startsWith("@path:")) {
    const rest = value.slice(6);
    const separator = rest.indexOf(":");
    if (separator > 0) {
      return { runner: rest.slice(0, separator), runnerPath: rest.slice(separator + 1) };
    }
  }
  return { runner: value, runnerPath: null };
}

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function runnerOptions(): Array<{ value: string; label: string }> {
  const options = [{ value: "", label: t("compat.runnerNone") }];
  const runners = catalog?.tools.filter((tool) => tool.kind === "runner" && tool.installed.length > 0) ?? [];
  for (const runner of runners) {
    options.push({ value: runner.id, label: `${toolName(runner.id)} · ${runner.installed[0].tag}` });
  }
  // Runners found in Steam's compatibilitytools.d, Lutris or a system Wine
  // install are usable too; the path is what tells them apart.
  if (catalog && catalog.target === `${catalog.currentOs}-${catalog.currentArch}`) {
    for (const runner of catalog.tools) {
      if (runner.kind !== "runner") continue;
      for (const path of runner.detected) {
        const value = detectedOptionValue(runner.id, path);
        if (!options.some((option) => option.value === value)) {
          options.push({ value, label: `${toolName(runner.id)} · ${pathName(path)}` });
        }
      }
    }
  }
  // A saved runner can disappear when its folder is removed; keep it visible so
  // the select still says what the setting points at.
  const configured = launchConfig?.runner;
  if (configured && launchConfig?.runnerPath) {
    const value = detectedOptionValue(configured, launchConfig.runnerPath);
    if (!options.some((option) => option.value === value)) {
      options.push({
        value,
        label: `${toolName(configured)} · ${pathName(launchConfig.runnerPath)}`,
      });
    }
  } else if (configured && !runners.some((runner) => runner.id === configured)) {
    options.push({
      value: configured,
      label: `${toolName(configured)} · ${t("compat.notInstalled")}`,
    });
  }
  return options;
}

function selectedRunnerValue(): string {
  const config = launchConfig;
  if (!config?.runner) return "";
  return config.runnerPath
    ? detectedOptionValue(config.runner, config.runnerPath)
    : config.runner;
}

function selectedRunnerTags(): Array<{ value: string; label: string }> {
  const id = launchConfig?.runner;
  if (!id || launchConfig?.runnerPath) return [];
  return toolOf(id)?.installed.map((entry) => ({ value: entry.tag, label: entry.tag })) ?? [];
}

function renderLaunchConfig(): string {
  if (!catalog) return "";
  const currentKey = `${catalog.currentOs}-${catalog.currentArch}`;
  if (catalog.target !== currentKey) {
    return `<h3 class="section-title">${esc(t("compat.launchTitle"))}</h3>
      <div class="info-box">${icon("info", 14)}<span>${esc(t("compat.launchOtherTarget"))}</span></div>`;
  }
  const umu = toolOf("umu-launcher");
  const config = launchConfig;
  const runner = config?.runner ?? "";
  const runnerTag = config?.runnerTag ?? "";
  const selectedValue = selectedRunnerValue();
  const prefix = config?.prefixDir ?? "";
  const umuAvailable = Boolean(umu && (umu.installed.length > 0 || umu.detected.length > 0));
  return `
    <h3 class="section-title">${esc(t("compat.launchTitle"))}</h3>
    <div class="list settings-group">
      <div class="row settings-row" data-search="runner wine proton prefix">
        <div class="row-main">
          <div class="settings-row-title">${esc(t("compat.runner"))}</div>
          <div class="settings-row-desc">${esc(t("compat.runnerHint"))}${
            config?.runnerPath ? ` <code>${esc(config.runnerPath)}</code>` : ""
          }</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-act="compat-runner" aria-label="${esc(t("compat.runner"))}">
            ${runnerOptions()
              .map((option) => `<option value="${esc(option.value)}"${option.value === selectedValue ? " selected" : ""}>${esc(option.label)}</option>`)
              .join("")}
          </select>
        </div>
      </div>
      ${
        runner && selectedRunnerTags().length > 0
          ? `<div class="row settings-row">
              <div class="row-main"><div class="settings-row-title">${esc(t("compat.runnerVersion"))}</div></div>
              <div class="settings-row-control">
                <select class="settings-select" data-act="compat-runner-tag" aria-label="${esc(t("compat.runnerVersion"))}">
                  ${selectedRunnerTags()
                    .map((option) => `<option value="${esc(option.value)}"${option.value === runnerTag ? " selected" : ""}>${esc(option.label)}</option>`)
                    .join("")}
                </select>
              </div>
            </div>`
          : ""
      }
      <div class="row settings-row" data-search="prefix wine proton">
        <div class="row-main">
          <div class="settings-row-title">${esc(t("compat.prefix"))}</div>
          <div class="settings-row-desc">${esc(t("compat.prefixHint"))}</div>
        </div>
        <div class="settings-row-control">
          <input id="compat-prefix-dir" class="input settings-path-input" value="${esc(prefix)}" spellcheck="false" autocomplete="off" />
          <button type="button" class="btn ghost small" data-act="compat-prefix-pick">${esc(t("common.browse"))}</button>
          <button type="button" class="btn primary small" data-act="compat-prefix-save">${esc(t("common.save"))}</button>
        </div>
      </div>
      ${
        umuAvailable
          ? `<div class="row settings-row">
              <div class="row-main">
                <div class="settings-row-title">${esc(t("compat.umu"))}</div>
                <div class="settings-row-desc">${esc(t("compat.umuHint"))}</div>
              </div>
              <div class="settings-row-control">
                <label class="switch"><input type="checkbox" data-act="compat-umu"${config?.umuEnabled ? " checked" : ""} /><span class="track"></span></label>
              </div>
            </div>`
          : ""
      }
      <div class="row settings-row">
        <div class="row-main">
          <div class="settings-row-desc">${esc(t("compat.toolsFolderHint"))}</div>
        </div>
        <div class="settings-row-control">
          <button type="button" class="btn ghost small" data-act="compat-open-tools">${icon("folder", 13)} ${esc(t("compat.toolsFolder"))}</button>
        </div>
      </div>
    </div>`;
}

export function renderCompatSection(): string {
  const options = targetOptions();
  return `
    <div class="settings-section-head">
      <h3 class="section-title">${esc(t("settings.secCompat"))}</h3>
      <button type="button" class="btn ghost small" data-act="compat-refresh"${refreshing ? " disabled" : ""}>
        ${icon("refresh", 13)} ${esc(refreshing ? t("compat.refreshing") : t("compat.refresh"))}
      </button>
    </div>
    <div class="info-box">${icon("info", 14)}<span>${esc(t("compat.prepHint"))}</span></div>
    <div class="list settings-group">
      <div class="row settings-row" data-search="target platform linux macos">
        <div class="row-main">
          <div class="settings-row-title">${esc(t("compat.target"))}</div>
          <div class="settings-row-desc">${esc(t("compat.targetHint"))}</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-act="compat-target" aria-label="${esc(t("compat.target"))}">
            ${options
              .map((option) => `<option value="${esc(option.value)}"${option.value === target ? " selected" : ""}>${esc(option.label)}</option>`)
              .join("")}
          </select>
        </div>
      </div>
    </div>
    ${renderGroups()}
    ${renderLaunchConfig()}`;
}

function bindListener(): void {
  if (!isTauri || listenerBound) return;
  listenerBound = true;
  void listen<CompatProgress>("compat-progress", (event) => {
    const entry = event.payload;
    progress.set(entry.id, entry);
    patchProgress(entry);
    if (entry.phase === "done") {
      progress.delete(entry.id);
      void loadCompatView(true);
    }
  });
}

function patchProgress(entry: CompatProgress): void {
  const host = document.querySelector<HTMLElement>(
    `[data-compat-progress="${CSS.escape(entry.id)}"]`,
  );
  if (!host) return;
  host.hidden = false;
  const bar = host.querySelector<HTMLElement>(".compat-progress > span");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, Math.round(entry.percent)))}%`;
  const label = host.querySelector<HTMLElement>(".compat-progress-label");
  if (label) {
    label.textContent =
      entry.phase === "extract"
        ? t("compat.extracting")
        : t("compat.downloading", { p: String(Math.round(entry.percent)) });
  }
}

/**
 * Loads the inventory and the launch config. The first paint is local (the
 * catalogue is static); a stale release cache refreshes in the background.
 */
export async function loadCompatView(force = false): Promise<void> {
  if (!isTauri) {
    loading = false;
    scheduleRender();
    return;
  }
  bindListener();
  if (loading && !force) return;
  if (catalog && !force) {
    scheduleRender();
    return;
  }
  const generation = ++loadGeneration;
  loading = true;
  scheduleRender();
  try {
    const [nextCatalog, nextConfig] = await Promise.all([
      compatCatalog(target, false),
      compatGetLaunchConfig().catch(() => null),
    ]);
    if (generation !== loadGeneration) return;
    catalog = nextCatalog;
    launchConfig = nextConfig;
  } catch (error) {
    if (generation !== loadGeneration) return;
    catalog = null;
    toast(localizeMessage(String(error)), "err");
  } finally {
    if (generation === loadGeneration) {
      loading = false;
      scheduleRender();
    }
  }
  if (generation === loadGeneration && catalog?.stale && !refreshing && !S.offlineMode) {
    void refreshCatalog();
  }
}

async function refreshCatalog(): Promise<void> {
  if (!isTauri || refreshing || S.offlineMode) return;
  const generation = loadGeneration;
  const requestedTarget = target;
  refreshing = true;
  scheduleRender();
  try {
    const next = await compatCatalog(requestedTarget, true);
    if (generation === loadGeneration && requestedTarget === target) catalog = next;
  } catch (error) {
    // A rate limit or an offline machine keeps the cached rows; the page does
    // not need a red banner for a version check that can wait.
    if (generation === loadGeneration && requestedTarget === target) {
      toast(localizeMessage(String(error)), "err");
    }
  } finally {
    refreshing = false;
    scheduleRender();
  }
}

async function saveLaunchConfig(next: CompatLaunchConfig): Promise<void> {
  launchConfig = next;
  scheduleRender();
  try {
    await compatSetLaunchConfig(next);
  } catch (error) {
    toast(localizeMessage(String(error)), "err");
  }
}

function baseConfig(): CompatLaunchConfig {
  return (
    launchConfig ?? {
      runner: null,
      runnerTag: null,
      runnerPath: null,
      prefixDir: "",
      umuEnabled: true,
    }
  );
}

/** Opens the install confirmation only for archives large enough to matter. */
async function confirmInstall(tool: CompatToolInfo): Promise<boolean> {
  const size = tool.latest?.size ?? 0;
  if (size < 100 * 1024 * 1024) return true;
  return askConfirm({
    title: t("compat.confirmTitle"),
    name: toolName(tool.id),
    body: t("compat.confirmBody", { size: fmtBytes(size) }),
    confirm: t("compat.install"),
    cancel: t("common.cancel"),
  });
}

export function handleCompatAction(act: string | undefined, el: HTMLElement): boolean {
  if (!act?.startsWith("compat-")) return false;
  if (act === "compat-target") {
    const value = (el as HTMLSelectElement).value;
    target = value;
    try {
      localStorage.setItem(TARGET_KEY, value);
    } catch {
      // The in-memory choice still applies for this session.
    }
    catalog = null;
    void loadCompatView(true);
    return true;
  }
  if (act === "compat-refresh") {
    void refreshCatalog();
    return true;
  }
  if (act === "compat-install") {
    const tool = toolOf(el.dataset.id ?? "");
    if (!tool) return true;
    void (async () => {
      if (!(await confirmInstall(tool))) return;
      progress.set(tool.id, { id: tool.id, phase: "download", percent: 0, downloaded: 0, total: tool.latest?.size ?? 0 });
      scheduleRender();
      try {
        await compatInstall(tool.id, target);
        toast(t("compat.done"), "ok");
        await loadCompatView(true);
      } catch (error) {
        const message = String(error);
        if (message === "@t:compat.cancelled") toast(t("compat.cancelled"), "");
        else toast(localizeMessage(message), "err");
      } finally {
        progress.delete(tool.id);
        scheduleRender();
      }
    })();
    return true;
  }
  if (act === "compat-cancel") {
    const id = el.dataset.id ?? "";
    if (id) void compatCancel(id).catch(() => undefined);
    return true;
  }
  if (act === "compat-remove") {
    const tool = toolOf(el.dataset.id ?? "");
    if (!tool) return true;
    void (async () => {
      const ok = await askConfirm({
        title: t("compat.removeTitle"),
        name: toolName(tool.id),
        body: t("compat.removeBody"),
        confirm: t("compat.remove"),
        cancel: t("common.cancel"),
      });
      if (!ok) return;
      try {
        await compatRemove(tool.id, target);
        toast(t("compat.removed"), "ok");
        await loadCompatView(true);
      } catch (error) {
        toast(localizeMessage(String(error)), "err");
      }
    })();
    return true;
  }
  if (act === "compat-open-tools") {
    void compatToolsDir()
      .then((path) => epicOpenFolderPath(path))
      .catch(() => undefined);
    return true;
  }
  if (act === "compat-runner") {
    const parsed = parseRunnerValue((el as HTMLSelectElement).value);
    const config = baseConfig();
    void saveLaunchConfig({
      ...config,
      runner: parsed.runner,
      runnerPath: parsed.runnerPath,
      runnerTag: null,
    });
    return true;
  }
  if (act === "compat-runner-tag") {
    const value = (el as HTMLSelectElement).value;
    const config = baseConfig();
    void saveLaunchConfig({ ...config, runnerTag: value || null });
    return true;
  }
  if (act === "compat-umu") {
    const enabled = (el as HTMLInputElement).checked;
    const config = baseConfig();
    void saveLaunchConfig({ ...config, umuEnabled: enabled });
    return true;
  }
  if (act === "compat-prefix-pick") {
    void (async () => {
      const picked = await epicSelectFolderDialog(baseConfig().prefixDir || null, t("compat.prefix"));
      if (!picked) return;
      const config = baseConfig();
      await saveLaunchConfig({ ...config, prefixDir: picked });
    })();
    return true;
  }
  if (act === "compat-prefix-save") {
    const input = document.getElementById("compat-prefix-dir") as HTMLInputElement | null;
    const value = input?.value.trim() ?? "";
    const config = baseConfig();
    void saveLaunchConfig({ ...config, prefixDir: value });
    return true;
  }
  return true;
}

/** The section remembers its data; a reload after an account change is explicit. */
export function resetCompatView(): void {
  catalog = null;
  launchConfig = null;
  progress.clear();
}
