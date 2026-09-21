/**
 * Pure, side-effect-free formatting and sanitization helpers.
 *
 * These helpers never touch application state or the DOM, which makes them
 * safe to unit-test and reuse from any module.
 */

/** Escape a string for safe HTML interpolation. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/** Format a demo catalog price. */
export function fmtPrice(p: number): string {
  return p === 0 ? "Ücretsiz" : `₺${p.toFixed(2)}`;
}

/** Format megabytes as MB/GB. */
export function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}

/** Format a byte count as MB/GB. */
export function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Format tracked playtime seconds into a short human label. */
export function fmtPlaytime(seconds: number): string {
  if (!seconds || seconds <= 0) return "Oynanmadı";
  if (seconds < 60) return "< 1 dk";
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  const hours = seconds / 3600;
  return hours >= 10 ? `${Math.round(hours)} sa` : `${hours.toFixed(1)} sa`;
}

/** Format an achievement unlock date for the Turkish locale. */
export function fmtAchDate(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
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
