/**
 * Toast notification helper.
 *
 * Renders a short-lived message into the `#toasts` container. Error toasts are
 * clickable to copy their text and are capped at three visible entries so a
 * burst of failures cannot flood the screen.
 */

import { toastsEl } from "./dom";

/** Show a toast. `kind` selects the visual state (ok/err/neutral). */
export function toast(msg: string, kind: "ok" | "err" | "" = ""): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (kind === "err") {
    el.title = "Click to copy";
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      const text = el.textContent ?? "";
      const done = (): void => el.remove();
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done);
      else done();
    });
    toastsEl.appendChild(el);
    const errs = toastsEl.querySelectorAll(".toast.err");
    while (errs.length > 3) errs[0]?.remove();
    return;
  }
  toastsEl.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
