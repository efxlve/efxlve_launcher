/**
 * A stage for the store's own screenshots.
 *
 * They are remote images, not files in the player's gallery, so they get this
 * small viewer instead of the gallery's lightbox: the whole point of the
 * feedback was that clicking one used to leave the launcher entirely.
 * Escape, the backdrop and the close button all dismiss it.
 */

import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";

let open = false;

/** True while the stage is up; the Escape chain asks this first. */
export function storeShotViewerOpen(): boolean {
  return open;
}

export function openStoreShot(url: string, title: string): void {
  if (!url) return;
  open = true;
  let root = document.getElementById("store-shot-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "store-shot-root";
    document.body.appendChild(root);
  }
  root.innerHTML = `
    <div class="store-shot-layer" data-act="close-store-shot">
      <figure class="store-shot-stage" data-act="prevent-modal-close">
        <img src="${esc(url)}" alt="${esc(title)}" decoding="async" />
        <figcaption>
          <span class="store-shot-name">${esc(title)}</span>
          <button type="button" class="icon-btn store-shot-close" data-act="close-store-shot" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
        </figcaption>
      </figure>
    </div>`;
}

export function closeStoreShot(): void {
  open = false;
  document.getElementById("store-shot-root")?.replaceChildren();
}
