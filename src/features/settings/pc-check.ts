/**
 * A small, offline PC check. It never uploads anything: the report is built in
 * the webview and copied to the clipboard for a support message.
 *
 * The hardware facts come from the Rust side (OS build, CPU, RAM, GPU, disks);
 * the webview adds what only it can see (WebView2, local storage, network).
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { hasConnection } from "../../core/offline";
import { S } from "../../core/state";
import { epicGetSystemDrives, epicSetupStatus } from "../../epic";
import { t } from "../../i18n";

type Level = "ok" | "warn" | "fail";

interface Check {
  label: string;
  value: string;
  level: Level;
  hint?: string;
}

interface PcCheckSystem {
  os: string;
  osVersion: string;
  arch: string;
  cpu: string;
  physicalCores: number;
  logicalCores: number;
  memoryMb: number;
  gpu: string;
  gpuMemoryMb: number;
  appVersion: string;
}

let lastReport = "";
let lastHtml = "";

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const gb = value / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function gigabytes(memoryMb: number): string {
  const gb = memoryMb / 1024;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

function iconFor(level: Level): string {
  return level === "ok" ? icon("check", 14) : level === "warn" ? icon("alert-triangle", 14) : icon("x", 14);
}

function hardwareChecks(system: PcCheckSystem | null): Check[] {
  if (!system) {
    // Browser preview: the Rust command does not exist, so show what the
    // webview knows rather than pretending the hardware is unknown.
    const cores = navigator.hardwareConcurrency || 0;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;
    return [{
      label: "CPU / RAM",
      value: `${cores || "—"}C${memory ? ` · ${memory} GB` : ""}`,
      level: cores >= 4 ? "ok" : "warn",
    }];
  }

  const osValue = [system.os, system.osVersion].filter(Boolean).join(" · ");
  const coreValue = system.logicalCores
    ? `${system.physicalCores}C / ${system.logicalCores}T`
    : "";
  const gpuValue = system.gpu
    ? `${system.gpu}${system.gpuMemoryMb > 0 ? ` · ${gigabytes(system.gpuMemoryMb)}` : ""}`
    : "—";
  const ramGb = system.memoryMb / 1024;

  return [
    {
      label: "OS",
      value: osValue || "—",
      level: osValue ? "ok" : "warn",
      hint: system.arch,
    },
    {
      label: "CPU",
      value: `${system.cpu || "—"}${coreValue ? ` · ${coreValue}` : ""}`,
      level: system.logicalCores >= 2 ? "ok" : "warn",
    },
    {
      label: "RAM",
      value: system.memoryMb > 0 ? gigabytes(system.memoryMb) : "—",
      level: ramGb >= 8 ? "ok" : "warn",
    },
    {
      label: "GPU",
      value: gpuValue,
      level: system.gpu ? "ok" : "warn",
    },
  ];
}

export async function runPcCheck(): Promise<string> {
  const checks: Check[] = [];
  const ua = navigator.userAgent;
  const chromium = ua.match(/(?:Edg|Chrome)\/([\d.]+)/)?.[1] ?? "";
  const major = Number(chromium.split(".")[0] || 0);

  const system = isTauri
    ? await invoke<PcCheckSystem>("pc_check_system").catch(() => null)
    : null;
  checks.push(...hardwareChecks(system));

  checks.push({
    label: "WebView2",
    value: chromium || "—",
    level: major >= 100 ? "ok" : major > 0 ? "warn" : "fail",
  });

  checks.push({
    label: t("settings.backend"),
    value: isTauri ? t("settings.backendRust") : t("settings.backendBrowser"),
    level: isTauri ? "ok" : "fail",
  });

  try {
    const setup = await epicSetupStatus();
    checks.push({
      label: "legendary",
      value: setup.version || setup.binaryPath || "—",
      level: setup.binaryPath ? "ok" : "warn",
    });
  } catch {
    checks.push({ label: "legendary", value: "—", level: "warn" });
  }

  try {
    const drives = await epicGetSystemDrives();
    if (drives.length === 0) {
      checks.push({ label: t("settings.pcCheckDisk"), value: "—", level: "warn" });
    } else {
      for (const drive of drives) {
        const free = drive.available_bytes ?? 0;
        checks.push({
          label: `${t("settings.pcCheckDisk")} ${drive.letter}:`,
          value: `${bytes(free)} / ${bytes(drive.total_bytes)}`,
          level: free >= 10 * 1024 ** 3 ? "ok" : free >= 2 * 1024 ** 3 ? "warn" : "fail",
        });
      }
    }
  } catch {
    checks.push({ label: t("settings.pcCheckDisk"), value: "—", level: "warn" });
  }

  const online = hasConnection();
  checks.push({
    label: t("settings.pcCheckNetwork"),
    value: S.offlineMode ? t("nav.offline") : online ? t("nav.online") : t("nav.noConnection"),
    level: S.offlineMode ? "warn" : online ? "ok" : "fail",
  });

  let storageOk = false;
  try {
    const key = "efxlve-pc-check";
    localStorage.setItem(key, "1");
    storageOk = localStorage.getItem(key) === "1";
    localStorage.removeItem(key);
  } catch {
    storageOk = false;
  }
  checks.push({
    label: t("settings.pcCheckStorage"),
    value: storageOk ? "OK" : t("common.error"),
    level: storageOk ? "ok" : "fail",
  });

  const passed = checks.filter((check) => check.level === "ok").length;
  const overall: Level = checks.some((check) => check.level === "fail")
    ? "fail"
    : passed === checks.length ? "ok" : "warn";

  const detail = system
    ? `os: ${[system.os, system.osVersion].filter(Boolean).join(" ")} (${system.arch})\n` +
      `cpu: ${system.cpu} (${system.physicalCores}C/${system.logicalCores}T)\n` +
      `ram: ${system.memoryMb} MiB\ngpu: ${system.gpu} (${system.gpuMemoryMb} MiB)`
    : `cpu: ${navigator.hardwareConcurrency || "?"} threads\nbrowser mode`;
  lastReport = checks
    .map((check) => `${check.level.toUpperCase()}  ${check.label}: ${check.value}${check.hint ? ` (${check.hint})` : ""}`)
    .join("\n");
  lastReport += `\n\napp: ${S.appVersion}\n${detail}\nua: ${ua}`;

  const rows = checks.map((check) => `
    <div class="pc-check-row ${check.level}">
      <span class="pc-check-icon">${iconFor(check.level)}</span>
      <span class="pc-check-label">${check.label}</span>
      <span class="pc-check-value" title="${check.value}">${check.value}</span>
      ${check.hint ? `<span class="pc-check-hint">${check.hint}</span>` : ""}
    </div>`).join("");

  lastHtml = `<div class="pc-check-panel">
    <div class="pc-check-summary ${overall}">
      <span class="pc-check-summary-icon">${iconFor(overall)}</span>
      <span class="pc-check-summary-title">${passed} / ${checks.length} OK</span>
      <button type="button" class="btn ghost small" data-act="copy-pc-check">${icon("clipboard", 13)} ${t("settings.pcCheckCopy")}</button>
    </div>
    <div class="pc-check-list">${rows}</div>
  </div>`;
  return lastHtml;
}

/** The last rendered result, so leaving Settings and coming back keeps it. */
export function pcCheckResultHtml(): string {
  return lastHtml;
}

export async function copyPcCheck(): Promise<void> {
  if (!lastReport) await runPcCheck();
  await navigator.clipboard.writeText(lastReport);
}
