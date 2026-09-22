/**
 * Selective install modal.
 *
 * Lets the user choose optional language/extra tags and DLC packs before
 * starting an install. State lives in S; the actual install runs through the
 * shared Epic actions.
 */

import { epicInstall, refreshEpicInstalled } from "../../core/epic-actions";
import { selectiveRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { updateBadge } from "../../core/nav";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtBytes } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { epicGetInstallOptions, epicGetQueue, epicInstallWithOptions } from "../../epic";
export async function openSelectiveModal(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (s?.installed) {
    // Installed game: run update/repair directly.
    void epicInstall(appName);
    return;
  }
  toast(t("selective.checking"), "");
  try {
    const opts = await epicGetInstallOptions(appName);
    if (!opts.hasOptions) {
      void epicInstall(appName);
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
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s ? s.title : appName;
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
  render();
  toast(t("selective.starting"), "");
  try {
    const msg = await epicInstallWithOptions(appName, tags, dlcs, null);
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
  S.selectedInstallTags.clear();
  S.selectedDlcAppIds.clear();
  if (selectiveRoot) selectiveRoot.innerHTML = "";
}

export function renderSelectiveModal(): void {
  if (!selectiveRoot || !S.selectiveInstallOptions) return;
  const opts = S.selectiveInstallOptions;

  const existingBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  const scrollPos = existingBody ? existingBody.scrollTop : 0;

  const langTags = opts.tags.filter((tag) => tag.category === "languages");
  const extraTags = opts.tags.filter((tag) => tag.category === "extras");
  const uninstalledDlcs = opts.dlcs.filter((d) => !d.installed);

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

  let langsHtml = "";
  if (langTags.length > 0) {
    langsHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          ${icon("chevron-down", 11)} ${t("selective.extraLanguages")} (${langTags.length})
        </div>
        <div class="selective-accordion-list">
          ${langTags
            .map((tag) => {
              const isChecked = S.selectedInstallTags.has(tag.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(localizeMessage(tag.label))}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(tag.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(tag.tag)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  let extrasHtml = "";
  if (extraTags.length > 0) {
    extrasHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          ${icon("chevron-down", 11)} ${t("selective.extraPacks")} (${extraTags.length})
        </div>
        <div class="selective-accordion-list">
          ${extraTags
            .map((tag) => {
              const isChecked = S.selectedInstallTags.has(tag.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(localizeMessage(tag.label))}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(tag.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(tag.tag)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  let dlcsHtml = "";
  if (uninstalledDlcs.length > 0) {
    dlcsHtml = `
      <div class="selective-accordion">
        <div class="selective-accordion-head">
          ${icon("chevron-down", 11)} ${t("selective.dlcs")} (${uninstalledDlcs.length})
        </div>
        <div class="selective-accordion-list">
          ${uninstalledDlcs
            .map((d) => {
              const isChecked = S.selectedDlcAppIds.has(d.appId);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(d.title)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(d.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-dlc" data-dlc="${esc(d.appId)}" ${isChecked ? "checked" : ""} />
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  selectiveRoot.innerHTML = `
    <div class="selective-overlay" data-act="selective-overlay-close">
      <div class="selective-dialog">
        <div class="selective-header">
          <h2>${esc(opts.title)} ${t("selective.options")}</h2>
          <button class="manage-head-close" data-act="selective-close" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>
        <div class="selective-body">
          <div class="selective-row base">
            <div class="selective-row-info">
              <span class="selective-row-label">${esc(opts.title)} <span class="muted-sub">${t("selective.required")}</span></span>
            </div>
            <div class="selective-row-right">
              <span class="selective-row-size">${fmtBytes(opts.baseSize)}</span>
              <input type="checkbox" class="selective-checkbox" checked disabled />
            </div>
          </div>

          ${langsHtml}
          ${extrasHtml}
          ${dlcsHtml}
        </div>

        <div class="selective-footer">
          <div class="selective-footer-stats">
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
