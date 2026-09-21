/**
 * Collections (categories) management UI.
 *
 * Renders the collection editor modal and the per-game collection picker, and
 * persists changes through the Epic collections commands. State lives in S;
 * re-renders go through the render bus.
 */

import { COLLECTION_ICONS, collectionMarker, isCollectionIcon } from "../../core/collection-icons";
import { isTauri } from "../../core/constants";
import { collectionRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { render, scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";

import { epicDeleteCollection, epicGetCollections, epicSaveCollection, epicSetGameCollections } from "../../epic";
export function openCollectionModal(colId?: string | null): void {
  S.activeEditingColId = colId ?? null;
  S.colModalSearchQuery = "";
  S.colModalTabFilter = "all";
  S.isMarkerPaletteOpen = false;
  if (colId) {
    const col = S.epicCollections.find((c) => c.id === colId);
    S.colModalSelectedApps = new Set(col?.app_names || []);
    S.colModalMarker = isCollectionIcon(col?.emoji) ? (col!.emoji as string) : "";
  } else {
    S.colModalSelectedApps = new Set();
    S.colModalMarker = "";
  }
  renderCollectionModal();
}

export function closeCollectionModal(): void {
  if (collectionRoot) collectionRoot.innerHTML = "";
  S.activeEditingColId = null;
  S.gameColModalAppName = null;
  S.isMarkerPaletteOpen = false;
}

/** Refresh the marker avatar/palette in place (avoids a full modal re-render). */
export function updateMarkerUi(): void {
  const display = document.getElementById("col-marker-display");
  const avatarBtn = document.querySelector(".col-marker-avatar-btn");
  const headerAvatar = document.getElementById("col-header-avatar");
  if (display) {
    display.innerHTML = collectionMarker(S.colModalMarker, 20);
  }
  if (avatarBtn) {
    avatarBtn.classList.toggle("has-marker", Boolean(S.colModalMarker));
  }
  if (headerAvatar) {
    headerAvatar.innerHTML = collectionMarker(S.colModalMarker, 18);
  }
  const pal = document.getElementById("col-marker-palette");
  if (pal) {
    pal.classList.toggle("open", S.isMarkerPaletteOpen);
    pal.querySelectorAll(".col-marker-item").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.icon === S.colModalMarker);
    });
  }
}

export function updateColPresetArrows(): void {
  const container = document.getElementById("col-presets-scrollable");
  const wrapper = container?.closest(".col-presets-track-wrapper");
  if (!container || !wrapper) return;

  const leftFade = wrapper.querySelector(".col-presets-fade.left") as HTMLElement | null;
  const rightFade = wrapper.querySelector(".col-presets-fade.right") as HTMLElement | null;

  const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
  const hasOverflow = maxScroll > 4;

  const canScrollLeft = hasOverflow && container.scrollLeft > 4;
  const canScrollRight = hasOverflow && container.scrollLeft < maxScroll - 4;

  if (leftFade) leftFade.classList.toggle("visible", canScrollLeft);
  if (rightFade) rightFade.classList.toggle("visible", canScrollRight);
}

