/**
 * Playtime editor modal.
 *
 * Lets the user correct tracked playtime and the last-played date for a game.
 * Reads/writes shared state (S) and persists through the Epic playtime command.
 */

import { playtimeRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc, fmtPlaytime } from "../../core/utils";
import { t } from "../../i18n";
import { epicSetPlaytime, type EpicSummary } from "../../epic";
export function closeEditPlaytimeModal(): void {
  if (playtimeRoot) playtimeRoot.innerHTML = "";
}

export function openEditPlaytimeModal(appName: string): void {
  if (!playtimeRoot) return;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const dl = S.downloads.get(appName);
  const title = s?.title || dl?.title || appName;

  const pt = S.playtimeMap.get(appName);
  const sec = pt?.total_seconds || 0;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  let lastPlayed = pt?.last_played || "";
  if (!lastPlayed && (hours > 0 || minutes > 0)) {
    lastPlayed = "Daha önce oynandı (Epic Games)";
  }

  const standardOptions = [
    "",
    "Daha önce oynandı (Epic Games)",
    "Bugün",
    "Dün",
    "Bu hafta",
    "Bu ay",
    "Geçen ay",
    "6 ay önce",
    "1 yıl önce veya daha eski",
  ];
  const hasCustomLastPlayed = Boolean(lastPlayed && !standardOptions.includes(lastPlayed));

  playtimeRoot.innerHTML = `
    <div class="playtime-overlay" data-act="playtime-overlay-close">
      <div class="playtime-dialog">
        <div class="playtime-header">
          <div class="playtime-header-title">
            <div class="playtime-header-icon">${icon("clock", 18)}</div>
            <div>
              <h2>Oynama Süresini Düzenle</h2>
              <div class="playtime-header-sub">${esc(title)}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-edit-playtime" title="Kapat">${icon("x", 16)}</button>
        </div>

        <div class="playtime-body">
          <div class="playtime-modal-notice">
            <div class="playtime-modal-notice-icon">${icon("info", 16)}</div>
            <div class="playtime-modal-notice-text">
              <strong>Epic Games Verileri Neden Otomatik Alınamıyor?</strong><br />
              Epic Games Store, oynama sürelerini yalnızca kendi sunucularındaki kapalı telemetride depolar ve 3. parti istemcilerin (Heroic, GOG vb.) erişebileceği bir REST/GraphQL veya OAuth API sağlamaz.
              Önceki Epic sürenizi buradan bir defaya mahsus girdiğinizde, gelecekteki oyun oturumlarınız bu sürenin üzerine eklenerek sayılmaya devam eder.
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">Toplam Oynama Süresi</label>
            <div class="playtime-inputs-row">
              <div class="playtime-input-wrap">
                <input id="pt-hours-input" type="number" min="0" step="1" class="text-input" value="${hours}" placeholder="0" />
                <span class="playtime-unit">Saat</span>
              </div>
              <div class="playtime-input-wrap">
                <input id="pt-minutes-input" type="number" min="0" max="59" step="1" class="text-input" value="${minutes}" placeholder="0" />
                <span class="playtime-unit">Dakika</span>
              </div>
            </div>
            <div class="playtime-quick-chips">
              <span class="playtime-quick-label">Hızlı Ekle:</span>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="1">+1 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="5">+5 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="10">+10 sa</button>
              <button type="button" class="quick-chip" data-act="pt-quick-add" data-hours="50">+50 sa</button>
              <button type="button" class="quick-chip reset" data-act="pt-reset">Sıfırla</button>
            </div>
          </div>

          <div class="playtime-form-group">
            <label class="playtime-form-label">Son Aktivite (Seçiniz)</label>
            <select id="pt-last-played-select" class="playtime-select">
              <option value="" ${!lastPlayed ? "selected" : ""}>Belirtilmemiş (Henüz Oynanmadı)</option>
              <option value="Daha önce oynandı (Epic Games)" ${lastPlayed === "Daha önce oynandı (Epic Games)" ? "selected" : ""}>Daha önce oynandı (Epic Games)</option>
              <option value="Bugün" ${lastPlayed === "Bugün" ? "selected" : ""}>Bugün</option>
              <option value="Dün" ${lastPlayed === "Dün" ? "selected" : ""}>Dün</option>
              <option value="Bu hafta" ${lastPlayed === "Bu hafta" ? "selected" : ""}>Bu hafta</option>
              <option value="Bu ay" ${lastPlayed === "Bu ay" ? "selected" : ""}>Bu ay</option>
              <option value="Geçen ay" ${lastPlayed === "Geçen ay" ? "selected" : ""}>Geçen ay</option>
              <option value="6 ay önce" ${lastPlayed === "6 ay önce" ? "selected" : ""}>6 ay önce</option>
              <option value="1 yıl önce veya daha eski" ${lastPlayed === "1 yıl önce veya daha eski" ? "selected" : ""}>1 yıl önce veya daha eski</option>
              ${hasCustomLastPlayed ? `<option value="${esc(lastPlayed)}" selected>Kayıtlı: ${esc(lastPlayed)}</option>` : ""}
            </select>
            <div class="playtime-input-hint">Kütüphane detay kartındaki "Son Aktivite" alanında görüntülenir.</div>
          </div>
        </div>

        <div class="playtime-footer">
          <button class="btn ghost" data-act="close-edit-playtime">Vazgeç</button>
          <button class="btn primary" data-act="save-playtime" data-id="${esc(appName)}">
            ${icon("check", 14)} Kaydet
          </button>
        </div>
      </div>
    </div>
  `;
}

