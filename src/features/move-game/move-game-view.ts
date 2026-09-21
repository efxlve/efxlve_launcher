/**
 * Cross-drive move modal: pure render and in-place update helpers.
 *
 * These functions only read shared state (`S`) and write to the cached move
 * modal root, so they can be called from the progress IPC listener without
 * triggering a full page re-render.
 */

import { moveModalRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import type { MoveGameProgress } from "../../epic";

/** Recompute and paint the free-space badge + start button state in place. */
export function updateMoveSpaceBadgeInPlace(): void {
  if (!S.activeMoveModalAppName) return;
  const s = S.epicSummaries.find((x) => x.appName === S.activeMoveModalAppName);
  if (!s) return;

  const curPath = s.installPath || "";
  const curDrive = curPath.length >= 2 && curPath[1] === ":" ? curPath[0].toUpperCase() : "";
  const installSize = s.installSize || 0;
  const targetDrive = S.moveSystemDrives.find(
    (d) => d.letter.toUpperCase() === S.selectedMoveDriveLetter.toUpperCase()
  );
  const availableBytes = targetDrive ? targetDrive.available_bytes : 0;
  const isSameDrive =
    Boolean(S.selectedMoveDriveLetter && curDrive && S.selectedMoveDriveLetter.toUpperCase() === curDrive.toUpperCase());
  const hasEnoughSpace = isSameDrive || availableBytes >= installSize;

  let badgeHtml = "";
  let canStart = true;

  if (!S.selectedMoveTargetPath.trim()) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span>Lütfen geçerli bir hedef klasör yolu belirtin.</span></div>`;
    canStart = false;
  } else if (
    S.selectedMoveTargetPath.trim().toLowerCase().replace(/[\\/]+$/, "") ===
    curPath.trim().toLowerCase().replace(/[\\/]+$/, "")
  ) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span>Hedef klasör mevcut kurulum konumu ile aynı! Lütfen farklı bir konum seçin.</span></div>`;
    canStart = false;
  } else if (!hasEnoughSpace) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span><strong>Yetersiz Disk Alanı:</strong> Gerekli ${fmtBytes(installSize)} • Seçilen Sürücüde Boş: ${fmtBytes(availableBytes)}</span></div>`;
    canStart = false;
  } else if (isSameDrive) {
    badgeHtml = `<div class="move-space-badge ok">${icon("zap", 15)} <span><strong>Aynı Sürücü:</strong> Dosyalar anında (&lt;1 saniyede) taşınacaktır. Yeniden indirme gerekmez.</span></div>`;
  } else {
    const remaining = Math.max(0, availableBytes - installSize);
    badgeHtml = `<div class="move-space-badge ok">${icon("check-circle", 15)} <span><strong>Disk Alanı Yeterli:</strong> Gerekli ${fmtBytes(installSize)} • Aktarım sonrası boş kalacak: ${fmtBytes(remaining)}</span></div>`;
  }

  const badgeContainer = document.getElementById("move-space-badge-container");
  if (badgeContainer) {
    badgeContainer.innerHTML = badgeHtml;
  }

  const previewEl = document.getElementById("move-path-preview");
  if (previewEl) {
    const gameFolderName =
      curPath.replace(/^[\\/]+|[\\/]+$/g, "").split(/[\\/]/).pop() || S.activeMoveModalAppName;
    const cleanBase = S.selectedMoveTargetPath.trim().replace(/[\\/]+$/, "");
    const finalDestPath = cleanBase ? `${cleanBase}\\${gameFolderName}` : "—";
    previewEl.innerHTML = `${icon("info", 13)} <span>Oyun hedef konumu: <strong title="${esc(finalDestPath)}">${esc(finalDestPath)}</strong></span>`;
  }

  const startBtn = document.querySelector('[data-act="start-move-game"]') as HTMLButtonElement | null;
  if (startBtn && !S.isMovingGame) {
    startBtn.disabled = !canStart;
  }
}

/** Paint live move progress without re-rendering the whole modal. */
export function updateMoveProgressInPlace(p: MoveGameProgress): void {
  const pct = Math.min(100, Math.max(0, Math.round(p.percent)));
  const pctEl = document.getElementById("move-progress-pct-val");
  if (pctEl) pctEl.textContent = `%${pct}`;

  const fillEl = document.getElementById("move-progress-bar-fill-el");
  if (fillEl) fillEl.style.width = `${pct}%`;

  let stageText = "Hazırlanıyor…";
  if (p.stage === "moving") stageText = "Dosyalar Taşınıyor…";
  else if (p.stage === "verifying") stageText = "Bütünlük Doğrulanıyor…";
  else if (p.stage === "cleaning") stageText = "Eski Konum Temizleniyor…";
  else if (p.stage === "complete") stageText = "Taşıma Tamamlandı!";
  else if (p.stage === "failed") stageText = "İşlem Başarısız Oldu";

  const stageEl = document.getElementById("move-progress-stage-val");
  if (stageEl) stageEl.textContent = stageText;

  const speedEtaEl = document.getElementById("move-progress-speed-eta");
  if (speedEtaEl) {
    const speedPart = p.speed ? `Hız: ${p.speed}` : "";
    const sizePart = `${fmtBytes(p.copied_bytes)} / ${fmtBytes(p.total_bytes)}`;
    speedEtaEl.textContent = speedPart ? `${speedPart} • ${sizePart}` : sizePart;
  }

  const fileCountEl = document.getElementById("move-progress-file-count");
  if (fileCountEl) {
    const etaPart = p.eta ? `Kalan: ${p.eta}` : "";
    const countPart = p.total_files > 0 ? `${p.files_copied} / ${p.total_files} Dosya` : "";
    fileCountEl.textContent = etaPart && countPart ? `${etaPart} • ${countPart}` : etaPart || countPart;
  }

  const curFileEl = document.getElementById("move-progress-cur-file");
  if (curFileEl) {
    const filename = p.current_file ? p.current_file.split(/[\\/]/).pop() || p.current_file : "";
    curFileEl.textContent = filename;
    curFileEl.title = p.current_file || "";
  }
}

/** Render the full move-game modal frame. */
export function renderMoveGameModalFrame(): void {
  const root = moveModalRoot || document.getElementById("move-modal-root");
  if (!root || !S.activeMoveModalAppName) return;
  const s = S.epicSummaries.find((x) => x.appName === S.activeMoveModalAppName);
  if (!s) return;

  const title = s.title;
  const curPath = s.installPath || "Bilinmiyor";
  const curDrive = curPath.length >= 2 && curPath[1] === ":" ? curPath[0].toUpperCase() : "";
  const installSize = s.installSize || 0;

  const driveCardsHtml =
    S.moveSystemDrives.length > 0
      ? S.moveSystemDrives
          .map((d) => {
            const isSel = d.letter.toUpperCase() === S.selectedMoveDriveLetter.toUpperCase();
            const isCur = d.letter.toUpperCase() === curDrive.toUpperCase();
            const usedBytes = Math.max(0, d.total_bytes - d.available_bytes);
            const usedPct =
              d.total_bytes > 0 ? Math.min(100, Math.round((usedBytes / d.total_bytes) * 100)) : 0;
            const barColor = usedPct > 90 ? "#ef4444" : usedPct > 75 ? "#f59e0b" : "#3b82f6";
            return `
              <button type="button" class="move-drive-card ${isSel ? "selected" : ""}" data-act="select-move-drive" data-drive="${d.letter}" ${S.isMovingGame ? "disabled" : ""}>
                <div class="move-drive-top">
                  <div class="move-drive-letter">
                    ${icon("hard-drive", 16)} ${d.letter}:
                  </div>
                  <span class="move-drive-tag">${isCur ? "Mevcut" : isSel ? "Seçili" : (d.label || "Yerel Disk")}</span>
                </div>
                <div class="move-drive-meter-track">
                  <div class="move-drive-meter-fill" style="width:${usedPct}%; background:${barColor}"></div>
                </div>
                <div class="move-drive-space-text">
                  <span>Boş: <strong>${fmtBytes(d.available_bytes)}</strong></span>
                  <span>%${usedPct} Dolu</span>
                </div>
              </button>
            `;
          })
          .join("")
      : `<div style="grid-column: 1/-1; padding: 12px; color: #94a3b8; font-size: 12px;">Sürücü bilgisi yüklenemedi. Aşağıdan doğrudan klasör seçebilirsiniz.</div>`;

  const targetDrive = S.moveSystemDrives.find(
    (d) => d.letter.toUpperCase() === S.selectedMoveDriveLetter.toUpperCase()
  );
  const availableBytes = targetDrive ? targetDrive.available_bytes : 0;
  const isSameDrive =
    Boolean(S.selectedMoveDriveLetter && curDrive && S.selectedMoveDriveLetter.toUpperCase() === curDrive.toUpperCase());
  const hasEnoughSpace = isSameDrive || availableBytes >= installSize;

  let badgeHtml = "";
  let canStart = true;
  if (!S.selectedMoveTargetPath.trim()) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span>Lütfen geçerli bir hedef klasör yolu belirtin.</span></div>`;
    canStart = false;
  } else if (
    S.selectedMoveTargetPath.trim().toLowerCase().replace(/[\\/]+$/, "") ===
    curPath.trim().toLowerCase().replace(/[\\/]+$/, "")
  ) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span>Hedef klasör mevcut kurulum konumu ile aynı! Lütfen farklı bir konum seçin.</span></div>`;
    canStart = false;
  } else if (!hasEnoughSpace) {
    badgeHtml = `<div class="move-space-badge warn">${icon("info", 15)} <span><strong>Yetersiz Disk Alanı:</strong> Gerekli ${fmtBytes(installSize)} • Seçilen Sürücüde Boş: ${fmtBytes(availableBytes)}</span></div>`;
    canStart = false;
  } else if (isSameDrive) {
    badgeHtml = `<div class="move-space-badge ok">${icon("zap", 15)} <span><strong>Aynı Sürücü:</strong> Dosyalar anında (&lt;1 saniyede) taşınacaktır. Yeniden indirme gerekmez.</span></div>`;
  } else {
    const remaining = Math.max(0, availableBytes - installSize);
    badgeHtml = `<div class="move-space-badge ok">${icon("check-circle", 15)} <span><strong>Disk Alanı Yeterli:</strong> Gerekli ${fmtBytes(installSize)} • Aktarım sonrası boş kalacak: ${fmtBytes(remaining)}</span></div>`;
  }

  let progressHtml = "";
  if (S.isMovingGame) {
    const p = S.activeMoveProgress || {
      id: s.appName,
      stage: "preparing",
      percent: 0,
      copied_bytes: 0,
      total_bytes: installSize,
      speed: "Başlatılıyor…",
      eta: "Hesaplanıyor…",
      current_file: "",
      files_copied: 0,
      total_files: 0,
    };
    const pct = Math.min(100, Math.max(0, Math.round(p.percent)));
    let stageText = "Hazırlanıyor…";
    if (p.stage === "moving") stageText = "Dosyalar Taşınıyor…";
    else if (p.stage === "verifying") stageText = "Bütünlük Doğrulanıyor…";
    else if (p.stage === "cleaning") stageText = "Eski Konum Temizleniyor…";
    else if (p.stage === "complete") stageText = "Taşıma Tamamlandı!";
    else if (p.stage === "failed") stageText = "İşlem Başarısız Oldu";

    const filename = p.current_file ? p.current_file.split(/[\\/]/).pop() || p.current_file : "";

    progressHtml = `
      <div class="move-live-progress">
        <div class="move-progress-top">
          <div class="move-progress-stage">
            <span class="running-dot"></span>
            <span id="move-progress-stage-val">${stageText}</span>
          </div>
          <div id="move-progress-pct-val" class="move-progress-pct">%${pct}</div>
        </div>
        <div class="move-progress-bar-track">
          <div id="move-progress-bar-fill-el" class="move-progress-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="move-progress-meta-row">
          <span id="move-progress-speed-eta">${p.speed ? `Hız: ${p.speed}` : ""} • ${fmtBytes(p.copied_bytes)} / ${fmtBytes(p.total_bytes)}</span>
          <span id="move-progress-file-count">${p.eta ? `Kalan: ${p.eta}` : ""} • ${p.files_copied} / ${p.total_files} Dosya</span>
        </div>
        <div id="move-progress-cur-file" class="move-progress-file" title="${esc(p.current_file)}">
          ${esc(filename)}
        </div>
      </div>
    `;
  }

  root.innerHTML = `
    <div class="move-modal-backdrop" data-act="move-overlay-close">
      <div class="move-modal-card" role="dialog" aria-modal="true">
        <div class="move-modal-head">
          <div class="move-modal-title-group">
            <div class="move-modal-icon">${icon("hard-drive", 20)}</div>
            <div>
              <h2 class="move-modal-title">Oyun Dosyalarını Taşı</h2>
              <div class="move-modal-subtitle">${esc(title)}</div>
            </div>
          </div>
          <button class="move-modal-close" data-act="close-move-modal" title="Kapat" ${S.isMovingGame ? "disabled" : ""}>
            ${icon("x", 16)}
          </button>
        </div>

        <div class="move-modal-body">
          <!-- 1. Current location & size -->
          <div class="move-current-box">
            <div class="move-current-info">
              <div class="move-current-label">Mevcut Kurulum Konumu</div>
              <div class="move-current-path" title="${esc(curPath)}">${esc(curPath)}</div>
            </div>
            <div class="move-current-size">
              <span class="move-size-val">${fmtBytes(installSize)}</span>
              <span class="move-size-label">Gerekli Boyut</span>
            </div>
          </div>

          <!-- 2. Target drive selection -->
          <div>
            <div class="move-section-label">
              ${icon("hard-drive", 14)} Hedef Disk Sürücüsü Seçin
            </div>
            <div class="move-drive-grid">
              ${driveCardsHtml}
            </div>
          </div>

          <!-- 3. Target folder path & browse -->
          <div>
            <div class="move-section-label">
              ${icon("folder", 14)} Hedef Klasör
            </div>
            <div class="move-path-input-group">
              <input
                id="move-target-input"
                class="move-path-input"
                type="text"
                value="${esc(S.selectedMoveTargetPath)}"
                placeholder="Örn: D:\\Games"
                spellcheck="false"
                autocomplete="off"
                ${S.isMovingGame ? "disabled" : ""}
              />
              <button
                type="button"
                class="btn ghost move-browse-btn"
                data-act="browse-move-target"
                ${S.isMovingGame ? "disabled" : ""}
                title="Sistem Klasör Gezginini Aç"
              >
                ${icon("folder", 14)} Gözat…
              </button>
            </div>
            <div class="move-path-preview" id="move-path-preview">
              ${icon("info", 13)} <span>Oyun hedef konumu: <strong title="${esc(
                S.selectedMoveTargetPath.trim()
                  ? `${S.selectedMoveTargetPath.trim().replace(/[\\/]+$/, "")}\\${curPath.replace(/^[\\/]+|[\\/]+$/g, "").split(/[\\/]/).pop() || S.activeMoveModalAppName}`
                  : "—"
              )}">${esc(
                S.selectedMoveTargetPath.trim()
                  ? `${S.selectedMoveTargetPath.trim().replace(/[\\/]+$/, "")}\\${curPath.replace(/^[\\/]+|[\\/]+$/g, "").split(/[\\/]/).pop() || S.activeMoveModalAppName}`
                  : "—"
              )}</strong></span>
            </div>
          </div>

          <!-- 4. Capacity badge -->
          <div id="move-space-badge-container">
            ${badgeHtml}
          </div>

          <!-- 5. Live progress (visible while moving) -->
          <div id="move-live-progress-container">
            ${progressHtml}
          </div>
        </div>

        <div class="move-modal-foot">
          ${
            S.isMovingGame
              ? `
            <button class="btn danger" data-act="cancel-move-game" data-id="${s.appName}">
              ${icon("x", 14)} İptal Et
            </button>
          `
              : `
            <button class="btn ghost" data-act="close-move-modal">Vazgeç</button>
            <button
              class="btn primary"
              data-act="start-move-game"
              data-id="${s.appName}"
              ${!canStart ? "disabled" : ""}
            >
              ${icon("hard-drive", 14)} Taşımayı Başlat
            </button>
          `
          }
        </div>
      </div>
    </div>
  `;
}
