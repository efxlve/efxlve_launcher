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

let report: FeedbackReport | null = null;
let currentNote = "";
let includeLogs = true;
let generation = 0;

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || "report.zip";
}

function renderFeedback(): void {
  const close = `<button type="button" class="manage-head-close" data-act="feedback-close" title="${esc(t("common.close"))}">${icon("x", 16)}</button>`;
  const head = (title: string): string => `
    <div class="modal-head">
      <h3 class="modal-title">${esc(title)}</h3>
      ${close}
    </div>`;

  const content = report
    ? `
      ${head(t("feedback.readyTitle"))}
      <p class="feedback-intro">${esc(t("feedback.readyBody"))}</p>
      <div class="feedback-report-file"><code>${esc(fileName(report.path))}</code></div>
      <ul class="feedback-file-list">
        ${report.files.map((file) => `<li>${esc(file)}</li>`).join("")}
      </ul>
      <p class="feedback-warning">${icon("info", 14)} ${esc(t("feedback.attachHint"))}</p>
      <div class="modal-foot">
        <button type="button" class="btn ghost" data-act="feedback-close">${esc(t("common.close"))}</button>
        <button type="button" class="btn ghost" data-act="feedback-open-folder">${icon("folder", 13)} ${esc(t("feedback.openFolder"))}</button>
        <button type="button" class="btn primary" data-act="feedback-open-github">${icon("github", 13)} ${esc(t("feedback.openGithub"))}</button>
      </div>`
    : `
      ${head(t("feedback.title"))}
      <p class="feedback-intro">${esc(t("feedback.intro"))}</p>
      <label class="feedback-label" for="feedback-note">${esc(t("feedback.noteLabel"))}</label>
      <textarea id="feedback-note" class="feedback-note" maxlength="2000" placeholder="${esc(t("feedback.notePlaceholder"))}"></textarea>
      <label class="feedback-check">
        <input type="checkbox" id="feedback-include-logs" ${includeLogs ? "checked" : ""} />
        <span>${esc(t("feedback.includeLogs"))}</span>
      </label>
      <p class="feedback-warning">${icon("info", 14)} ${esc(t("feedback.privacy"))}</p>
      <div class="modal-foot">
        <button type="button" class="btn ghost" data-act="feedback-close">${esc(t("common.cancel"))}</button>
        <button type="button" class="btn primary" id="feedback-create" data-act="feedback-create">${esc(t("feedback.create"))}</button>
      </div>`;

  feedbackRoot.innerHTML = `
    <div class="confirm-layer feedback-layer">
      <div class="modal-backdrop" data-act="feedback-close">
        <div class="modal feedback-modal" role="dialog" aria-modal="true" data-act="prevent-modal-close">
          ${content}
        </div>
      </div>
    </div>`;

  const note = document.getElementById("feedback-note") as HTMLTextAreaElement | null;
  if (note) {
    note.value = currentNote;
    note.addEventListener("input", () => {
      currentNote = note.value;
    });
    note.focus();
  }
  const logs = document.getElementById("feedback-include-logs") as HTMLInputElement | null;
  logs?.addEventListener("change", () => {
    includeLogs = logs.checked;
  });
}

export function openFeedback(): void {
  generation += 1;
  report = null;
  currentNote = "";
  includeLogs = true;
  renderFeedback();
}

export function closeFeedback(): void {
  generation += 1;
  report = null;
  currentNote = "";
  includeLogs = true;
  feedbackRoot.innerHTML = "";
}

export async function createFeedbackReport(): Promise<void> {
  const note = currentNote.trim();
  if (!note) {
    toast(t("feedback.noteRequired"), "err");
    document.getElementById("feedback-note")?.focus();
    return;
  }
  const token = generation;
  const button = document.getElementById("feedback-create") as HTMLButtonElement | null;
  if (button) {
    button.disabled = true;
    button.textContent = t("feedback.creating");
  }
  try {
    const created = await feedbackCreateReport(note, includeLogs);
    if (token !== generation) return;
    report = created;
    renderFeedback();
  } catch (error) {
    if (token !== generation) return;
    if (button) {
      button.disabled = false;
      button.textContent = t("feedback.create");
    }
    toast(`${t("feedback.createFailed")} ${String(error)}`, "err");
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

