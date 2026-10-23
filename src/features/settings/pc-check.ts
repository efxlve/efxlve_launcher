/**
 * A small, offline PC check. It never uploads anything: the report is built in
 * the webview and copied to the clipboard for a support message.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
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

let lastReport = "";

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const gb = value / 1024 ** 3;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function iconFor(level: Level): string {
  return level === "ok" ? icon("check", 14) : level === "warn" ? icon("alert-triangle", 14) : icon("x", 14);
}

export async function runPcCheck(): Promise<string> {
  const checks: Check[] = [];
  const ua = navigator.userAgent;
  const chromium = ua.match(/(?:Edg|Chrome)\/([\d.]+)/)?.[1] ?? "";
  const major = Number(chromium.split(".")[0] || 0);
  checks.push({
    label: "WebView2",
    value: chromium || "—",
    level: major >= 100 ? "ok" : major > 0 ? "warn" : "fail",
  });

  const cores = navigator.hardwareConcurrency || 0;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory || 0;
  checks.push({
    label: "CPU / RAM",
    value: `${cores || "—"} cores · ${memory ? `${memory} GB` : "—"}`,
    level: cores >= 4 && (!memory || memory >= 8) ? "ok" : "warn",
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
    const letter = S.libraryPath.slice(0, 2).toUpperCase();
    const drive = drives.find((item) => item.letter.toUpperCase() === letter) ?? drives[0];
    if (drive) {
      const free = drive.available_bytes ?? 0;
      checks.push({
        label: t("settings.pcCheckDisk"),
        value: `${drive.letter} · ${t("move.free")} ${bytes(free)}`,
        level: free >= 10 * 1024 ** 3 ? "ok" : "warn",
      });
    }
  } catch {
    checks.push({ label: t("settings.pcCheckDisk"), value: "—", level: "warn" });
  }

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

  lastReport = checks
    .map((check) => `${check.level.toUpperCase()}  ${check.label}: ${check.value}${check.hint ? ` (${check.hint})` : ""}`)
    .join("\n");
  lastReport += `\napp: ${S.appVersion} · os: ${navigator.platform} · ua: ${ua}`;

  return `<div class="pc-check-list">${checks.map((check) => `
    <div class="pc-check-row ${check.level}">
      <span class="pc-check-icon">${iconFor(check.level)}</span>
      <span class="pc-check-label">${check.label}</span>
      <span class="pc-check-value">${check.value}</span>
      ${check.hint ? `<span class="pc-check-hint">${check.hint}</span>` : ""}
    </div>`).join("")}</div>
    <button type="button" class="btn ghost small" data-act="copy-pc-check">${icon("clipboard", 13)} ${t("settings.pcCheckCopy")}</button>`;
}

export async function copyPcCheck(): Promise<void> {
  if (!lastReport) await runPcCheck();
  await navigator.clipboard.writeText(lastReport);
}
