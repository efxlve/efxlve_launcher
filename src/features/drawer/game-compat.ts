/**
 * Per-game compatibility override on the game page's System tab.
 *
 * The global runner lives in Settings → Compatibility; this card only stores an
 * exception for the open title. A game that needs an older Proton build (or a
 * runner outside the launcher's folder) can keep it without changing every
 * other launch. The runner list and option encoding are the same ones the
 * Settings page uses.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import type { EpicSummary } from "../../epic";
import {
  compatCatalog,
  compatGetGameConfig,
  compatSetGameConfig,
  type CompatCatalog,
  type CompatToolInfo,
  type GameCompatConfig,
} from "../../compat";

const RUNNER_NAMES: Record<string, string> = {
  "ge-proton": "GE-Proton",
  "proton-cachyos": "Proton-CachyOS",
  "wine-staging": "Wine-Staging",
};

const configs = new Map<string, GameCompatConfig>();
let catalog: CompatCatalog | null = null;

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
    </div>`;
}

export function renderGameCompatCard(s: EpicSummary): string {
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
    catalog = await compatCatalog(null, false);
    let config = configs.get(appName);
    if (!config) {
      config = await compatGetGameConfig(appName);
      configs.set(appName, config);
    }
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
  } catch {
    // A missing catalogue is not worth a red box on the System tab; the global
    // settings still work and the next open retries.
    card.hidden = true;
  }
}

export function handleGameCompatChange(el: HTMLElement): boolean {
  if (el.dataset.act !== "game-compat-runner") return false;
  const appName = el.dataset.id ?? "";
  const select = el as HTMLSelectElement;
  if (!appName) return true;
  const config = configs.get(appName) ?? {
    runner: null,
    runnerPath: null,
    runnerTag: null,
    layers: null,
  };
  const parsed = parseValue(select.value);
  const next: GameCompatConfig = {
    ...config,
    runner: parsed.runner,
    runnerPath: parsed.runnerPath,
    runnerTag: null,
  };
  configs.set(appName, next);
  void compatSetGameConfig(appName, next)
    .then(() => toast(t("compat.gameSaved"), "ok"))
    .catch((error) => {
      configs.delete(appName);
      select.value = selectedValue(config);
      toast(String(error), "err");
    });
  return true;
}