export async function saveEditedPlaytime(appName: string): Promise<void> {
  const hInput = document.getElementById("pt-hours-input") as HTMLInputElement | null;
  const mInput = document.getElementById("pt-minutes-input") as HTMLInputElement | null;
  const lpSelect = document.getElementById("pt-last-played-select") as HTMLSelectElement | null;

  const hours = Math.max(0, parseInt(hInput?.value || "0", 10) || 0);
  const minutes = Math.max(0, Math.min(59, parseInt(mInput?.value || "0", 10) || 0));
  const totalSeconds = hours * 3600 + minutes * 60;
  const selectedLp = lpSelect?.value?.trim() || "";
  const lastPlayed = selectedLp.length > 0 ? selectedLp : null;

  const saveBtn = document.querySelector<HTMLButtonElement>('[data-act="save-playtime"]');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Kaydediliyor…";
  }

  try {
    const updated = await epicSetPlaytime(appName, totalSeconds, lastPlayed);
    S.playtimeMap.set(appName, updated);

    // Update Overview drawer if open
    const overviewPtVal = document.getElementById("drawer-stat-playtime");
    if (overviewPtVal) {
      overviewPtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : "Oynanmadı";
    }
    const overviewLpVal = document.getElementById("drawer-stat-last-activity");
    if (overviewLpVal) {
      overviewLpVal.textContent = updated.last_played || "Henüz oynanmadı";
    }

    // Update Manage drawer if open
    const managePtVal = document.getElementById("manage-playtime-val");
    if (managePtVal) {
      managePtVal.textContent = updated.total_seconds > 0 ? fmtPlaytime(updated.total_seconds) : "Oynanmadı";
    }
    const managePtMeta = document.getElementById("manage-playtime-meta");
    if (managePtMeta) {
      managePtMeta.textContent = updated.session_count
        ? `${updated.session_count} oturum kaydedildi • Son: ${updated.last_played || "Henüz oynanmadı"}`
        : "Bu launcher üzerinden henüz oturum kaydedilmedi";
    }

    // Update card/grid if visible
    const cardBadge = document.querySelector(`.pcard[data-id="${appName}"] .playtime-badge`) as HTMLElement | null;
    if (cardBadge) {
      if (updated.total_seconds > 0) {
        cardBadge.innerHTML = `${icon("clock", 11)} ${fmtPlaytime(updated.total_seconds)}`;
        cardBadge.style.display = "";
      } else {
        cardBadge.style.display = "none";
      }
    }

    toast(
      updated.total_seconds > 0
        ? `Oynama süresi güncellendi: ${fmtPlaytime(updated.total_seconds)}`
        : "Oynama süresi sıfırlandı",
      "ok"
    );
    closeEditPlaytimeModal();
  } catch (err) {
    toast(`Süre kaydedilemedi: ${String(err)}`, "err");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Kaydet";
    }
  }
}

