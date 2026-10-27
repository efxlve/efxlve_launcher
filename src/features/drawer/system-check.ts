/**
 * Local hardware facts and requirement comparison for the System tab.
 *
 * The facts come from the same offline command as Settings > PC check: the
 * module never uploads anything and reads the OS once per session. Only the
 * rows that can be measured (OS, RAM, storage, core count, VRAM) are compared;
 * a CPU or GPU model needs a benchmark database, so those rows stay a manual
 * comparison and the UI says so.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { fmtBytes } from "../../core/utils";
import { epicGetSystemDrives, type SystemDriveInfo } from "../../epic";
import { t } from "../../i18n";
import type { VerifiedHardwareItem } from "./drawer-widgets";

export interface PcFacts {
  os: string;
  osVersion: string;
  arch: string;
  cpu: string;
  physicalCores: number;
  logicalCores: number;
  memoryMb: number;
  gpu: string;
  gpuMemoryMb: number;
}

interface PcCheckSystem extends PcFacts {
  appVersion: string;
}

export type RequirementStatus = "ok" | "fail" | "manual" | "unknown";

export interface RequirementCheck {
  status: RequirementStatus;
  /** The value read from this PC, already formatted for the row. */
  detected: string;
}

let cachedFacts: PcFacts | null = null;
let cachedDrives: SystemDriveInfo[] = [];
let loadState: "idle" | "loading" | "done" = isTauri ? "idle" : "done";
let pending: Promise<void> | null = null;

export function getPcFacts(): PcFacts | null {
  return cachedFacts;
}

export function getPcDrives(): SystemDriveInfo[] {
  return cachedDrives;
}

export function pcFactsState(): "idle" | "loading" | "done" {
  return loadState;
}

/** Reads the hardware once; every later call returns the same answer. */
export function ensurePcFacts(): Promise<void> {
  if (loadState === "done") return Promise.resolve();
  if (pending) return pending;
  loadState = "loading";
  pending = (async () => {
    const [system, drives] = await Promise.all([
      invoke<PcCheckSystem>("pc_check_system").catch(() => null),
      epicGetSystemDrives().catch(() => [] as SystemDriveInfo[]),
    ]);
    if (system && system.memoryMb > 0) cachedFacts = system;
    cachedDrives = Array.isArray(drives) ? drives : [];
  })().finally(() => {
    loadState = "done";
    pending = null;
  });
  return pending;
}

export function formatGb(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded.toString();
}

function parseSizeValuesGb(text: string): number[] {
  const values: number[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[1].replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = match[2].toUpperCase();
    values.push(unit === "TB" ? value * 1024 : unit === "MB" ? value / 1024 : value);
  }
  return values;
}

interface WindowsFacts {
  version: number;
  bits: 32 | 64 | 0;
}

function windowsFacts(facts: PcFacts): WindowsFacts | null {
  const text = `${facts.os} ${facts.osVersion}`.toLowerCase();
  if (!text.includes("windows")) return null;
  const build = Number(/build\s+(\d+)/i.exec(facts.osVersion)?.[1] ?? 0);
  let version = 0;
  if (/windows\s*11/.test(text) || build >= 22000) version = 11;
  else if (/windows\s*10/.test(text) || build >= 10240) version = 10;
  else if (/windows\s*8\.1/.test(text) || build >= 9600) version = 8.1;
  else if (/windows\s*8\b/.test(text) || build >= 9200) version = 8;
  else if (/windows\s*7/.test(text) || build >= 7600) version = 7;
  else if (build >= 6000) version = 6;
  if (!version) return null;
  const bits: 32 | 64 | 0 = facts.arch
    ? /64|arm64|aarch64/i.test(facts.arch)
      ? 64
      : 32
    : 0;
  return { version, bits };
}

function requiredWindowsVersion(text: string): number | null {
  const match = /windows\s*(11|10|8\.1|8|7|vista|xp)/i.exec(text);
  if (!match) return null;
  switch (match[1].toLowerCase()) {
    case "11": return 11;
    case "10": return 10;
    case "8.1": return 8.1;
    case "8": return 8;
    case "7": return 7;
    case "vista": return 6;
    case "xp": return 5.1;
    default: return null;
  }
}

function osDetected(facts: PcFacts): string {
  return [facts.os, facts.osVersion].filter(Boolean).join(" · ");
}

function cpuDetected(facts: PcFacts): string {
  const cores = facts.logicalCores > 0
    ? `${facts.physicalCores}C/${facts.logicalCores}T`
    : "";
  return [facts.cpu, cores].filter(Boolean).join(" · ");
}

function gpuDetected(facts: PcFacts): string {
  const vram = facts.gpuMemoryMb > 0 ? `${formatGb(facts.gpuMemoryMb / 1024)} GB` : "";
  return [facts.gpu, vram].filter(Boolean).join(" · ");
}

/**
 * Free space for the drive the game lives on. `exact` is false when the path
 * is unknown or the drive is not in the list; the row then shows the largest
 * free volume but stays a manual check instead of passing on another drive.
 */
