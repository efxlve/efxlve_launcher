/**
 * Toast notification helper.
 *
 * Renders a short-lived message into the `#toasts` container. Errors stay a
 * little longer than confirmations and are capped at three visible entries so
 * a burst of failures cannot flood the screen. A click dismisses early.
 */

import { localizeMessage } from "../i18n";
import { toastsEl } from "./dom";

/** Show a toast. `kind` selects the visual state (ok/err/neutral). */
export function toast(msg: string, kind: "ok" | "err" | "" = ""): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = localizeMessage(msg);
  const life = kind === "err" ? 6000 : 3500;
  const timer = window.setTimeout(() => el.remove(), life);
  el.addEventListener("click", () => {
    window.clearTimeout(timer);
    el.remove();
  });
  toastsEl.appendChild(el);
  if (kind === "err") {
    const errs = toastsEl.querySelectorAll(".toast.err");
    while (errs.length > 3) errs[0]?.remove();
  }
}
