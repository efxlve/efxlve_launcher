/**
 * In-app archive guide. The screen has to explain the part sizes, the target
 * folder and the optional xtool step without assuming the user has seen a
 * repack before.
 */
import { icon, type IconName } from "../../core/icons";
import { IS_WINDOWS } from "../../core/platform";
import { t } from "../../i18n";

function section(iconName: IconName, titleKey: string, bodyKey: string): string {
  return `
    <section class="archive-guide-section">
      <h4>${icon(iconName, 14)} ${t(titleKey)}</h4>
      <p>${t(bodyKey)}</p>
    </section>`;
}

export function renderArchiveGuide(): string {
  const quick = [1, 2, 3, 4, 5]
    .map((step) => `<li>${t(`archive.guideQuick${step}`)}</li>`)
    .join("");
  const trouble = (IS_WINDOWS ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5])
    .map((step) => `<li>${t(`archive.guideTrouble${step}`)}</li>`)
    .join("");
  const xtool = IS_WINDOWS
    ? `<section class="archive-guide-section">
         <h4>${icon("sparkles", 14)} ${t("archive.guideXtoolTitle")}</h4>
         <p>${t("archive.guideXtoolBody")}</p>
         <p>${t("archive.guideXtoolInstall")}</p>
         <p>${t("archive.guideXtoolSecurity")}</p>
         <p>${t("archive.guideXtoolRestore")}</p>
         <p class="archive-guide-note">${t("archive.guideXtoolLegal")}</p>
       </section>`
    : "";
  return `
    <div class="archive-guide">
      <p class="archive-guide-lead">${t("archive.guideIntro")}</p>

      <section class="archive-guide-section">
        <h4>${icon("rocket", 14)} ${t("archive.guideQuickTitle")}</h4>
        <ol class="archive-guide-steps">${quick}</ol>
      </section>

      ${section("package", "archive.guideWhatTitle", "archive.guideWhatBody")}
      ${section("layers", "archive.guidePartsTitle", "archive.guidePartsBody")}
      ${section("folder", "archive.guideTargetTitle", "archive.guideTargetBody")}
      ${section("activity", "archive.guideCompressionTitle", "archive.guideCompressionBody")}
      ${section("search", "archive.guideEstimateTitle", "archive.guideEstimateBody")}

      ${xtool}

      ${section("hard-drive", "archive.guideBackupTitle", "archive.guideBackupBody")}
      ${section("download", "archive.guideRestoreTitle", "archive.guideRestoreBody")}
      ${section("hard-drive", "archive.guideBurnTitle", "archive.guideBurnBody")}

      <section class="archive-guide-section">
        <h4>${icon("alert-triangle", 14)} ${t("archive.guideTroubleTitle")}</h4>
        <ul class="archive-guide-bullets">${trouble}</ul>
      </section>

      <section class="archive-guide-section">
        <h4>${icon("info", 14)} ${t("archive.guideNotesTitle")}</h4>
        <p>${t("archive.guideNotesBody")}</p>
      </section>
    </div>`;
}
