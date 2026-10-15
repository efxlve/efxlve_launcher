/**
 * Boot timing marks.
 *
 * "The launcher takes long to come up" is only fixable with numbers, so the
 * boot path drops a few marks: the shell paint, the library paints and the
 * moment the boot IPC settles. In the desktop app the marks also land in
 * `<app_data>/perf.log` through the `perf_mark` command, so a user can send
 * that file when a start feels slow; in the browser they only reach the
 * console.
 *
 * The marks are cheap by design: a number, a console line in dev builds, and a
 * fire-and-forget IPC call that never blocks the caller.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./constants";

const started = performance.timeOrigin;
const marks: { label: string; ms: number }[] = [];

/** Records one boot mark. Call it at most once per label. */
export function perfMark(label: string): void {
  // Absolute milliseconds since navigation start, so the marks read like a
  // timeline even when they are collected from different files.
  const ms = Math.round(performance.now());
  marks.push({ label, ms });
  if (import.meta.env.DEV) console.debug(`[perf] ${label}: ${ms} ms`);
  if (isTauri) void invoke("perf_mark", { label, ms }).catch(() => {});
  // Also keep them on `window` for support: a slow start can be reported by
  // opening the devtools and reading `__perfMarks`.
  (window as unknown as { __perfMarks?: unknown }).__perfMarks = marks;
}

/** One line per mark, for the console or a bug report. */
export function perfSummary(): string {
  return marks.map((mark) => `${String(mark.ms).padStart(6)} ms  ${mark.label}`).join("\n");
}
