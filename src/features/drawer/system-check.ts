/**
 * Local hardware facts and requirement comparison for the System tab.
 *
 * The facts come from the same offline command as Settings > PC check: the
 * module never uploads anything and reads the OS once per session. Measurable
 * rows (OS, RAM, storage, DirectX feature level, core count, VRAM) are compared
 * automatically. A CPU or GPU model is ranked with the generated offline score
 * table; a model the table does not know, or one that is close to the
 * requirement, stays partial instead of claiming a full match.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { fmtBytes } from "../../core/utils";
import { epicGetSystemDrives, type SystemDriveInfo } from "../../epic";
import { t } from "../../i18n";
import type { VerifiedHardwareItem } from "./drawer-widgets";
import { compareHardwareScore } from "./hardware-scores";

export interface PcFacts {
  os: string;
  osVersion: string;
  arch: string;
  cpu: string;
  physicalCores: number;
  logicalCores: number;
  memoryMb: number;
  gpu: string;
  gpuVendorId: number;
  gpuDeviceId: number;
  gpuMemoryMb: number;
  /** Display driver version from the Windows display class, e.g. "32.0.16.2101". */
  gpuDriverVersion: string;
  /** Display driver date as Windows stores it, e.g. "10-19-2026". */
  gpuDriverDate: string;
  /** "DirectX 12 (12_1)" or empty when the feature level is unknown. */
  directx: string;
  /** 122, 121, 120, 111, 110… / 0. */
  directxLevel: number;
  /** 0 = no DXR, 10 = DXR 1.0, 11 = DXR 1.1, 12 = DXR 1.2. */
  raytracingTier: number;
  /** 0 = no mesh shaders, 10 = tier 1. */
  meshShaderTier: number;
  /** 0 = no VRS, 1 = tier 1, 2 = tier 2. */
  shadingRateTier: number;
  /** 0 = no sampler feedback, 90 = tier 0.9, 100 = tier 1.0. */
  samplerFeedbackTier: number;
  /** False when Windows could not answer the DX12 feature queries. */
  dx12FeaturesKnown: boolean;
  /** DXR 1.1 + mesh shaders + VRS tier 2 + sampler feedback 0.9. */
  dx12Ultimate: boolean;
}

interface PcCheckSystem extends PcFacts {
  appVersion: string;
}

export type RequirementStatus = "ok" | "partial" | "fail" | "manual" | "unknown";

export interface RequirementCheck {
  status: RequirementStatus;
  /** The value read from this PC, already formatted for the row. */
  detected: string;
  /** True when the CPU/GPU model was ranked with the offline score table. */
  scored?: boolean;
}

let cachedFacts: PcFacts | null = null;
let cachedDrives: SystemDriveInfo[] = [];
let loadState: "idle" | "loading" | "done" = isTauri ? "idle" : "done";
let pending: Promise<void> | null = null;
let loadGeneration = 0;

export function getPcFacts(): PcFacts | null {
  return cachedFacts;
}

export function getPcDrives(): SystemDriveInfo[] {
  return cachedDrives;
}

/**
 * `D: · SSD`, `D: · HDD` or just `D:` for the drive an install path lives on.
 * The drive kind is omitted when the list has not loaded or Windows cannot
 * report the seek penalty.
 */
export function installDriveLabel(installPath: string | null | undefined): string {
  if (!installPath) return "";
  const match = /^([A-Za-z]):(?:[\\/]|$)/.exec(installPath);
  if (!match) return "";
  const letter = match[1].toUpperCase();
  const drive = cachedDrives.find((candidate) => candidate.letter.toUpperCase() === letter);
  const kind = drive?.is_ssd === true ? "SSD" : drive?.is_ssd === false ? "HDD" : "";
  return [`${letter}:`, kind].filter(Boolean).join(" · ");
}

export function pcFactsState(): "idle" | "loading" | "done" {
  return loadState;
}

/**
 * Drops the cached answer so the next read sees a drive that was plugged in or
 * a monitor that was connected. A running read is ignored when it lands.
 */
