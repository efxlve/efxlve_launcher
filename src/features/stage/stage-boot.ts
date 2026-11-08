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

/** Main's render branch calls this; it never blocks the desktop. */
export function renderStageBoot(): void {
  if (!S.stage.active) {
    document.getElementById("stage-root")?.remove();
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
