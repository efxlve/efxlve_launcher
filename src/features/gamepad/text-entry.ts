/**
 * Text editing for the controller keyboard.
 *
 * Kept as a pure function so the caret and selection rules can be tested
 * without a DOM; the keyboard module applies the result to the real field and
 * dispatches the input event the launcher already listens for.
 */

export interface TextEdit {
  value: string;
  /** Collapsed caret position after the edit. */
  caret: number;
}

/** Keys the controller keyboard sends as commands instead of characters. */
export type TextCommand = "backspace" | "space" | "clear" | "left" | "right";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply one command or one typed character.
 *
 * `start` and `end` are the current selection; a forward selection is
 * normalised, and an empty selection is a collapsed caret. The caller keeps
 * the field's maxLength contract by passing the limit (0 = no limit).
 */
export function applyTextEdit(
  value: string,
  start: number,
  end: number,
  key: string,
  maxLength = 0,
): TextEdit {
  const length = value.length;
  let from = clamp(Math.min(start, end), 0, length);
  let to = clamp(Math.max(start, end), 0, length);

  if (key === "left") return { value, caret: Math.max(0, from - 1) };
  if (key === "right") return { value, caret: Math.min(length, to + 1) };

  if (key === "backspace") {
    if (from !== to) {
      return { value: value.slice(0, from) + value.slice(to), caret: from };
    }
    if (from === 0) return { value, caret: 0 };
    return { value: value.slice(0, from - 1) + value.slice(to), caret: from - 1 };
  }

  if (key === "clear") return { value: "", caret: 0 };

  const text = key === "space" ? " " : key;
  if (!text) return { value, caret: to };

  const room = maxLength > 0 ? Math.max(0, maxLength - (value.length - (to - from))) : text.length;
  let inserted = text.slice(0, room);
  // Never leave half of a surrogate pair in the field when maxlength cuts it.
  if (/[\uD800-\uDBFF]$/.test(inserted)) inserted = inserted.slice(0, -1);
  if (!inserted) return { value, caret: to };

  return {
    value: value.slice(0, from) + inserted + value.slice(to),
    caret: from + inserted.length,
  };
}

/** True for a field the on-screen keyboard can type into. */
export function isTextEntryTarget(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly;
  }
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.disabled || el.readOnly) return false;
  // These input types have no caret and reject setRangeText.
  return ["text", "search", "email", "url", "password", "tel", "number"].includes(el.type);
}
