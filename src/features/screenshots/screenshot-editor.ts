/**
 * Screenshot editor: crop, rotate, annotate, redact, then save a copy.
 *
 * Canvas-based and dependency-free. Every edit is a command on a stack, so undo
 * and redo are exact (the stack is replayed from the original image instead of
 * keeping snapshots around) and the saved PNG always matches what the preview
 * shows. Nothing overwrites the original unless the user asks for it and the
 * file is a PNG.
 *
 * Opened from the Screenshots page's lightbox and from the game page's gallery.
 */

import { icon } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { epicGetScreenshotFullData, epicSaveEditedScreenshot, type GameScreenshotItem } from "../../epic";

type EditorTool = "crop" | "pen" | "arrow" | "rect" | "mosaic" | "text";

interface Point {
  x: number;
  y: number;
}

type Command =
  | { kind: "crop"; x: number; y: number; w: number; h: number }
  | { kind: "rotate"; dir: 1 | -1 }
  | { kind: "flip"; axis: "h" | "v" }
  | { kind: "stroke"; points: Point[]; color: string; size: number }
  | { kind: "arrow"; from: Point; to: Point; color: string; size: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: string; size: number }
  | { kind: "mosaic"; x: number; y: number; w: number; h: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number };

/** Colors offered by the palette; the first is the default. */
const COLORS = ["#ff3b30", "#ffd60a", "#2fb36d", "#4aa8ff", "#ffffff", "#000000"];
const SIZES = [3, 6, 12];

let root: HTMLElement | null = null;
let item: GameScreenshotItem | null = null;
let base: HTMLImageElement | null = null;
let baseW = 0;
let baseH = 0;
let canvas: HTMLCanvasElement | null = null;
let commands: Command[] = [];
let redoStack: Command[] = [];
let tool: EditorTool = "pen";
let color = COLORS[0];
let size = SIZES[1];
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;
let cropRect: { x: number; y: number; w: number; h: number } | null = null;
let busy = false;

export function editorOpen(): boolean {
  return root !== null;
}

export function closeScreenshotEditor(): void {
  root?.remove();
  root = null;
  item = null;
  base = null;
  canvas = null;
  commands = [];
  redoStack = [];
  dragStart = null;
  dragCurrent = null;
  cropRect = null;
}

/* ---------- Canvas plumbing ---------- */

function ctx(): CanvasRenderingContext2D | null {
  return canvas ? canvas.getContext("2d") : null;
}

/** The box the commands end up with: crops shrink it, rotations swap it. */
function replaySize(): { width: number; height: number } {
  let width = baseW;
  let height = baseH;
  for (const command of commands) {
    if (command.kind === "crop") {
      width = command.w;
      height = command.h;
    } else if (command.kind === "rotate") {
      [width, height] = [height, width];
    }
  }
  return { width, height };
}

/** Applies one command's transform, in image coordinates. */
function applyTransform(context: CanvasRenderingContext2D, command: Command, box: { w: number; h: number }): void {
  if (command.kind === "crop") {
    context.translate(-command.x, -command.y);
    box.w = command.w;
    box.h = command.h;
    return;
  }
  if (command.kind === "rotate") {
    const { w, h } = box;
    if (command.dir === 1) {
      context.translate(h, 0);
      context.rotate(Math.PI / 2);
    } else {
      context.translate(0, w);
      context.rotate(-Math.PI / 2);
    }
    box.w = h;
    box.h = w;
    return;
  }
  if (command.kind === "flip") {
    if (command.axis === "h") {
      context.translate(box.w, 0);
      context.scale(-1, 1);
    } else {
      context.translate(0, box.h);
      context.scale(1, -1);
    }
  }
}

