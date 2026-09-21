/**
 * Custom cover/hero editor and SteamGridDB asset picker.
 *
 * Lets the user set a custom portrait cover or wide hero image, or pick one
 * from SteamGridDB. State lives in S and is persisted to localStorage.
 */

import { CUSTOM_COVERS_KEY, CUSTOM_HEROES_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { openEpicModal, render } from "../../core/render";
import { epicWideArt, rawOf } from "../../core/selectors";
import { S } from "../../core/state";

import { esc } from "../../core/utils";

import { epicGetSteamGridCovers, epicSearchSteamGrid } from "../../epic";
export function saveCustomCover(appName: string, url: string): void {
  S.customCovers[appName] = url.trim();
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(S.customCovers));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

export function resetCustomCover(appName: string): void {
  delete S.customCovers[appName];
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(S.customCovers));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

export function saveCustomHero(appName: string, url: string): void {
  S.customHeroes[appName] = url.trim();
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(S.customHeroes));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

export function resetCustomHero(appName: string): void {
  delete S.customHeroes[appName];
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(S.customHeroes));
  render();
  if (S.currentModalAppName === appName) {
    openEpicModal(appName, false);
  }
}

/* ---------- SteamGridDB Durum Değişkenleri ---------- */

















export function cleanSteamGridSearchTerm(title: string): string {
  let s = title.trim();
  const prefixes = [
    "Tom Clancy's ",
    "Marvel's ",
    "Sid Meier's ",
    "Disney's ",
    "EA SPORTS™ ",
    "EA SPORTS ",
    "Star Wars™ ",
    "STAR WARS™ ",
    "STAR WARS ",
    "Warhammer 40,000: ",
    "Warhammer: ",
  ];
  for (const p of prefixes) {
    if (s.startsWith(p)) s = s.substring(p.length);
  }
  const dashPos = s.indexOf(" - ");
  if (dashPos !== -1) {
    const sub = s.substring(dashPos + 3).toLowerCase();
    if (sub.includes("edition") || sub.includes("cut") || sub.includes("version")) {
      s = s.substring(0, dashPos);
    }
  }
  const suffixes = [
    " Standard Edition",
    " Enhanced Edition",
    " Definitive Edition",
    " Gold Edition",
    " Deluxe Edition",
    " Complete Edition",
    " Game of the Year Edition",
    " GOTY Edition",
    " Special Edition",
    " Remastered",
    " Director's Cut",
  ];
  for (const suffix of suffixes) {
    const idx = s.toLowerCase().indexOf(suffix.toLowerCase());
    if (idx !== -1) {
      s = s.substring(0, idx);
    }
  }
  return s.trim();
}
export function closeCustomCoverModal(): void {
  const root = document.getElementById("cover-modal-root");
  if (root) root.innerHTML = "";
}

export function openCustomCoverModal(appName: string, initialTarget: "cover" | "hero" = "cover"): void {
  let coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) {
    coverRoot = document.createElement("div");
    coverRoot.id = "cover-modal-root";
    document.body.appendChild(coverRoot);
  }
  S.activeCustomCoverAppName = appName;
  S.activeCoverTarget = initialTarget;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;

  S.sgdbSearchQuery = cleanSteamGridSearchTerm(title);
  S.sgdbAssetType = S.activeCoverTarget === "hero" ? "heroes" : "grids";
  S.sgdbActiveStyle = "";
  S.sgdbSelectedCoverUrl = "";
  S.customCoverActiveTab = S.steamGridApiKey ? "steamgrid" : "url";
  S.sgdbErrorMsg = "";
  S.sgdbCoversList = [];
  S.sgdbGamesList = [];
  S.sgdbSelectedGameId = null;
  S.showModalSgdbInfo = false;

  renderCustomCoverModalFrame(appName);
  renderCustomCoverModalContent(appName);

  if (S.steamGridApiKey && S.sgdbSearchQuery) {
    void searchAndLoadSteamGrid(appName, S.sgdbSearchQuery);
  }
}

