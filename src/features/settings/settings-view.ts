/**
 * Settings page renderer.
 *
 * Renders account, storage, integrations, language and system sections. It only
 * reads shared state (S) and imports presentational helpers; all actions are
 * routed through the global data-act delegation in main.ts.
 */

import { isTauri } from "../../core/constants";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { esc, fmtBytes } from "../../core/utils";
import { LANGUAGES, t } from "../../i18n";
import {
  epicDefaultInstallDir,
  epicDetectEglGames,
  epicGetSettings,
  epicGetSteamGridKey,
  epicThirdPartyLaunchers,
  type EglDetectedGame,
  type ThirdPartyLauncher,
} from "../../epic";

export function renderSettings(): string {
  return `
    <h2>Ayarlar</h2><p class="subtitle">Launcher yapılandırması</p>
    <div class="settings-box">
      <h3>Epic oturumu</h3>
      <p>${S.epicAccount ? `Bağlı hesap: <strong>${esc(S.epicAccount)}</strong>` : "Giriş yapılmadı."}</p>
      ${S.epicAccount ? `<p><button class="btn danger" data-act="epic-logout">Epic'ten çıkış yap</button></p>` : ""}
      <p class="muted">Atlanan öğeler: ${S.epicSkippedCount}</p>
    </div>
    <div class="settings-box">
      <h3>Oyun kurulum klasörü</h3>
      <p><input id="epic-install-dir" class="text-input" value="${esc(S.epicSettingsCache?.install_dir ?? "")}" placeholder="${esc(S.epicDefaultDir || "varsayılan")}" autocomplete="off" spellcheck="false" /></p>
      <p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost small" data-act="epic-save-install-dir">Kaydet</button>
        <span class="muted">Boş bırakırsan varsayılan kullanılır: <code>${esc(S.epicDefaultDir || "—")}</code></span>
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("gamepad-2", 16)} Epic Games Launcher Entegrasyonu</h3>
      <p>Bilgisayarınızda Epic Games Launcher tarafından yüklenmiş oyunları otomatik algılar ve efxlve launcher ile eşitler.</p>
      ${
        S.eglDetectedList.length > 0
          ? `
          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
              <span style="font-size:13px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:6px">
                ${icon("check", 14)} ${S.eglDetectedList.length} Oyun Algılandı
              </span>
              <button class="btn primary small" data-act="epic-sync-egl" ${S.eglSyncing ? "disabled" : ""}>
                ${S.eglSyncing ? "Eşitleniyor…" : "Oyunları Eşitle ve İçe Aktar"}
              </button>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;padding-right:6px">
              ${S.eglDetectedList
                .map(
                  (g: EglDetectedGame) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);border-radius:8px;font-size:12px">
                  <div style="display:flex;flex-direction:column;gap:2px">
                    <span style="font-weight:600;color:#fff">${esc(g.title)}</span>
                    <span style="color:var(--muted);font-size:11px;opacity:0.8">${esc(g.installPath)}</span>
                  </div>
                  <span style="color:var(--accent);font-size:11px;font-weight:600">${fmtBytes(g.installSize)}</span>
                </div>`
                )
                .join("")}
            </div>
          </div>`
          : `
          <p class="muted" style="margin:10px 0">Epic Games Launcher üzerinde kurulu ek oyun bulunamadı veya EGL klasörü tespit edilemedi.</p>
          <p><button class="btn ghost small" data-act="epic-refresh-egl">${icon("refresh", 12)} Yeniden Tara</button></p>
          `
      }
    </div>
    <div class="settings-box">
      <h3>${icon("gamepad-2", 16)} 3. Parti Başlatıcılar (EA, Ubisoft, Rockstar)</h3>
      <p>Bazı Epic oyunları harici bir başlatıcı gerektirir. Sistemde kurulu olup olmadıklarını buradan kontrol edebilirsin.</p>
      <div class="tpl-grid">
        ${S.thirdPartyLaunchers.length === 0
          ? `<p class="muted">Tarama yapılıyor…</p>`
          : S.thirdPartyLaunchers
              .map(
                (l) => `
          <div class="tpl-card ${l.installed ? "installed" : ""}">
            <div class="tpl-head">
              <span class="tpl-name">${esc(l.name)}</span>
              <span class="tpl-status ${l.installed ? "on" : "off"}">
                ${l.installed ? `${icon("check", 11)} Kurulu${l.version ? ` · v${esc(l.version)}` : ""}` : "Kurulu değil"}
              </span>
            </div>
            <div class="tpl-path" title="${esc(l.installPath || "")}">
              ${l.installed ? esc(l.installPath || "Kurulum yolu bilinmiyor") : "Harici başlatıcı gerektiren oyunlar için önerilir."}
            </div>
            <div class="tpl-actions">
              <button class="ps5-btn secondary" data-act="open-external-url" data-url="${esc(l.downloadUrl)}">
                ${icon("external", 13)} Resmi indirme sayfası
              </button>
            </div>
          </div>`,
              )
              .join("")}
      </div>
      <div style="margin-top:12px">
        <button class="btn ghost small" data-act="third-party-refresh">${icon("refresh", 12)} Yeniden Tara</button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("folder", 16)} Epic Games Koleksiyonları (Kategoriler)</h3>
      <p>Epic Games Launcher üzerindeki özel kategorilerinizi ("Online", "Hikaye", vb.) içe aktarın veya senkronize edin.</p>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;flex-wrap:wrap;gap:10px">
        <span class="muted">${S.epicCollections.length} koleksiyon kayıtlı</span>
        <button class="btn ghost small" data-act="import-egl-collections">
          ${icon("download", 12)} EGL Koleksiyonlarını İçe Aktar
        </button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("image", 16)} SteamGridDB Entegrasyonu (Topluluk Kapakları)</h3>
      <p>SteamGridDB topluluk platformu üzerinden oyunlarınıza yüksek kaliteli dikey kapaklar (2:3) ve vitrin afişleri (hero) ekleyin.</p>
      <div style="display:flex;align-items:center;gap:10px;margin:12px 0;flex-wrap:wrap">
        <span class="sgdb-status-badge ${S.steamGridApiKey ? "connected" : "disconnected"}">
          ${S.steamGridApiKey ? `${icon("check", 12)} Bağlı` : "Anahtar Tanımlanmadı"}
        </span>
        <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:11px;padding:3px 8px">
          ${icon("external", 11)} Ücretsiz API Anahtarı Al
        </button>
      </div>
      <div style="display:flex;gap:8px;max-width:560px;align-items:center;flex-wrap:wrap">
        <input id="settings-sgdb-key-input" type="${S.showSettingsSgdbKey ? "text" : "password"}" class="text-input" style="flex:1;min-width:240px" placeholder="SteamGridDB API Anahtarını yapıştırın..." value="${esc(S.steamGridApiKey || "")}" spellcheck="false" autocomplete="off" />
        <button class="btn ghost small" data-act="toggle-sgdb-key-visibility" title="Göster/Gizle">${icon(S.showSettingsSgdbKey ? "eye-off" : "eye", 13)}</button>
        <button class="btn primary small" data-act="save-sgdb-key">Kaydet</button>
        <button class="btn ghost small" data-act="test-sgdb-key">Test Et</button>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("zap", 16)} İndirme Ağ Profili (Bant Genişliği)</h3>
      <p>İndirme sırasında bilgisayarınızın ağ ve işlemci kullanım seviyesini belirleyin.</p>
      <div class="net-profile-pills" style="margin-top:10px">
        <button class="net-profile-btn ${S.networkProfile === "max" ? "active" : ""}" data-act="set-net-profile" data-profile="max">
          ${icon("rocket", 13)} Maksimum Hız (16 Worker)
        </button>
        <button class="net-profile-btn ${S.networkProfile === "balanced" ? "active" : ""}" data-act="set-net-profile" data-profile="balanced">
          ${icon("shield-check", 13)} Dengeli (4 Worker - Önerilen)
        </button>
        <button class="net-profile-btn ${S.networkProfile === "low" ? "active" : ""}" data-act="set-net-profile" data-profile="low">
          ${icon("clock", 13)} Eko / Düşük (1 Worker)
        </button>
      </div>
      <p class="muted" style="margin-top:8px">
        ${S.networkProfile === "max" ? "Tüm internet bant genişliğini ve CPU çekirdeklerini kullanarak en yüksek indirme hızını hedefler." : S.networkProfile === "low" ? "Arka planda düşük kaynak tüketir, oyun oynarken veya internette gezinirken takılmayı önler." : "Oyun ve günlük kullanımda internetinizi kilitlemeden ideal indirme hızı sunar."}
      </p>
    </div>
    <div class="settings-box">
      <h3>${icon("wifi-off", 16)} Çevrimdışı Mod (Offline Mode)</h3>
      <p>İnternet bağlantınız olmadığında veya çevrimdışı kalmak istediğinizde kütüphaneyi yerel önbellekten çalıştırır ve oyunları doğrudan çevrimdışı başlatır.</p>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <label class="toggle-switch">
          <input type="checkbox" data-act="toggle-offline-mode" ${S.offlineMode ? "checked" : ""} />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-weight:600;color:${S.offlineMode ? "#fbbf24" : "var(--muted)"}">
          ${S.offlineMode ? "Çevrimdışı Mod Aktif" : "Çevrimiçi Mod (Standart)"}
        </span>
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("globe", 16)} ${t("settings.language")}</h3>
      <p>${t("settings.languageDesc")}</p>
      <div class="lang-selection-group">
        ${LANGUAGES.map(
          (l) => `
          <button class="lang-option-btn ${S.appLanguage === l.code ? "active" : ""}" data-act="set-app-language" data-lang="${esc(l.code)}">
            <span class="lang-flag" style="font-size:12px;font-weight:700;letter-spacing:0.04em">${esc(l.code.toUpperCase())}</span>
            <span class="lang-name">${esc(l.label)}</span>
            ${l.code === "tr" ? `<span class="lang-tag">${t("settings.defaultTag")}</span>` : ""}
          </button>`,
        ).join("")}
      </div>
    </div>
    <div class="settings-box">
      <h3>${icon("camera", 16)} Ekran Görüntüleri (Screenshots)</h3>
      <p>Oyun içi ekran görüntüsü kısayol tuşunu ve depolama sıkıştırma seçeneklerini özelleştirin.</p>
      
      <!-- Kısayol Tuşu -->
      <div style="margin-top:14px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:10px">
        <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:#fff;margin-bottom:8px">
          ${icon("keyboard", 14)} Ekran Görüntüsü Kısayol Tuşu
        </label>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <select id="ss-hotkey-select" class="text-input" style="width:auto;min-width:190px" data-act="change-ss-hotkey">
            ${S.PRESET_HOTKEYS.map(k => `
              <option value="${k.code}" ${k.code === S.screenshotHotkey ? "selected" : ""}>${k.name}</option>
            `).join("")}
            ${!S.PRESET_HOTKEYS.some(k => k.code === S.screenshotHotkey) ? `
              <option value="${S.screenshotHotkey}" selected>Özel: ${esc(S.screenshotHotkeyName)} (${S.screenshotHotkey})</option>
            ` : ""}
          </select>
          <button type="button" class="btn ghost small ${S.isRecordingScreenshotHotkey ? "active" : ""}" data-act="record-screenshot-hotkey" style="${S.isRecordingScreenshotHotkey ? "background:rgba(239,68,68,0.2);border-color:#ef4444;color:#fca5a5" : ""}">
            ${S.isRecordingScreenshotHotkey ? `${icon("keyboard", 12)} Tuşa Basın…` : `${icon("edit", 12)} Yeni Tuş Ata`}
          </button>
          <span class="muted" style="font-size:12px">Aktif tuş: <strong style="color:var(--accent);background:rgba(124,58,237,0.15);padding:2px 6px;border-radius:4px">${esc(S.screenshotHotkeyName)}</strong></span>
        </div>
      </div>

      <!-- Görsel Sıkıştırma (Opsiyonel - Varsayılan Kapalı) -->
      <div style="margin-top:12px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid var(--border);border-radius:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <label style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:#fff">
              ${icon("minimize-2", 14)} Görsel Sıkıştırma (Opsiyonel)
            </label>
            <p class="muted" style="font-size:12px;margin:4px 0 0">
              Yeni çekilen ekran görüntülerini otomatik sıkıştırarak disk alanından %70-85 tasarruf sağlar.
            </p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" data-act="toggle-screenshot-compression" ${S.screenshotCompressionEnabled ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>

        ${S.screenshotCompressionEnabled ? `
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.05);display:flex;flex-direction:column;gap:10px">
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">Format:</span>
              <div class="ss-format-pills">
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "avif" ? "active" : ""}" data-act="set-ss-format" data-format="avif">
                  AVIF (En Yüksek Verim - Önerilen)
                </button>
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "webp" ? "active" : ""}" data-act="set-ss-format" data-format="webp">
                  WebP (Dengeli)
                </button>
                <button type="button" class="ss-format-btn ${S.screenshotCompressionFormat === "jpg" ? "active" : ""}" data-act="set-ss-format" data-format="jpg">
                  JPEG (Evrensel)
                </button>
              </div>
            </div>

            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span style="font-size:12px;font-weight:600;color:var(--muted)">Kalite:</span>
              <input type="range" min="0.70" max="0.95" step="0.05" value="${S.screenshotCompressionQuality}" data-act="set-ss-quality" id="ss-quality-slider" style="width:140px;accent-color:var(--accent)" />
              <span id="ss-quality-val" style="font-size:12px;font-weight:600;color:#fff">%${Math.round(S.screenshotCompressionQuality * 100)}</span>
              <span class="muted" style="font-size:11px">(%85 önerilen görsel netliği sunar)</span>
            </div>

            <div style="font-size:11px;color:#93c5fd;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);padding:6px 10px;border-radius:6px;display:flex;align-items:center;gap:6px">
              ${icon("info", 13)}
              <span><strong>AVIF Teknolojisi:</strong> Modern AV1 kodlaması sayesinde 12-15 MB'lık ham PNG ekran görüntüleri görsel fark olmaksızın ~1.2 MB'a sıkıştırılır.</span>
            </div>
          </div>
        ` : `
          <p class="muted" style="font-size:11px;margin-top:6px;opacity:0.8">
            Sıkıştırma kapalıyken görüntüler doğrudan orijinal, sıkıştırmasız ham PNG formatında kaydedilir.
          </p>
        `}
      </div>
    </div>
    <div class="settings-box">
      <h3>Sistem</h3>
      <p><strong>Backend:</strong> ${isTauri ? "Rust (Tauri)" : "Demo (tarayıcı mock)"}</p>
      <p><strong>Kütüphane klasörü:</strong><br /><code>${esc(S.libraryPath)}</code></p>
      <p><strong>Sürüm:</strong> 0.1.0</p>
      <p style="margin-top:16px">
        <button class="btn ghost" data-act="reset-demo">Demo verisini sıfırla</button>
      </p>
    </div>`;
}

/** Load settings, default dir, EGL games, SteamGrid key and third-party launchers. */
export async function loadSettingsView(): Promise<void> {
  if (isTauri) {
    try {
      const [st, dir, eglList, sgdbKey, thirdParty] = await Promise.all([
        epicGetSettings(),
        epicDefaultInstallDir(),
        epicDetectEglGames().catch(() => [] as EglDetectedGame[]),
        epicGetSteamGridKey().catch(() => null),
        epicThirdPartyLaunchers().catch(() => [] as ThirdPartyLauncher[]),
      ]);
      S.epicSettingsCache = st;
      S.epicDefaultDir = dir;
      S.eglDetectedList = eglList;
      S.steamGridApiKey = sgdbKey;
      S.thirdPartyLaunchers = thirdParty;
    } catch {
      // Silent: keep the last cached values.
    }
  }
  render();
}