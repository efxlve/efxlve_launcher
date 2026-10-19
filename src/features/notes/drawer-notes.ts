/**
 * The game page's Notes tab: that game's notes, read and written in place.
 *
 * The full editor (toolbar, colors, search) lives on the Notes page; this tab
 * is the quick view: the list, the body with markdown preview and checklists,
 * pin and delete. Writes go through the same client, so the page and the
 * overlay see them at once.
 */

import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { cachedNotes, deleteNote, loadNotes, notesForScope, saveNote, type Note } from "./notes-client";
import { notePreview, renderMarkdownLite, toggleChecklist } from "./markdown";

interface DrawerDraft {
  id?: string;
  title: string;
  body: string;
  pinned: boolean;
  color: string;
}

let listScope: string | null = null;
let editing = false;
let draft: DrawerDraft = { title: "", body: "", pinned: false, color: "" };
let mode: "edit" | "preview" = "edit";
let deleteArmed = false;
let saveTimer: number | null = null;
let wired = false;

function formatUpdated(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

/** Repaints the tab content in place; the drawer keeps its own frame. */
function repaint(): void {
  const host = document.getElementById("drawer-tab-content");
  if (host && listScope) host.innerHTML = renderDrawerNotes(listScope);
}

function refreshTabButton(appName: string): void {
  const btn = document.querySelector<HTMLElement>('.drawer-tab[data-tab="notes"]');
  if (!btn) return;
  const active = btn.classList.contains("active");
  btn.outerHTML = `<button class="tab drawer-tab${active ? " active" : ""}" data-act="drawer-tab" data-tab="notes" data-id="${esc(appName)}">${icon("edit", 14)}${esc(t("drawer.notes"))}</button>`;
}

/** Loads the list once per open and keeps the tab button's count in step. */
export function ensureDrawerNotes(appName: string, onLoaded?: () => void): void {
  wireDrawerNotes();
  void loadNotes().then(() => {
    if (S.currentModalAppName !== appName) return;
    refreshTabButton(appName);
    if (S.activeDrawerTab === "notes") repaint();
    onLoaded?.();
  });
}

function noteRowHtml(note: Note): string {
  const title = note.title.trim() || t("notes.untitled");
  return `
    <button class="drawer-note-row" data-act="drawer-note-open" data-id="${esc(note.id)}">
      <span class="drawer-note-bar${note.color ? ` color-${esc(note.color)}` : ""}"></span>
      <span class="drawer-note-main">
        <span class="drawer-note-title">${note.pinned ? icon("pin", 11) : ""}${esc(title)}</span>
        ${note.body.trim() ? `<span class="drawer-note-preview">${esc(notePreview(note.body, 140))}</span>` : ""}
      </span>
      <span class="drawer-note-time">${esc(formatUpdated(note.updated))}</span>
    </button>`;
}

function editorHtml(): string {
  const preview = mode === "preview";
  return `
    <div class="drawer-notes-editor">
      <div class="drawer-notes-editor-head">
        <button class="btn ghost small" data-act="drawer-note-back">← ${esc(t("notes.title"))}</button>
        <input id="drawer-note-title" class="notes-title-input" type="text" value="${esc(draft.title)}" placeholder="${esc(t("notes.titlePlaceholder"))}" spellcheck="false" />
        <button class="icon-btn${draft.pinned ? " active" : ""}" data-act="drawer-note-pin" title="${esc(draft.pinned ? t("notes.unpin") : t("notes.pin"))}">${icon("pin", 15)}</button>
        <button class="icon-btn" data-act="drawer-note-mode" title="${esc(preview ? t("notes.edit") : t("notes.preview"))}">${icon(preview ? "edit" : "eye", 15)}</button>
        <button class="icon-btn${deleteArmed ? " danger" : ""}" data-act="drawer-note-delete" title="${esc(t("notes.delete"))}">${icon("trash", 15)}</button>
      </div>
      ${
        deleteArmed
          ? `<div class="notes-delete-bar">
              <span>${esc(t("notes.deleteConfirm"))}</span>
              <button class="btn danger small" data-act="drawer-note-delete">${esc(t("common.delete"))}</button>
              <button class="btn ghost small" data-act="drawer-note-delete-cancel">${esc(t("common.cancel"))}</button>
            </div>`
          : ""
      }
      ${
        preview
          ? `<div class="notes-preview">${renderMarkdownLite(draft.body).html || `<p class="notes-preview-empty">${esc(t("notes.emptyBody"))}</p>`}</div>`
          : `<textarea id="drawer-note-body" class="notes-body" spellcheck="false" placeholder="${esc(t("notes.bodyPlaceholder"))}">${esc(draft.body)}</textarea>`
      }
      <div class="notes-editor-foot">
        <span class="notes-save-state" id="drawer-note-save-state"></span>
      </div>
    </div>`;
}

export function renderDrawerNotes(appName: string): string {
  listScope = appName;
  if (editing) return editorHtml();
  const notes = notesForScope(appName);
  return `
    <div class="drawer-notes">
      <div class="drawer-notes-head">
        <div class="drawer-notes-title">${icon("edit", 15)} <span>${esc(t("notes.title"))}</span></div>
        <div class="drawer-notes-actions">
          <button class="btn ghost small" data-view="notes">${esc(t("notes.openPage"))}</button>
          <button class="btn primary small" data-act="drawer-note-new">${icon("plus", 13)} ${esc(t("notes.newNote"))}</button>
        </div>
      </div>
      ${
        notes.length
          ? `<div class="drawer-notes-list">${notes.map(noteRowHtml).join("")}</div>`
          : `<div class="empty-state">
              ${icon("edit", 26)}
              <h3>${esc(t("notes.emptyList"))}</h3>
              <p>${esc(t("notes.drawerEmptyDesc"))}</p>
            </div>`
      }
    </div>`;
}

function paintSaveState(): void {
  const el = document.getElementById("drawer-note-save-state");
  if (el) el.textContent = t("notes.saved");
}

async function flushSave(): Promise<void> {
  if (!draft.title.trim() && !draft.body.trim()) return;
  if (!listScope) return;
  const note = await saveNote({
    id: draft.id,
    scope: listScope,
    title: draft.title,
    body: draft.body,
    pinned: draft.pinned,
    color: draft.color,
  });
  if (note) draft.id = note.id;
  paintSaveState();
  refreshTabButton(listScope);
}

function queueSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 700);
}

