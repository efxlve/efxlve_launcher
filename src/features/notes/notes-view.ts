/**
 * Notes page: the launcher's and the games' notes in one place.
 *
 * Left pane: search, the scope filter and the list. Right pane: the editor —
 * title, the markdown-lite toolbar, the body (or its preview), pin, color and
 * delete. Writes autosave through `notes-client`; the drawer and the overlay
 * read the same list.
 */

import { icon } from "../../core/icons";
import { render, scheduleRender } from "../../core/render";
import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import {
  LAUNCHER_SCOPE,
  cachedNotes,
  deleteNote,
  loadNotes,
  noteGuideUrls,
  notesFontSize,
  onNotesChanged,
  saveNote,
  sortNotes,
  type Note,
} from "./notes-client";
import { notePreview, renderMarkdownLite, scopeTail, toggleChecklist } from "./markdown";

/** The swatches the editor offers; empty is the neutral surface color. */
const NOTE_COLORS = ["", "blue", "green", "yellow", "red", "purple"];

let notesLoaded = false;
let wired = false;

let selectedId: string | null = null;
/** True while the editor pane shows a note or a fresh draft. */
let editorOpen = false;
/** Undefined until the first autosave of a fresh note. */
let draftId: string | undefined;
let draftScope = LAUNCHER_SCOPE;
let draftTitle = "";
let draftBody = "";
let draftPinned = false;
let draftColor = "";
let draftDirty = false;
let searchQuery = "";
let scopeFilter: "all" | "launcher" | "games" = "all";
let editorMode: "edit" | "preview" = "preview";
let deleteArmed = false;
let saveTimer: number | null = null;
let saveState: "idle" | "saving" | "saved" = "idle";

function hasDraft(): boolean {
  return editorOpen;
}

function clearDraft(): void {
  selectedId = null;
  editorOpen = false;
  draftId = undefined;
  draftScope = LAUNCHER_SCOPE;
  draftTitle = "";
  draftBody = "";
  draftPinned = false;
  draftColor = "";
  draftDirty = false;
  editorMode = "preview";
  deleteArmed = false;
  saveState = "idle";
}

/** The game title a scope belongs to, when the library knows it. */
function scopeLabel(scope: string): string {
  if (scope === LAUNCHER_SCOPE) return t("notes.scopeLauncher");
  return summaryOf(scope)?.title || scopeTail(scope);
}

function visibleNotes(): Note[] {
  const needle = searchQuery.trim().toLowerCase();
  return sortNotes(
    cachedNotes().filter((note) => {
      if (scopeFilter === "launcher" && note.scope !== LAUNCHER_SCOPE) return false;
      if (scopeFilter === "games" && note.scope === LAUNCHER_SCOPE) return false;
      if (!needle) return true;
      const hay = `${note.title} ${note.body} ${noteGuideUrls(note).join(" ")} ${scopeLabel(note.scope)}`.toLowerCase();
      return hay.includes(needle);
    }),
  );
}

/** The message an empty list shows: "nothing yet" or "nothing matched". */
function listEmptyHtml(): string {
  const filtered = Boolean(searchQuery.trim()) || scopeFilter !== "all";
  return `<div class="notes-list-empty">${esc(t(filtered ? "notes.noResults" : "notes.emptyList"))}</div>`;
}

/* ---------- Rows ---------- */

