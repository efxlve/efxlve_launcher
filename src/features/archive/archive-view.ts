/**
 * Settings > Archive: compress an installed game into disc-sized parts and
 * restore one of those backups later.
 */

import { icon } from "../../core/icons";
import { IS_WINDOWS } from "../../core/platform";
import { S } from "../../core/state";
import { esc, fmtBytes, fmtSpeed } from "../../core/utils";
import { currentLanguage, t, localizeMessage } from "../../i18n";
import type {
  ArchivePlan,
  ArchiveProgress,
  ArchiveSummary,
  DiscRecorder,
  FoundArchive,
  RestoreResult,
} from "../../archive";
import { archiveGameList, loadArchiveView, selectedArchiveGame } from "./archive-actions";

function storeName(key: string): string {
  if (key.startsWith("steam::")) return "Steam";
  if (key.startsWith("gog::")) return "GOG";
  if (key.startsWith("amazon::")) return "Amazon";
  if (key.startsWith("custom::")) return t("backups.storeCustom");
  if (key.startsWith("ubisoft::")) return "Ubisoft";
  if (key.startsWith("ea::")) return "EA";
  if (key.startsWith("xbox::")) return "Xbox";
  if (key.startsWith("battlenet::")) return "Battle.net";
  if (key.startsWith("riot::")) return "Riot Games";
  return "Epic";
}

function profileLabel(id: string): string {
  switch (id) {
    case "cd":
      return t("archive.profileCd");
    case "dvd5":
      return t("archive.profileDvd5");
    case "dvd9":
      return t("archive.profileDvd9");
    case "bd25":
      return t("archive.profileBd25");
    case "bd50":
      return t("archive.profileBd50");
    case "bd100":
      return t("archive.profileBd100");
    case "fat32":
      return t("archive.profileFat32");
    default:
      return t("archive.profileCustom");
  }
}

function partWord(count: number): string {
  return count === 1 ? t("archive.partOne") : t("archive.partMany");
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "scanning":
      return t("archive.stageScanning");
    case "compressing":
      return t("archive.stageCompressing");
    case "finalizing":
      return t("archive.stageFinalizing");
    case "restoring":
      return t("archive.stageRestoring");
    case "registering":
      return t("archive.stageRegistering");
    case "done":
      return t("archive.stageDone");
    case "failed":
      return t("archive.stageFailed");
    default:
      return stage;
  }
}

function fmtBytesOrZero(bytes: number): string {
  return bytes > 0 ? fmtBytes(bytes) : "0 B";
}

function fmtEta(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds >= 3600) {
    return t("archive.etaHours", {
      h: Math.floor(seconds / 3600),
      m: Math.floor((seconds % 3600) / 60),
    });
  }
  if (seconds >= 60) {
    return t("archive.etaMinutes", {
      m: Math.floor(seconds / 60),
      s: seconds % 60,
    });
  }
  return t("archive.etaSeconds", { s: seconds });
}