function drawShape(context: CanvasRenderingContext2D, command: Command): void {
  if (command.kind === "stroke") {
    if (command.points.length < 2) return;
    context.strokeStyle = command.color;
    context.lineWidth = command.size;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(command.points[0].x, command.points[0].y);
    for (const point of command.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    return;
  }
  if (command.kind === "rect") {
    context.strokeStyle = command.color;
    context.lineWidth = command.size;
    context.strokeRect(command.x, command.y, command.w, command.h);
    return;
  }
  if (command.kind === "arrow") {
    const { from, to } = command;
    context.strokeStyle = command.color;
    context.fillStyle = command.color;
    context.lineWidth = command.size;
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(10, command.size * 4);
    context.beginPath();
    context.moveTo(to.x, to.y);
    context.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
    context.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
    context.closePath();
    context.fill();
    return;
  }
  if (command.kind === "mosaic" && base) {
    const blocks = Math.max(2, Math.round(Math.min(command.w, command.h) / 12));
    const tiny = document.createElement("canvas");
    tiny.width = Math.max(1, blocks);
    tiny.height = Math.max(1, Math.round((blocks * command.h) / Math.max(1, command.w)));
    const tinyCtx = tiny.getContext("2d");
    if (!tinyCtx) return;
    tinyCtx.drawImage(base, command.x, command.y, command.w, command.h, 0, 0, tiny.width, tiny.height);
    context.imageSmoothingEnabled = false;
    context.drawImage(tiny, 0, 0, tiny.width, tiny.height, command.x, command.y, command.w, command.h);
    context.imageSmoothingEnabled = true;
    return;
  }
  if (command.kind === "text") {
    context.fillStyle = command.color;
    context.font = `600 ${command.size * 4}px ui-sans-serif, system-ui, sans-serif`;
    context.textBaseline = "top";
    // A dark outline keeps light text readable on bright screenshots.
    context.lineWidth = Math.max(2, command.size);
    context.strokeStyle = "rgba(0, 0, 0, 0.65)";
    context.strokeText(command.text, command.x, command.y);
    context.fillText(command.text, command.x, command.y);
  }
}

/** Repaints the whole stack; cheap enough to run on every pointer move. */
function paint(): void {
  const context = ctx();
  if (!context || !base || !canvas) return;
  const { width, height } = replaySize();
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  const box = { w: baseW, h: baseH };
  for (const command of commands) applyTransform(context, command, box);
  context.drawImage(base, 0, 0);
  context.restore();

  context.save();
  const shapeBox = { w: baseW, h: baseH };
  for (const command of commands) {
    applyTransform(context, command, shapeBox);
    drawShape(context, command);
  }
  context.restore();

  // Live overlays: the crop rectangle and the in-progress drag.
  context.save();
  const liveBox = { w: baseW, h: baseH };
  for (const command of commands) applyTransform(context, command, liveBox);
  const overlay = tool === "crop" ? cropRect : null;
  if (overlay) {
    context.setLineDash([6, 4]);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect(overlay.x, overlay.y, overlay.w, overlay.h);
    context.setLineDash([]);
  }
  if (dragStart && dragCurrent && tool !== "crop") {
    context.strokeStyle = color;
    context.lineWidth = size;
    if (tool === "rect") {
      context.strokeRect(
        Math.min(dragStart.x, dragCurrent.x),
        Math.min(dragStart.y, dragCurrent.y),
        Math.abs(dragCurrent.x - dragStart.x),
        Math.abs(dragCurrent.y - dragStart.y),
      );
    } else if (tool === "mosaic") {
      context.setLineDash([6, 4]);
      context.strokeRect(
        Math.min(dragStart.x, dragCurrent.x),
        Math.min(dragStart.y, dragCurrent.y),
        Math.abs(dragCurrent.x - dragStart.x),
        Math.abs(dragCurrent.y - dragStart.y),
      );
      context.setLineDash([]);
    }
  }
  context.restore();
}

/** Pointer position in image coordinates (the canvas is shown scaled). */
function toImage(event: PointerEvent): Point | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function push(command: Command): void {
  commands.push(command);
  redoStack = [];
  paint();
  updateToolbar();
}

/* ---------- Interactions ---------- */

function wireCanvas(): void {
  if (!canvas) return;
  canvas.addEventListener("pointerdown", (event) => {
    if (!canvas) return;
    const point = toImage(event);
    if (!point) return;
    canvas.setPointerCapture(event.pointerId);
    dragStart = point;
    dragCurrent = point;
    if (tool === "crop") cropRect = null;
    if (tool === "pen") {
      push({ kind: "stroke", points: [point], color, size });
      dragStart = point;
    }
    if (tool === "text") {
      const text = window.prompt(t("ss.editTextPrompt"));
      if (text && text.trim()) push({ kind: "text", x: point.x, y: point.y, text: text.trim(), color, size });
      dragStart = null;
      dragCurrent = null;
    }
  });
  canvas.addEventListener("pointermove", (event) => {
    const point = toImage(event);
    if (!point || !dragStart) return;
    if (tool === "pen") {
      const last = commands[commands.length - 1];
      if (last && last.kind === "stroke") {
        last.points.push(point);
        paint();
      }
      return;
    }
    dragCurrent = point;
    if (tool === "crop") {
      cropRect = {
        x: Math.min(dragStart.x, point.x),
        y: Math.min(dragStart.y, point.y),
        w: Math.abs(point.x - dragStart.x),
        h: Math.abs(point.y - dragStart.y),
      };
    }
    paint();
  });
  canvas.addEventListener("pointerup", (event) => {
    const point = toImage(event);
    canvas?.releasePointerCapture(event.pointerId);
    if (!point || !dragStart) {
      dragStart = null;
      dragCurrent = null;
      return;
    }
    const start = dragStart;
    dragStart = null;
    dragCurrent = null;
    if (tool === "arrow" && (Math.abs(point.x - start.x) > 4 || Math.abs(point.y - start.y) > 4)) {
      push({ kind: "arrow", from: start, to: point, color, size });
      return;
    }
    if (tool === "rect") {
      const w = Math.abs(point.x - start.x);
      const h = Math.abs(point.y - start.y);
      if (w > 4 && h > 4) {
        push({ kind: "rect", x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), w, h, color, size });
      }
      return;
    }
    if (tool === "mosaic") {
      const w = Math.abs(point.x - start.x);
      const h = Math.abs(point.y - start.y);
      if (w > 4 && h > 4) {
        push({ kind: "mosaic", x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), w, h });
      }
      return;
    }
    // Crop keeps its rectangle pending until "Apply crop": the toolbar's button
    // state has to follow the drag, which only ends here.
    paint();
    updateToolbar();
  });
}