function noteRowHtml(note: Note): string {
  const title = note.title.trim() || t("notes.untitled");
  const links = noteGuideUrls(note);
  const preview = notePreview(note.body) || links[0] || "";
  const achievementFlag = note.achievement
    ? `<span class="notes-row-kind" title="${esc(t("drawer.achievements"))}">${icon("trophy", 12)}</span>`
    : "";
  const guideFlag = links.length > 0
    ? `<span class="notes-row-kind" title="${esc(links[0])}">${icon("link", 12)}</span>`
    : "";
  return `
    <button class="notes-row${note.id === selectedId ? " is-active" : ""}${note.pinned ? " is-pinned" : ""}${note.color ? ` color-${esc(note.color)}` : ""}" data-act="notes-select" data-id="${esc(note.id)}">
      <span class="notes-row-bar"></span>
      <span class="notes-row-main">
        <span class="notes-row-top">
          <span class="notes-row-title">${achievementFlag}${guideFlag}${esc(title)}</span>
          ${note.pinned ? `<span class="notes-row-pin">${icon("pin", 12)}</span>` : ""}
        </span>
        ${preview ? `<span class="notes-row-preview">${esc(preview)}</span>` : ""}
        <span class="notes-row-meta">
          <span class="notes-scope-chip">${esc(scopeLabel(note.scope))}</span>
          <span class="notes-row-time">${esc(formatUpdated(note.updated))}</span>
        </span>
      </span>
    </button>`;
}