export function fmtArchiveDate(seconds: number): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString(currentLanguage(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function renderArchiveSection(): string {
  if (S.settingsSection === "archive") loadArchiveView();
  const title = `<h3 class="section-title">${icon("package", 13)} ${t("archive.title")}</h3>
    <p class="page-sub settings-lang-desc">${t("archive.sub")}</p>`;
  const tabs = `
    <div class="archive-tabs" role="tablist">
      <button type="button" role="tab" class="btn ${S.archiveTab === "backup" ? "primary" : "ghost"} small" data-act="archive-tab" data-tab="backup" aria-selected="${S.archiveTab === "backup"}">${icon("package", 13)} ${t("archive.tabBackup")}</button>
      <button type="button" role="tab" class="btn ${S.archiveTab === "restore" ? "primary" : "ghost"} small" data-act="archive-tab" data-tab="restore" aria-selected="${S.archiveTab === "restore"}">${icon("hard-drive", 13)} ${t("archive.tabRestore")}</button>
    </div>`;
  return `${title}${tabs}${S.archiveTab === "backup" ? renderBackupTab() : renderRestoreTab()}`;
}

function renderBackupTab(): string {
  const games = archiveGameList();
  if (!games.length) {
    return `<div class="info-box">${icon("info", 14)}<span>${t("archive.noInstalledGames")}</span></div>`;
  }
  const game = selectedArchiveGame() ?? games[0];
  if (S.archiveSelectedApp !== game.key) S.archiveSelectedApp = game.key;
  const profiles = S.archiveProfiles ?? [];
  const plan = S.archivePlan;
  const running = S.archiveRunning;
  const registering = running && S.archiveProgress?.stage === "registering";
  return `
    <div class="list settings-group archive-card">
      <div class="row settings-row stacked">
        <div class="row-main">
          <div class="settings-row-title">${t("archive.game")}</div>
          <div class="settings-row-desc">${t("archive.gameDesc")}</div>
        </div>
        <select class="settings-select archive-game-select" data-act="archive-select-game">
          ${games
            .map(
              (item) =>
                `<option value="${esc(item.key)}" ${item.key === game.key ? "selected" : ""}>${esc(item.title)} · ${storeName(item.key)}</option>`,
            )
            .join("")}
        </select>
      </div>
      <div class="row settings-row stacked">
        <div class="row-main">
          <div class="settings-row-title">${t("archive.mediaTitle")}</div>
          <div class="settings-row-desc">${t("archive.mediaDesc")}</div>
        </div>
        <div class="archive-profiles">
          ${profiles
            .map(
              (profile) => `
                <button type="button" class="archive-profile ${profile.id === S.archiveProfile ? "active" : ""}" data-act="archive-profile" data-profile="${esc(profile.id)}">
                  <span class="archive-profile-name">${esc(profileLabel(profile.id))}</span>
                  <span class="archive-profile-size tabular-nums">${profile.id === "custom" ? `${S.archiveCustomMib} MiB` : fmtBytes(profile.volumeBytes)} / ${t("archive.partOne")}</span>
                  <span class="archive-profile-fs">${esc(profile.fileSystem)}</span>
                </button>`,
            )
            .join("")}
        </div>
        ${
          S.archiveProfile === "custom"
            ? `<div class="archive-inline">
                 <label class="archive-inline-label" for="archive-custom-mib">${t("archive.customSize")}</label>
                 <input id="archive-custom-mib" class="input archive-number" type="number" min="16" max="1000000" value="${S.archiveCustomMib}" data-act="archive-custom-mib" />
                 <span class="archive-inline-unit">MiB</span>
               </div>`
            : ""
        }
        <div class="archive-note">${t("archive.mediaHint")}</div>
      </div>
      <div class="row settings-row">
        <div class="row-main">
          <div class="settings-row-title">${t("archive.level")}</div>
          <div class="settings-row-desc">${t("archive.levelDesc")}</div>
        </div>
        <div class="settings-row-control">
          <select class="settings-select" data-act="archive-level">
            <option value="fast" ${S.archiveLevel === "fast" ? "selected" : ""}>${t("archive.levelFast")}</option>
            <option value="balanced" ${S.archiveLevel === "balanced" ? "selected" : ""}>${t("archive.levelBalanced")}</option>
            <option value="max" ${S.archiveLevel === "max" ? "selected" : ""}>${t("archive.levelMax")}</option>
          </select>
        </div>
      </div>
      <div class="row settings-row stacked">
        <div class="row-main">
          <div class="settings-row-title">${t("archive.target")}</div>
          <div class="settings-row-desc">${t("archive.targetDesc")}</div>
        </div>
        <div class="archive-inline">
          <input id="archive-target-input" class="input archive-path" type="text" value="${esc(S.archiveTarget)}" placeholder="${esc(t("archive.targetPlaceholder"))}" data-act="archive-target-input" />
          <button type="button" class="btn ghost small" data-act="archive-pick-target">${icon("folder", 13)} ${t("archive.chooseFolder")}</button>
        </div>
      </div>
    </div>
    ${renderPlanSummary(plan)}
    <div class="archive-note archive-start-hint">${t("archive.startHint")}</div>
    <div class="archive-actions">
      ${
        running
          ? registering
            ? `<button type="button" class="btn ghost small" disabled>${icon("refresh", 13, "spin")} ${t("archive.stageRegistering")}</button>`
            : `<button type="button" class="btn danger small" data-act="archive-cancel">${icon("x", 13)} ${t("archive.cancel")}</button>`
          : `<button type="button" class="btn primary" data-act="archive-start" ${!plan || !plan.enoughSpace || !plan.volumeFits || S.archiveBurning !== null ? "disabled" : ""}>${icon("package", 14)} ${t("archive.start")}</button>`
      }
    </div>
    ${S.archiveResult ? "" : renderProgress(S.archiveProgress, "archive")}
    ${renderBackupResult(S.archiveResult)}
    ${S.archiveResult?.discLayout && IS_WINDOWS ? renderBurnPanel(S.archiveResult.manifestPath) : ""}
  `;
}

function renderPlanSummary(plan: ArchivePlan | null): string {
  if (S.archivePlanLoading && !plan) {
    return `<div class="archive-summary archive-loading">${icon("refresh", 14, "spin")} ${t("archive.calculating")}</div>`;
  }
  if (!plan) {
    return `<div class="archive-summary archive-loading">${t("archive.noPlan")}</div>`;
  }
  const free = plan.freeBytes == null ? "—" : fmtBytesOrZero(plan.freeBytes);
  return `
    <div class="archive-summary">
      <div class="archive-summary-grid">
        <div><span class="archive-k">${t("archive.originalSize")}</span><span class="archive-v tabular-nums">${fmtBytes(plan.originalBytes)}</span></div>
        <div><span class="archive-k">${t("archive.files")}</span><span class="archive-v tabular-nums">${plan.fileCount.toLocaleString()}</span></div>
        <div><span class="archive-k">${t("archive.estimatedVolumes")}</span><span class="archive-v tabular-nums">${plan.estimatedVolumes}</span></div>
        <div><span class="archive-k">${t("archive.freeSpace")}</span><span class="archive-v tabular-nums ${plan.enoughSpace ? "" : "is-err"}">${free}${plan.targetFileSystem ? ` · ${esc(plan.targetFileSystem)}` : ""}</span></div>
        <div><span class="archive-k">${t("archive.selectedMedia")}</span><span class="archive-v">${esc(profileLabel(S.archiveProfile))}</span></div>
        <div><span class="archive-k">${t("archive.partSize")}</span><span class="archive-v tabular-nums">${fmtBytesOrZero(plan.volumeBytes)}</span></div>
      </div>
      <div class="archive-path-line"><span class="archive-k">${t("archive.outputFolder")}</span><span class="archive-path-value">${esc(plan.archivePath)}</span></div>
      ${
        plan.enoughSpace
          ? ""
          : `<div class="archive-warn">${icon("alert-triangle", 13)} ${t("archive.notEnoughSpace", { need: fmtBytesOrZero(plan.requiredBytes), free })}</div>`
      }
      ${
        plan.volumeFits
          ? ""
          : `<div class="archive-warn">${icon("alert-triangle", 13)} ${t("archive.fat32Limit")}</div>`
      }
      ${
        plan.skippedLinks > 0
          ? `<div class="archive-note">${t("archive.skippedLinks", { count: plan.skippedLinks })}</div>`
          : ""
      }
    </div>`;
}

function renderBackupResult(result: ArchiveSummary | null): string {
  if (!result) return "";
  return `
    <div class="archive-result">
      <div class="archive-result-head">${icon("check-circle", 15)} <strong>${t("archive.resultTitle")}</strong></div>
      <div class="archive-result-title">${esc(result.title)}</div>
      <div class="archive-summary-grid">
        <div><span class="archive-k">${t("archive.originalSize")}</span><span class="archive-v tabular-nums">${fmtBytes(result.originalBytes)}</span></div>
        <div><span class="archive-k">${t("archive.storedSize")}</span><span class="archive-v tabular-nums">${fmtBytes(result.storedBytes)}</span></div>
        <div><span class="archive-k">${t("archive.parts")}</span><span class="archive-v tabular-nums">${result.volumeCount}</span></div>
        <div><span class="archive-k">${t("archive.compression")}</span><span class="archive-v tabular-nums">zstd ${result.compression.level}</span></div>
      </div>
      <div class="archive-path-line"><span class="archive-k">${t("archive.outputFolder")}</span><span class="archive-path-value">${esc(result.folder)}</span></div>
      <div class="archive-disc-hint">${icon("info", 13)} ${t("archive.discHint")}</div>
      <div class="archive-actions">
        <button type="button" class="btn ghost small" data-act="archive-open-folder" data-path="${esc(result.folder)}">${icon("folder", 13)} ${t("archive.openFolder")}</button>
      </div>
    </div>`;
}

function renderProgress(progress: ArchiveProgress | null, prefix: string): string {
  if (!progress) return "";
  const failed = progress.stage === "failed";
  return `
    <div class="archive-progress ${failed ? "is-err" : ""}" id="${prefix}-progress">
      <div class="archive-progress-head">
        <span id="${prefix}-progress-stage">${esc(stageLabel(progress.stage))}</span>
        <span class="tabular-nums" id="${prefix}-progress-percent">${progress.percent.toFixed(1)}%</span>
      </div>
      <div class="progress"><span id="${prefix}-progress-fill" style="width:${progress.percent}%"></span></div>
      <div class="archive-progress-meta">
        <span id="${prefix}-progress-bytes" class="tabular-nums">${fmtBytesOrZero(progress.processedBytes)} / ${fmtBytesOrZero(progress.totalBytes)}</span>
        <span id="${prefix}-progress-speed" class="tabular-nums">${progress.speedBytes ? fmtSpeed(progress.speedBytes) : ""}</span>
        <span id="${prefix}-progress-eta" class="tabular-nums">${progress.etaSeconds ? t("archive.eta", { eta: fmtEta(progress.etaSeconds) }) : ""}</span>
      </div>
      <div class="archive-progress-file" id="${prefix}-progress-file">${esc(progress.currentFile)}</div>
      <div class="archive-progress-volume" id="${prefix}-progress-volume">${progress.volume ? t("archive.volumeN", { n: progress.volume }) : ""}</div>
      ${
        failed && progress.error
          ? `<div class="archive-warn">${icon("alert-triangle", 13)} ${esc(localizeMessage(progress.error))}</div>`
          : ""
      }
    </div>`;
}

function renderRestoreTab(): string {
  const found = selectedFound();
  const restoreReady = Boolean(
    found && !found.missingVolumes.length && S.archiveRestoreTarget.trim(),
  );
  const registering = S.archiveRunning && S.archiveProgress?.stage === "registering";
  return `
    <div class="list settings-group archive-card">
      <div class="row settings-row stacked">
        <div class="row-main">
          <div class="settings-row-title">${t("archive.restoreSource")}</div>
          <div class="settings-row-desc">${t("archive.restoreSourceDesc")}</div>
        </div>
        <div class="archive-inline">
          <input id="archive-source-input" class="input archive-path" type="text" value="${esc(S.archiveSource)}" placeholder="${esc(t("archive.sourcePlaceholder"))}" data-act="archive-source-input" />
          <button type="button" class="btn ghost small" data-act="archive-pick-source">${icon("folder", 13)} ${t("archive.chooseFolder")}</button>
          <button type="button" class="btn primary small" data-act="archive-scan" ${S.archiveFoundLoading ? "disabled" : ""}>${S.archiveFoundLoading ? t("archive.scanning") : t("archive.scan")}</button>
        </div>
      </div>
    </div>
    ${renderFoundList()}
    ${renderRestoreDetail()}
    <div class="archive-actions">
      ${
        S.archiveRunning
          ? registering
            ? `<button type="button" class="btn ghost small" disabled>${icon("refresh", 13, "spin")} ${t("archive.stageRegistering")}</button>`
            : `<button type="button" class="btn danger small" data-act="archive-cancel">${icon("x", 13)} ${t("archive.cancel")}</button>`
          : `<button type="button" class="btn primary" data-act="archive-restore-start" ${restoreReady && S.archiveBurning === null ? "" : "disabled"}>${icon("download", 14)} ${t("archive.restoreStart")}</button>`
      }
    </div>
    ${S.archiveRestoreResult ? "" : renderProgress(S.archiveProgress, "archive")}
    ${renderRestoreResult(S.archiveRestoreResult)}
  `;
}

function missingLabels(found: FoundArchive): string {
  return found.missingVolumes
    .map(
      (index) =>
        found.manifest.volumes.find((volume) => volume.index === index)?.fileName ??
        String(index),
    )
    .join(", ");
}

function selectedFound(): FoundArchive | undefined {
  if (!S.archiveFound || !S.archiveSelectedManifest) return undefined;
  return S.archiveFound.find((item) => item.manifestPath === S.archiveSelectedManifest);
}

function renderFoundList(): string {
  if (S.archiveFoundLoading) {
    return `<div class="archive-summary archive-loading">${icon("refresh", 14, "spin")} ${t("archive.scanning")}</div>`;
  }
  if (!S.archiveFound) {
    return `<div class="archive-summary archive-loading">${t("archive.scanHint")}</div>`;
  }
  if (!S.archiveFound.length) {
    return `<div class="info-box">${icon("info", 14)}<span>${t("archive.noArchives")}</span></div>`;
  }
  return `
    <div class="archive-found-list">
      ${S.archiveFound
        .map((item) => {
          const missing = item.missingVolumes.length > 0;
          return `
            <button type="button" class="archive-found ${item.manifestPath === S.archiveSelectedManifest ? "active" : ""}" data-act="archive-select-found" data-manifest="${esc(item.manifestPath)}">
              <span class="archive-found-main">
                <span class="archive-found-title">${esc(item.manifest.title)}</span>
                <span class="archive-found-meta">${storeName(item.manifest.appName)} · ${fmtArchiveDate(item.manifest.createdAt)} · ${fmtBytes(item.storedBytes)} · ${item.manifest.volumes.length} ${partWord(item.manifest.volumes.length)}</span>
              </span>
              ${
                missing
                  ? `<span class="archive-found-warn">${icon("alert-triangle", 12)} ${t("archive.partsMissing", { count: item.missingVolumes.length })}</span>`
                  : `<span class="archive-found-ok">${icon("check-circle", 12)} ${t("archive.partsReady")}</span>`
              }
            </button>`;
        })
        .join("")}
    </div>`;
}

function renderRestoreDetail(): string {
  const found = selectedFound();
  if (!found) return "";
  const manifest = found.manifest;
  const missing = found.missingVolumes.length > 0;
  const finalPath = joinPath(S.archiveRestoreTarget, manifest.installDirName);
  return `
    <div class="archive-summary archive-restore-detail">
      <div class="archive-result-title">${esc(manifest.title)} <span class="archive-store">${storeName(manifest.appName)}</span></div>
      <div class="archive-summary-grid">
        <div><span class="archive-k">${t("archive.originalSize")}</span><span class="archive-v tabular-nums">${fmtBytes(manifest.originalBytes)}</span></div>
        <div><span class="archive-k">${t("archive.storedSize")}</span><span class="archive-v tabular-nums">${fmtBytes(found.storedBytes)}</span></div>
        <div><span class="archive-k">${t("archive.parts")}</span><span class="archive-v tabular-nums">${manifest.volumes.length}</span></div>
        <div><span class="archive-k">${t("archive.compression")}</span><span class="archive-v tabular-nums">zstd ${manifest.compression.level}</span></div>
      </div>
      ${
        missing
          ? `<div class="archive-warn">${icon("alert-triangle", 13)} ${esc(t("archive.missingList", { list: missingLabels(found) }))}</div>
             <div class="archive-actions"><button type="button" class="btn ghost small" data-act="archive-add-parts">${icon("folder", 13)} ${t("archive.addPartsFolder")}</button></div>
             ${S.archiveExtraDirs.length ? `<div class="archive-note">${t("archive.extraDirs", { count: S.archiveExtraDirs.length })}</div>` : ""}`
          : ""
      }
      <div class="archive-inline archive-restore-target">
        <label class="archive-inline-label" for="archive-restore-target">${t("archive.restoreTarget")}</label>
        <input id="archive-restore-target" class="input archive-path" type="text" value="${esc(S.archiveRestoreTarget)}" data-act="archive-restore-target-input" />
        <button type="button" class="btn ghost small" data-act="archive-pick-restore-target">${icon("folder", 13)} ${t("archive.chooseFolder")}</button>
      </div>
      <div class="archive-path-line"><span class="archive-k">${t("archive.restoreFinalPath")}</span><span class="archive-path-value">${esc(finalPath)}</span></div>
      <label class="archive-check">
        <input type="checkbox" data-act="archive-overwrite" ${S.archiveOverwrite ? "checked" : ""} />
        <span>${t("archive.overwrite")}</span>
      </label>
      <div class="archive-note">${t("archive.restoreHint")}</div>
      ${
        manifest.discLayout && IS_WINDOWS
          ? S.archiveDiscsManifest === found.manifestPath
            ? renderBurnPanel(found.manifestPath)
            : `<div class="archive-actions"><button type="button" class="btn ghost small" data-act="archive-burn-load" data-manifest="${esc(found.manifestPath)}">${icon("hard-drive", 13)} ${t("archive.burnTitle")}</button></div>`
          : ""
      }
    </div>`;
}

function renderRestoreResult(result: RestoreResult | null): string {
  if (!result) return "";
  const registration = result.registration;
  return `
    <div class="archive-result">
      <div class="archive-result-head">${icon("check-circle", 15)} <strong>${t("archive.restoreDone")}</strong></div>
      <div class="archive-path-line"><span class="archive-k">${t("archive.restoreFinalPath")}</span><span class="archive-path-value">${esc(result.target)}</span></div>
      <div class="archive-summary-grid">
        <div><span class="archive-k">${t("archive.files")}</span><span class="archive-v tabular-nums">${result.fileCount.toLocaleString()}</span></div>
        <div><span class="archive-k">${t("archive.originalSize")}</span><span class="archive-v tabular-nums">${fmtBytes(result.bytes)}</span></div>
      </div>
      <div class="${registration.registered ? "archive-ok" : "archive-warn"}">
        ${icon(registration.registered ? "check-circle" : "info", 13)}
        <span>${esc(localizeMessage(registration.detail))}</span>
      </div>
      ${
        registration.warning
          ? `<div class="archive-warn">${icon("alert-triangle", 13)} ${esc(localizeMessage(registration.warning))}</div>`
          : ""
      }
      <div class="archive-actions">
        <button type="button" class="btn ghost small" data-act="archive-open-folder" data-path="${esc(result.target)}">${icon("folder", 13)} ${t("archive.openFolder")}</button>
      </div>
    </div>`;
}

function recorderLabel(recorder: DiscRecorder): string {
  const name = recorder.name.trim();
  if (name) return name;
  const hardware = `${recorder.vendor} ${recorder.product}`.trim();
  return hardware || recorder.id;
}

function renderBurnPanel(manifestPath: string): string {
  const discs = S.archiveDiscsManifest === manifestPath ? S.archiveDiscs : null;
  const recorders = S.archiveBurnRecorders;
  const selected = S.archiveBurnRecorder;
  const busy = S.archiveBurning !== null || S.archiveRunning;
  const recorderControl =
    recorders === null
      ? `<div class="archive-loading">${icon("refresh", 14, "spin")} ${t("archive.calculating")}</div>`
      : recorders.length === 0
        ? `<div class="archive-warn">${icon("alert-triangle", 13)} ${t("archive.burnNoRecorder")}
             <button type="button" class="btn ghost small" data-act="archive-burn-refresh">${icon("refresh", 13)} ${t("archive.burnRefresh")}</button>
           </div>`
        : `<div class="archive-inline">
             <label class="archive-inline-label" for="archive-burn-recorder">${t("archive.burnRecorder")}</label>
             <select id="archive-burn-recorder" class="settings-select archive-burn-select" data-act="archive-burn-recorder" ${busy ? "disabled" : ""}>
               ${recorders
                 .map(
                   (recorder) =>
                     `<option value="${esc(recorder.id)}" ${recorder.id === selected ? "selected" : ""}>${esc(recorderLabel(recorder))}</option>`,
                 )
                 .join("")}
             </select>
             <button type="button" class="btn ghost small" data-act="archive-burn-refresh" ${busy ? "disabled" : ""}>${icon("refresh", 13)} ${t("archive.burnRefresh")}</button>
           </div>`;
  const discList =
    discs === null
      ? S.archiveDiscsLoading
        ? `<div class="archive-loading">${icon("refresh", 14, "spin")} ${t("archive.calculating")}</div>`
        : `<div class="archive-actions">
             <button type="button" class="btn ghost small" data-act="archive-burn-load" data-manifest="${esc(manifestPath)}">${icon("hard-drive", 13)} ${t("archive.burnLoad")}</button>
           </div>`
      : discs.length === 0
        ? `<div class="archive-note">${t("archive.burnFlat")}</div>`
        : `<div class="archive-burn-list">
             ${discs
               .map((disc) => {
                 const burning = S.archiveBurning === disc.volumeIndex;
                 const done = S.archiveBurnDone === disc.volumeIndex;
                 return `<div class="archive-burn-row">
                   <div class="archive-burn-main">
                     <span class="archive-found-title">${t("archive.burnDisc", { n: disc.volumeIndex })}</span>
                     <span class="archive-found-meta">${fmtBytesOrZero(disc.bytes)} · ${esc(disc.folder)}</span>
                   </div>
                   ${done ? `<span class="archive-found-ok">${icon("check-circle", 13)} ${t("archive.burnDoneShort")}</span>` : ""}
                   <button type="button" class="btn primary small" data-act="archive-burn" data-folder="${esc(disc.folder)}" data-index="${disc.volumeIndex}" ${!selected || busy ? "disabled" : ""}>
                     ${burning ? `${icon("refresh", 13, "spin")} ${t("archive.burning")}` : `${icon("hard-drive", 13)} ${t("archive.burnStart")}`}
                   </button>
                 </div>`;
               })
               .join("")}
           </div>`;
  return `
    <div class="archive-burn">
      <div class="archive-result-head">${icon("hard-drive", 15)} <strong>${t("archive.burnTitle")}</strong></div>
      <div class="archive-note">${t("archive.burnExperimental")}</div>
      ${recorderControl}
      ${discList}
      <div class="archive-note">${t("archive.burnEject")}</div>
    </div>`;
}


