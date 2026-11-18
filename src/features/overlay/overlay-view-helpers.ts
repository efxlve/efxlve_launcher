/**
 * Small DOM helpers shared by the overlay views: an empty/error block and an
 * in-place text patch. Nothing here owns state or imports a view module.
 */

import { icon, type IconName } from "../../core/icons";
import { esc } from "../../core/utils";

export function emptyBlockHtml(
  iconName: IconName,
  title: string,
  desc = "",
  action = "",
): string {
  return `
    <div class="ov-empty-block">
      <div class="ov-empty-icon">${icon(iconName, 24)}</div>
      <div class="ov-empty-title">${esc(title)}</div>
      ${desc ? `<div class="ov-empty-desc">${esc(desc)}</div>` : ""}
      ${action}
    </div>`;
}

/** Patches a live number in place; an empty value keeps the disabled style. */
export function setText(id: string, text: string, empty = false): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("is-empty", empty);
}
