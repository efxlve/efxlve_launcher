/**
 * Media Photo Studio: Professional screenshot editor with color grading presets,
 * live adjustments (brightness, contrast, saturation, warmth, vignette),
 * aspect-ratio crop presets, transform, annotations, watermarking, and clipboard export.
 *
 * Canvas-based and dependency-free.
 */

import { icon } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { epicGetScreenshotFullData, epicSaveEditedScreenshot, type GameScreenshotItem } from "../../epic";

export type EditorTab = "annotate" | "filters" | "adjust" | "crop";
export type EditorTool = "crop" | "pen" | "arrow" | "rect" | "mosaic" | "text";
export type FilterPreset = "none" | "cinematic" | "cyberpunk" | "noir" | "vibrant" | "retro" | "sunset" | "cold";
export type CropAspect = "free" | "16:9" | "21:9" | "4:3" | "1:1" | "9:16";

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

interface Adjustments {
  filter: FilterPreset;
  brightness: number; // -50 to 50
  contrast: number; // -50 to 50
  saturation: number; // -100 to 100
  warmth: number; // -50 to 50
  vignette: number; // 0 to 100
}

const DEFAULT_ADJUSTMENTS: Adjustments = {
  filter: "none",
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  vignette: 0,
};

const COLORS = ["#ff3b30", "#ffd60a", "#2fb36d", "#4aa8ff", "#a855f7", "#ffffff", "#000000"];
const SIZES = [3, 6, 12];

const ASPECT_RATIOS: Record<CropAspect, number | null> = {
  free: null,
  "16:9": 16 / 9,
  "21:9": 21 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "9:16": 9 / 16,
};

let root: HTMLElement | null = null;
let item: GameScreenshotItem | null = null;
let base: HTMLImageElement | null = null;
let baseW = 0;
let baseH = 0;
let canvas: HTMLCanvasElement | null = null;
let commands: Command[] = [];
let redoStack: Command[] = [];
let activeTab: EditorTab = "filters";
let tool: EditorTool = "pen";
let color = COLORS[0];
let size = SIZES[1];
let cropAspect: CropAspect = "free";
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;
let cropRect: { x: number; y: number; w: number; h: number } | null = null;
let adjustments: Adjustments = { ...DEFAULT_ADJUSTMENTS };
let watermarkEnabled = false;
let isComparing = false;
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
  adjustments = { ...DEFAULT_ADJUSTMENTS };
  watermarkEnabled = false;
  isComparing = false;
}

/* ---------- Canvas plumbing ---------- */

function ctx(): CanvasRenderingContext2D | null {
  return canvas ? canvas.getContext("2d") : null;
}

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

function getFilterString(adj: Adjustments): string {
  const parts: string[] = [];
  const b = Math.max(0.1, 1 + adj.brightness / 100);
  const c = Math.max(0.1, 1 + adj.contrast / 100);
  const s = Math.max(0, 1 + adj.saturation / 100);

  switch (adj.filter) {
    case "cinematic":
      parts.push(`contrast(${c * 1.15}) saturate(${s * 1.25}) hue-rotate(-8deg) brightness(${b * 1.02})`);
      break;
    case "cyberpunk":
      parts.push(`contrast(${c * 1.25}) saturate(${s * 1.45}) hue-rotate(185deg) brightness(${b * 1.05})`);
      break;
    case "noir":
      parts.push(`grayscale(1) contrast(${c * 1.4}) brightness(${b * 0.95})`);
      break;
    case "vibrant":
      parts.push(`contrast(${c * 1.1}) saturate(${s * 1.45}) brightness(${b * 1.04})`);
      break;
    case "retro":
      parts.push(`sepia(0.32) contrast(${c * 1.18}) saturate(${s * 1.25}) hue-rotate(315deg) brightness(${b})`);
      break;
    case "sunset":
      parts.push(`sepia(0.38) saturate(${s * 1.35}) brightness(${b * 1.05}) hue-rotate(-12deg)`);
      break;
    case "cold":
      parts.push(`contrast(${c * 1.15}) saturate(${s * 0.85}) hue-rotate(18deg) brightness(${b * 0.96})`);
      break;
    default:
      if (b !== 1) parts.push(`brightness(${b})`);
      if (c !== 1) parts.push(`contrast(${c})`);
      if (s !== 1) parts.push(`saturate(${s})`);
      break;
  }

  if (adj.warmth > 0) {
    parts.push(`sepia(${adj.warmth / 110})`);
  } else if (adj.warmth < 0) {
    parts.push(`hue-rotate(${adj.warmth * 0.35}deg)`);
  }

  return parts.join(" ") || "none";
}