/** The click-router delegates here; true when the click was ours. */export function handleDrawerNotesAction(act: string | undefined, el: HTMLElement): boolean {
  switch (act) {
    case "drawer-note-new":
      editing = true;
      draft = { title: "", body: "", pinned: false, color: "" };
      mode = "edit";
      deleteArmed = false;
      repaint();
      document.getElementById("drawer-note-title")?.focus();
      return true;
    case "drawer-note-open": {
      const note = cachedNotes().find((item) => item.id === (el.dataset.id ?? ""));
      if (!note) return true;
      editing = true;
      draft = { id: note.id, title: note.title, body: note.body, pinned: note.pinned, color: note.color };
      mode = "edit";
      deleteArmed = false;
      repaint();
      document.getElementById("drawer-note-title")?.focus();
      return true;
    }
    case "drawer-note-back":
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        saveTimer = null;
      }
      void flushSave();
      editing = false;
      deleteArmed = false;
      repaint();
      return true;
    case "drawer-note-pin":
      draft.pinned = !draft.pinned;
      queueSave();
      repaint();
      return true;
    case "drawer-note-mode":
      mode = mode === "edit" ? "preview" : "edit";
      repaint();
      return true;
    case "drawer-note-delete":
      if (!deleteArmed) {
        deleteArmed = true;
        repaint();
        return true;
      }
      if (draft.id) void deleteNote(draft.id);
      editing = false;
      deleteArmed = false;
      draft = { title: "", body: "", pinned: false, color: "" };
      repaint();
      if (listScope) refreshTabButton(listScope);
      return true;
    case "drawer-note-delete-cancel":
      deleteArmed = false;
      repaint();
      return true;
    default:
      return false;
  }
}

function wireDrawerNotes(): void {
  if (wired) return;
  wired = true;
  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "drawer-note-title") {
      draft.title = (target as HTMLInputElement).value;
      queueSave();
      return;
    }
    if (target.id === "drawer-note-body") {
      draft.body = (target as HTMLTextAreaElement).value;
      queueSave();
    }
  });

  document.addEventListener("click", (event) => {
    const box = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-note-check]");
    if (!box || !box.closest(".drawer-notes-editor")) return;
    const index = Number(box.dataset.noteCheck);
    if (!Number.isFinite(index)) return;
    draft.body = toggleChecklist(draft.body, index);
    repaint();
    void flushSave();
  });
}