function formatUpdated(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

/* ---------- Editor ---------- */

const TOOLS: { kind: string; label: string; titleKey: string }[] = [
  { kind: "heading", label: "H", titleKey: "notes.mdHeading" },
  { kind: "bold", label: "B", titleKey: "notes.mdBold" },
  { kind: "italic", label: "I", titleKey: "notes.mdItalic" },
  { kind: "strike", label: "S", titleKey: "notes.mdStrike" },
  { kind: "code", label: "</>", titleKey: "notes.mdCode" },
  { kind: "link", label: "↗", titleKey: "notes.mdLink" },
  { kind: "bullet", label: "•", titleKey: "notes.mdBullet" },
  { kind: "number", label: "1.", titleKey: "notes.mdNumber" },
  { kind: "check", label: "☑", titleKey: "notes.mdCheck" },
  { kind: "quote", label: "❝", titleKey: "notes.mdQuote" },
];

function editorHtml(): string {
  if (!hasDraft()) {
    return `
      <div class="notes-editor-empty">
        <div class="notes-editor-empty-icon">${icon("edit", 26)}</div>
        <div class="notes-editor-empty-title">${esc(t("notes.pickNote"))}</div>
        <div class="notes-editor-empty-desc">${esc(t("notes.pickNoteDesc"))}</div>
        <button class="btn primary small" data-act="notes-new">${icon("plus", 14)} ${esc(t("notes.newNote"))}</button>
      </div>`;
  }
  const preview = editorMode === "preview";
  const rendered = preview ? renderMarkdownLite(draftBody).html : "";
  const activeNote = draftId ? cachedNotes().find((note) => note.id === draftId) : undefined;
  const linkedGuides = activeNote ? noteGuideUrls(activeNote) : [];
  return `
    <div class="notes-editor-head">
      ${
        preview
          ? `<div class="notes-title-view" title="${esc(t("notes.edit"))}">${esc(draftTitle.trim() || t("notes.untitled"))}</div>`
          : `<input id="notes-title" class="notes-title-input" type="text" value="${esc(draftTitle)}" placeholder="${esc(t("notes.titlePlaceholder"))}" spellcheck="false" />`
      }
      <div class="notes-editor-actions">
        <button class="icon-btn${draftPinned ? " active" : ""}" data-act="notes-pin-editor" title="${esc(draftPinned ? t("notes.unpin") : t("notes.pin"))}">${icon("pin", 15)}</button>
        <button class="icon-btn" data-act="notes-mode" title="${esc(preview ? t("notes.edit") : t("notes.preview"))}">${icon(preview ? "edit" : "eye", 15)}</button>
        <button class="icon-btn${deleteArmed ? " danger" : ""}" data-act="notes-delete" title="${esc(t("notes.delete"))}">${icon("trash", 15)}</button>
      </div>
    </div>
    ${
      deleteArmed
        ? `<div class="notes-delete-bar">
            <span>${esc(t("notes.deleteConfirm"))}</span>
            <button class="btn danger small" data-act="notes-delete">${esc(t("common.delete"))}</button>
            <button class="btn ghost small" data-act="notes-delete-cancel">${esc(t("common.cancel"))}</button>
          </div>`
        : ""
    }
    ${
      preview
        ? `<div class="notes-preview">${rendered || `<p class="notes-preview-empty">${esc(t("notes.emptyBody"))}</p>`}</div>`
        : `<div class="notes-toolbar">
            ${TOOLS.map((tool) => `<button type="button" class="notes-tool-btn" data-act="notes-tool" data-md="${tool.kind}" title="${esc(t(tool.titleKey))}">${esc(tool.label)}</button>`).join("")}
            <button type="button" class="btn ghost small notes-tool-done" data-act="notes-mode">${icon("eye", 12)} ${esc(t("notes.preview"))}</button>
          </div>
          <textarea id="notes-body" class="notes-body" spellcheck="false" placeholder="${esc(t("notes.bodyPlaceholder"))}">${esc(draftBody)}</textarea>`
    }
    ${
      linkedGuides.length > 0
        ? `<div class="notes-linked-guides">${linkedGuides
            .map(
              (url) => `<button type="button" class="notes-linked-guide" data-act="ach-guide" data-url="${esc(url)}" title="${esc(url)}">
                ${icon("link", 12)}
                <span>${esc(url)}</span>
                ${icon("external", 11)}
              </button>`,
            )
            .join("")}</div>`
        : ""
    }
    <div class="notes-editor-foot">
      <div class="notes-colors" title="${esc(t("notes.color"))}">
        ${NOTE_COLORS.map((color) => `<button class="notes-color${color ? ` is-${color}` : " is-none"}${draftColor === color ? " active" : ""}" data-act="notes-color" data-color="${color}"></button>`).join("")}
      </div>
      <span class="notes-scope-hint">${esc(scopeLabel(draftScope))}</span>
      <span class="notes-save-state" id="notes-save-state">${saveState === "saving" ? esc(t("notes.saving")) : saveState === "saved" ? esc(t("notes.saved")) : ""}</span>
    </div>`;
}

/* ---------- Page ---------- */

export function renderNotesPage(): string {
  if (!notesLoaded) {
    return `<div class="page notes-page"><div class="empty-state"><span class="spinner"></span></div></div>`;
  }
  const notes = visibleNotes();
  return `
    <div class="page notes-page">
      <div class="notes-layout">
        <aside class="notes-side">
          <div class="notes-side-head">
            <div class="notes-search">
              ${icon("search", 14)}
              <input id="notes-search" class="notes-search-input" type="text" value="${esc(searchQuery)}" placeholder="${esc(t("notes.searchPlaceholder"))}" spellcheck="false" />
            </div>
            <button class="btn primary small" data-act="notes-new">${icon("plus", 14)} <span>${esc(t("notes.newNote"))}</span></button>
          </div>
          <div class="seg notes-filter">
            <button class="${scopeFilter === "all" ? "active" : ""}" data-act="notes-filter" data-scope="all">${esc(t("notes.filterAll"))}</button>
            <button class="${scopeFilter === "launcher" ? "active" : ""}" data-act="notes-filter" data-scope="launcher">${esc(t("notes.filterLauncher"))}</button>
            <button class="${scopeFilter === "games" ? "active" : ""}" data-act="notes-filter" data-scope="games">${esc(t("notes.filterGames"))}</button>
          </div>
          <div class="notes-list" id="notes-list">
            ${notes.length ? notes.map(noteRowHtml).join("") : listEmptyHtml()}
          </div>
        </aside>
        <section class="notes-editor notes-font-${notesFontSize()}">
          ${editorHtml()}
        </section>
      </div>
    </div>`;
}

/** Repaints the list only, so the search box keeps its focus and caret. */
function paintNotesList(): void {
  const host = document.getElementById("notes-list");
  if (!host) return;
  const notes = visibleNotes();
  host.innerHTML = notes.length ? notes.map(noteRowHtml).join("") : listEmptyHtml();
}

function paintSaveState(): void {
  const el = document.getElementById("notes-save-state");
  if (!el) return;
  el.textContent =
    saveState === "saving" ? t("notes.saving") : saveState === "saved" ? t("notes.saved") : "";
}

/* ---------- Actions ---------- */

export async function loadNotesView(force = false): Promise<void> {
  await loadNotes(force);
  notesLoaded = true;
  // A removed or filtered-away selection closes the editor.
  if (selectedId && !cachedNotes().some((note) => note.id === selectedId)) clearDraft();
  render();
  wireNotesView();
}

async function flushSave(): Promise<void> {
  if (!hasDraft() || !draftDirty) return;
  if (!draftTitle.trim() && !draftBody.trim()) return;
  saveState = "saving";
  paintSaveState();
  const existing = draftId
    ? cachedNotes().find((note) => note.id === draftId)
    : undefined;
  const note = await saveNote({
    id: draftId,
    scope: draftScope,
    title: draftTitle,
    body: draftBody,
    pinned: draftPinned,
    color: draftColor,
    achievement: existing?.achievement ?? "",
    guideUrl: "",
    guideUrls: existing ? noteGuideUrls(existing) : [],
  });
  if (note) {
    draftId = note.id;
    selectedId = note.id;
    draftDirty = false;
    saveState = "saved";
  } else {
    saveState = "idle";
  }
  paintSaveState();
  scheduleRender();
}

function queueSave(): void {
  draftDirty = true;
  saveState = "idle";
  paintSaveState();
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 700);
}