export function resetPcFacts(): void {
  loadGeneration++;
  cachedFacts = null;
  cachedDrives = [];
  loadState = isTauri ? "idle" : "done";
  pending = null;
}

/** Reads the hardware once; every later call returns the same answer. */
export function ensurePcFacts(): Promise<void> {
  if (loadState === "done") return Promise.resolve();
  if (pending) return pending;
  loadState = "loading";
  const generation = loadGeneration;
  pending = (async () => {
    const [system, drives] = await Promise.all([
      invoke<PcCheckSystem>("pc_check_system").catch(() => null),
      epicGetSystemDrives().catch(() => [] as SystemDriveInfo[]),
    ]);
    if (generation !== loadGeneration) return;
    if (system && system.memoryMb > 0) {
      // Older dev backends do not send the DX12 fields yet; default them so a
      // hot-reloaded webview does not compare undefined tiers.
      cachedFacts = {
        ...system,
        gpuDriverVersion: system.gpuDriverVersion ?? "",
        gpuDriverDate: system.gpuDriverDate ?? "",
        raytracingTier: system.raytracingTier ?? 0,
        meshShaderTier: system.meshShaderTier ?? 0,
        shadingRateTier: system.shadingRateTier ?? 0,
        samplerFeedbackTier: system.samplerFeedbackTier ?? 0,
        dx12FeaturesKnown: system.dx12FeaturesKnown ?? false,
        dx12Ultimate: system.dx12Ultimate ?? false,
      };
    }
    cachedDrives = Array.isArray(drives) ? drives : [];
  })().finally(() => {
    if (generation !== loadGeneration) return;
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

function requiredDirectXLevel(text: string): number | null {
  const match = /(?:directx|dx)\s*(\d+)(?:\.(\d+))?/i.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (major >= 12) return minor >= 2 ? 122 : minor >= 1 ? 121 : 120;
  if (major === 11) return minor >= 1 ? 111 : 110;
  if (major === 10) return minor >= 1 ? 101 : 100;
  if (major === 9) return minor >= 3 ? 93 : 90;
  return null;
}

function checkDirectX(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = [facts.directx, facts.dx12Ultimate ? "DX12 Ultimate" : ""]
    .filter(Boolean)
    .join(" · ");
  const level = Number(facts.directxLevel) || 0;
  if (level <= 0) return detected ? { status: "manual", detected } : null;
  // "DirectX 12 Ultimate" is a feature set, not only feature level 12_2.
  if (/\bultimate\b/i.test(required)) {
    if (!facts.dx12FeaturesKnown) return { status: "manual", detected };
    if (!facts.dx12Ultimate) return { status: "fail", detected };
  }
  const needed = requiredDirectXLevel(required);
  if (!needed) return { status: "manual", detected };
  return { status: level >= needed ? "ok" : "fail", detected };
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
 * is unknown or the drive is not in the list; the row then stays a manual
 * check instead of passing on another drive. `missing` means the install path
 * names a volume that is not currently mounted, so no other drive's free space
 * may stand in for it.
 */
interface FreeSpace {
  bytes: number;
  exact: boolean;
  isSsd: boolean | null;
  /** Drive letter (no colon) or mount the figure belongs to. */
  drive: string | null;
  missing: boolean;
}

function freeSpace(installPath: string | null | undefined): FreeSpace {
  if (cachedDrives.length === 0) {
    return { bytes: 0, exact: false, isSsd: null, drive: null, missing: false };
  }
  if (installPath) {
    const windowsDrive = /^([A-Za-z]):[\\/]/.exec(installPath);
    if (windowsDrive) {
      const letter = windowsDrive[1].toUpperCase();
      const hit = cachedDrives.find(
        (drive) => drive.letter.toUpperCase() === letter,
      );
      if (hit) {
        return {
          bytes: hit.available_bytes,
          exact: true,
          isSsd: hit.is_ssd ?? null,
          drive: letter,
          missing: false,
        };
      }
      // A disconnected install drive cannot be checked against another
      // volume; naming it is more honest than showing C: free space.
      return { bytes: 0, exact: false, isSsd: null, drive: letter, missing: true };
    }
    const mount = cachedDrives
      .filter((drive) => installPath.startsWith(drive.letter))
      .sort((a, b) => b.letter.length - a.letter.length)[0];
    if (mount) {
      return {
        bytes: mount.available_bytes,
        exact: true,
        isSsd: mount.is_ssd ?? null,
        drive: mount.letter,
        missing: false,
      };
    }
  }
  const largest = cachedDrives.reduce((a, b) =>
    b.available_bytes > a.available_bytes ? b : a,
  );
  return {
    bytes: largest.available_bytes,
    exact: false,
    isSsd: largest.is_ssd ?? null,
    drive: largest.letter,
    missing: false,
  };
}

/**
 * Every bit width a row accepts. A row can offer both ("32bit/64bit") or
 * write them once per version ("Windows 7 (32-bit), Windows 7 (64-bit)").
 */
function requiredBitWidths(text: string): number[] {
  const widths = new Set<number>();
  for (const match of text.matchAll(
    /(32|64)\s*(?:(?:\/|,|-|or)\s*(32|64)\s*)?-?\s*bit\b/gi,
  )) {
    widths.add(Number(match[1]));
    if (match[2]) widths.add(Number(match[2]));
  }
  return [...widths];
}

function checkOs(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = osDetected(facts);
  if (!/windows/i.test(required) || !detected) return detected ? { status: "manual", detected } : null;
  const win = windowsFacts(facts);
  if (!win) return { status: "manual", detected };
  const widths = requiredBitWidths(required);
  // A row that offers either width only needs one of them to match, and a
  // 64-bit Windows still runs 32-bit builds. Only a 64-bit-only row on a
  // 32-bit PC is a real mismatch.
  if (win.bits === 32 && widths.length > 0 && !widths.includes(32)) {
    return { status: "fail", detected };
  }
  const neededVersion = requiredWindowsVersion(required);
  if (!neededVersion) return { status: "manual", detected };
  return { status: win.version >= neededVersion ? "ok" : "fail", detected };
}

function checkGraphicsFeature(
  item: VerifiedHardwareItem,
  required: string,
  facts: PcFacts,
): RequirementCheck | null {
  const text = required.trim().toLowerCase();
  const negative = /^(no|none|not required|n\/?a|yok|gerekmiyor|non|nein|nicht)\b/.test(text);
  const optional = /optional|recommended|öneril|empfohlen|recommand|recomend/.test(text);
  const status = (supported: boolean): RequirementStatus =>
    supported ? "ok" : optional ? "partial" : "fail";
  // The row says the feature is not required: it is met even when the probe
  // could not run.
  if (negative) return { status: "ok", detected: "—" };
  // Some stores put the feature name in a generic "Other" row instead of the
  // title; read the value in that case.
  const label = item.label.toLowerCase();
  const target = /^(other|additional|ek|notes)/.test(label) ? text : label;

  if (/ray\s*tracing|raytracing|lancer de rayons|strahlverfolgung|trazado de rayos|ışın izleme|işın izleme/.test(target)) {
    if (!facts.dx12FeaturesKnown) return { status: "manual", detected: "—" };
    const needs12 = /\b1[.,]2\b/.test(text);
    const needs11 = /\b1[.,]1\b/.test(text) || needs12;
    const tier = facts.raytracingTier;
    const supported = needs12 ? tier >= 12 : needs11 ? tier >= 11 : tier >= 10;
    const detected = tier >= 12 ? "DXR 1.2" : tier >= 11 ? "DXR 1.1" : tier >= 10 ? "DXR 1.0" : "—";
    return { status: status(supported), detected };
  }

  if (/mesh\s*shader|mesh-shader|nuanceur de maillage|mesh gölgelendirici/.test(target)) {
    if (!facts.dx12FeaturesKnown) return { status: "manual", detected: "—" };
    const supported = facts.meshShaderTier >= 10;
    return { status: status(supported), detected: supported ? "Mesh Shader Tier 1" : "—" };
  }

  if (/variable\s*rate\s*shading|\bvrs\b|taux de rafraîchissement variable|değişken hızlı gölgelendirme/.test(target)) {
    if (!facts.dx12FeaturesKnown) return { status: "manual", detected: "—" };
    const tier = facts.shadingRateTier;
    const needs2 = /\btier\s*2\b|\b2\b/.test(text);
    const supported = needs2 ? tier >= 2 : tier >= 1;
    const detected = tier >= 2 ? "VRS Tier 2" : tier >= 1 ? "VRS Tier 1" : "—";
    return { status: status(supported), detected };
  }

  if (/sampler\s*feedback|rétroaction d'échantillonnage|örnekleyici geri bildirimi/.test(target)) {
    if (!facts.dx12FeaturesKnown) return { status: "manual", detected: "—" };
    const tier = facts.samplerFeedbackTier;
    const needs10 = /\b1[.,]0\b/.test(text);
    const supported = needs10 ? tier >= 100 : tier >= 90;
    const detected = tier >= 100 ? "Sampler Feedback 1.0" : tier >= 90 ? "Sampler Feedback 0.9" : "—";
    return { status: status(supported), detected };
  }

  return { status: "manual", detected: "—" };
}

function checkCpu(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = cpuDetected(facts);
  if (!detected) return null;
  // A row can list alternatives ("6 cores or 4 cores") or a pair
  // ("4 cores / 8 threads"): the easiest alternative is the threshold.
  const requirements = [
    ...required.matchAll(
      /(\d+)(?:\s+(?:hardware|cpu|logical|physical|işlemci))*\s*(cores?|threads?|çekirdek|iş parçacığı)/gi,
    ),
  ];
  // Rows also spell the count out: "Dual core CPU", "quad-core processor".
  const wordCores: Record<string, number> = {
    single: 1,
    dual: 2,
    triple: 3,
    quad: 4,
    penta: 5,
    hexa: 6,
    six: 6,
    octa: 8,
    eight: 8,
    deca: 10,
    ten: 10,
    twelve: 12,
  };
  const spelledCores = [
    ...required.matchAll(
      /\b(single|dual|triple|quad|penta|hexa|six|octa|eight|deca|ten|twelve)[\s-]*cores?\b/gi,
    ),
  ].map((match) => wordCores[match[1].toLowerCase()]);
  const coreNeeds = [
    ...requirements
      .filter((match) => /core|çekirdek/i.test(match[2]))
      .map((match) => Number(match[1])),
    ...spelledCores,
  ];
  const threadNeeds = requirements
    .filter((match) => /thread|iş parçacığı/i.test(match[2]))
    .map((match) => Number(match[1]));
  const coreNeed = coreNeeds.length > 0 ? Math.min(...coreNeeds) : 0;
  const threadNeed = threadNeeds.length > 0 ? Math.min(...threadNeeds) : 0;
  const hasCounts = coreNeed > 0 || threadNeed > 0;
  if (
    (coreNeed > 0 && facts.physicalCores <= 0) ||
    (threadNeed > 0 && facts.logicalCores <= 0)
  ) {
    return { status: "manual", detected };
  }
  if (
    (coreNeed > 0 && facts.physicalCores < coreNeed) ||
    (threadNeed > 0 && facts.logicalCores < threadNeed)
  ) {
    return { status: "fail", detected };
  }
  const namesModel = /intel|amd|ryzen|core\s*i[3579]|core\s*ultra|apple\s*m\d|phenom|athlon|fx[-\s]?\d|processor/i.test(required);
  if (namesModel) {
    const score = compareHardwareScore("cpu", facts.cpu, required);
    if (score) return { status: score, detected, scored: true };
    // A core count next to an unknown model proves only half the row.
    return { status: hasCounts ? "partial" : "manual", detected };
  }
  return { status: hasCounts ? "ok" : "manual", detected };
}

function checkGpu(required: string, facts: PcFacts): RequirementCheck | null {
  const detected = gpuDetected(facts);
  if (!detected) return null;
  const vramValues = parseSizeValuesGb(required);
  const hasVram = vramValues.length > 0 && facts.gpuMemoryMb > 0;
  if (hasVram) {
    // A GPU row can list two cards; the smaller card is the threshold.
    const needed = Math.min(...vramValues);
    const has = facts.gpuMemoryMb / 1024;
    // Rust reports nominal VRAM (7891 MiB becomes 8192), but a non-Windows
    // backend can still round differently; half a gigabyte covers that.
    if (has + 0.5 < needed) return { status: "fail", detected };
  }
  const namesModel = /nvidia|geforce|gtx|rtx|radeon|rx\s*\d|arc\s*a\d|intel|amd/i.test(required);
  if (namesModel) {
    const score = compareHardwareScore("gpu", facts.gpu, required);
    if (score) {
      // A named model without readable VRAM cannot be confirmed even when the
      // score table likes it.
      if (vramValues.length > 0 && !hasVram && score === "ok") {
        return { status: "partial", detected, scored: true };
      }
      return { status: score, detected, scored: true };
    }
    // The score table starts at DirectX 10 hardware, so a row that only names
    // DirectX 9-era cards ("Radeon HD 2600 XT, nVidia 8600") has no score. A
    // PC at a DirectX 12 feature level is above the whole class the row
    // describes, and the VRAM part of the row was already checked above.
    const rowLevel = requiredDirectXLevel(required);
    if (
      rowLevel !== null &&
      rowLevel <= 100 &&
      Number(facts.directxLevel) >= 120 &&
      (vramValues.length === 0 || hasVram)
    ) {
      return { status: "ok", detected };
    }
    return { status: hasVram ? "partial" : "manual", detected };
  }
  return { status: hasVram ? "ok" : "manual", detected };
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

function driveLabel(drive: string): string {
  return /^[A-Za-z]$/.test(drive) ? `${drive.toUpperCase()}:` : drive;
}

function storageDetected(free: FreeSpace): string {
  if (free.missing && free.drive) {
    return t("storage.driveMissing", { drive: driveLabel(free.drive) });
  }
  const parts = [`${fmtBytes(free.bytes)} ${t("storage.free")}`];
  if (free.drive) parts.push(driveLabel(free.drive));
  if (free.isSsd === true) parts.push("SSD");
  else if (free.isSsd === false) parts.push("HDD");
  return parts.join(" · ");
}

function checkStorage(required: string, installPath?: string | null): RequirementCheck | null {
  const free = freeSpace(installPath);
  if (free.missing) {
    return { status: "manual", detected: storageDetected(free) };
  }
  if (free.bytes <= 0) return null;
  const detected = storageDetected(free);
  const values = parseSizeValuesGb(required);
  const ssdMentioned = /\bssd\b/i.test(required);
  const ssdRecommended = /recommend|öneril|empfohlen|recommand|recomend/i.test(required);
  // A modern game can require an SSD; a HDD with enough free space would
  // otherwise pass the size test and stutter in play.
  if (ssdMentioned && !ssdRecommended && free.isSsd === false) {
    return { status: "fail", detected };
  }
  if (ssdMentioned && free.isSsd === null) {
    return { status: "manual", detected };
  }
  if (ssdMentioned && !ssdRecommended && free.isSsd === true && values.length === 0) {
    return { status: "ok", detected };
  }
  if (values.length === 0 || !free.exact) return { status: "manual", detected };
  const diskPassed = free.bytes / 1024 ** 3 + 0.5 >= values[0];
  if (!diskPassed) return { status: "fail", detected };
  if (ssdMentioned && ssdRecommended && free.isSsd === false) {
    return { status: "partial", detected };
  }
  return { status: "ok", detected };
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
    case "directx": return checkDirectX(required, facts);
    case "feature": return checkGraphicsFeature(item, required, facts);
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
  if (checks.some((check) => check.status === "partial")) return "partial";
  const ok = checks.filter((check) => check.status === "ok").length;
  const pending = checks.filter(
    (check) => check.status === "manual" || check.status === "unknown",
  ).length;
  if (pending > 0) return ok > 0 ? "partial" : "unknown";
  return ok > 0 ? "ok" : "unknown";
}