export function renderCustomCoverModalFrame(appName: string): void {
  const coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) return;
  const s = S.epicSummaries.find((x) => x.appName === appName);
  const title = s?.title || appName;
  const g = rawOf(appName);
  const devRaw = g ? g.metadata?.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";

  const hasCustomCover = Boolean(S.customCovers[appName]);
  const hasCustomHero = Boolean(S.customHeroes[appName]);
  const isCustomForTarget = S.activeCoverTarget === "hero" ? hasCustomHero : hasCustomCover;

  const currentCoverArt = S.customCovers[appName] || s?.cover || "";
  const currentHeroArt = S.customHeroes[appName] || (s ? epicWideArt(s) : null) || s?.cover || "";
  const activeCurrentImg = S.sgdbSelectedCoverUrl || (S.activeCoverTarget === "hero" ? currentHeroArt : currentCoverArt);
  const hasAnyCustom = hasCustomCover || hasCustomHero;

  coverRoot.innerHTML = `
    <div class="cover-overlay" data-act="cover-modal-backdrop">
      <div class="cover-dialog wide" data-act="prevent-modal-close">
        <div class="cover-dialog-header">
          <div class="cover-dialog-title-group">
            <div class="cover-dialog-icon">${icon("image", 18)}</div>
            <div>
              <h2>Görselleri Özelleştir</h2>
              <div class="cover-dialog-sub">${esc(title)}${dev ? ` • ${esc(dev)}` : ""}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-custom-cover" title="Kapat">${icon("x", 16)}</button>
        </div>

        <div class="cover-dialog-body">
          <!-- Düzenleme Hedefi Segment Kontrolü -->
          <div class="cover-target-segment">
            <button class="target-segment-pill ${S.activeCoverTarget === "cover" ? "active" : ""}" data-act="set-cover-target" data-target="cover" data-id="${appName}">
              ${icon("image", 14)}
              <span>Dikey Kapak (2:3 Kütüphane)</span>
              ${hasCustomCover ? `<span class="target-indicator-dot" title="Özel dikey kapak aktif"></span>` : ""}
            </button>
            <button class="target-segment-pill ${S.activeCoverTarget === "hero" ? "active" : ""}" data-act="set-cover-target" data-target="hero" data-id="${appName}">
              ${icon("rows", 14)}
              <span>Yatay Afiş (Hero / Vitrin)</span>
              ${hasCustomHero ? `<span class="target-indicator-dot" title="Özel yatay afiş aktif"></span>` : ""}
            </button>
          </div>

          <!-- Canlı Önizleme ve Hedef Bilgisi -->
          <div class="cover-preview-section">
            <div class="cover-preview-card ${S.activeCoverTarget === "hero" ? "wide" : "portrait"}">
              ${activeCurrentImg ? `<img id="cover-preview-img" src="${esc(activeCurrentImg)}" alt="Önizleme" />` : `<div id="cover-preview-img" class="cover-preview-empty">${icon("image", 36)}</div>`}
              <div class="cover-preview-badge">${S.sgdbSelectedCoverUrl ? "Seçilen Önizleme" : isCustomForTarget ? "Özel Görsel" : "Orijinal"}</div>
            </div>
            <div class="cover-preview-meta">
              <div class="cover-meta-header">
                <span class="cover-meta-badge ${S.activeCoverTarget}">
                  ${S.activeCoverTarget === "cover" ? `${icon("image", 12)} 2:3 Kütüphane Kartı` : `${icon("rows", 12)} 16:7 Vitrin & Detay Afişi`}
                </span>
                ${isCustomForTarget ? `<span class="cover-status-tag custom">${icon("sparkles", 11)} Özel Görsel Kullanılıyor</span>` : `<span class="cover-status-tag">${icon("check", 11)} Orijinal Epic Görseli</span>`}
              </div>
              <div class="cover-meta-desc">
                ${S.activeCoverTarget === "cover"
                  ? "Kütüphane ızgarasında ve listelerde görünen dikey afiş. SteamGridDB'den beğendiğiniz bir kapak seçebilir veya web bağlantısı yapıştırabilirsiniz."
                  : "Ana sayfadaki öne çıkan vitrinde (Spotlight), detay çekmecesinde ve raflarda arka plan olarak kullanılan sinematik yatay afiş."}
              </div>
              <div class="cover-meta-actions">
                ${isCustomForTarget ? `
                  <button class="btn ghost small danger" data-act="reset-active-target" data-id="${appName}">
                    ${icon("refresh", 12)} ${S.activeCoverTarget === "cover" ? "Dikey Kapağı Sıfırla" : "Yatay Afişi Sıfırla"}
                  </button>
                ` : ""}
              </div>
            </div>
          </div>

          <!-- Kaynak Sekmeleri -->
          <div class="cover-modal-tabs">
            <button class="cover-tab-btn ${S.customCoverActiveTab === "steamgrid" ? "active" : ""}" data-act="switch-cover-tab" data-tab="steamgrid" data-id="${appName}">
              ${icon("globe", 13)} <span>SteamGridDB Topluluğu</span>
            </button>
            <button class="cover-tab-btn ${S.customCoverActiveTab === "url" ? "active" : ""}" data-act="switch-cover-tab" data-tab="url" data-id="${appName}">
              ${icon("external", 13)} <span>Doğrudan Web URL</span>
            </button>
            <button class="cover-tab-btn ${(S.customCoverActiveTab as string) === "file" ? "active" : ""}" data-act="switch-cover-tab" data-tab="file" data-id="${appName}">
              ${icon("folder", 13)} <span>Bilgisayardan Dosya</span>
            </button>
          </div>

          <div id="cover-tab-content-area"></div>
        </div>

        <div class="cover-dialog-footer">
          ${hasAnyCustom ? `
            <button class="btn ghost danger" data-act="reset-all-art" data-id="${appName}" title="Hem dikey kapağı hem yatay afişi orijinal Epic görsellerine döndür">
              ${icon("refresh", 13)} Tümünü Sıfırla
            </button>
          ` : ""}
          <div style="flex:1"></div>
          <button class="btn ghost" data-act="close-custom-cover">Vazgeç</button>
          <button class="btn primary" data-act="save-custom-cover" data-id="${appName}">
            ${icon("check", 14)} ${S.activeCoverTarget === "cover" ? "Dikey Kapağı Kaydet" : "Yatay Afişi Kaydet"}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function renderCustomCoverModalContent(appName: string): void {
  const container = document.getElementById("cover-tab-content-area");
  if (!container) return;

  if (S.customCoverActiveTab === "url") {
    const currentVal = S.sgdbSelectedCoverUrl || (S.activeCoverTarget === "hero" ? S.customHeroes[appName] : S.customCovers[appName]) || "";
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-inputs-section">
          <label class="cover-input-label">Görsel Web Bağlantısı (URL)</label>
          <div class="cover-url-row">
            <input id="custom-cover-url-input" class="text-input" placeholder="https://... (Doğrudan görsel linki: .jpg, .png, .webp)" value="${esc(currentVal)}" spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="preview-custom-cover-url" title="Önizle">Önizle</button>
          </div>
          <div class="cover-preview-hint" style="margin-top:4px">
            Doğrudan görsel bağlantısı yapıştırıp <strong>Önizle</strong> butonuna tıklayarak yukarıdaki önizleme kutusunda test edebilirsiniz.
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (S.customCoverActiveTab === "file") {
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-inputs-section">
          <label class="cover-input-label">Bilgisayardan Yerel Dosya Seç</label>
          <label class="cover-file-upload-btn">
            ${icon("folder", 14)} <span>Görsel Dosyası Seç (.png, .jpg, .webp)</span>
            <input id="custom-cover-file-input" type="file" accept="image/*" style="display:none;" />
          </label>
          <div class="cover-preview-hint" style="margin-top:4px">
            Dosya seçtiğinizde görsel yerel olarak işlenerek yukarıdaki önizlemeye anında yansıtılacaktır.
          </div>
        </div>
      </div>
    `;
    return;
  }

  // SteamGridDB Sekmesi
  if (!S.steamGridApiKey) {
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="sgdb-setup-box">
          <div class="sgdb-setup-header">
            <div class="sgdb-setup-icon">${icon("globe", 20)}</div>
            <div>
              <div class="sgdb-setup-title">SteamGridDB Topluluk Entegrasyonu</div>
              <div class="sgdb-setup-desc">
                Video oyunları için topluluk tarafından hazırlanan binlerce dikey kapak (2:3) ve vitrin afişi.
              </div>
            </div>
          </div>

          <div class="sgdb-info-card">
            <div class="sgdb-info-header">
              <div class="sgdb-info-title">
                ${icon("info", 13)}
                <span>SteamGridDB Nedir ve Neden API Anahtarı Gerekir?</span>
              </div>
            </div>
            <div class="sgdb-info-content">
              <p style="margin:0;line-height:1.45">
                SteamGridDB, oyunlar için yüksek kaliteli açık görsel arşividir. Kötüye kullanımı önlemek ve doğrudan kütüphanenizden arama yapabilmek için ücretsiz bir kişisel erişim anahtarı (Token) gereklidir.
              </p>
              <div class="sgdb-info-steps">
                <div class="sgdb-step">
                  <span class="sgdb-step-num">1</span>
                  <span>Resmi SteamGridDB sayfasına gidip giriş yapın (Steam veya Discord ile).</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">2</span>
                  <span>Açılan sayfada <strong>"Create API Key"</strong> butonuna tıklayarak anahtarınızı kopyalayın.</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">3</span>
                  <span>Anahtarı aşağıdaki alana yapıştırıp <strong>"Kaydet ve Ara"</strong> butonuna basın.</span>
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:center;width:100%">
            <button class="btn ghost small sgdb-key-guide-btn" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">
              ${icon("external", 12)} <span>Ücretsiz API Anahtarınızı Buradan Alın</span>
            </button>
          </div>

          <div class="sgdb-setup-input-row">
            <input id="modal-sgdb-key-input" type="${S.showModalSgdbKey ? "text" : "password"}" class="text-input" placeholder="API Anahtarınızı (Token) buraya yapıştırın..." spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="toggle-modal-sgdb-key-visibility" title="Göster/Gizle">${icon(S.showModalSgdbKey ? "eye-off" : "eye", 13)}</button>
            <button class="btn primary small" data-act="save-inline-sgdb-key" data-id="${appName}">Kaydet ve Ara</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="cover-tab-pane">
      <div class="sgdb-container">
        <div class="sgdb-search-bar">
          <input id="sgdb-search-input" class="text-input" placeholder="Oyun adı ara..." value="${esc(S.sgdbSearchQuery)}" spellcheck="false" autocomplete="off" />
          <button class="btn primary small" data-act="sgdb-search" data-id="${appName}" ${S.sgdbIsSearching ? "disabled" : ""}>
            ${S.sgdbIsSearching ? icon("refresh", 12) : icon("search", 12)}
            <span>${S.sgdbIsSearching ? "Aranıyor…" : "Ara"}</span>
          </button>
          <button class="btn ghost small ${S.showModalSgdbInfo ? "active" : ""}" data-act="toggle-sgdb-modal-info" title="SteamGridDB Bilgi">
            ${icon("info", 13)}
          </button>
        </div>

        ${S.showModalSgdbInfo ? `
        <div class="sgdb-info-card compact">
          <div class="sgdb-info-header">
            <div class="sgdb-info-title">${icon("info", 13)} <span>SteamGridDB Topluluk Kütüphanesi</span></div>
            <button data-act="toggle-sgdb-modal-info" title="Kapat">${icon("x", 12)}</button>
          </div>
          <div class="sgdb-info-content">
            <p style="margin:0">SteamGridDB; video oyunları için resmi ve topluluk yapımı dikey kapak (2:3) ve vitrin afişi (Hero) barındıran açık platformdur. Seçtiğiniz görseller kütüphaneniz için anında uygulanır.</p>
            <div style="display:flex;align-items:center;gap:12px;margin-top:2px;font-size:11px;color:#94a3b8">
              <span>Kayıtlı Anahtar: <code>${esc(S.steamGridApiKey.slice(0, 5))}••••••</code></span>
              <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:10.5px;padding:2px 8px">
                ${icon("external", 11)} Anahtarı Yönet
              </button>
            </div>
          </div>
        </div>
        ` : ""}

        ${S.sgdbGamesList.length > 1 ? `
        <div class="sgdb-matching-games-bar">
          <span class="sgdb-matching-label">${icon("gamepad-2", 12)} Oyunlar:</span>
          <div class="sgdb-matching-chips-track">
            ${S.sgdbGamesList.map(g => `
              <button class="sgdb-game-chip ${S.sgdbSelectedGameId === g.id ? "active" : ""}" data-act="sgdb-select-game" data-game-id="${g.id}" data-id="${appName}" title="${esc(g.name)} (ID: ${g.id})">
                ${esc(g.name)}
              </button>
            `).join("")}
          </div>
        </div>` : ""}

        <div class="sgdb-filter-bar">
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${S.sgdbAssetType === "grids" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="grids" data-id="${appName}">
              ${icon("image", 11)} Dikey (2:3)
            </button>
            <button class="sgdb-chip ${S.sgdbAssetType === "heroes" ? "active" : ""}" data-act="sgdb-set-asset-type" data-type="heroes" data-id="${appName}">
              ${icon("rows", 11)} Yatay Afiş (Hero)
            </button>
          </div>
          <div class="sgdb-chip-group">
            <button class="sgdb-chip ${S.sgdbActiveStyle === "" ? "active" : ""}" data-act="sgdb-set-style" data-style="" data-id="${appName}">Tümü</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "official" ? "active" : ""}" data-act="sgdb-set-style" data-style="official" data-id="${appName}">Resmi</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "no_logo" ? "active" : ""}" data-act="sgdb-set-style" data-style="no_logo" data-id="${appName}">Logosuz</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "alternate" ? "active" : ""}" data-act="sgdb-set-style" data-style="alternate" data-id="${appName}">Alternatif</button>
          </div>
        </div>

        <div class="sgdb-gallery">
          ${S.sgdbIsSearching ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:8px">
              ${icon("refresh", 16)} SteamGridDB üzerinden taranıyor…
            </div>
          ` : S.sgdbErrorMsg ? `
            <div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
              ${esc(S.sgdbErrorMsg)}
            </div>
          ` : S.sgdbCoversList.length === 0 ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">
              Uygun görsel bulunamadı. Farklı bir arama terimi deneyin.
            </div>
          ` : `
            <div class="${S.sgdbAssetType === "heroes" ? "sgdb-grid-horizontal" : "sgdb-grid-vertical"}">
              ${S.sgdbCoversList.map(item => {
                const isSel = S.sgdbSelectedCoverUrl === item.url;
                const thumbUrl = item.thumb || item.url;
                const authorName = item.author?.name || "Topluluk";
                const styleLabel = item.style === "no_logo" ? "Logosuz" : item.style === "alternate" ? "Alternatif" : item.style === "official" ? "Resmi" : "";
                return `
                <div class="sgdb-card ${isSel ? "selected" : ""}" data-act="sgdb-select-card" data-url="${esc(item.url)}" title="${esc(authorName)} • Skor: ${item.score}">
                  <img src="${esc(thumbUrl)}" loading="lazy" alt="Cover" />
                  <div class="sgdb-card-badges">
                    ${styleLabel ? `<span class="sgdb-style-tag">${esc(styleLabel)}</span>` : "<span></span>"}
                    <span class="sgdb-score-tag">▲ ${item.score}</span>
                  </div>
                  <div class="sgdb-card-footer">${esc(authorName)}</div>
                  ${isSel ? `<div class="sgdb-selected-check">${icon("check", 14)}</div>` : ""}
                </div>`;
              }).join("")}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

export async function searchAndLoadSteamGrid(appName: string, query?: string): Promise<void> {
  if (!S.steamGridApiKey) {
    renderCustomCoverModalContent(appName);
    return;
  }
  S.sgdbIsSearching = true;
  S.sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);

  const term = query !== undefined ? query.trim() : S.sgdbSearchQuery.trim();
  if (!term) {
    S.sgdbIsSearching = false;
    S.sgdbGamesList = [];
    S.sgdbCoversList = [];
    renderCustomCoverModalContent(appName);
    return;
  }

  try {
    const games = await epicSearchSteamGrid(term);
    S.sgdbGamesList = games;
    if (games.length > 0) {
      S.sgdbSelectedGameId = games[0].id;
      await loadSteamGridCovers(appName, games[0].id);
    } else {
      S.sgdbSelectedGameId = null;
      S.sgdbCoversList = [];
      S.sgdbIsSearching = false;
      renderCustomCoverModalContent(appName);
    }
  } catch (err) {
    S.sgdbErrorMsg = String(err);
    S.sgdbCoversList = [];
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

export async function loadSteamGridCovers(appName: string, gameId: number): Promise<void> {
  S.sgdbIsSearching = true;
  S.sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);
  try {
    const covers = await epicGetSteamGridCovers(gameId, S.sgdbAssetType, S.sgdbActiveStyle || undefined);
    S.sgdbCoversList = covers;
  } catch (err) {
    S.sgdbErrorMsg = String(err);
    S.sgdbCoversList = [];
  } finally {
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

