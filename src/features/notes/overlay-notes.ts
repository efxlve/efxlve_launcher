/**
 * The overlay's Notes widget: the same notes the launcher writes, in the game.
 *
 * The widget shows the current scope (the running game, or the launcher) with
 * its notes list and a compact editor — title, markdown body (or preview with
 * tappable checklists), pin and delete. Every write goes through
 * `notes-client`, so the launcher, the game page and this widget stay one
 * list; the Rust side's `notes-changed` event brings in the others' writes.
 */

import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { LAUNCHER_SCOPE, cachedNotes, deleteNote, loadNotes, noteGuideUrls, notesFontSize, saveNote, setNotesFontSize, sortNotes, type Note } from "./notes-client";
import { notePreview, renderMarkdownLite, toggleChecklist } from "./markdown";
import { MAX_NOTE_IMAGES, clipboardImage, compressPastedImage } from "./note-image";

let scope = LAUNCHER_SCOPE;
let loadedOnce = false;
let editing = false;
let draftId: string | undefined;
let draftTitle = "";
let draftBody = "";
let draftImages: string[] = [];
let draftPinned = false;
let mode: "edit" | "preview" = "edit";
let deleteArmed = false;
let saveTimer: number | null = null;
let wired = false;
/** The settings widget's repaint, handed over by the overlay (no cycle). */
let settingsRepaint: (() => void) | null = null;

export function setOverlayNotesSettingsRepaint(fn: () => void): void {
  settingsRepaint = fn;
}

/** The scope the widget shows: the game, or the launcher over no game. */
export function overlayNotesScope(launcherMode: boolean, appName: string): string {
  return launcherMode || !appName ? LAUNCHER_SCOPE : appName;
}

function widgetBody(): HTMLElement | null {
  return document.getElementById("ov-widget-notes-body");
}

function notesForScope(): Note[] {
  return sortNotes(cachedNotes().filter((note) => note.scope === scope));
}

function formatUpdated(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

function rowHtml(note: Note): string {
  const links = noteGuideUrls(note);
  const preview = notePreview(note.body, 90) || links[0] || "";
  return `
    <button class="ov-note-row${note.pinned ? " is-pinned" : ""}" data-ov="ov-note-open" data-id="${esc(note.id)}">
      <span class="ov-note-bar${note.color ? ` color-${esc(note.color)}` : ""}"></span>
      <span class="ov-note-row-main">
        <span class="ov-note-row-title">${note.pinned ? icon("pin", 10) : ""}${note.achievement ? icon("trophy", 10) : ""}${links.length > 0 ? icon("link", 10) : ""}${esc(note.title.trim() || t("notes.untitled"))}</span>
        ${preview ? `<span class="ov-note-row-preview">${esc(preview)}</span>` : ""}
      </span>
      <span class="ov-note-row-time">${esc(formatUpdated(note.updated))}</span>
    </button>`;
}

function editorHtml(): string {
  const preview = mode === "preview";
  return `
    <div class="ov-notes-editor notes-font-${notesFontSize()}">
      <div class="ov-notes-editor-head">
        <button class="ov-widget-tool-btn" data-ov="ov-note-back" title="${esc(t("notes.title"))}">${icon("arrow-left", 13)}</button>
        <input id="ov-note-title" class="ov-note-title" type="text" value="${esc(draftTitle)}" placeholder="${esc(t("notes.titlePlaceholder"))}" spellcheck="false" />
        <button class="ov-widget-tool-btn${draftPinned ? " is-pinned" : ""}" data-ov="ov-note-pin" title="${esc(draftPinned ? t("notes.unpin") : t("notes.pin"))}">${icon("pin", 12)}</button>
        <button class="ov-widget-tool-btn" data-ov="ov-note-mode" title="${esc(preview ? t("notes.edit") : t("notes.preview"))}">${icon(preview ? "edit" : "eye", 12)}</button>
        <button class="ov-widget-tool-btn${deleteArmed ? " danger" : ""}" data-ov="ov-note-delete" title="${esc(t("notes.delete"))}">${icon("trash", 12)}</button>
      </div>
      ${
        deleteArmed
          ? `<div class="ov-note-delete-bar">
              <span>${esc(t("notes.deleteConfirm"))}</span>
              <button class="btn danger small" data-ov="ov-note-delete">${esc(t("common.delete"))}</button>
              <button class="btn ghost small" data-ov="ov-note-delete-cancel">${esc(t("common.cancel"))}</button>
            </div>`
          : ""
      }
      ${
        preview
          ? `<div class="ov-notes-preview notes-preview">${renderMarkdownLite(draftBody, draftImages).html || `<p class="notes-preview-empty">${esc(t("notes.emptyBody"))}</p>`}</div>`
          : `<textarea id="ov-note-body" class="ov-note-body" spellcheck="false" placeholder="${esc(t("notes.bodyPlaceholder"))}">${esc(draftBody)}</textarea>`
      }
      <div class="ov-note-save-state" id="ov-note-save-state"></div>
    </div>`;
}

/** Paints the widget; loads the list first when this is the first open. */
export function renderOverlayNotes(): void {
  const host = widgetBody();
  if (!host) return;
  wireOverlayNotes();
  if (!loadedOnce) {
    void loadNotes().then(() => {
      loadedOnce = true;
      if (widgetBody()) renderOverlayNotes();
    });
  }
  if (editing) {
    host.innerHTML = editorHtml();
    return;
  }
  const notes = notesForScope();
  host.innerHTML = `
    <div class="ov-notes">
      <div class="ov-notes-head">
        <span class="ov-notes-count">${esc(t("notes.statsNotes", { count: String(notes.length) }))}</span>
        <button class="btn primary small" data-ov="ov-note-new">${icon("plus", 12)} ${esc(t("notes.newNote"))}</button>
      </div>
      ${
        notes.length
          ? `<div class="ov-notes-list">${notes.map(rowHtml).join("")}</div>`
          : `<div class="ov-notes-empty">${icon("edit", 20)}<span>${esc(t("notes.emptyList"))}</span></div>`
      }
    </div>`;
}

function paintSaveState(): void {
  const el = document.getElementById("ov-note-save-state");
  if (el) el.textContent = t("notes.saved");
}

async function flushSave(): Promise<void> {
  if (!draftTitle.trim() && !draftBody.trim()) return;
  const existing = draftId
    ? cachedNotes().find((note) => note.id === draftId)
    : undefined;
  const note = await saveNote({
    id: draftId,
    scope,
    title: draftTitle,
    body: draftBody,
    pinned: draftPinned,
    color: "",
    achievement: existing?.achievement ?? "",
    guideUrl: "",
    guideUrls: existing ? noteGuideUrls(existing) : [],
    images: draftImages,
  });
  if (note) draftId = note.id;
  paintSaveState();
}

function queueSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 600);
}

