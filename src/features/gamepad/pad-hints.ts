/**
 * Controller hint markup shared by the HUD, the couch shell and the settings
 * preview. The glyph shows the physical button for the detected pad family.
 */

import { psShapeFor, psShapeSvg } from "../../core/controller-glyphs";
import type { ControllerKind } from "../../core/types";

export type FaceButton = "a" | "b" | "x" | "y";

/** Face-button glyph: PlayStation pads get their geometric shapes instead of A/B/X/Y. */
export function faceGlyph(kind: ControllerKind, btn: FaceButton): string {
  if (kind === "playstation") {
    return `<span class="gp-glyph gp-face ps-${psShapeFor(btn)}">${psShapeSvg(btn)}</span>`;
  }
  return `<span class="gp-glyph gp-face gp-${btn}">${btn.toUpperCase()}</span>`;
}

/** One shoulder glyph: LB/RB on Xbox and generic pads, L1/R1 elsewhere. */
export function bumperGlyph(kind: ControllerKind, side: "l" | "r"): string {
  const label = kind === "xbox" || kind === "generic"
    ? (side === "l" ? "LB" : "RB")
    : (side === "l" ? "L1" : "R1");
  return `<span class="gp-glyph gp-bumper">${label}</span>`;
}

/** Both shoulder glyphs, side by side. */
export function bumperGlyphs(kind: ControllerKind): string {
  return `${bumperGlyph(kind, "l")}${bumperGlyph(kind, "r")}`;
}

/** One trigger glyph: LT/RT on Xbox and generic pads, L2/R2 elsewhere. */
export function triggerGlyph(kind: ControllerKind, side: "l" | "r"): string {
  const label = kind === "xbox" || kind === "generic"
    ? (side === "l" ? "LT" : "RT")
    : (side === "l" ? "L2" : "R2");
  return `<span class="gp-glyph gp-bumper">${label}</span>`;
}

/** Both trigger glyphs, side by side. */
export function triggerGlyphs(kind: ControllerKind): string {
  return `${triggerGlyph(kind, "l")}${triggerGlyph(kind, "r")}`;
}

export function systemGlyph(label: string): string {
  return `<span class="gp-glyph gp-system">${label}</span>`;
}

export function hudItem(glyphs: string, label: string): string {
  return `<div class="gp-hud-item">${glyphs} <span>${label}</span></div>`;
}