/* ---------- Toolbar ---------- */

function toolButton(id: EditorTool, label: string, iconName: Parameters<typeof icon>[0]): string {
  return `<button type="button" class="ss-edit-tool${tool === id ? " active" : ""}" data-act="sse-tool" data-tool="${id}" title="${esc(label)}">${icon(iconName, 15)}<span>${esc(label)}</span></button>`;
}

function updateToolbar(): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>(".ss-edit-tool").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
  const undo = root.querySelector<HTMLButtonElement>('[data-act="sse-undo"]');
  if (undo) undo.disabled = commands.length === 0;
  const redo = root.querySelector<HTMLButtonElement>('[data-act="sse-redo"]');
  if (redo) redo.disabled = redoStack.length === 0;
  const crop = root.querySelector<HTMLButtonElement>('[data-act="sse-crop-apply"]');
  if (crop) crop.disabled = !cropRect;
}

function toolbarHtml(): string {
  return `
    <div class="ss-edit-bar">
      <div class="ss-edit-tools">
        ${toolButton("crop", t("ss.editCrop"), "minimize-2")}
        ${toolButton("pen", t("ss.editPen"), "edit")}
        ${toolButton("arrow", t("ss.editArrow"), "arrow-right")}
        ${toolButton("rect", t("ss.editRect"), "square")}
        ${toolButton("mosaic", t("ss.editMosaic"), "eye-off")}
        ${toolButton("text", t("ss.editText"), "hash")}
      </div>
      <div class="ss-edit-tools">
        <button type="button" class="ss-edit-tool" data-act="sse-rotate" data-dir="-1" title="${esc(t("ss.editRotateLeft"))}">${icon("arrow-left", 15)}</button>
        <button type="button" class="ss-edit-tool" data-act="sse-rotate" data-dir="1" title="${esc(t("ss.editRotateRight"))}">${icon("arrow-right", 15)}</button>
        <button type="button" class="ss-edit-tool" data-act="sse-flip" data-axis="h" title="${esc(t("ss.editFlipH"))}">${icon("arrow-left-right", 15)}</button>
        <button type="button" class="ss-edit-tool" data-act="sse-flip" data-axis="v" title="${esc(t("ss.editFlipV"))}">${icon("arrow-down-a-z", 15)}</button>
      </div>
      <div class="ss-edit-tools">
        ${COLORS.map((value) => `<button type="button" class="ss-edit-color${value === color ? " active" : ""}" data-act="sse-color" data-color="${value}" style="--swatch:${value}" title="${value}"></button>`).join("")}
        ${SIZES.map((value) => `<button type="button" class="ss-edit-size${value === size ? " active" : ""}" data-act="sse-size" data-size="${value}" title="${value} px"><span style="width:${value + 2}px;height:${value + 2}px"></span></button>`).join("")}
      </div>
      <div class="ss-edit-tools">
        <button type="button" class="btn ghost small" data-act="sse-undo" disabled>${icon("chevron-left", 13)} ${t("ss.editUndo")}</button>
        <button type="button" class="btn ghost small" data-act="sse-redo" disabled>${t("ss.editRedo")} ${icon("chevron-right", 13)}</button>
        <button type="button" class="btn ghost small" data-act="sse-reset">${t("ss.editReset")}</button>
        <button type="button" class="btn primary small" data-act="sse-crop-apply" disabled>${t("ss.editCropApply")}</button>
      </div>
    </div>`;
}

/* ---------- Open / save ---------- */