async function selectNote(id: string): Promise<void> {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  await flushSave();
  const note = cachedNotes().find((item) => item.id === id);
  if (!note) return;
  selectedId = note.id;
  editorOpen = true;
  draftId = note.id;
  draftScope = note.scope;
  draftTitle = note.title;
  draftBody = note.body;
  draftPinned = note.pinned;
  draftColor = note.color;
  draftDirty = false;
  editorMode = "preview";
  deleteArmed = false;
  saveState = "idle";
  render();
}

function startNewNote(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
  void flushSave();
  clearDraft();
  editorOpen = true;
  editorMode = "edit";
  render();
  document.getElementById("notes-title")?.focus();
}

async function deleteDraft(): Promise<void> {
  if (!deleteArmed) {
    deleteArmed = true;
    render();
    return;
  }
  if (draftId) await deleteNote(draftId);
  clearDraft();
  render();
}

async function togglePin(note: Note | null): Promise<void> {
  if (note) {
    await saveNote({
      id: note.id,
      scope: note.scope,
      title: note.title,
      body: note.body,
      pinned: !note.pinned,
      color: note.color,
      achievement: note.achievement,
      guideUrl: "",
      guideUrls: noteGuideUrls(note),
    });
  } else {
    draftPinned = !draftPinned;
    queueSave();
  }
  render();
}

/** Inserts markdown at the caret: wraps the selection, or prefixes the line. */
function applyTool(kind: string): void {
  const textarea = document.getElementById("notes-body") as HTMLTextAreaElement | null;
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);

  const replace = (text: string, selectionStart: number, selectionEnd: number): void => {
    draftBody = text;
    textarea.value = text;
    textarea.focus();
    textarea.setSelectionRange(selectionStart, selectionEnd);
    queueSave();
  };

  const wrap = (before: string, after: string, placeholder: string): void => {
    const body = selected || placeholder;
    replace(
      value.slice(0, start) + before + body + after + value.slice(end),
      start + before.length,
      start + before.length + body.length,
    );
  };

  const prefixLine = (prefix: string): void => {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    replace(value.slice(0, lineStart) + prefix + value.slice(lineStart), start + prefix.length, end + prefix.length);
  };

  switch (kind) {
    case "bold": wrap("**", "**", t("notes.mdBoldText")); break;
    case "italic": wrap("*", "*", t("notes.mdItalicText")); break;
    case "strike": wrap("~~", "~~", t("notes.mdStrikeText")); break;
    case "code": wrap("`", "`", t("notes.mdCodeText")); break;
    case "link": wrap("[", "](https://)", t("notes.mdLinkText")); break;
    case "heading": prefixLine("## "); break;
    case "bullet": prefixLine("- "); break;
    case "number": prefixLine("1. "); break;
    case "check": prefixLine("- [ ] "); break;
    case "quote": prefixLine("> "); break;
  }
}

