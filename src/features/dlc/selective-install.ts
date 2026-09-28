/**
 * Selective install modal.
 *
 * Lets the user choose optional language/extra tags and DLC packs before
 * starting an install. State lives in S; the actual install runs through the
 * shared Epic actions.
 */

import { epicInstall, refreshEpicInstalled } from "../../core/epic-actions";
import { selectiveRoot } from "../../core/dom";
import { epicArt, refreshGameActionUi } from "../../core/game-view";
import { icon } from "../../core/icons";
import { updateBadge } from "../../core/nav";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { epicGetInstallOptions, epicGetQueue, epicInstallWithOptions } from "../../epic";
import { summaryOf } from "../../core/selectors";
export async function openSelectiveModal(appName: string): Promise<void> {
  const s = summaryOf(appName);
  if (s?.installed) {
    // Installed game: run update/repair directly.
    void epicInstall(appName);
    return;
  }
  toast(t("selective.checking"), "");
  try {
    const opts = await epicGetInstallOptions(appName);
    if (!opts.hasOptions) {
      void epicInstall(appName, S.selectiveInstallDir);
      return;
    }
    S.selectiveInstallOptions = opts;
    S.selectedInstallTags.clear();
    S.selectedDlcAppIds.clear();
    renderSelectiveModal();
  } catch (_err) {
    void epicInstall(appName);
  }
}

export async function applySelectiveInstall(appName: string, tags: string[], dlcs: string[]): Promise<void> {
  const s = summaryOf(appName);
  const title = s ? s.title : appName;
  const installDir = S.selectiveInstallDir;
  closeSelectiveModal();
  S.downloads.set(appName, { progress: 0, done: false, title });
  if (!S.activeDlMetrics || S.activeDlMetrics.done) {
    S.activeDlMetrics = {
      id: appName,
      title,
      progress: 0,
      done: false,
      speed: t("dl.starting"),
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: t("dl.calculating"),
      downloadedBytes: 0,
      totalBytes: 0,
    };
  }
  updateBadge();
  refreshGameActionUi(appName);
  toast(t("selective.starting"), "");
  try {
    const msg = await epicInstallWithOptions(appName, tags, dlcs, installDir);
    toast(msg, "ok");
    S.dlQueueStatus = await epicGetQueue();
    render();
    void refreshEpicInstalled();
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    render();
    toast(t("selective.startFailed", { msg: String(e) }), "err");
  }
}

export function closeSelectiveModal(): void {
  S.selectiveInstallOptions = null;
  S.selectiveInstallDir = null;
  S.selectedInstallTags.clear();
  S.selectedDlcAppIds.clear();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
}

/** Small "select all / clear" pair shown on each accordion header. */
function bulkActions(group: string): string {
  return `
    <span class="selective-acc-actions">
      <button class="selective-link" data-act="selective-bulk" data-group="${group}" data-mode="all">${t("selective.selectAll")}</button>
      <button class="selective-link" data-act="selective-bulk" data-group="${group}" data-mode="none">${t("selective.clear")}</button>
    </span>`;
}

/** One option row: label on the left, size + control on the right. */
function selectiveRow(label: string, size: number, control: string, rowClass = ""): string {
  return `
    <div class="selective-row${rowClass}">
      <div class="selective-row-info">
        <span class="selective-row-label">${label}</span>
      </div>
      <div class="selective-row-right">
        <span class="selective-row-size">${fmtBytes(size)}</span>
        ${control}
      </div>
    </div>`;
}