function drawVignette(context: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
  if (amount <= 0) return;
  context.save();
  const radius = Math.sqrt(Math.pow(w / 2, 2) + Math.pow(h / 2, 2));
  const grad = context.createRadialGradient(w / 2, h / 2, radius * 0.45, w / 2, h / 2, radius);
  const alpha = (amount / 100) * 0.85;
  grad.addColorStop(0, "rgba(0, 0, 0, 0)");
  grad.addColorStop(1, `rgba(0, 0, 0, ${alpha})`);
  context.fillStyle = grad;
  context.fillRect(0, 0, w, h);
  context.restore();
}

function drawWatermark(context: CanvasRenderingContext2D, width: number, height: number): void {
  const game = item?.game_title || "Efxlve";
  const text = `${game} • EFXLVE STUDIO`;
  const fontSize = Math.max(12, Math.round(height * 0.022));
  context.save();
  context.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const textWidth = context.measureText(text).width;
  const paddingX = Math.round(fontSize * 0.8);
  const paddingY = Math.round(fontSize * 0.45);
  const boxW = textWidth + paddingX * 2;
  const boxH = fontSize + paddingY * 2;
  const margin = Math.round(fontSize * 1.2);
  const x = width - boxW - margin;
  const y = height - boxH - margin;

  context.fillStyle = "rgba(10, 12, 16, 0.78)";
  context.beginPath();
  const radius = Math.round(boxH / 2);
  context.roundRect(x, y, boxW, boxH, radius);
  context.fill();

  context.strokeStyle = "rgba(255, 255, 255, 0.22)";
  context.lineWidth = 1;
  context.stroke();

  context.fillStyle = "#ffffff";
  context.textBaseline = "middle";
  context.fillText(text, x + paddingX, y + boxH / 2);
  context.restore();
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
    context.lineWidth = Math.max(2, command.size);
    context.strokeStyle = "rgba(0, 0, 0, 0.65)";
    context.strokeText(command.text, command.x, command.y);
    context.fillText(command.text, command.x, command.y);
  }
}