function freeSpace(installPath: string | null | undefined): { bytes: number; exact: boolean } {
  if (cachedDrives.length === 0) return { bytes: 0, exact: false };
  if (installPath) {
    const windowsDrive = /^([A-Za-z]):[\\/]/.exec(installPath);
    if (windowsDrive) {
      const hit = cachedDrives.find(
        (drive) => drive.letter.toLowerCase() === windowsDrive[1].toLowerCase(),
      );
      if (hit) return { bytes: hit.available_bytes, exact: true };
    }
    const mount = cachedDrives
      .filter((drive) => installPath.startsWith(drive.letter))
      .sort((a, b) => b.letter.length - a.letter.length)[0];
    if (mount) return { bytes: mount.available_bytes, exact: true };
  }
  return {
    bytes: Math.max(0, ...cachedDrives.map((drive) => drive.available_bytes)),
    exact: false,
  };
}

function checkOs(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = osDetected(facts);
  if (!/windows/i.test(required) || !detected) return detected ? { status: "manual", detected } : null;
  const win = windowsFacts(facts);
  if (!win) return { status: "manual", detected };
  const bits = /(64|32)[\s-]?bit/i.exec(required);
  if (bits) {
    const needed = Number(bits[1]);
    if (win.bits && win.bits !== needed) return { status: "fail", detected };
  }
  const neededVersion = requiredWindowsVersion(required);
  if (!neededVersion) return { status: "manual", detected };
  return { status: win.version >= neededVersion ? "ok" : "fail", detected };
}

function checkCpu(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = cpuDetected(facts);
  if (!detected) return null;
  const cores = /(\d+)\s*(?:cores?|threads?|çekirdek|iş parçacığı)/i.exec(required);
  if (!cores) return { status: "manual", detected };
  const needed = Number(cores[1]);
  const has = /threads?|iş parçacığı/i.test(cores[0]) ? facts.logicalCores : facts.physicalCores;
  if (has <= 0) return { status: "manual", detected };
  return { status: has >= needed ? "ok" : "fail", detected };
}

function checkGpu(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = gpuDetected(facts);
  if (!detected) return null;
  const vramValues = parseSizeValuesGb(required);
  if (vramValues.length > 0 && facts.gpuMemoryMb > 0) {
    // A GPU row can list two cards; the smaller card is the threshold.
    const needed = Math.min(...vramValues);
    const has = facts.gpuMemoryMb / 1024;
    return { status: has + 0.25 >= needed ? "ok" : "fail", detected };
  }
  return { status: "manual", detected };
}

function checkRam(required: string, facts: PcFacts): RequirementCheck | null {
  if (facts.memoryMb <= 0) return null;
  const has = facts.memoryMb / 1024;
  const detected = `${formatGb(has)} GB`;
  const values = parseSizeValuesGb(required);
  if (values.length === 0) return { status: "manual", detected };
  // Reserved hardware memory makes the OS report a little less than the
  // installed sticks; half a gigabyte covers that without passing a 16 GB
  // requirement on an 8 GB machine.
  return { status: has + 0.5 >= values[0] ? "ok" : "fail", detected };
}

function checkStorage(required: string, installPath?: string | null): RequirementCheck | null {
  const free = freeSpace(installPath);
  if (free.bytes <= 0) return null;
  const detected = `${fmtBytes(free.bytes)} ${t("storage.free")}`;
  const values = parseSizeValuesGb(required);
  if (values.length === 0 || !free.exact) return { status: "manual", detected };
  return {
    status: free.bytes / 1024 ** 3 + 0.5 >= values[0] ? "ok" : "fail",
    detected,
  };
}

/**
 * Compares one requirement row against this PC. `null` means the row has no
 * detected counterpart to show (sound card, network, free-form notes).
 */
export function checkRequirement(
  item: VerifiedHardwareItem,
  required: string,
  facts: PcFacts | null,
  installPath?: string | null,
): RequirementCheck | null {
  if (!facts || !required) return null;
  switch (item.kind) {
    case "os": return checkOs(required, facts);
    case "cpu": return checkCpu(required, facts);
    case "ram": return checkRam(required, facts);
    case "gpu": return checkGpu(required, facts);
    case "storage": return checkStorage(required, installPath);
    case "directx": {
      const win = windowsFacts(facts);
      if (!win) return null;
      return {
        status: "manual",
        detected: win.version >= 10 ? "DirectX 12" : "",
      };
    }
    default:
      return null;
  }
}

export type SystemVerdict = "ok" | "partial" | "fail" | "unknown";

/**
 * A single status for the panel. A failed measurable row always wins; when
 * only manual rows remain, the verdict never claims the PC is ready.
 */
export function systemVerdict(checks: RequirementCheck[]): SystemVerdict {
  if (checks.some((check) => check.status === "fail")) return "fail";
  const ok = checks.filter((check) => check.status === "ok").length;
  const pending = checks.filter(
    (check) => check.status === "manual" || check.status === "unknown",
  ).length;
  if (pending > 0) return ok > 0 ? "partial" : "unknown";
  return ok > 0 ? "ok" : "unknown";
}
