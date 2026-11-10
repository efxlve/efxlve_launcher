/**
 * In-app guide for Cloud Saves & Backup.
 *
 * The page itself carries short explanations; this modal is the one place that
 * answers "what exactly is saved, where does it go, and how do I get it back".
 */

import { icon, type IconName } from "../../core/icons";
import { t } from "../../i18n";

const GUIDE_DOC_URL =
  "https://github.com/efxlve/efxlve_launcher/blob/main/docs/CLOUD_SAVES.md";

export function closeCloudGuideModal(): void {
  document.getElementById("cloud-guide-backdrop")?.remove();
}

function block(iconName: IconName, title: string, body: string): string {
  return `
    <section class="cs-guide-block">
      <span class="cs-guide-icon">${icon(iconName, 16)}</span>
      <div>
        <h4 class="cs-guide-title">${t(title)}</h4>
        <p class="cs-guide-text">${t(body)}</p>
      </div>
    </section>`;
}

export function openCloudGuideModal(): void {
  closeCloudGuideModal();

  const backdrop = document.createElement("div");
  backdrop.id = "cloud-guide-backdrop";
  backdrop.className = "modal-backdrop";
  backdrop.dataset.act = "close-cloud-guide";

  backdrop.innerHTML = `
    <div class="modal cs-guide" role="dialog" aria-modal="true" aria-labelledby="cloud-guide-title" data-act="prevent-modal-close">
      <div class="modal-head">
        <div class="cs-guide-head">
          <span class="cs-guide-hero-icon">${icon("shield", 18)}</span>
          <div>
            <h3 id="cloud-guide-title" class="modal-title">${t("cloud.guideTitle2")}</h3>
            <p class="cs-guide-intro">${t("cloud.guideIntro")}</p>
          </div>
        </div>
        <button type="button" class="manage-head-close" data-act="close-cloud-guide" title="${t("common.close")}">
          ${icon("x", 16)}
        </button>
      </div>

      <div class="modal-body cs-guide-body">
        ${block("package", "cloud.guideWhatTitle", "cloud.guideWhatDesc")}
        ${block("lock", "cloud.guideLocalTitle", "cloud.guideLocalDesc")}
        ${block("cloud", "cloud.guideWhereTitle", "cloud.guideWhereDesc")}
        ${block("download", "cloud.guideRestoreTitle", "cloud.guideRestoreDesc")}
        ${block("rocket", "cloud.guideMoveTitle", "cloud.guideMoveDesc")}
        ${block("search", "cloud.guideDetectTitle", "cloud.guideDetectDesc")}
        ${block("alert-triangle", "cloud.guideTroubleTitle", "cloud.guideTroubleDesc")}
        ${block("lock", "cloud.guidePasswordTitle", "cloud.guidePasswordDesc")}
        ${block("info", "cloud.guideNotSavedTitle", "cloud.guideNotSavedDesc")}
      </div>

      <div class="modal-foot cs-guide-foot">
        <button type="button" class="btn ghost small" data-act="open-external-url" data-url="${GUIDE_DOC_URL}">
          ${icon("external", 13)} ${t("cloud.openGithubGuide")}
        </button>
        <button type="button" class="btn primary small" data-act="close-cloud-guide">
          ${t("common.close")}
        </button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
}