/** Repaints the whole stack including filters, vignette, shapes, overlays and watermark. */
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

  // 1. Base image with color grading & filters
  context.save();
  const box = { w: baseW, h: baseH };
  for (const command of commands) applyTransform(context, command, box);

  if (!isComparing) {
    context.filter = getFilterString(adjustments);
  } else {
    context.filter = "none";
  }
  context.drawImage(base, 0, 0);
  context.filter = "none";
  context.restore();

  // 2. Artistic Vignette
  if (!isComparing && adjustments.vignette > 0) {
    drawVignette(context, width, height, adjustments.vignette);
  }

  // 3. User Drawn Shapes & Annotations
  if (!isComparing) {
    context.save();
    const shapeBox = { w: baseW, h: baseH };
    for (const command of commands) {
      applyTransform(context, command, shapeBox);
      drawShape(context, command);
    }
    context.restore();

    // 4. Watermark Stamp
    if (watermarkEnabled) {
      drawWatermark(context, width, height);
    }
  }

  // 5. Live overlays: crop rectangle and in-progress drag
  context.save();
  const liveBox = { w: baseW, h: baseH };
  for (const command of commands) applyTransform(context, command, liveBox);

  const overlay = activeTab === "crop" || tool === "crop" ? cropRect : null;
  if (overlay) {
    context.setLineDash([6, 4]);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect(overlay.x, overlay.y, overlay.w, overlay.h);
    context.setLineDash([]);
  }
  if (dragStart && dragCurrent && tool !== "crop" && activeTab === "annotate") {
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

    const isCropMode = activeTab === "crop" || tool === "crop";
    if (isCropMode) {
      cropRect = null;
      return;
    }

    if (activeTab === "annotate") {
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
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = toImage(event);
    if (!point || !dragStart) return;

    const isCropMode = activeTab === "crop" || tool === "crop";
    if (isCropMode) {
      dragCurrent = point;
      let w = Math.abs(point.x - dragStart.x);
      let h = Math.abs(point.y - dragStart.y);
      const ratio = ASPECT_RATIOS[cropAspect];
      if (ratio) {
        h = Math.round(w / ratio);
      }
      const dirX = point.x >= dragStart.x ? 1 : -1;
      const dirY = point.y >= dragStart.y ? 1 : -1;
      cropRect = {
        x: dirX === 1 ? dragStart.x : Math.max(0, dragStart.x - w),
        y: dirY === 1 ? dragStart.y : Math.max(0, dragStart.y - h),
        w,
        h,
      };
      paint();
      return;
    }

    if (activeTab === "annotate") {
      if (tool === "pen") {
        const last = commands[commands.length - 1];
        if (last && last.kind === "stroke") {
          last.points.push(point);
          paint();
        }
        return;
      }
      dragCurrent = point;
      paint();
    }
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

    const isCropMode = activeTab === "crop" || tool === "crop";
    if (isCropMode) {
      paint();
      updateToolbar();
      return;
    }

    if (activeTab === "annotate") {
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
    }
    paint();
    updateToolbar();
  });
}

/* ---------- Toolbar Markup ---------- */

function filterButton(id: FilterPreset, label: string): string {
  const active = adjustments.filter === id;
  return `<button type="button" class="ss-preset-btn${active ? " active" : ""}" data-act="sse-filter" data-filter="${id}">${esc(label)}</button>`;
}

function aspectButton(id: CropAspect, label: string): string {
  const active = cropAspect === id;
  return `<button type="button" class="ss-aspect-btn${active ? " active" : ""}" data-act="sse-aspect" data-aspect="${id}">${esc(label)}</button>`;
}

function toolButton(id: EditorTool, label: string, iconName: Parameters<typeof icon>[0]): string {
  return `<button type="button" class="ss-edit-tool${tool === id ? " active" : ""}" data-act="sse-tool" data-tool="${id}" title="${esc(label)}">${icon(iconName, 14)}<span>${esc(label)}</span></button>`;
}

function updateToolbar(): void {
  if (!root) return;

  // Active top tab
  root.querySelectorAll<HTMLElement>(".ss-studio-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === activeTab);
  });

  // Active panel
  root.querySelectorAll<HTMLElement>(".ss-panel-view").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== activeTab;
  });

  // Annotate tools
  root.querySelectorAll<HTMLElement>(".ss-edit-tool").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });

  // Filter presets
  root.querySelectorAll<HTMLElement>(".ss-preset-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === adjustments.filter);
  });

  // Crop aspects
  root.querySelectorAll<HTMLElement>(".ss-aspect-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.aspect === cropAspect);
  });

  // Watermark button
  const wmBtn = root.querySelector<HTMLElement>('[data-act="sse-watermark"]');
  if (wmBtn) wmBtn.classList.toggle("active", watermarkEnabled);

  // Undo / Redo / Crop
  const undo = root.querySelector<HTMLButtonElement>('[data-act="sse-undo"]');
  if (undo) undo.disabled = commands.length === 0;
  const redo = root.querySelector<HTMLButtonElement>('[data-act="sse-redo"]');
  if (redo) redo.disabled = redoStack.length === 0;
  const crop = root.querySelector<HTMLButtonElement>('[data-act="sse-crop-apply"]');
  if (crop) crop.disabled = !cropRect;
}