export function openScreenshotEditor(shot: GameScreenshotItem): void {
  if (root) closeScreenshotEditor();
  item = shot;
  commands = [];
  redoStack = [];
  tool = "pen";
  root = document.createElement("div");
  root.id = "ss-editor-root";
  document.body.appendChild(root);
  root.innerHTML = `
    <div class="modal-backdrop ss-edit-backdrop" data-act="sse-backdrop">
      <div class="ss-edit-box" role="dialog" aria-modal="true">
        <div class="ss-edit-head">
          <span class="ss-edit-title">${icon("edit", 15)} <span>${esc(t("ss.edit"))}</span></span>
          <span class="ss-edit-name">${esc(shot.file_name)}</span>
          <div class="ss-edit-head-actions">
            <button type="button" class="btn ghost small" data-act="sse-save-copy">${icon("copy", 13)} ${t("ss.editSaveCopy")}</button>
            ${shot.file_name.toLowerCase().endsWith(".png") ? `<button type="button" class="btn ghost danger small" data-act="sse-save-replace">${icon("check", 13)} ${t("ss.editSaveReplace")}</button>` : ""}
            <button type="button" class="btn ghost small" data-act="sse-close" title="${t("common.close")} (ESC)">${icon("x", 14)}</button>
          </div>
        </div>
        ${toolbarHtml()}
        <div class="ss-edit-stage">
          <div class="ss-edit-loading"><span class="hltb-spinner" style="width:28px;height:28px;border-width:3px"></span></div>
          <canvas class="ss-edit-canvas" hidden></canvas>
        </div>
        <div class="ss-edit-hint">${esc(t("ss.editHint"))}</div>
      </div>
    </div>`;

  void epicGetScreenshotFullData(shot.file_path)
    .then((dataUrl) => {
      const image = new Image();
      image.onload = () => {
        base = image;
        baseW = image.naturalWidth;
        baseH = image.naturalHeight;
        canvas = root?.querySelector<HTMLCanvasElement>(".ss-edit-canvas") ?? null;
        const loading = root?.querySelector<HTMLElement>(".ss-edit-loading");
        if (loading) loading.hidden = true;
        if (canvas) canvas.hidden = false;
        wireCanvas();
        paint();
        updateToolbar();
      };
      image.onerror = () => toast(t("ss.editLoadFailed"), "err");
      image.src = dataUrl;
    })
    .catch((error) => toast(String(error), "err"));
}

async function save(replace: boolean): Promise<void> {
  if (!canvas || !item || busy) return;
  busy = true;
  try {
    const dataUrl = canvas.toDataURL("image/png");
    const saved = await epicSaveEditedScreenshot(item.file_path, dataUrl, replace);
    toast(t(replace ? "ss.editSavedReplace" : "ss.editSaved", { file: saved.split(/[\\/]/).pop() ?? "" }), "ok");
    closeScreenshotEditor();
    window.dispatchEvent(new CustomEvent("screenshots-changed"));
  } catch (error) {
    toast(String(error), "err");
  } finally {
    busy = false;
  }
}

/* ---------- Actions ---------- */

export function handleScreenshotEditorAction(act: string | undefined, el: HTMLElement, targetEl?: HTMLElement): boolean {
  if (!act?.startsWith("sse-")) return false;
  switch (act) {
    case "sse-tool": {
      const next = el.dataset.tool as EditorTool | undefined;
      if (next) {
        tool = next;
        if (next !== "crop") cropRect = null;
        paint();
        updateToolbar();
      }
      return true;
    }
    case "sse-color": {
      const value = el.dataset.color;
      if (value) {
        color = value;
        root?.querySelectorAll(".ss-edit-color").forEach((node) => node.classList.toggle("active", node === el));
      }
      return true;
    }
    case "sse-size": {
      const value = Number(el.dataset.size ?? "0");
      if (value > 0) {
        size = value;
        root?.querySelectorAll(".ss-edit-size").forEach((node) => node.classList.toggle("active", node === el));
      }
      return true;
    }
    case "sse-rotate": {
      const dir = Number(el.dataset.dir ?? "1") === -1 ? -1 : 1;
      push({ kind: "rotate", dir: dir as 1 | -1 });
      return true;
    }
    case "sse-flip": {
      const axis = el.dataset.axis === "v" ? "v" : "h";
      push({ kind: "flip", axis });
      return true;
    }
    case "sse-undo": {
      const last = commands.pop();
      if (last) {
        redoStack.push(last);
        if (last.kind === "crop") cropRect = null;
        paint();
        updateToolbar();
      }
      return true;
    }
    case "sse-redo": {
      const next = redoStack.pop();
      if (next) push(next);
      return true;
    }
    case "sse-reset":
      commands = [];
      redoStack = [];
      cropRect = null;
      paint();
      updateToolbar();
      return true;
    case "sse-crop-apply":
      if (cropRect && cropRect.w > 8 && cropRect.h > 8) {
        push({ kind: "crop", ...cropRect });
        cropRect = null;
      }
      return true;
    case "sse-save-copy":
      void save(false);
      return true;
    case "sse-save-replace":
      void save(true);
      return true;
    case "sse-close":
      closeScreenshotEditor();
      return true;
    case "sse-backdrop":
      if (targetEl === el) closeScreenshotEditor();
      return true;
    default:
      return false;
  }
}
