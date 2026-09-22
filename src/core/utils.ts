/**
 * Formatting and sanitization helpers.
 *
 * Most helpers are pure and never touch application state or the DOM. The few
 * user-facing formatters (`fmtPlaytime`, `fmtAchDate`) read the active language
 * through i18n so their output is localized.
 */

import { currentLanguage, t } from "../i18n";

/** Escape a string for safe HTML interpolation. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/** Format megabytes as MB/GB. */
export function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/**
 * Format a transfer rate. When `bits` is true the value is shown in bits per
 * second (Mbps/Kbps), which some users prefer over bytes (MB/s).
 */
export function fmtSpeed(bytesPerSec: number, bits = false): string {
  if (!bytesPerSec || bytesPerSec <= 0) return bits ? "0 bps" : "0 B/s";
  if (bits) {
    const b = bytesPerSec * 8;
    if (b >= 1e9) return `${(b / 1e9).toFixed(1)} Gbps`;
    if (b >= 1e6) return `${(b / 1e6).toFixed(1)} Mbps`;
    if (b >= 1e3) return `${(b / 1e3).toFixed(1)} Kbps`;
    return `${Math.round(b)} bps`;
  }
  if (bytesPerSec >= 1024 ** 3) return `${(bytesPerSec / 1024 ** 3).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/** Format a byte count as MB/GB. */
export function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Format tracked playtime seconds into a short, localized human label. */
export function fmtPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return t("playtime.notPlayed");
  if (seconds < 60) return t("common.lessThanMinute");
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t("common.minutesUnit")}`;
  const hours = seconds / 3600;
  return hours >= 10
    ? `${Math.round(hours)} ${t("common.hoursShort")}`
    : `${hours.toFixed(1)} ${t("common.hoursShort")}`;
}

/** Format an achievement unlock date for the active locale. */
export function fmtAchDate(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(currentLanguage(), { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

/**
 * Format a screenshot epoch timestamp (seconds) as `DD.MM.YYYY HH:MM:SS`.
 * Falls back to the provided string when the timestamp is missing/invalid.
 */
export function formatScreenshotDate(ts: number, fallbackStr?: string): string {
  if (ts && ts > 0) {
    try {
      const d = new Date(ts * 1000);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, "0");
        const month = String(d.getMonth() + 1).padStart(2, "0");
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, "0");
        const mins = String(d.getMinutes()).padStart(2, "0");
        const secs = String(d.getSeconds()).padStart(2, "0");
        return `${day}.${month}.${year} ${hours}:${mins}:${secs}`;
      }
    } catch {
      // Fall through to the fallback string.
    }
  }
  return fallbackStr || "";
}

/**
 * Extract a clean, display-friendly version from Legendary's messy version strings.
 */
export function cleanDisplayVersion(rawVersion?: string | null): { display: string; full: string } {
  if (!rawVersion) return { display: "", full: "" };
  const trimmed = rawVersion.trim();
  if (!trimmed) return { display: "", full: "" };

  // Match a trailing semantic version after underscore/dash/space.
  const trailingSemver = trimmed.match(/(?:[_\-]v?|\bv)(\d+\.\d+(?:\.\d+)*(?:[a-zA-Z0-9_\-]+)?)$/i);
  if (trailingSemver && trailingSemver[1]) {
    const v = trailingSemver[1].replace(/^v/i, "");
    return { display: `v${v}`, full: trimmed };
  }

  const embeddedSemver = trimmed.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  if (embeddedSemver && embeddedSemver[1]) {
    return { display: `v${embeddedSemver[1]}`, full: trimmed };
  }

  if (trimmed.length > 18) {
    return { display: `${trimmed.slice(0, 16)}…`, full: trimmed };
  }

  const display = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed : `v${trimmed}`;
  return { display, full: trimmed };
}

/** Parses "KEY=VALUE" lines into an env var map (blank lines and # comments ignored). */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}
