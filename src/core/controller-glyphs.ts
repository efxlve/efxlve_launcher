/**
 * Shared face-button glyphs for controller hints.
 *
 * The general icon set draws the square filled and the circle/triangle as
 * outlines, which reads as three different button styles at keycap size. These
 * paths use one stroke weight for all four PlayStation shapes.
 */

export type FaceButton = "a" | "b" | "x" | "y";
export type PSShape = "cross" | "circle" | "square" | "triangle";

const PS_SHAPES: Record<PSShape, string> = {
  cross: '<path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/>',
  circle: '<circle cx="12" cy="12" r="6.4"/>',
  square: '<rect x="6.6" y="6.6" width="10.8" height="10.8" rx="0.9"/>',
  triangle: '<path d="M12 5.8 19.1 18H4.9z"/>',
};

const PS_FOR_BUTTON: Record<FaceButton, PSShape> = {
  a: "cross",
  b: "circle",
  x: "square",
  y: "triangle",
};

/** The PlayStation shape that sits on this face button. */
export function psShapeFor(button: FaceButton): PSShape {
  return PS_FOR_BUTTON[button];
}

/** One outline-style glyph for a PlayStation face button. */
export function psShapeSvg(button: FaceButton, size = 12): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PS_SHAPES[PS_FOR_BUTTON[button]]}</svg>`;
}
