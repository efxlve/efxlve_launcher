/**
 * Per-game compatibility override on the game page's System tab.
 *
 * The global runner lives in Settings → Compatibility; this card only stores an
 * exception for the open title. A game that needs an older Proton build (or a
 * runner outside the launcher's folder) can keep it without changing every
 * other launch. The runner list and option encoding are the same ones the
 * Settings page uses.
 */

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { epicSelectFolderDialog, type EpicSummary } from "../../epic";
import {
  compatCatalog,
  compatGameDiagnostics,
  compatGamePrefixState,
  compatGetGameConfig,
  compatGetLaunchConfig,
  compatOpenGamePrefix,
  compatPreparePrefix,
  compatSetGameConfig,
  type CompatCatalog,
  type CompatPrefixProgress,
  type CompatToolInfo,
  type GameCompatConfig,
} from "../../compat";

const RUNNER_NAMES: Record<string, string> = {
  "ge-proton": "GE-Proton",
  "proton-cachyos": "Proton-CachyOS",
  "wine-staging": "Wine-Staging",
};

const LAYER_NAMES: Record<string, string> = {
  dxvk: "DXVK",
  "vkd3d-proton": "VKD3D-Proton",
};

const configs = new Map<string, GameCompatConfig>();
/** Saves are queued so a prepare never reads an older runner than the UI. */
const pendingSaves = new Map<string, Promise<void>>();
let catalog: CompatCatalog | null = null;
/** The global layer choice, shown as the inherited state of a game's switches. */
let globalLayers: string[] = [];
/** The global prefix root, shown as the placeholder of a game's prefix field. */
let globalPrefixDir: string | null = null;
/** The one game whose prefix is being created right now. */
let preparingPrefix: string | null = null;
let prefixListenerStarted = false;

function setPrefixStatus(text: string, busy: boolean): void {
  const el = document.querySelector<HTMLElement>(
    "#game-compat-card .game-compat-prefix-status",
  );
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("busy", busy);
}

async function refreshPrefixState(appName: string): Promise<void> {
  if (preparingPrefix === appName || S.currentModalAppName !== appName) return;
  try {
    const state = await compatGamePrefixState(appName);
    if (preparingPrefix === appName || S.currentModalAppName !== appName) return;
    setPrefixStatus(
      t(state.initialized ? "compat.prefixReady" : "compat.prefixStateMissing"),
      false,
    );
  } catch {
    // The card still works without the status line.
  }
}

function ensurePrefixProgressListener(): void {
  if (prefixListenerStarted || !isTauri) return;
  prefixListenerStarted = true;
  void listen<CompatPrefixProgress>("compat-prefix-progress", (event) => {
    const data = event.payload;
    if (data.appName !== S.currentModalAppName) return;
    if (data.phase === "starting" || data.phase === "running") {
      setPrefixStatus(
        t("compat.prefixPreparing", { seconds: data.elapsedSeconds }),
        true,
      );
    } else if (data.phase === "done") {
      setPrefixStatus(t("compat.prefixReady"), false);
    } else if (data.phase === "error") {
      setPrefixStatus("", false);
    }
  }).catch(() => {});
}

function runnerName(id: string): string {
  return RUNNER_NAMES[id] ?? id;
}

function pathName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function detectedValue(id: string, path: string): string {
  return `@path:${id}:${path}`;
}