export function renderSelectiveModal(): void {
  if (!selectiveRoot || !S.selectiveInstallOptions) return;
  const opts = S.selectiveInstallOptions;

  const existingBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  const scrollPos = existingBody ? existingBody.scrollTop : 0;

  const langTags = opts.tags.filter((tag) => tag.category === "languages");
  const extraTags = opts.tags.filter((tag) => tag.category === "extras");
  const summary = summaryOf(opts.appName);

  let totalDl = opts.baseDownloadSize || opts.baseSize;
  let totalDisk = opts.baseSize;

  for (const tag of opts.tags) {
    if (S.selectedInstallTags.has(tag.tag)) {
      totalDl += tag.downloadSize || tag.size;
      totalDisk += tag.size;
    }
  }

  for (const dlc of opts.dlcs) {
    if (S.selectedDlcAppIds.has(dlc.appId)) {
      totalDl += dlc.size;
      totalDisk += dlc.size;
    }
  }

  const selectedCount = S.selectedInstallTags.size + S.selectedDlcAppIds.size;

  const tagSection = (labelKey: string, group: string, tags: typeof opts.tags): string => {
    if (tags.length === 0) return "";
    return `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          ${icon("chevron-down", 11)} <span>${t(labelKey)} (${tags.length})</span>
          ${bulkActions(group)}
        </div>
        <div class="selective-accordion-list">
          ${tags
            .map((tag) =>
              selectiveRow(
                esc(localizeMessage(tag.label)),
                tag.size,
                `<input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(tag.tag)}" ${S.selectedInstallTags.has(tag.tag) ? "checked" : ""} />`,
              ),
            )
            .join("")}
        </div>
      </div>
    `;
  };

  // Every add-on is listed: installed ones stay visible with an "Installed" badge
  // (Epic's dialog does the same) instead of silently disappearing.
  const dlcsHtml = opts.dlcs.length === 0
    ? ""
    : `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          ${icon("chevron-down", 11)} <span>${t("selective.dlcs")} (${opts.dlcs.length})</span>
          ${bulkActions("dlcs")}
        </div>
        <div class="selective-accordion-list">
          ${opts.dlcs
            .map((d) =>
              d.installed
                ? selectiveRow(
                    `${esc(d.title)} <span class="chip ok">${t("selective.installed")}</span>`,
                    d.size,
                    `<input type="checkbox" class="selective-checkbox" checked disabled />`,
                    " installed",
                  )
                : selectiveRow(
                    esc(d.title),
                    d.size,
                    `<input type="checkbox" class="selective-checkbox" data-act="selective-toggle-dlc" data-dlc="${esc(d.appId)}" ${S.selectedDlcAppIds.has(d.appId) ? "checked" : ""} />`,
                  ),
            )
            .join("")}
        </div>
      </div>
    `;

  selectiveRoot.innerHTML = `
    <div class="selective-overlay" data-act="selective-overlay-close">
      <div class="selective-dialog">
        <div class="selective-header">
          <div class="selective-head-group">
            <div class="selective-head-cover">${summary ? epicArt(summary) : ""}</div>
            <h2>${esc(opts.title)} <span class="muted-sub">${t("selective.options")}</span></h2>
          </div>
          <button class="manage-head-close" data-act="selective-close" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="selective-body">
          <div class="selective-row base">
            <div class="selective-row-info">
              <span class="selective-row-label">${icon("lock", 12)} ${esc(opts.title)} <span class="muted-sub">${t("selective.required")}</span></span>
            </div>
            <div class="selective-row-right">
              <span class="selective-row-size">${fmtBytes(opts.baseSize)}</span>
              <input type="checkbox" class="selective-checkbox" checked disabled />
            </div>
          </div>

          ${tagSection("selective.extraLanguages", "languages", langTags)}
          ${tagSection("selective.extraPacks", "extras", extraTags)}
          ${dlcsHtml}

          <p class="selective-note">${t("selective.note")}</p>
        </div>

        <div class="selective-footer">
          <div class="selective-footer-stats">
            <span>${t("selective.selectedCount", { count: selectedCount })}</span>
            <span>${t("selective.downloadSize")}: <strong>${fmtBytes(totalDl)}</strong></span>
            <span>${t("selective.storageSize")}: <strong>${fmtBytes(totalDisk)}</strong></span>
          </div>
          <button class="selective-apply-btn" data-act="selective-apply" data-id="${esc(opts.appName)}">
            ${t("selective.apply")}
          </button>
        </div>
      </div>
    </div>
  `;

  const newBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  if (newBody && scrollPos > 0) newBody.scrollTop = scrollPos;
}
