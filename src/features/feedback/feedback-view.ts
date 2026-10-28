/**
 * User-triggered feedback dialog.
 *
 * The launcher cannot create a GitHub issue for the user: that needs a token
 * which must never ship in the client. Instead it builds a small diagnostic zip
 * and opens a prefilled GitHub issue; the user reviews the zip and attaches it.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { feedbackRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { toast } from "../../core/toast";
import { epicOpenFolderPath } from "../../epic-commands";
import { feedbackCreateReport, type FeedbackReport } from "../../feedback";

const NOTE_MAX = 2000;

let report: FeedbackReport | null = null;
let currentNote = "";
let includeLogs = true;
let creating = false;
let noteError = "";
let createError = "";
let generation = 0;

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "report.zip";
}

/** One file row in the ready state: the icon names the kind of content. */
function fileIcon(name: string): string {
  if (name.endsWith(".json")) return icon("settings", 13);
  if (name.endsWith(".log")) return icon("terminal", 13);
  return icon("clipboard", 13);
}

function head(title: string, subtitle: string, done: boolean): string {
  return `
    <div class="feedback-head">
      <span class="feedback-head-mark${done ? " is-ok" : ""}">${icon(done ? "check-circle" : "alert-triangle", 18)}</span>
      <div class="feedback-head-text">
        <h3 class="feedback-title" id="feedback-title">${esc(title)}</h3>
        <p class="feedback-sub">${esc(subtitle)}</p>
      </div>
      <button type="button" class="manage-head-close" data-act="feedback-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>
    </div>`;
}

function renderReady(created: FeedbackReport): string {
  const files = created.files
    .map(
      (file) => `
        <li class="feedback-file-item" title="${esc(file)}">
          ${fileIcon(file)}
          <span class="feedback-file-name">${esc(file)}</span>
        </li>`,
    )
    .join("");

  const contents = created.files.length
    ? `<div class="feedback-contents">
        <span class="feedback-contents-title">${esc(t("feedback.contents"))}</span>
        <ul class="feedback-files">${files}</ul>
      </div>`
    : "";

  return `
    ${head(t("feedback.readyTitle"), t("feedback.readyBody"), true)}
    <div class="feedback-body">
      <div class="feedback-report">
        <span class="feedback-report-mark">${icon("package", 20)}</span>
        <div class="feedback-report-text">
          <span class="feedback-report-name" title="${esc(created.path)}">${esc(fileName(created.path))}</span>
          <span class="feedback-report-path" title="${esc(created.folder)}">${esc(created.folder)}</span>
        </div>
      </div>
      ${contents}
      <p class="info-box">${icon("info", 14)} <span>${esc(t("feedback.attachHint"))}</span></p>
    </div>
    <div class="feedback-foot">
      <button type="button" class="btn ghost" data-act="feedback-close">${esc(t("common.close"))}</button>
      <button type="button" class="btn ghost" data-act="feedback-open-folder">${icon("folder", 14)} ${esc(t("feedback.openFolder"))}</button>
      <button type="button" class="btn primary" id="feedback-open-github" data-act="feedback-open-github">${icon("github", 14)} ${esc(t("feedback.openGithub"))}</button>
    </div>`;
}

function renderCreate(): string {
  const createButton = creating
    ? `<span class="spinner feedback-btn-spinner"></span><span>${esc(t("feedback.creating"))}</span>`
    : `${icon("package", 14)} <span>${esc(t("feedback.create"))}</span>`;

  return `
    ${head(t("feedback.title"), t("feedback.intro"), false)}
    <div class="feedback-body">
      <div class="feedback-field">
        <div class="feedback-field-head">
          <label class="feedback-label" for="feedback-note">${esc(t("feedback.noteLabel"))}</label>
          <span class="feedback-count${currentNote.length >= NOTE_MAX - 100 ? " is-near" : ""}" data-feedback-count>${currentNote.length} / ${NOTE_MAX}</span>
        </div>
        <textarea id="feedback-note" class="feedback-note${noteError ? " is-invalid" : ""}" maxlength="${NOTE_MAX}" placeholder="${esc(t("feedback.notePlaceholder"))}"${creating ? " disabled" : ""}></textarea>
        <p class="feedback-error${noteError ? "" : " hidden"}" data-feedback-note-error role="alert">${icon("alert-triangle", 13)}<span>${esc(noteError)}</span></p>
        <p class="feedback-hint">${esc(t("feedback.noteHint"))}</p>
      </div>
      <label class="feedback-toggle">
        <span class="feedback-toggle-text">
          <span class="feedback-toggle-title">${esc(t("feedback.diagnosticsTitle"))}</span>
          <span class="feedback-toggle-desc">${esc(t("feedback.diagnosticsDesc"))}</span>
        </span>
        <span class="switch">
          <input type="checkbox" id="feedback-include-logs" ${includeLogs ? "checked" : ""}${creating ? " disabled" : ""} />
          <span class="track"></span>
        </span>
      </label>
      ${createError ? `<p class="feedback-error" data-feedback-create-error role="alert">${icon("alert-triangle", 13)}<span>${esc(createError)}</span></p>` : ""}
      <p class="info-box feedback-privacy">${icon("info", 14)} <span>${esc(t("feedback.privacy"))}</span></p>
    </div>
    <div class="feedback-foot">
      <button type="button" class="btn ghost" data-act="feedback-close">${esc(t("common.cancel"))}</button>
      <button type="button" class="btn primary" id="feedback-create" data-act="feedback-create"${creating ? " disabled" : ""}>${createButton}</button>
    </div>`;
}

