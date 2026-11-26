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
  S.selectiveInstalled = false;
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
    // Epic preselects Fortnite's modes; the backend uses the same defaults for
    // an update that carries no selection.
    for (const tag of opts.tags) {
      if (tag.defaultSelected) S.selectedInstallTags.add(tag.tag);
    }
    S.selectedDlcAppIds.clear();
    renderSelectiveModal();
  } catch (_err) {
    void epicInstall(appName);
  }
}

/**
 * Re-opens the same pack picker for an installed copy from Manage. Installed
 * rows stay checked and disabled, and applying adds the new rows to the real
 * installed tag set, so the base install is never replaced by the fresh-install
 * defaults.
 */
export async function openInstalledOptions(appName: string): Promise<void> {
  const s = summaryOf(appName);
  if (!s?.installed) {
    await openSelectiveModal(appName);
    return;
  }
  toast(t("selective.checking"), "");
  try {
    const opts = await epicGetInstallOptions(appName);
    if (!opts.hasOptions) {
      toast(t("selective.none"), "");
      return;
    }
    S.selectiveInstallOptions = opts;
    S.selectedInstallTags.clear();
    // The manage picker starts on what is actually on disk. New rows are the
    // only ones that change the download size.
    for (const tag of opts.tags) {
      if (tag.installed) S.selectedInstallTags.add(tag.tag);
    }
    S.selectedDlcAppIds.clear();
    S.selectiveInstalled = true;
    S.selectiveInstallDir = null;
    renderSelectiveModal();
  } catch (err) {
    toast(t("selective.checkFailed", { msg: String(err) }), "err");
  }
}

export async function applySelectiveInstall(appName: string, tags: string[], dlcs: string[]): Promise<void> {
  const s = summaryOf(appName);
  const title = s ? s.title : appName;
  // A row is an SDL group; legendary filters on the raw tags, so flatten the
  // selected groups before closing the modal that holds them.
  const options = S.selectiveInstallOptions;
  const installedMode = S.selectiveInstalled;
  let installTags = tags.flatMap((key) => {
    const row = options?.tags.find((tag) => tag.tag === key);
    return row?.tags && row.tags.length > 0 ? row.tags : [key];
  });
  // Adding packs to an installed copy must never feed legendary a smaller
  // selection than the files on disk: it would treat them as removed.
  if (installedMode) {
    installTags = Array.from(new Set([...(options?.installedTags ?? []), ...installTags]));
  }
  // An empty list means "no selection given" to legendary, which the backend
  // treats as an update and fills with the default modes. The untagged tag is
  // the explicit "required content only" choice.
  if (installTags.length === 0) installTags.push("");
  // The installed path is already on disk: reuse its parent as the base folder
  // instead of the fresh-install dialog's default drive.
  const installDir = installedMode
    ? s?.installPath
      ? s.installPath.replace(/[\\/][^\\/]+$/, "")
      : null
    : S.selectiveInstallDir;
  closeSelectiveModal();
  // Resuming a partial install keeps its percentage and drops the resume row.
  const resume = S.epicResumable.get(appName);
  const startProgress = resume?.progress ?? 0;
  S.downloads.set(appName, { progress: startProgress, done: false, title });
  S.epicResumable.delete(appName);
  if (!S.activeDlMetrics || S.activeDlMetrics.done) {
    S.activeDlMetrics = {
      id: appName,
      title,
      progress: startProgress,
      done: false,
      speed: t("dl.starting"),
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: t("dl.calculating"),
      downloadedBytes: resume?.downloadedBytes ?? 0,
      totalBytes: resume?.totalBytes ?? 0,
      phase: "starting",
    };
  }
  updateBadge();
  refreshGameActionUi(appName);
  toast(t("selective.starting"), "");
  try {
    const msg = await epicInstallWithOptions(appName, installTags, dlcs, installDir);
    toast(msg, "ok");
    S.dlQueueStatus = (await epicGetQueue()) ?? S.dlQueueStatus;
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
  S.selectiveInstalled = false;
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

  const modeTags = opts.tags.filter((tag) => tag.category === "modes");
  const langTags = opts.tags.filter((tag) => tag.category === "languages");
  const extraTags = opts.tags.filter((tag) => tag.category === "extras");
  const summary = summaryOf(opts.appName);
  const installedMode = S.selectiveInstalled;

  let totalDl = installedMode ? 0 : opts.baseDownloadSize || opts.baseSize;
  let totalDisk = installedMode ? 0 : opts.baseSize;

  for (const tag of opts.tags) {
    if (S.selectedInstallTags.has(tag.tag) && !(installedMode && tag.installed)) {
      totalDl += tag.downloadSize || tag.size;
      totalDisk += tag.size;
    }
  }

  for (const dlc of opts.dlcs) {
    if (S.selectedDlcAppIds.has(dlc.appId) && !(installedMode && dlc.installed)) {
      totalDl += dlc.size;
      totalDisk += dlc.size;
    }
  }

  const selectedCount = installedMode
    ? opts.tags.filter((tag) => !tag.installed && S.selectedInstallTags.has(tag.tag)).length +
      opts.dlcs.filter((dlc) => !dlc.installed && S.selectedDlcAppIds.has(dlc.appId)).length
    : S.selectedInstallTags.size + S.selectedDlcAppIds.size;

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
            .map((tag) => {
              const installed = Boolean(tag.installed);
              const label = `${esc(localizeMessage(tag.label))}${installed ? ` <span class="chip ok">${t("selective.installed")}</span>` : ""}`;
              const control = installed
                ? `<input type="checkbox" class="selective-checkbox" checked disabled />`
                : `<input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(tag.tag)}" ${S.selectedInstallTags.has(tag.tag) ? "checked" : ""} />`;
              return selectiveRow(label, tag.size, control, installed ? " installed" : "");
            })
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
    <div class="selective-overlay${installedMode ? " over-manage" : ""}" data-act="selective-overlay-close">
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

          ${tagSection("selective.gameModes", "modes", modeTags)}
          ${tagSection("selective.extraLanguages", "languages", langTags)}
          ${tagSection("selective.extraPacks", "extras", extraTags)}
          ${dlcsHtml}

          <p class="selective-note">${installedMode ? t("selective.installedNote") : t("selective.note")}</p>
        </div>

        <div class="selective-footer">
          <div class="selective-footer-stats">
            <span>${t(installedMode ? "selective.newSelected" : "selective.selectedCount", { count: selectedCount })}</span>
            <span>${t(installedMode ? "selective.addedDownload" : "selective.downloadSize")}: <strong>${fmtBytes(totalDl)}</strong></span>
            <span>${t(installedMode ? "selective.addedStorage" : "selective.storageSize")}: <strong>${fmtBytes(totalDisk)}</strong></span>
          </div>
          <button class="selective-apply-btn" data-act="selective-apply" data-id="${esc(opts.appName)}" ${installedMode && selectedCount === 0 ? "disabled" : ""}>
            ${t(installedMode ? "selective.addContent" : "selective.apply")}
          </button>
        </div>
      </div>
    </div>
  `;

  const newBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  if (newBody && scrollPos > 0) newBody.scrollTop = scrollPos;
}