export function renderCollectionModal(): void {
  if (!collectionRoot) return;
  const col = S.activeEditingColId ? S.epicCollections.find((c) => c.id === S.activeEditingColId) : null;
  const colName = col ? col.name : "";
  const isEditing = Boolean(S.activeEditingColId);

  const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
  let filtered = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
  if (S.colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => S.colModalSelectedApps.has(s.appName));
  } else if (S.colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

  const installedCount = S.epicSummaries.filter((s) => s.installed).length;
  const selectedCount = S.colModalSelectedApps.size;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar" id="col-header-avatar">
              ${collectionMarker(S.colModalMarker, 20)}
            </div>
            <div>
              <h2>
                <span>${isEditing ? "Koleksiyonu Düzenle" : "Yeni Koleksiyon Oluştur"}</span>
                <span class="col-header-count" id="col-header-selected-badge">${selectedCount} Seçildi</span>
              </h2>
              <div class="col-modal-subtitle">${isEditing ? `"${esc(colName)}" kategorisini özelleştirin` : "Oyunlarınızı kategorilere ayırarak düzenleyin"}</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="Kapat">
            ${icon("x", 16)}
          </button>
        </div>

        <div class="col-modal-body">
          <div class="col-input-group">
            <label for="col-name-input" class="col-label">Koleksiyon Simgesi & Adı</label>
            <div class="col-name-row">
              <div class="col-marker-picker-container">
                <button type="button" class="col-marker-avatar-btn ${S.colModalMarker ? "has-marker" : ""}" data-act="toggle-col-marker-palette" title="Simge Seç">
                  <span id="col-marker-display">${collectionMarker(S.colModalMarker, 22)}</span>
                  <span class="col-marker-edit-badge">${icon("edit", 10)}</span>
                </button>
                <div id="col-marker-palette" class="col-marker-palette ${S.isMarkerPaletteOpen ? "open" : ""}">
                  <div class="col-marker-palette-header">
                    <span>Bir Simge Seçin</span>
                    ${S.colModalMarker ? `<button type="button" class="col-marker-clear-btn" data-act="clear-col-marker">${icon("trash", 11)} Kaldır</button>` : ""}
                  </div>
                  <div class="col-marker-grid">
                    ${COLLECTION_ICONS.map((name) => `
                      <button type="button" class="col-marker-item ${S.colModalMarker === name ? "active" : ""}" data-act="pick-col-marker" data-icon="${name}" title="${name}">${icon(name, 18)}</button>
                    `).join("")}
                  </div>
                </div>
              </div>
              <input id="col-name-input" class="text-input col-name-input" placeholder="Örn: Hikaye, Online, Co-op, Bitirdiklerim..." value="${esc(colName)}" autocomplete="off" spellcheck="false" />
            </div>

            <!-- Detay Sayfası Tarzı Kaydırılabilir Hızlı Şablonlar -->
            <div class="col-presets-wrapper">
              <span class="col-quick-label">Hızlı Şablonlar:</span>
              <div class="col-presets-track-wrapper">
                <div class="col-presets-fade left">
                  <button type="button" class="col-presets-arrow left" data-act="col-presets-scroll" data-dir="left" title="Sola kaydır">
                    ${icon("chevron-left", 12)}
                  </button>
                </div>
                <div class="col-quick-presets" id="col-presets-scrollable">
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="list" data-name="Hikaye">${icon("list", 13)} <span>Hikaye</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="globe" data-name="Online">${icon("globe", 13)} <span>Online</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="trophy" data-name="Platin Hedef">${icon("trophy", 13)} <span>Platin Hedef</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="shield" data-name="RPG">${icon("shield", 13)} <span>RPG</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="zap" data-name="Yarış">${icon("zap", 13)} <span>Yarış</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="eye" data-name="Korku">${icon("eye", 13)} <span>Korku</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="heart" data-name="Favoriler">${icon("heart", 13)} <span>Favoriler</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="zap" data-name="Aksiyon">${icon("zap", 13)} <span>Aksiyon</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="layers" data-name="Bulmaca">${icon("layers", 13)} <span>Bulmaca</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="rocket" data-name="Bilim Kurgu">${icon("rocket", 13)} <span>Bilim Kurgu</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="gamepad-2" data-name="Retro / Klasik">${icon("gamepad-2", 13)} <span>Retro / Klasik</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="cpu" data-name="Strateji">${icon("cpu", 13)} <span>Strateji</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="crown" data-name="VIP / Özel">${icon("crown", 13)} <span>VIP / Özel</span></button>
                  <button type="button" class="col-preset-chip" data-act="quick-col-preset" data-icon="check-circle" data-name="Bitirdiklerim">${icon("check-circle", 13)} <span>Bitirdiklerim</span></button>
                </div>
                <div class="col-presets-fade right">
                  <button type="button" class="col-presets-arrow right" data-act="col-presets-scroll" data-dir="right" title="Sağa kaydır">
                    ${icon("chevron-right", 12)}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="col-picker-box">
            <div class="col-picker-head">
              <div class="col-filter-tabs">
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "all" ? "active" : ""}" data-act="col-tab-filter" data-filter="all">
                  Tümü <span class="col-tab-cnt">${S.epicSummaries.length}</span>
                </button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "selected" ? "active" : ""}" data-act="col-tab-filter" data-filter="selected">
                  Seçilenler <span class="col-tab-cnt" id="col-tab-selected-cnt">${selectedCount}</span>
                </button>
                <button type="button" class="col-filter-tab ${S.colModalTabFilter === "installed" ? "active" : ""}" data-act="col-tab-filter" data-filter="installed">
                  Yüklü <span class="col-tab-cnt">${installedCount}</span>
                </button>
              </div>

              <div class="col-quick-btns">
                <button type="button" class="col-quick-btn" data-act="col-select-all">Tümünü Seç</button>
                <button type="button" class="col-quick-btn" data-act="col-deselect-all">Temizle</button>
              </div>
            </div>

            <div class="col-search-wrap">
              <span>${icon("search", 13)}</span>
              <input id="col-search-input" class="text-input" placeholder="Kütüphanedeki ${S.epicSummaries.length} oyun arasında ara..." value="${esc(S.colModalSearchQuery)}" autocomplete="off" />
              ${S.colModalSearchQuery ? `<button type="button" class="col-search-clear" data-act="col-search-clear" title="Temizle">${icon("x", 12)}</button>` : ""}
            </div>

            <div class="col-games-list">
              ${filtered.length > 0 ? filtered.map((s) => {
                const checked = S.colModalSelectedApps.has(s.appName);
                return `
                  <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
                    <div class="col-custom-cb ${checked ? "checked" : ""}">
                      ${icon("check", 12)}
                    </div>
                    ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
                    <div class="col-game-info">
                      <div class="col-game-title">${esc(s.title)}</div>
                      <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} Yüklü</span>` : "Yüklü Değil"}</div>
                    </div>
                  </div>
                `;
              }).join("") : `<div class="col-empty-msg">Eşleşen oyun bulunamadı.</div>`}
            </div>
          </div>
        </div>

        <div class="col-modal-footer">
          <div>
            ${isEditing ? `<button class="btn danger small" data-act="col-delete-btn" data-col-id="${col!.id}">${icon("trash", 13)} Koleksiyonu Sil</button>` : `<div class="col-footer-summary"><span id="col-footer-count">${selectedCount}</span> / ${S.epicSummaries.length} oyun seçildi</div>`}
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn ghost small" data-act="close-col-modal">İptal</button>
            <button class="btn primary small" data-act="col-save-btn">${isEditing ? "Değişiklikleri Kaydet" : "Koleksiyon Oluştur"}</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  if (nameInput && !isEditing) nameInput.focus();

  const searchInput = document.getElementById("col-search-input") as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      S.colModalSearchQuery = (e.target as HTMLInputElement).value;
      updateColGamesListInPlace();
    });
  }

  const presetsScrollable = document.getElementById("col-presets-scrollable");
  if (presetsScrollable) {
    presetsScrollable.addEventListener("scroll", updateColPresetArrows, { passive: true });
    requestAnimationFrame(() => updateColPresetArrows());
  }
}

export function updateColGamesListInPlace(): void {
  const container = document.querySelector(".col-games-list");
  if (!container) return;
  const q = S.colModalSearchQuery.toLocaleLowerCase("tr");
  let filtered = S.epicSummaries.filter((s) => s.title.toLocaleLowerCase("tr").includes(q));
  if (S.colModalTabFilter === "selected") {
    filtered = filtered.filter((s) => S.colModalSelectedApps.has(s.appName));
  } else if (S.colModalTabFilter === "installed") {
    filtered = filtered.filter((s) => s.installed);
  }

  container.innerHTML = filtered.length > 0 ? filtered.map((s) => {
    const checked = S.colModalSelectedApps.has(s.appName);
    return `
      <div class="col-game-item ${checked ? "selected" : ""}" data-act="col-toggle-game" data-app="${s.appName}">
        <div class="col-custom-cb ${checked ? "checked" : ""}">
          ${icon("check", 12)}
        </div>
        ${s.cover ? `<img class="col-game-thumb" src="${esc(s.cover)}" alt="" loading="lazy" />` : `<div class="col-game-thumb placeholder">${icon("gamepad-2", 16)}</div>`}
        <div class="col-game-info">
          <div class="col-game-title">${esc(s.title)}</div>
          <div class="col-game-sub">${s.installed ? `<span class="col-inst-badge">${icon("check", 10)} Yüklü</span>` : "Yüklü Değil"}</div>
        </div>
      </div>
    `;
  }).join("") : `<div class="col-empty-msg">Eşleşen oyun bulunamadı.</div>`;

  const selCountEl = document.getElementById("col-tab-selected-cnt");
  if (selCountEl) selCountEl.textContent = String(S.colModalSelectedApps.size);

  const headerBadge = document.getElementById("col-header-selected-badge");
  if (headerBadge) headerBadge.textContent = `${S.colModalSelectedApps.size} Seçildi`;

  const footerCnt = document.getElementById("col-footer-count");
  if (footerCnt) footerCnt.textContent = String(S.colModalSelectedApps.size);
}

export async function saveCollectionFromModal(): Promise<void> {
  const nameInput = document.getElementById("col-name-input") as HTMLInputElement | null;
  const name = nameInput?.value.trim() || "";
  if (!name) {
    toast("Lütfen koleksiyon adı girin.", "err");
    return;
  }
  try {
    const saved = await epicSaveCollection(
      name,
      Array.from(S.colModalSelectedApps),
      S.activeEditingColId,
      S.colModalMarker || null,
    );
    toast(`"${saved.name}" koleksiyonu kaydedildi`, "ok");
    closeCollectionModal();
    await loadEpicCollections();
    render();
  } catch (e) {
    toast(`Koleksiyon kaydedilemedi: ${String(e)}`, "err");
  }
}

export async function deleteCollectionFromModal(colId: string): Promise<void> {
  const col = S.epicCollections.find((c) => c.id === colId);
  const name = col ? col.name : "Koleksiyon";
  if (!confirm(`"${name}" koleksiyonunu silmek istediğinize emin misiniz?\n(Oyunlar silinmez, yalnızca kategori kaldırılır)`)) {
    return;
  }
  try {
    await epicDeleteCollection(colId);
    if (S.activeCollectionId === colId) S.activeCollectionId = null;
    toast(`"${name}" koleksiyonu silindi`, "ok");
    closeCollectionModal();
    await loadEpicCollections();
    render();
  } catch (e) {
    toast(`Koleksiyon silinemedi: ${String(e)}`, "err");
  }
}

/* ---------- Oyun Koleksiyonları Seçim Modalı (Detay Çekmecesinden) ---------- */




export function openGameCollectionsModal(appName: string): void {
  if (!collectionRoot) return;
  S.gameColModalAppName = appName;
  S.gameColModalSelectedCols = new Set(
    S.epicCollections
      .filter((c) => c.app_names.some((a) => a.toLowerCase() === appName.toLowerCase()))
      .map((c) => c.id),
  );

  const sum = S.epicSummaries.find((s) => s.appName === appName);
  const title = sum?.title || appName;

  collectionRoot.innerHTML = `
    <div class="col-modal-backdrop" data-act="col-modal-backdrop">
      <div class="col-modal-card" style="max-width:540px; height:auto; max-height:75vh;" role="dialog" aria-modal="true">
        <div class="col-modal-header">
          <div class="col-modal-title">
            <div class="col-modal-header-avatar">
              ${icon("folder", 20)}
            </div>
            <div>
              <h2>Koleksiyonlar</h2>
              <div class="col-modal-subtitle">${esc(title)} oyununun dahil olacağı kategoriler</div>
            </div>
          </div>
          <button class="col-modal-close" data-act="close-col-modal" title="Kapat">
            ${icon("x", 16)}
          </button>
        </div>
        <div class="col-modal-body">
          <div class="col-game-checkboxes">
            ${S.epicCollections.length > 0 ? S.epicCollections.map((c) => {
              const checked = S.gameColModalSelectedCols.has(c.id);
              return `
                <div class="col-game-item ${checked ? "selected" : ""}" data-col-id="${esc(c.id)}">
                  <div class="col-custom-cb ${checked ? "checked" : ""}">
                    ${icon("check", 12)}
                  </div>
                  <div class="col-game-info">
                    <div class="col-game-title">
                      ${isCollectionIcon(c.emoji) ? `<span class="col-item-marker">${collectionMarker(c.emoji, 14)}</span> ` : ""}${esc(c.name)}
                    </div>
                    <div class="col-game-sub">${c.app_names.length} oyun</div>
                  </div>
                </div>
              `;
            }).join("") : `
              <div class="col-empty-msg">
                Henüz hiç koleksiyon oluşturulmamış.<br/>
                <button class="btn ghost small" data-act="open-new-collection-modal" style="margin-top:8px">+ Yeni Koleksiyon Oluştur</button>
              </div>
            `}
          </div>
        </div>
        <div class="col-modal-footer">
          <button class="btn ghost small" data-act="open-new-collection-modal">+ Yeni Koleksiyon</button>
          <div style="display:flex;gap:10px">
            <button class="btn ghost small" data-act="close-col-modal">İptal</button>
            <button class="btn primary small" data-act="save-game-col-btn">Kaydet</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function saveGameCollectionsFromModal(): Promise<void> {
  if (!S.gameColModalAppName) return;
  const appName = S.gameColModalAppName;
  const colIds = Array.from(S.gameColModalSelectedCols);
  try {
    await epicSetGameCollections(appName, colIds);
    toast("Oyun koleksiyonları güncellendi", "ok");
    closeCollectionModal();
    await loadEpicCollections();
    if (S.currentModalAppName === appName) {
      updateDrawerCollectionsBoxInPlace(appName);
    }
    render();
  } catch (e) {
    toast(`Koleksiyonlar güncellenemedi: ${String(e)}`, "err");
  }
}

export function updateDrawerCollectionsBoxInPlace(appName: string): void {
  const container = document.getElementById("drawer-col-chips-container");
  const subEl = document.getElementById("drawer-col-subtitle");
  const editBtn = document.querySelector<HTMLElement>(".drawer-col-edit-btn span");
  if (!container) return;
  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === appName.toLowerCase()),
  );
  if (subEl) {
    subEl.textContent = gameCols.length > 0 ? `${gameCols.length} kategoride ekli` : "Kategori atanmadı";
  }
  if (editBtn) {
    editBtn.textContent = gameCols.length > 0 ? "Düzenle" : "+ Ekle";
  }
  container.innerHTML =
    gameCols.length > 0
      ? gameCols
          .map(
            (c) => `
          <button class="bento-col-pill drawer-col-pill" data-act="select-collection" data-col-id="${esc(c.id)}" title="${esc(c.name)} koleksiyonunu kütüphanede göster">
            ${isCollectionIcon(c.emoji) ? `<span class="col-pill-marker">${collectionMarker(c.emoji, 13)}</span>` : `<span class="col-pill-dot"></span>`}
            <span class="col-pill-text">${esc(c.name)}</span>
          </button>
        `,
          )
          .join("")
      : `
          <button class="bento-empty-col" data-act="manage-game-collections" data-id="${appName}">
            <span>Kategori atanmadı</span>
          </button>
        `;
}

/** Load the user's collections from Epic and refresh the library if visible. */
export async function loadEpicCollections(): Promise<void> {
  if (!isTauri) return;
  try {
    S.epicCollections = await epicGetCollections();
    if (S.view === "library") scheduleRender();
  } catch (e) {
    console.warn("Koleksiyonlar alınamadı:", e);
  }
}