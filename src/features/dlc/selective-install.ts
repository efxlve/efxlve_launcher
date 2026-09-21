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
import { t } from "../../i18n";
import {
  epicGetInstallOptions,
  epicInstallWithOptions,
  type GameInstallOptions,
} from "../../epic";
export async function openSelectiveModal(appName: string): Promise<void> {
  const s = S.epicSummaries.find((x) => x.appName === appName);
  if (s?.installed) {
    // Kurulu oyun için doğrudan güncelleme/onarım çalıştır
    void epicInstall(appName);
    return;
  }
  toast("Kurulum seçenekleri denetleniyor…", "");
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
      speed: "Başlatılıyor…",
      speedBytes: 0,
      diskSpeed: "—",
      diskBytes: 0,
      eta: "Hesaplanıyor…",
      downloadedBytes: 0,
      totalBytes: 0,
    };
  }
  updateBadge();
  render();
  toast("Seçici kurulum başlatılıyor…", "");
  try {
    const msg = await epicInstallWithOptions(appName, tags, dlcs, null);
    toast(msg, "ok");
    void refreshEpicInstalled();
  } catch (e) {
    S.downloads.delete(appName);
    if (S.activeDlMetrics?.id === appName) S.activeDlMetrics = null;
    updateBadge();
    render();
    toast(`Kurulum başlatılamadı: ${String(e)}`, "err");
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

  const langTags = opts.tags.filter((t) => t.category === "languages");
  const extraTags = opts.tags.filter((t) => t.category === "extras");
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
          <span style="font-size:11px">▾</span> Ek Diller (${langTags.length})
        </div>
        <div class="selective-accordion-list">
          ${langTags
            .map((t) => {
              const isChecked = S.selectedInstallTags.has(t.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(t.label)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(t.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(t.tag)}" ${isChecked ? "checked" : ""} />
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
          <span style="font-size:11px">▾</span> Ek Paketler &amp; Dokular (${extraTags.length})
        </div>
        <div class="selective-accordion-list">
          ${extraTags
            .map((t) => {
              const isChecked = S.selectedInstallTags.has(t.tag);
              return `
                <div class="selective-row">
                  <div class="selective-row-info">
                    <span class="selective-row-label">${esc(t.label)}</span>
                  </div>
                  <div class="selective-row-right">
                    <span class="selective-row-size">${fmtBytes(t.size)}</span>
                    <input type="checkbox" class="selective-checkbox" data-act="selective-toggle-tag" data-tag="${esc(t.tag)}" ${isChecked ? "checked" : ""} />
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
          <span style="font-size:11px">▾</span> Eklentiler &amp; DLC (${uninstalledDlcs.length})
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
          <h2>${esc(opts.title)} Yükleme Seçenekleri</h2>
          <button class="manage-head-close" data-act="selective-close" title="Kapat">${icon("x", 16)}</button>
        </div>
        <div class="selective-body">
          <div class="selective-row base">
            <div class="selective-row-info">
              <span class="selective-row-label">${esc(opts.title)} <span class="muted-sub">(Gerekli)</span></span>
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
            <span>İndirilecek Dosya Boyutu: <strong>${fmtBytes(totalDl)}</strong></span>
            <span>Gerekli Depolama Alanı: <strong>${fmtBytes(totalDisk)}</strong></span>
          </div>
          <button class="selective-apply-btn" data-act="selective-apply" data-id="${esc(opts.appName)}">
            Uygula
          </button>
        </div>
      </div>
    </div>
  `;

  const newBody = selectiveRoot.querySelector(".selective-body") as HTMLElement | null;
  if (newBody && scrollPos > 0) newBody.scrollTop = scrollPos;
}