function parseValue(value: string): { runner: string | null; runnerPath: string | null } {
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

function selectedValue(config: GameCompatConfig): string {
  if (!config.runner) return "";
  return config.runnerPath
    ? detectedValue(config.runner, config.runnerPath)
    : config.runner;
}

function effectiveLayers(config: GameCompatConfig): string[] {
  return config.layers ?? globalLayers;
}

function sameLayers(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function layerTools(): CompatToolInfo[] {
  return (
    catalog?.tools.filter(
      (tool) =>
        (tool.id === "dxvk" || tool.id === "vkd3d-proton") &&
        (tool.installed.length > 0 || tool.detected.length > 0),
    ) ?? []
  );
}

function runnerOptions(config: GameCompatConfig): string {
  const selected = selectedValue(config);
  const chosen = (value: string): string => (value === selected ? " selected" : "");
  const options = [`<option value=""${chosen("")}>${esc(t("compat.gameInherit"))}</option>`];
  const runners: CompatToolInfo[] =
    catalog?.tools.filter((tool) => tool.kind === "runner" && tool.installed.length > 0) ?? [];
  for (const runner of runners) {
    options.push(
      `<option value="${esc(runner.id)}"${chosen(runner.id)}>${esc(`${runnerName(runner.id)} · ${runner.installed[0].tag}`)}</option>`,
    );
  }
  if (catalog && catalog.target === `${catalog.currentOs}-${catalog.currentArch}`) {
    for (const runner of catalog.tools) {
      if (runner.kind !== "runner") continue;
      for (const path of runner.detected) {
        const value = detectedValue(runner.id, path);
        options.push(
          `<option value="${esc(value)}"${chosen(value)}>${esc(`${runnerName(runner.id)} · ${pathName(path)}`)}</option>`,
        );
      }
    }
  }
  if (selected && !options.some((option) => option.includes(`value="${esc(selected)}"`))) {
    const label = config.runnerPath
      ? `${runnerName(config.runner ?? "")} · ${pathName(config.runnerPath)}`
      : `${runnerName(config.runner ?? "")} · ${t("compat.notInstalled")}`;
    options.push(`<option value="${esc(selected)}" selected>${esc(label)}</option>`);
  }
  return options.join("");
}

function cardBody(appName: string, config: GameCompatConfig): string {
  const activeLayers = effectiveLayers(config);
  const layers = layerTools();
  const layerRows = layers
    .map((tool) => {
      const checked = activeLayers.includes(tool.id);
      const hint = t(tool.id === "dxvk" ? "compat.layerDxvkHint" : "compat.layerVkd3dHint");
      return `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${esc(LAYER_NAMES[tool.id] ?? tool.id)}</div>
            <div class="row-meta">${esc(hint)}</div>
          </div>
          <div class="row-actions">
            <label class="switch">
              <input type="checkbox" data-act="game-compat-layer" data-id="${esc(appName)}" data-layer="${esc(tool.id)}"${checked ? " checked" : ""} />
              <span class="track"></span>
            </label>
          </div>
        </div>`;
    })
    .join("");
  return `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(t("compat.runner"))}</div>
        <div class="row-meta">${esc(t("compat.gameRunnerHint"))}</div>
      </div>
      <div class="row-actions">
        <select class="settings-select" data-act="game-compat-runner" data-id="${esc(appName)}" aria-label="${esc(t("compat.runner"))}">
          ${runnerOptions(config)}
        </select>
      </div>
    </div>
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(t("compat.prefix"))}</div>
        <div class="row-meta">${esc(t("compat.gamePrefixHint"))}</div>
        <div class="row-meta game-compat-prefix-status" aria-live="polite"></div>
      </div>
      <div class="row-actions game-compat-path-actions">
        <input class="input settings-path-input game-compat-prefix" value="${esc(config.prefixDir ?? "")}" placeholder="${esc(globalPrefixDir ?? "")}" spellcheck="false" autocomplete="off" aria-label="${esc(t("compat.prefix"))}" />
        <button type="button" class="btn ghost small" data-act="game-compat-prefix-pick" data-id="${esc(appName)}">${esc(t("common.browse"))}</button>
        <button type="button" class="btn primary small" data-act="game-compat-prefix-save" data-id="${esc(appName)}">${esc(t("common.save"))}</button>
        <button type="button" class="btn ghost small" data-act="game-compat-prefix-prepare" data-id="${esc(appName)}" title="${esc(t("compat.preparePrefixHint"))}">${esc(t("compat.preparePrefix"))}</button>
        <button type="button" class="btn ghost small" data-act="game-compat-prefix-open" data-id="${esc(appName)}" title="${esc(t("compat.openPrefix"))}">${icon("folder", 12)} ${esc(t("compat.openPrefix"))}</button>
        <button type="button" class="btn ghost small" data-act="game-compat-prefix-diagnostics" data-id="${esc(appName)}" title="${esc(t("compat.diagnosticsHint"))}">${icon("clipboard", 12)} ${esc(t("compat.diagnostics"))}</button>
      </div>
    </div>
    ${
      layers.length > 0
        ? `<div class="game-compat-subhead">
             <div class="row-title">${esc(t("compat.gameLayers"))}</div>
             <div class="row-meta">${esc(t("compat.gameLayersHint"))}</div>
           </div>
           ${layerRows}`
        : ""
    }`;
}

export function renderGameCompatCard(s: EpicSummary): string {
  // Only the launcher-managed stores go through `launch_spec`; Steam and the
  // companion clients start their own games, so the card would be inert there.
  const source = sourceOfKey(s.appName);
  if (source !== "epic" && source !== "gog" && source !== "amazon") return "";
  return `
    <section class="card game-compat-card" id="game-compat-card" data-app="${esc(s.appName)}">
      <h3 class="gp-section-title">${icon("settings", 14)} ${esc(t("compat.gameTitle"))}</h3>
      <div id="game-compat-body" class="game-compat-body"><span class="spinner"></span></div>
    </section>`;
}

export async function hydrateGameCompatCard(appName: string): Promise<void> {
  const card = document.getElementById("game-compat-card");
  if (!card || card.dataset.app !== appName || card.dataset.loaded === "1") return;
  try {
    // The catalogue only scans local folders when it is not asked to refresh;
    // call it instead of caching so a runner installed in Settings shows up on
    // the next visit to this tab.
    const cached = configs.get(appName);
    const [nextCatalog, config, launch] = await Promise.all([
      compatCatalog(null, false),
      cached ? Promise.resolve(cached) : compatGetGameConfig(appName),
      compatGetLaunchConfig(),
    ]);
    catalog = nextCatalog;
    globalLayers = launch.layers;
    globalPrefixDir = launch.prefixDir;
    configs.set(appName, config);
    if (S.currentModalAppName !== appName) return;
    card.dataset.loaded = "1";
    // The compatibility controls are only meaningful where the store launch is
    // wrapped; Windows starts the game directly.
    if (catalog.currentOs === "windows") {
      card.hidden = true;
      return;
    }
    const body = card.querySelector<HTMLElement>("#game-compat-body");
    if (body) body.innerHTML = cardBody(appName, config);
    if (preparingPrefix === appName) {
      setPrefixStatus(t("compat.prefixPreparing", { seconds: 0 }), true);
    } else {
      void refreshPrefixState(appName);
    }
    ensurePrefixProgressListener();
  } catch {
    // A missing catalogue is not worth a red box on the System tab; the global
    // settings still work and the next open retries.
    card.hidden = true;
  }
}

function emptyConfig(): GameCompatConfig {
  return {
    runner: null,
    runnerPath: null,
    runnerTag: null,
    layers: null,
    prefixDir: null,
  };
}

function saveGameConfig(
  appName: string,
  next: GameCompatConfig,
  previous: GameCompatConfig,
  rollback: () => void,
): Promise<void> {
  configs.set(appName, next);
  const queued = (pendingSaves.get(appName) ?? Promise.resolve())
    .catch(() => {})
    .then(() => compatSetGameConfig(appName, next));
  pendingSaves.set(appName, queued);
  void queued
    .then(() => toast(t("compat.gameSaved"), "ok"))
    .catch((error) => {
      configs.set(appName, previous);
      rollback();
      toast(String(error), "err");
    })
    .finally(() => {
      if (pendingSaves.get(appName) === queued) pendingSaves.delete(appName);
    });
  return queued;
}

function prefixInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("#game-compat-card .game-compat-prefix");
}

function savePrefix(appName: string, prefixDir: string | null): void {
  const config = configs.get(appName) ?? emptyConfig();
  const input = prefixInput();
  if (input) input.value = prefixDir ?? "";
  void saveGameConfig(appName, { ...config, prefixDir }, config, () => {
    if (input) input.value = config.prefixDir ?? "";
  })
    .then(() => refreshPrefixState(appName))
    .catch(() => {});
}

function startPrepare(appName: string): void {
  const config = configs.get(appName) ?? emptyConfig();
  const input = prefixInput();
  const prefixDir = input?.value.trim() || null;
  preparingPrefix = appName;
  setPrefixStatus(t("compat.prefixPreparing", { seconds: 0 }), true);
  void (async () => {
    try {
      await pendingSaves.get(appName)?.catch(() => {});
      const next = {
        ...(configs.get(appName) ?? config),
        prefixDir: input?.value.trim() || null,
      };
      configs.set(appName, next);
      await compatSetGameConfig(appName, next);
      await compatPreparePrefix(appName);
      setPrefixStatus(t("compat.prefixReady"), false);
      toast(t("compat.prefixReady"), "ok");
    } catch (error) {
      configs.set(appName, config);
      if (input) input.value = config.prefixDir ?? "";
      setPrefixStatus("", false);
      toast(String(error), "err");
    } finally {
      preparingPrefix = null;
      void refreshPrefixState(appName);
    }
  })();
}

export function handleGameCompatClick(act: string | undefined, el: HTMLElement): boolean {
  if (
    act !== "game-compat-prefix-pick" &&
    act !== "game-compat-prefix-save" &&
    act !== "game-compat-prefix-prepare" &&
    act !== "game-compat-prefix-open" &&
    act !== "game-compat-prefix-diagnostics"
  ) {
    return false;
  }
  const appName = el.dataset.id ?? "";
  if (!appName || preparingPrefix === appName) return true;
  const config = configs.get(appName) ?? emptyConfig();

  if (act === "game-compat-prefix-diagnostics") {
    void compatGameDiagnostics(appName)
      .then((text) => navigator.clipboard.writeText(text))
      .then(() => toast(t("compat.diagnosticsCopied"), "ok"))
      .catch((error) => toast(String(error), "err"));
    return true;
  }

  if (act === "game-compat-prefix-open") {
    void compatOpenGamePrefix(appName)
      .then((message) => toast(message, "ok"))
      .catch((error) => toast(String(error), "err"));
    return true;
  }

  if (act === "game-compat-prefix-prepare") {
    startPrepare(appName);
    return true;
  }

  if (act === "game-compat-prefix-pick") {
    void (async () => {
      try {
        const picked = await epicSelectFolderDialog(
          config.prefixDir ?? globalPrefixDir,
          t("compat.prefix"),
        );
        if (picked) savePrefix(appName, picked);
      } catch (error) {
        toast(String(error), "err");
      }
    })();
    return true;
  }

  const input = prefixInput();
  savePrefix(appName, input?.value.trim() || null);
  return true;
}

export function handleGameCompatChange(el: HTMLElement): boolean {
  const act = el.dataset.act;
  if (act !== "game-compat-runner" && act !== "game-compat-layer") return false;
  const appName = el.dataset.id ?? "";
  if (!appName || preparingPrefix === appName) return true;
  const config = configs.get(appName) ?? emptyConfig();

  if (act === "game-compat-runner") {
    const select = el as HTMLSelectElement;
    const parsed = parseValue(select.value);
    const next: GameCompatConfig = {
      ...config,
      runner: parsed.runner,
      runnerPath: parsed.runnerPath,
      runnerTag: null,
    };
    saveGameConfig(appName, next, config, () => {
      select.value = selectedValue(config);
    });
    return true;
  }

  const input = el as HTMLInputElement;
  const layer = input.dataset.layer;
  if (!layer) return true;
  const active = new Set(effectiveLayers(config));
  if (input.checked) active.add(layer);
  else active.delete(layer);
  // Keep the stored order stable, and fall back to "inherit" when the result
  // matches the global choice again.
  const ordered = Object.keys(LAYER_NAMES).filter((id) => active.has(id));
  const next: GameCompatConfig = {
    ...config,
    layers: sameLayers(ordered, globalLayers) ? null : ordered,
  };
  saveGameConfig(appName, next, config, () => {
    input.checked = effectiveLayers(config).includes(layer);
  });
  return true;
}