function toolbarHtml(): string {
  return `
    <div class="ss-studio-header-strip">
      <div class="ss-studio-tabs">
        <button type="button" class="ss-studio-tab${activeTab === "filters" ? " active" : ""}" data-act="sse-tab" data-tab="filters">${icon("sparkles", 13)} ${t("ss.editFilter")}</button>
        <button type="button" class="ss-studio-tab${activeTab === "adjust" ? " active" : ""}" data-act="sse-tab" data-tab="adjust">${icon("sliders", 13)} ${t("ss.editAdjust")}</button>
        <button type="button" class="ss-studio-tab${activeTab === "crop" ? " active" : ""}" data-act="sse-tab" data-tab="crop">${icon("minimize-2", 13)} ${t("ss.editCropRatio")}</button>
        <button type="button" class="ss-studio-tab${activeTab === "annotate" ? " active" : ""}" data-act="sse-tab" data-tab="annotate">${icon("edit", 13)} ${t("ss.editText")}</button>
      </div>
      <div class="ss-studio-actions">
        <button type="button" class="btn ghost small" data-act="sse-undo" disabled title="${esc(t("ss.editUndo"))}">${icon("chevron-left", 13)}</button>
        <button type="button" class="btn ghost small" data-act="sse-redo" disabled title="${esc(t("ss.editRedo"))}">${icon("chevron-right", 13)}</button>
        <button type="button" class="btn ghost small" data-act="sse-reset">${t("ss.editReset")}</button>
      </div>
    </div>

    <div class="ss-studio-panels">
      <!-- 1. Filters panel -->
      <div class="ss-panel-view" data-panel="filters"${activeTab !== "filters" ? " hidden" : ""}>
        <div class="ss-presets-strip">
          ${filterButton("none", t("ss.filterNone"))}
          ${filterButton("cinematic", t("ss.filterCinematic"))}
          ${filterButton("cyberpunk", t("ss.filterCyberpunk"))}
          ${filterButton("noir", t("ss.filterNoir"))}
          ${filterButton("vibrant", t("ss.filterVibrant"))}
          ${filterButton("retro", t("ss.filterRetro"))}
          ${filterButton("sunset", t("ss.filterSunset"))}
          ${filterButton("cold", t("ss.filterCold"))}
        </div>
      </div>

      <!-- 2. Adjustments panel -->
      <div class="ss-panel-view" data-panel="adjust"${activeTab !== "adjust" ? " hidden" : ""}>
        <div class="ss-sliders-row">
          <label class="ss-slider-cell">
            <span class="ss-slider-title">${t("ss.editBrightness")} <span data-val-for="brightness">${adjustments.brightness > 0 ? "+" : ""}${adjustments.brightness}%</span></span>
            <input type="range" class="ss-range" data-act="sse-adjust" data-prop="brightness" min="-50" max="50" step="1" value="${adjustments.brightness}" />
          </label>
          <label class="ss-slider-cell">
            <span class="ss-slider-title">${t("ss.editContrast")} <span data-val-for="contrast">${adjustments.contrast > 0 ? "+" : ""}${adjustments.contrast}%</span></span>
            <input type="range" class="ss-range" data-act="sse-adjust" data-prop="contrast" min="-50" max="50" step="1" value="${adjustments.contrast}" />
          </label>
          <label class="ss-slider-cell">
            <span class="ss-slider-title">${t("ss.editSaturation")} <span data-val-for="saturation">${adjustments.saturation > 0 ? "+" : ""}${adjustments.saturation}%</span></span>
            <input type="range" class="ss-range" data-act="sse-adjust" data-prop="saturation" min="-100" max="100" step="1" value="${adjustments.saturation}" />
          </label>
          <label class="ss-slider-cell">
            <span class="ss-slider-title">${t("ss.editWarmth")} <span data-val-for="warmth">${adjustments.warmth > 0 ? "+" : ""}${adjustments.warmth}%</span></span>
            <input type="range" class="ss-range" data-act="sse-adjust" data-prop="warmth" min="-50" max="50" step="1" value="${adjustments.warmth}" />
          </label>
          <label class="ss-slider-cell">
            <span class="ss-slider-title">${t("ss.editVignette")} <span data-val-for="vignette">${adjustments.vignette}%</span></span>
            <input type="range" class="ss-range" data-act="sse-adjust" data-prop="vignette" min="0" max="100" step="1" value="${adjustments.vignette}" />
          </label>
        </div>
      </div>

      <!-- 3. Crop & Transform panel -->
      <div class="ss-panel-view" data-panel="crop"${activeTab !== "crop" ? " hidden" : ""}>
        <div class="ss-crop-substrip">
          <div class="ss-aspect-group">
            ${aspectButton("free", "Serbest")}
            ${aspectButton("16:9", "16:9 Desktop")}
            ${aspectButton("21:9", "21:9 Wide")}
            ${aspectButton("4:3", "4:3 Classic")}
            ${aspectButton("1:1", "1:1 Square")}
            ${aspectButton("9:16", "9:16 Story")}
          </div>
          <div class="ss-crop-actions-group">
            <button type="button" class="ss-edit-tool" data-act="sse-rotate" data-dir="-1" title="${esc(t("ss.editRotateLeft"))}">${icon("arrow-left", 14)} 90°</button>
            <button type="button" class="ss-edit-tool" data-act="sse-rotate" data-dir="1" title="${esc(t("ss.editRotateRight"))}">90° ${icon("arrow-right", 14)}</button>
            <button type="button" class="ss-edit-tool" data-act="sse-flip" data-axis="h" title="${esc(t("ss.editFlipH"))}">${icon("arrow-left-right", 14)}</button>
            <button type="button" class="ss-edit-tool" data-act="sse-flip" data-axis="v" title="${esc(t("ss.editFlipV"))}">${icon("arrow-down-a-z", 14)}</button>
            <button type="button" class="btn primary small" data-act="sse-crop-apply" disabled>${icon("check", 13)} ${t("ss.editCropApply")}</button>
          </div>
        </div>
      </div>

      <!-- 4. Annotate & Draw panel -->
      <div class="ss-panel-view" data-panel="annotate"${activeTab !== "annotate" ? " hidden" : ""}>
        <div class="ss-annotate-substrip">
          <div class="ss-edit-tools">
            ${toolButton("pen", t("ss.editPen"), "edit")}
            ${toolButton("arrow", t("ss.editArrow"), "arrow-right")}
            ${toolButton("rect", t("ss.editRect"), "square")}
            ${toolButton("mosaic", t("ss.editMosaic"), "eye-off")}
            ${toolButton("text", t("ss.editText"), "hash")}
          </div>
          <div class="ss-edit-tools">
            ${COLORS.map((val) => `<button type="button" class="ss-edit-color${val === color ? " active" : ""}" data-act="sse-color" data-color="${val}" style="--swatch:${val}" title="${val}"></button>`).join("")}
            ${SIZES.map((val) => `<button type="button" class="ss-edit-size${val === size ? " active" : ""}" data-act="sse-size" data-size="${val}" title="${val} px"><span style="width:${val + 2}px;height:${val + 2}px"></span></button>`).join("")}
          </div>
          <button type="button" class="ss-edit-tool${watermarkEnabled ? " active" : ""}" data-act="sse-watermark" title="${esc(t("ss.editWatermark"))}">${icon("sparkles", 13)} <span>${t("ss.editWatermark")}</span></button>
        </div>
      </div>
    </div>`;
}