function renderFeedback(): void {
  feedbackRoot.innerHTML = `
    <div class="confirm-layer feedback-layer">
      <div class="modal-backdrop" data-act="feedback-close">
        <div class="modal feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedback-title" data-act="prevent-modal-close">
          ${report ? renderReady(report) : renderCreate()}
        </div>
      </div>
    </div>`;

  if (report) {
    (document.getElementById("feedback-open-github") as HTMLButtonElement | null)?.focus();
    return;
  }

  const note = document.getElementById("feedback-note") as HTMLTextAreaElement | null;
  if (!note) return;
  note.value = currentNote;
  note.focus();
  note.setSelectionRange(note.value.length, note.value.length);
  note.addEventListener("input", () => {
    currentNote = note.value;
    syncNoteCount(note);
    if (noteError) {
      noteError = "";
      note.classList.remove("is-invalid");
      document.querySelector("[data-feedback-note-error]")?.classList.add("hidden");
    }
    if (createError) {
      createError = "";
      document.querySelector("[data-feedback-create-error]")?.remove();
    }
  });

  const logs = document.getElementById("feedback-include-logs") as HTMLInputElement | null;
  logs?.addEventListener("change", () => {
    includeLogs = logs.checked;
  });
}

/** Counter and near-limit warning live next to the label, not under the field. */
function syncNoteCount(note: HTMLTextAreaElement): void {
  const counter = document.querySelector<HTMLElement>("[data-feedback-count]");
  if (!counter) return;
  counter.textContent = `${note.value.length} / ${NOTE_MAX}`;
  counter.classList.toggle("is-near", note.value.length >= NOTE_MAX - 100);
}

export function openFeedback(): void {
  generation += 1;
  report = null;
  currentNote = "";
  includeLogs = true;
  creating = false;
  noteError = "";
  createError = "";
  renderFeedback();
}

export function closeFeedback(): void {
  generation += 1;
  report = null;
  currentNote = "";
  includeLogs = true;
  creating = false;
  noteError = "";
  createError = "";
  feedbackRoot.innerHTML = "";
}

export async function createFeedbackReport(): Promise<void> {
  if (creating) return;
  const note = currentNote.trim();
  if (!note) {
    noteError = t("feedback.noteRequired");
    renderFeedback();
    return;
  }

  const token = generation;
  creating = true;
  createError = "";
  const button = document.getElementById("feedback-create") as HTMLButtonElement | null;
  const noteField = document.getElementById("feedback-note") as HTMLTextAreaElement | null;
  const logs = document.getElementById("feedback-include-logs") as HTMLInputElement | null;
  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="spinner feedback-btn-spinner"></span><span>${esc(t("feedback.creating"))}</span>`;
  }
  if (noteField) noteField.disabled = true;
  if (logs) logs.disabled = true;

  try {
    const created = await feedbackCreateReport(note, includeLogs);
    creating = false;
    if (token !== generation) return;
    report = created;
    renderFeedback();
  } catch (error) {
    creating = false;
    if (token !== generation) return;
    createError = `${t("feedback.createFailed")} ${String(error)}`;
    renderFeedback();
  }
}

export function openFeedbackIssue(): void {
  if (!report) return;
  const url = new URL("https://github.com/efxlve/efxlve_launcher/issues/new");
  url.searchParams.set("title", report.issueTitle);
  url.searchParams.set("body", report.issueBody);
  void openUrl(url.toString()).catch((error) => toast(String(error), "err"));
}

export async function openFeedbackFolder(): Promise<void> {
  if (!report) return;
  try {
    const opened = await epicOpenFolderPath(report.folder);
    if (opened) toast(opened, "ok");
  } catch (error) {
    toast(String(error), "err");
  }
}

// Escape belongs to the feedback dialog while it is on screen. Capture runs
// before the global Escape chain, which would otherwise close a page behind it.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape" || !feedbackRoot.firstElementChild) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeFeedback();
  },
  true,
);
