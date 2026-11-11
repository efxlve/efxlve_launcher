/**
 * Lazy entry for the Stage shell.
 *
 * The desktop bundle keeps only this tiny module, the mode state and the
 * gamepad bridge. The first Stage entry pays one short dynamic import; the
 * subsequent renders call the already-loaded renderer directly.
 */

import { S } from "../../core/state";

type StageRenderer = () => void;

let renderer: StageRenderer | null = null;
let loading: Promise<boolean> | null = null;
/** A chunk load is in flight: the boot frame owns the screen even though
 *  `S.stage.active` is still false, so a desktop repaint must not erase it. */
let pending = false;

export function isStageChunkReady(): boolean {
  return renderer !== null;
}

/** Load the shell once. Returns false when the chunk could not be loaded. */
export function ensureStageChunk(): Promise<boolean> {
  if (renderer) return Promise.resolve(true);
  if (loading) return loading;
  loading = import("./stage-render")
    .then((module) => {
      renderer = module.renderStage;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      loading = null;
    });
  return loading;
}

function paintBootFrame(): void {
  let root = document.getElementById("stage-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "stage-root";
    root.className = "stage-root stage-route-home";
    root.innerHTML = `<div class="stage-boot">
      <span class="stage-brand-name">EFXLVE</span>
      <span class="stage-brand-mode">STAGE</span>
      <span class="stage-boot-line"></span>
    </div>`;
    document.body.appendChild(root);
  }
}

/** Show the boot frame before the lazy chunk is available. A cold first
 *  entry must answer the button press immediately instead of doing nothing. */
export function beginStageBoot(): void {
  pending = true;
  paintBootFrame();
}

/** The chunk resolved or failed; the normal render branch owns the root now. */
export function endStageBoot(): void {
  pending = false;
}

/** Clear the boot frame after a failed entry. */
export function clearStageBoot(): void {
  pending = false;
  if (!S.stage.active) document.getElementById("stage-root")?.remove();
}

/** Main's render branch calls this; it never blocks the desktop. */
export function renderStageBoot(): void {
  if (!S.stage.active) {
    if (!pending) document.getElementById("stage-root")?.remove();
    return;
  }
  if (renderer) {
    renderer();
    return;
  }
  paintBootFrame();
  void ensureStageChunk().then((ok) => {
    if (ok && S.stage.active) renderer?.();
  });
}