/** Opens the editor and puts the caret at the end of the clicked field. */
function enterEditMode(focus: "title" | "body" = "body"): void {
  if (editorMode === "edit") return;
  editorMode = "edit";
  render();
  if (focus === "title") {
    const title = document.getElementById("notes-title") as HTMLInputElement | null;
    if (!title) return;
    title.focus();
    const end = title.value.length;
    title.setSelectionRange(end, end);
    return;
  }
  const body = document.getElementById("notes-body") as HTMLTextAreaElement | null;
  if (!body) return;
  body.focus();
  const end = body.value.length;
  body.setSelectionRange(end, end);
}

/** The click-router delegates here; true when the click was a notes action. */
export function handleNotesAction(act: string | undefined, el: HTMLElement): boolean {
  const id = el.dataset.id ?? "";
  switch (act) {
    case "notes-new":
      startNewNote();
      return true;
    case "notes-select":
      if (id) void selectNote(id);
      return true;
    case "notes-pin-editor":
      void togglePin(null);
      return true;
    case "notes-mode":
      if (editorMode === "edit") {
        // Leaving the editor saves immediately instead of waiting for the next
        // autosave tick, then shows the rendered note.
        void flushSave();
        editorMode = "preview";
        render();
      } else {
        enterEditMode();
      }
      return true;
    case "notes-delete":
      void deleteDraft();
      return true;
    case "notes-delete-cancel":
      deleteArmed = false;
      render();
      return true;
    case "notes-tool":
      applyTool(el.dataset.md ?? "");
      return true;
    case "notes-color":
      draftColor = el.dataset.color ?? "";
      queueSave();
      render();
      return true;
    case "notes-filter": {
      const scope = el.dataset.scope;
      scopeFilter = scope === "launcher" || scope === "games" ? scope : "all";
      render();
      return true;
    }
    default:
      return false;
  }
}

/** Input wiring, once: search, title, body and the preview checkboxes. */
function wireNotesView(): void {
  if (wired) return;
  wired = true;

  onNotesChanged(() => {
    if (S.view !== "notes") return;
    void loadNotes(true).then(() => {
      if (S.view === "notes") render();
    });
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "notes-search") {
      searchQuery = (target as HTMLInputElement).value;
      paintNotesList();
      return;
    }
    if (target.id === "notes-title") {
      draftTitle = (target as HTMLInputElement).value;
      queueSave();
      return;
    }
    if (target.id === "notes-body") {
      draftBody = (target as HTMLTextAreaElement).value;
      queueSave();
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const box = target?.closest<HTMLElement>("[data-note-check]");
    if (box && box.closest(".notes-editor")) {
      const index = Number(box.dataset.noteCheck);
      if (!Number.isFinite(index)) return;
      draftBody = toggleChecklist(draftBody, index);
      draftDirty = true;
      render();
      void flushSave();
      return;
    }
    // The note opens as rendered markdown; a click on the title or body starts
    // editing, while links and checklist boxes keep their own action.
    if (target?.closest(".notes-title-view")) {
      enterEditMode("title");
      return;
    }
    if (target?.closest(".notes-preview") && !target.closest("a, button")) {
      enterEditMode("body");
    }
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== "notes-search") return;
    if (event.key === "Escape" && target.value) {
      event.preventDefault();
      target.value = "";
      searchQuery = "";
      paintNotesList();
    }
  });
}