/* ---------- Open / Save / Clipboard ---------- */

export function openScreenshotEditor(shot: GameScreenshotItem): void {
  if (root) closeScreenshotEditor();
  item = shot;
  commands = [];
  redoStack = [];
  tool = "pen";
  activeTab = "filters";
  cropAspect = "free";
  adjustments = { ...DEFAULT_ADJUSTMENTS };
  watermarkEnabled = false;
  isComparing = false;

  root = document.createElement("div");
  root.id = "ss-editor-root";
  document.body.appendChild(root);

  root.innerHTML = `
    <div class="modal-backdrop ss-edit-backdrop" data-act="sse-backdrop">
      <div class="ss-edit-box" role="dialog" aria-modal="true">
        <div class="ss-edit-head">
          <span class="ss-edit-title">${icon("camera", 16)} <span>${esc(t("ss.editStudioTitle"))}</span></span>
          <span class="ss-edit-name">${esc(shot.game_title ? `${shot.game_title} — ` : "")}${esc(shot.file_name)}</span>
          <div class="ss-edit-head-actions">
            <button type="button" class="btn ghost small ss-compare-btn" data-act="sse-compare" title="${esc(t("ss.editBeforeAfter"))}">
              ${icon("eye", 13)} ${t("ss.editBeforeAfter")}
            </button>
            <button type="button" class="btn ghost small" data-act="sse-copy-clip" title="${esc(t("ss.editCopyClip"))}">
              ${icon("copy", 13)} ${t("ss.editCopyClip")}
            </button>
            <button type="button" class="btn ghost small" data-act="sse-save-copy">
              ${icon("copy", 13)} ${t("ss.editSaveCopy")}
            </button>
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

  // Wire range sliders live input
  root.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset.act === "sse-adjust") {
      const prop = target.dataset.prop as keyof Adjustments;
      if (prop && prop in adjustments) {
        (adjustments as any)[prop] = Number(target.value);
        const valEl = root?.querySelector<HTMLElement>(`[data-val-for="${prop}"]`);
        if (valEl) {
          const val = Number(target.value);
          valEl.textContent = prop === "vignette" ? `${val}%` : `${val > 0 ? "+" : ""}${val}%`;
        }
        paint();
      }
    }
  });

  // Wire Before/After hold comparison
  const compareBtn = root.querySelector<HTMLElement>('[data-act="sse-compare"]');
  if (compareBtn) {
    const startCompare = () => {
      isComparing = true;
      paint();
    };
    const endCompare = () => {
      if (isComparing) {
        isComparing = false;
        paint();
      }
    };
    compareBtn.addEventListener("pointerdown", startCompare);
    compareBtn.addEventListener("pointerup", endCompare);
    compareBtn.addEventListener("pointerleave", endCompare);
    compareBtn.addEventListener("pointercancel", endCompare);
  }

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

async function copyToClipboard(): Promise<void> {
  if (!canvas) return;
  canvas.toBlob(async (blob) => {
    if (!blob) {
      toast(t("ss.copyFailed"), "err");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast(t("ss.editCopiedClip"), "ok");
    } catch {
      toast(t("ss.copyFailed"), "err");
    }
  }, "image/png");
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

/* ---------- Actions Routing ---------- */

export function handleScreenshotEditorAction(act: string | undefined, el: HTMLElement, targetEl?: HTMLElement): boolean {
  if (!act?.startsWith("sse-")) return false;
  switch (act) {
    case "sse-tab": {
      const tab = el.dataset.tab as EditorTab | undefined;
      if (tab) {
        activeTab = tab;
        if (tab === "crop") {
          tool = "crop";
        } else if (tool === "crop") {
          tool = "pen";
          cropRect = null;
        }
        paint();
        updateToolbar();
      }
      return true;
    }
    case "sse-filter": {
      const filter = el.dataset.filter as FilterPreset | undefined;
      if (filter) {
        adjustments.filter = filter;
        paint();
        updateToolbar();
      }
      return true;
    }
    case "sse-aspect": {
      const aspect = el.dataset.aspect as CropAspect | undefined;
      if (aspect) {
        cropAspect = aspect;
        cropRect = null;
        paint();
        updateToolbar();
      }
      return true;
    }
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
    case "sse-watermark": {
      watermarkEnabled = !watermarkEnabled;
      paint();
      updateToolbar();
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
      adjustments = { ...DEFAULT_ADJUSTMENTS };
      watermarkEnabled = false;
      paint();
      updateToolbar();
      return true;
    case "sse-crop-apply":
      if (cropRect && cropRect.w > 8 && cropRect.h > 8) {
        push({ kind: "crop", ...cropRect });
        cropRect = null;
      }
      return true;
    case "sse-copy-clip":
      void copyToClipboard();
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