/** The overlay click handler delegates here; true when the click was ours. */
export function handleOverlayNotesAction(act: string | undefined, el: HTMLElement): boolean {
  switch (act) {
    case "ov-note-new":
      editing = true;
      draftId = undefined;
      draftTitle = "";
      draftBody = "";
      draftImages = [];
      draftPinned = false;
      mode = "edit";
      deleteArmed = false;
      renderOverlayNotes();
      document.getElementById("ov-note-title")?.focus();
      return true;
    case "ov-note-open": {
      const note = cachedNotes().find((item) => item.id === (el.dataset.id ?? ""));
      if (!note) return true;
      editing = true;
      draftId = note.id;
      draftTitle = note.title;
      draftBody = note.body;
      draftImages = [...(note.images ?? [])];
      draftPinned = note.pinned;
      mode = "edit";
      deleteArmed = false;
      renderOverlayNotes();
      return true;
    }
    case "ov-note-back":
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      void flushSave();
      editing = false;
      deleteArmed = false;
      renderOverlayNotes();
      return true;
    case "ov-note-pin":
      draftPinned = !draftPinned;
      queueSave();
      renderOverlayNotes();
      return true;
    case "ov-note-mode":
      mode = mode === "edit" ? "preview" : "edit";
      renderOverlayNotes();
      return true;
    case "ov-note-delete":
      if (!deleteArmed) {
        deleteArmed = true;
        renderOverlayNotes();
        return true;
      }
      if (draftId) void deleteNote(draftId);
      editing = false;
      deleteArmed = false;
      draftId = undefined;
      draftTitle = "";
      draftBody = "";
      draftImages = [];
      renderOverlayNotes();
      return true;
    case "ov-note-delete-cancel":
      deleteArmed = false;
      renderOverlayNotes();
      return true;
    case "ov-note-font": {
      const size = el.dataset.size;
      if (size === "s" || size === "m" || size === "l") {
        setNotesFontSize(size);
        renderOverlayNotes();
        // The settings widget's own buttons mark the active size.
        settingsRepaint?.();
      }
      return true;
    }
    default:
      return false;
  }
}

async function insertPastedImage(file: File): Promise<void> {
  if (draftImages.length >= MAX_NOTE_IMAGES) {
    toast(t("notes.imageLimit"));
    return;
  }
  const dataUrl = await compressPastedImage(file);
  if (!dataUrl) {
    toast(t("notes.imageTooLarge"), "err");
    return;
  }
  if (draftImages.length >= MAX_NOTE_IMAGES) {
    toast(t("notes.imageLimit"));
    return;
  }
  const textarea = document.getElementById("ov-note-body") as HTMLTextAreaElement | null;
  if (!textarea) return;
  const index = draftImages.length;
  draftImages.push(dataUrl);
  const marker = `![${t("notes.imageAlt")}](note-image:${index})`;
  const start = textarea.selectionStart ?? draftBody.length;
  const end = textarea.selectionEnd ?? start;
  draftBody = `${draftBody.slice(0, start)}${marker}\n${draftBody.slice(end)}`;
  textarea.value = draftBody;
  const caret = start + marker.length + 1;
  textarea.setSelectionRange(caret, caret);
  queueSave();
  if (mode === "preview") renderOverlayNotes();
}

function wireOverlayNotes(): void {
  if (wired) return;
  wired = true;

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "ov-note-title") {
      draftTitle = (target as HTMLInputElement).value;
      queueSave();
      return;
    }
    if (target.id === "ov-note-body") {
      draftBody = (target as HTMLTextAreaElement).value;
      queueSave();
    }
  });

  document.addEventListener("paste", (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id !== "ov-note-body") return;
    const file = clipboardImage(event);
    if (!file) return;
    event.preventDefault();
    void insertPastedImage(file);
  });

  document.addEventListener("click", (event) => {
    const box = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-note-check]");
    if (!box || !box.closest(".ov-notes-editor")) return;
    const index = Number(box.dataset.noteCheck);
    if (!Number.isFinite(index)) return;
    draftBody = toggleChecklist(draftBody, index);
    renderOverlayNotes();
    void flushSave();
  });
}

/** The overlay's open path: a new scope, a fresh view. */
export function setOverlayNotesScope(next: string): void {
  scope = next || LAUNCHER_SCOPE;
  editing = false;
  deleteArmed = false;
}

/** Another window wrote to the file: reload and repaint the open widget. */
export function refreshOverlayNotes(): void {
  if (!widgetBody()) return;
  void loadNotes(true).then(() => {
    if (widgetBody()) renderOverlayNotes();
  });
}
