/**
 * Theme showcase grid, Theme Designer modal & Import/Export system.
 *
 * Provides a responsive theme gallery with live miniature launcher mockups,
 * real-time customizable theme creator with frosted glass & wallpaper blur,
 * preset palettes, and import/export capabilities.
 */

import { themeModalRoot } from "../../core/dom";
import { icon } from "../../core/icons";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { esc } from "../../core/utils";
import {
  applySurface,
  customThemes,
  deleteCustomTheme,
  duplicateTheme,
  exportThemeJson,
  getCustomThemeInput,
  importThemeJson,
  saveCustomTheme,
  themeById,
  themes,
  THEME_PRESETS,
  type CustomThemeInput,
  type ThemeDef,
} from "../../core/themes";
import { t } from "../../i18n";

type ThemeFilter = "all" | "dark" | "light" | "custom";
let currentFilter: ThemeFilter = "all";

/** Theme designer modal state */
let designerOpen = false;
let designerSourceId: string | null = null;
let harmonizeSurfaces = true;
let designerDraft: CustomThemeInput = {
  name: "",
  bg: "#141418",
  surface: "#1f1f26",
  accent: "#7c3aed",
  accentHover: "#8b5cf6",
  light: false,
  scene: undefined,
  sceneBlur: 0,
  sceneOpacity: 0.5,
  radius: "default",
};

/** Theme importer modal state */
let importerOpen = false;

const HEX_TEST = /^#[0-9a-f]{6}$/i;

/** Renders the full modern Theme Section for Settings → Appearance. */
export function renderThemeSection(): string {
  const allThemes = themes();
  const customList = customThemes();

  let filtered = allThemes;
  if (currentFilter === "dark") {
    filtered = allThemes.filter((th) => th.scheme === "dark");
  } else if (currentFilter === "light") {
    filtered = allThemes.filter((th) => th.scheme === "light");
  } else if (currentFilter === "custom") {
    filtered = allThemes.filter((th) => Boolean(th.custom));
  }

  const activeTheme = themeById(S.surface);
  const activeName = activeTheme.name ?? t(activeTheme.labelKey);

  const cardsHtml =
    filtered.length > 0
      ? filtered.map((theme) => renderThemeCard(theme)).join("")
      : currentFilter === "custom"
        ? `<div class="theme-empty-custom">
            <span style="font-size: 24px; opacity: 0.8;">${icon("sparkles", 28)}</span>
            <span>${esc(t("settings.themeEmptyCustom"))}</span>
            <button type="button" class="btn primary small" data-act="theme-add">
              ${icon("plus", 13)} ${t("settings.themeAdd")}
            </button>
          </div>`
        : "";

  return `
    <div class="theme-section" data-search="${esc(`${t("settings.themeTitle")} ${t("settings.themeDesc")} theme surface appearance`)}">
      <div class="theme-section-header">
        <div class="theme-section-titles">
          <h3 class="section-title">${esc(t("settings.themeTitle"))}</h3>
          <p class="page-sub">${esc(t("settings.themeDesc"))}</p>
        </div>
        <div class="theme-section-actions">
          <button type="button" class="btn ghost small" data-act="theme-import-open" title="${esc(t("settings.themeImport"))}">
            ${icon("download", 13)} <span>${esc(t("settings.themeImport"))}</span>
          </button>
          <button type="button" class="btn primary small" data-act="theme-add">
            ${icon("plus", 13)} <span>${esc(t("settings.themeAdd"))}</span>
          </button>
        </div>
      </div>

      <div class="theme-filter-bar">
        <div class="seg theme-filter-seg">
          <button type="button" class="${currentFilter === "all" ? "active" : ""}" data-act="theme-filter" data-filter="all">
            ${esc(t("settings.themeFilterAll"))} (${allThemes.length})
          </button>
          <button type="button" class="${currentFilter === "dark" ? "active" : ""}" data-act="theme-filter" data-filter="dark">
            ${esc(t("settings.themeFilterDark"))}
          </button>
          <button type="button" class="${currentFilter === "light" ? "active" : ""}" data-act="theme-filter" data-filter="light">
            ${esc(t("settings.themeFilterLight"))}
          </button>
          <button type="button" class="${currentFilter === "custom" ? "active" : ""}" data-act="theme-filter" data-filter="custom">
            ${esc(t("settings.themeFilterCustom"))} (${customList.length})
          </button>
        </div>

        <div class="theme-active-indicator">
          <span>${esc(t("settings.themeActive"))}:</span>
          <strong>${esc(activeName)}</strong>
        </div>
      </div>

      <div class="theme-grid">
        ${cardsHtml}
      </div>
    </div>
  `;
}

/** Renders one theme card with realistic miniature launcher mockup. */
function renderThemeCard(theme: ThemeDef): string {
  const isActive = S.surface === theme.id;
  const displayName = theme.name ?? t(theme.labelKey);

  const previewBg = theme.bg;
  const accent = theme.accent;
  const surface1 = theme.tokens?.["--surface-1"] ?? theme.surface ?? (theme.scheme === "light" ? "#ffffff" : "#1a1a20");
  const surface2 = theme.tokens?.["--surface-2"] ?? (theme.scheme === "light" ? "#f3f4f6" : "#24242e");
  const lineColor = theme.tokens?.["--line"] ?? "rgba(255,255,255,0.08)";
  const hasScene = Boolean(theme.scene);
  const sceneBlur = theme.sceneBlur ?? 0;
  const scrimOpacity = theme.sceneOpacity ?? (theme.scheme === "light" ? 0.35 : 0.5);
  const scrimColor = theme.scheme === "light" ? `rgba(255, 255, 255, ${scrimOpacity})` : `rgba(0, 0, 0, ${scrimOpacity})`;

  const cardArtGradient = `linear-gradient(135deg, ${accent}33, ${surface2})`;

  return `
    <div class="theme-card ${isActive ? "active" : ""}" data-act="set-surface" data-surface="${esc(theme.id)}" role="button" tabindex="0" aria-pressed="${isActive ? "true" : "false"}">
      <div class="theme-card-preview" style="background: ${esc(previewBg)};">
        ${hasScene ? `<div class="theme-card-preview-scene" style="background-image: url('${esc(theme.scene!)}'); filter: blur(${sceneBlur}px);"></div>` : ""}
        <div class="theme-card-preview-scrim" style="background: ${scrimColor};"></div>
        <div class="theme-card-mockup">
          <div class="theme-mock-winbar">
            <span class="theme-mock-dot"></span>
            <span class="theme-mock-dot"></span>
            <span class="theme-mock-dot"></span>
          </div>
          <div class="theme-mock-body">
            <div class="theme-mock-sidebar" style="background: ${esc(surface1)}; border-color: ${esc(lineColor)};">
              <span class="theme-mock-nav-item active" style="background: ${esc(accent)};"></span>
              <span class="theme-mock-nav-item" style="background: ${esc(lineColor)};"></span>
              <span class="theme-mock-nav-item" style="background: ${esc(lineColor)};"></span>
            </div>
            <div class="theme-mock-content">
              <div class="theme-mock-search" style="background: ${esc(surface2)}; border-color: ${esc(lineColor)};"></div>
              <div class="theme-mock-cards">
                <div class="theme-mock-card" style="background: ${esc(surface1)}; border-color: ${esc(lineColor)};">
                  <div class="theme-mock-card-art" style="background: ${cardArtGradient};"></div>
                  <div class="theme-mock-play" style="background: ${esc(accent)};"></div>
                </div>
                <div class="theme-mock-card" style="background: ${esc(surface1)}; border-color: ${esc(lineColor)};">
                  <div class="theme-mock-card-art" style="background: ${esc(surface2)};"></div>
                  <div class="theme-mock-play" style="background: ${esc(accent)};"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
        ${isActive ? `<div class="theme-card-badge-active" title="${esc(t("settings.themeActive"))}">${icon("check", 13)}</div>` : ""}
      </div>

      <div class="theme-card-info">
        <div class="theme-card-header">
          <span class="theme-card-title" title="${esc(displayName)}">${esc(displayName)}</span>
          <div class="theme-card-tags">
            ${theme.custom ? `<span class="chip micro custom">${icon("sparkles", 9)} ${esc(t("settings.themeCustomBadge"))}</span>` : ""}
            ${hasScene ? `<span class="chip micro glass">${icon("image", 9)} Cam</span>` : ""}
            ${theme.scheme === "light" ? `<span class="chip micro light">Açık</span>` : ""}
          </div>
        </div>

        <div class="theme-card-footer">
          <div class="theme-swatch-cluster" title="Palet: ${esc(theme.bg)}, ${esc(surface1)}, ${esc(accent)}">
            <span class="theme-dot" style="background: ${esc(theme.bg)};"></span>
            <span class="theme-dot" style="background: ${esc(surface1)};"></span>
            <span class="theme-dot" style="background: ${esc(accent)}; border-color: ${esc(accent)};"></span>
          </div>

          <div class="theme-card-actions">
            ${theme.custom ? `
              <button type="button" class="theme-action-btn" data-act="theme-edit" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeEdit"))}">
                ${icon("edit", 12)}
              </button>
              <button type="button" class="theme-action-btn" data-act="theme-clone" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeClone"))}">
                ${icon("copy", 12)}
              </button>
              <button type="button" class="theme-action-btn" data-act="theme-export" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeExport"))}">
                ${icon("share-2", 12)}
              </button>
              <button type="button" class="theme-action-btn danger" data-act="theme-delete" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeDelete"))}">
                ${icon("trash", 12)}
              </button>
            ` : `
              <button type="button" class="theme-action-btn" data-act="theme-clone" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeClone"))}">
                ${icon("copy", 12)}
              </button>
              <button type="button" class="theme-action-btn" data-act="theme-export" data-theme-id="${esc(theme.id)}" title="${esc(t("settings.themeExport"))}">
                ${icon("share-2", 12)}
              </button>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Opens the Theme Designer Modal to create or edit a custom theme. */
export function openThemeDesigner(themeId?: string): void {
  designerSourceId = themeId ?? null;
  harmonizeSurfaces = true;

  if (themeId) {
    const custom = getCustomThemeInput(themeId);
    if (custom) {
      designerDraft = {
        id: custom.id,
        name: custom.name,
        bg: custom.bg,
        surface: custom.surface ?? "#181822",
        accent: custom.accent,
        accentHover: custom.accentHover ?? custom.accent,
        light: custom.light,
        scene: custom.scene,
        sceneBlur: custom.sceneBlur ?? 0,
        sceneOpacity: custom.sceneOpacity ?? 0.5,
        radius: custom.radius ?? "default",
      };
    } else {
      const def = themeById(themeId);
      designerDraft = {
        name: `${def.name ?? t(def.labelKey)} (Özel)`,
        bg: HEX_TEST.test(def.bg) ? def.bg : "#141418",
        surface: def.surface && HEX_TEST.test(def.surface) ? def.surface : (def.scheme === "light" ? "#ffffff" : "#1f1f28"),
        accent: HEX_TEST.test(def.accent) ? def.accent : "#7c3aed",
        accentHover: def.accent,
        light: def.scheme === "light",
        scene: undefined,
        sceneBlur: 0,
        sceneOpacity: 0.5,
        radius: "default",
      };
      designerSourceId = null;
    }
  } else {
    const active = themeById(S.surface);
    designerDraft = {
      name: "",
      bg: HEX_TEST.test(active.bg) ? active.bg : "#101014",
      surface: active.surface && HEX_TEST.test(active.surface) ? active.surface : (active.scheme === "light" ? "#ffffff" : "#181820"),
      accent: HEX_TEST.test(active.accent) ? active.accent : "#7c3aed",
      accentHover: active.accent,
      light: active.scheme === "light",
      scene: undefined,
      sceneBlur: 0,
      sceneOpacity: 0.5,
      radius: "default",
    };
  }

  designerOpen = true;
  renderDesignerModal();
}

/** Closes the Theme Designer Modal and restores active surface. */
export function closeThemeDesigner(): void {
  designerOpen = false;
  designerSourceId = null;
  themeModalRoot.innerHTML = "";
  // Ensure the actual active theme is applied if the user tested live
  applySurface(S.surface, false);
}

/** Renders the Designer Modal DOM into `themeModalRoot`. */
function renderDesignerModal(): void {
  const isEditing = Boolean(designerSourceId);
  const title = isEditing ? t("settings.themeEdit") : t("settings.themeDesignerTitle");

  const presetChips = THEME_PRESETS.map((p) => `
    <button type="button" class="theme-preset-chip" data-act="td-preset" data-preset-id="${esc(p.id)}">
      <div class="theme-preset-dots">
        <span class="theme-preset-dot" style="background: ${esc(p.bg)};"></span>
        <span class="theme-preset-dot" style="background: ${esc(p.surface)};"></span>
        <span class="theme-preset-dot" style="background: ${esc(p.accent)};"></span>
      </div>
      <span>${esc(p.name)}</span>
    </button>
  `).join("");

  const blurVal = designerDraft.sceneBlur ?? 0;
  const opacityVal = Math.round((designerDraft.sceneOpacity ?? 0.5) * 100);

  themeModalRoot.innerHTML = `
    <div class="modal-backdrop theme-designer-backdrop" data-act="td-cancel">
      <div class="modal-box theme-designer-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <div class="modal-head-main">
            <h3 class="modal-title" style="display:flex;align-items:center;gap:8px;">
              ${icon("sparkles", 18)} <span>${esc(title)}</span>
            </h3>
            <span class="modal-sub">${esc(t("settings.themeDesignerDesc"))}</span>
          </div>
          <button type="button" class="win-btn win-close" data-act="td-cancel" title="${esc(t("settings.themeCancel"))}">
            ${icon("x", 14)}
          </button>
        </div>

        <div class="theme-designer-body">
          <!-- Left Controls Column -->
          <div class="theme-designer-form">
            <!-- Basic info -->
            <div class="theme-form-section">
              <span class="theme-form-section-title">Temel Bilgiler</span>
              <input id="td-name" class="text-input" maxlength="32" placeholder="${esc(t("settings.themeNamePlaceholder"))}" value="${esc(designerDraft.name)}" />
              
              <div class="seg" style="align-self:flex-start;margin-top:4px;">
                <button type="button" class="${!designerDraft.light ? "active" : ""}" data-act="td-scheme" data-scheme="dark">
                  ${esc(t("settings.themeFilterDark"))}
                </button>
                <button type="button" class="${designerDraft.light ? "active" : ""}" data-act="td-scheme" data-scheme="light">
                  ${esc(t("settings.themeFilterLight"))}
                </button>
              </div>
            </div>

            <!-- Preset Palettes -->
            <div class="theme-form-section">
              <span class="theme-form-section-title">${esc(t("settings.themePresets"))}</span>
              <div class="theme-preset-chips">
                ${presetChips}
              </div>
            </div>

            <!-- Colors -->
            <div class="theme-form-section">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <span class="theme-form-section-title">Renk Ayarları</span>
                <label style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-2);cursor:pointer;">
                  <input type="checkbox" id="td-harmonize" ${harmonizeSurfaces ? "checked" : ""} />
                  <span>${esc(t("settings.themeHarmonize"))}</span>
                </label>
              </div>

              <div class="theme-color-rows">
                <div class="theme-color-row">
                  <span class="theme-color-label">${esc(t("settings.themeBg"))}</span>
                  <div class="theme-color-controls">
                    <div class="theme-color-picker-wrap">
                      <input type="color" id="td-bg-picker" value="${esc(designerDraft.bg)}" />
                    </div>
                    <input type="text" id="td-bg-hex" class="theme-color-hex" maxlength="7" value="${esc(designerDraft.bg)}" />
                  </div>
                </div>

                <div class="theme-color-row">
                  <span class="theme-color-label">${esc(t("settings.themeSurface"))}</span>
                  <div class="theme-color-controls">
                    <div class="theme-color-picker-wrap">
                      <input type="color" id="td-surface-picker" value="${esc(designerDraft.surface ?? "#181820")}" />
                    </div>
                    <input type="text" id="td-surface-hex" class="theme-color-hex" maxlength="7" value="${esc(designerDraft.surface ?? "#181820")}" />
                  </div>
                </div>

                <div class="theme-color-row">
                  <span class="theme-color-label">${esc(t("settings.themeAccent"))}</span>
                  <div class="theme-color-controls">
                    <div class="theme-color-picker-wrap">
                      <input type="color" id="td-accent-picker" value="${esc(designerDraft.accent)}" />
                    </div>
                    <input type="text" id="td-accent-hex" class="theme-color-hex" maxlength="7" value="${esc(designerDraft.accent)}" />
                  </div>
                </div>
              </div>
            </div>

            <!-- Backdrop and Frosted Glass -->
            <div class="theme-form-section">
              <span class="theme-form-section-title">Duvar Kağıdı ve Cam Efektleri</span>
              <div class="theme-scene-box">
                <div class="theme-scene-toolbar">
                  <button type="button" class="btn ghost small" data-act="td-pick-scene">
                    ${icon("image", 13)} <span>${esc(t("settings.themeScenePick"))}</span>
                  </button>
                  <input type="file" id="td-scene-file" accept="image/*" hidden />

                  ${designerDraft.scene ? `
                    <img class="theme-scene-thumb-preview" src="${esc(designerDraft.scene)}" alt="" />
                    <button type="button" class="btn ghost small" data-act="td-clear-scene" style="color:var(--err);">
                      ${icon("trash", 12)} ${esc(t("settings.themeSceneClear"))}
                    </button>
                  ` : `<span class="theme-hint">${esc(t("settings.themeSceneHint"))}</span>`}
                </div>

                ${designerDraft.scene ? `
                  <div class="theme-range-row">
                    <label for="td-blur-range">${esc(t("settings.themeBlur"))}</label>
                    <div class="theme-range-wrap">
                      <input type="range" id="td-blur-range" min="0" max="24" step="1" value="${blurVal}" class="settings-range" />
                      <span id="td-blur-val" class="theme-range-val tabular-nums">${blurVal}px</span>
                    </div>
                  </div>

                  <div class="theme-range-row">
                    <label for="td-opacity-range">${esc(t("settings.themeOpacity"))}</label>
                    <div class="theme-range-wrap">
                      <input type="range" id="td-opacity-range" min="10" max="90" step="5" value="${opacityVal}" class="settings-range" />
                      <span id="td-opacity-val" class="theme-range-val tabular-nums">${opacityVal}%</span>
                    </div>
                  </div>
                ` : ""}
              </div>
            </div>

            <!-- Corner Radius -->
            <div class="theme-form-section">
              <span class="theme-form-section-title">${esc(t("settings.themeRadius"))}</span>
              <div class="seg" style="align-self:flex-start;">
                <button type="button" class="${designerDraft.radius === "sharp" ? "active" : ""}" data-act="td-radius" data-radius="sharp">
                  ${esc(t("settings.themeRadiusSharp"))} (0px)
                </button>
                <button type="button" class="${!designerDraft.radius || designerDraft.radius === "default" ? "active" : ""}" data-act="td-radius" data-radius="default">
                  ${esc(t("settings.themeRadiusDefault"))} (6px)
                </button>
                <button type="button" class="${designerDraft.radius === "round" ? "active" : ""}" data-act="td-radius" data-radius="round">
                  ${esc(t("settings.themeRadiusRound"))} (12px)
                </button>
              </div>
            </div>
          </div>

          <!-- Right Live Interactive Preview Column -->
          <div class="theme-designer-preview-col">
            <div class="theme-preview-head">
              <span class="theme-preview-head-title">
                <span class="theme-pulse-dot"></span>
                <span>${esc(t("settings.themePreview"))}</span>
              </span>
              <button type="button" class="btn ghost small" data-act="td-live-test" style="font-size:11.5px;height:24px;padding:0 8px;">
                ${icon("eye", 12)} ${esc(t("settings.themeLiveTest"))}
              </button>
            </div>

            <div id="theme-designer-preview-window" class="theme-preview-window">
              <!-- Dynamically populated by updateDesignerLivePreview -->
            </div>
          </div>
        </div>

        <div class="modal-foot" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;">
          <button type="button" class="btn ghost small" data-act="td-cancel">
            ${esc(t("settings.themeCancel"))}
          </button>
          <button type="button" class="btn primary small" data-act="td-save">
            ${icon("check", 13)} ${esc(t("settings.themeSave"))}
          </button>
        </div>
      </div>
    </div>
  `;

  attachDesignerEventListeners();
  updateDesignerLivePreview();
}

/** Updates the live interactive preview frame in the designer dialog. */
function updateDesignerLivePreview(): void {
  const container = document.getElementById("theme-designer-preview-window");
  if (!container) return;

  const bg = designerDraft.bg;
  const surface = designerDraft.surface ?? (designerDraft.light ? "#ffffff" : "#181820");
  const accent = designerDraft.accent;
  const hasScene = Boolean(designerDraft.scene);
  const blur = designerDraft.sceneBlur ?? 0;
  const opacity = designerDraft.sceneOpacity ?? (designerDraft.light ? 0.38 : 0.52);
  const scrimColor = designerDraft.light ? `rgba(255, 255, 255, ${opacity})` : `rgba(0, 0, 0, ${opacity})`;
  const textColor = designerDraft.light ? "#111318" : "#ffffff";
  const onAccentColor = designerDraft.light ? "#ffffff" : "#000000";

  container.style.backgroundColor = bg;
  if (hasScene && designerDraft.scene) {
    container.style.backgroundImage = `url("${designerDraft.scene}")`;
  } else {
    container.style.backgroundImage = "none";
  }

  const scrimStyle = `background: ${scrimColor}; ${blur > 0 ? `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px);` : ""}`;
  const sidebarStyle = `background: ${surface}; color: ${textColor};`;
  const cardStyle = `background: ${surface}; color: ${textColor};`;
  const playBtnStyle = `background: ${accent}; color: ${onAccentColor};`;

  container.innerHTML = `
    <div class="theme-preview-scrim" style="${scrimStyle}"></div>
    <div class="theme-preview-shell">
      <div class="theme-preview-winbar">
        <span class="theme-preview-win-title">Efxlve Launcher</span>
        <div class="theme-preview-win-dots">
          <span class="theme-preview-win-dot"></span>
          <span class="theme-preview-win-dot"></span>
          <span class="theme-preview-win-dot"></span>
        </div>
      </div>

      <div class="theme-preview-body">
        <div class="theme-preview-sidebar" style="${sidebarStyle}">
          <div class="theme-preview-nav-item active" style="background: ${accent}26; color: ${accent}; border-left: 2px solid ${accent};">
            Kütüphane
          </div>
          <div class="theme-preview-nav-item">Mağazalar</div>
          <div class="theme-preview-nav-item">İndirmeler</div>
          <div class="theme-preview-nav-item">Ayarlar</div>
        </div>

        <div class="theme-preview-main">
          <div class="theme-preview-search" style="background: ${surface};">
            Oyunlarda ara...
          </div>

          <div class="theme-preview-cards">
            <div class="theme-preview-card" style="${cardStyle}">
              <div class="theme-preview-card-art" style="background: linear-gradient(135deg, ${accent}44, #12151b);"></div>
              <div class="theme-preview-card-meta">
                <span class="theme-preview-card-name">Cyberpunk</span>
                <span class="theme-preview-play-btn" style="${playBtnStyle}">Oyna</span>
              </div>
            </div>

            <div class="theme-preview-card" style="${cardStyle}">
              <div class="theme-preview-card-art" style="background: linear-gradient(135deg, #2b3a4a, #10141c);"></div>
              <div class="theme-preview-card-meta">
                <span class="theme-preview-card-name">Witcher 3</span>
                <span class="theme-preview-play-btn" style="${playBtnStyle}">Oyna</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/** Attaches input listeners for the theme designer modal. */
function attachDesignerEventListeners(): void {
  const nameInput = document.getElementById("td-name") as HTMLInputElement | null;
  nameInput?.addEventListener("input", (e) => {
    designerDraft.name = (e.target as HTMLInputElement).value;
  });

  const harmonizeCb = document.getElementById("td-harmonize") as HTMLInputElement | null;
  harmonizeCb?.addEventListener("change", (e) => {
    harmonizeSurfaces = (e.target as HTMLInputElement).checked;
  });

  // Background color
  const bgPicker = document.getElementById("td-bg-picker") as HTMLInputElement | null;
  const bgHex = document.getElementById("td-bg-hex") as HTMLInputElement | null;
  bgPicker?.addEventListener("input", (e) => {
    const val = (e.target as HTMLInputElement).value;
    designerDraft.bg = val;
    if (bgHex) bgHex.value = val;
    if (harmonizeSurfaces) autoHarmonizeSurface();
    updateDesignerLivePreview();
  });
  bgHex?.addEventListener("change", (e) => {
    const val = (e.target as HTMLInputElement).value;
    if (HEX_TEST.test(val)) {
      designerDraft.bg = val;
      if (bgPicker) bgPicker.value = val;
      if (harmonizeSurfaces) autoHarmonizeSurface();
      updateDesignerLivePreview();
    }
  });

  // Surface color
  const surfacePicker = document.getElementById("td-surface-picker") as HTMLInputElement | null;
  const surfaceHex = document.getElementById("td-surface-hex") as HTMLInputElement | null;
  surfacePicker?.addEventListener("input", (e) => {
    const val = (e.target as HTMLInputElement).value;
    designerDraft.surface = val;
    if (surfaceHex) surfaceHex.value = val;
    updateDesignerLivePreview();
  });
  surfaceHex?.addEventListener("change", (e) => {
    const val = (e.target as HTMLInputElement).value;
    if (HEX_TEST.test(val)) {
      designerDraft.surface = val;
      if (surfacePicker) surfacePicker.value = val;
      updateDesignerLivePreview();
    }
  });

  // Accent color
  const accentPicker = document.getElementById("td-accent-picker") as HTMLInputElement | null;
  const accentHex = document.getElementById("td-accent-hex") as HTMLInputElement | null;
  accentPicker?.addEventListener("input", (e) => {
    const val = (e.target as HTMLInputElement).value;
    designerDraft.accent = val;
    designerDraft.accentHover = val;
    if (accentHex) accentHex.value = val;
    updateDesignerLivePreview();
  });
  accentHex?.addEventListener("change", (e) => {
    const val = (e.target as HTMLInputElement).value;
    if (HEX_TEST.test(val)) {
      designerDraft.accent = val;
      designerDraft.accentHover = val;
      if (accentPicker) accentPicker.value = val;
      updateDesignerLivePreview();
    }
  });

  // Sliders
  const blurRange = document.getElementById("td-blur-range") as HTMLInputElement | null;
  blurRange?.addEventListener("input", (e) => {
    const val = Number((e.target as HTMLInputElement).value);
    designerDraft.sceneBlur = val;
    const label = document.getElementById("td-blur-val");
    if (label) label.textContent = `${val}px`;
    updateDesignerLivePreview();
  });

  const opacityRange = document.getElementById("td-opacity-range") as HTMLInputElement | null;
  opacityRange?.addEventListener("input", (e) => {
    const val = Number((e.target as HTMLInputElement).value);
    designerDraft.sceneOpacity = val / 100;
    const label = document.getElementById("td-opacity-val");
    if (label) label.textContent = `${val}%`;
    updateDesignerLivePreview();
  });

  // Scene file picker
  const sceneFile = document.getElementById("td-scene-file") as HTMLInputElement | null;
  sceneFile?.addEventListener("change", (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void applyThemeSceneFile(file);
  });
}

function autoHarmonizeSurface(): void {
  const bg = designerDraft.bg;
  if (!HEX_TEST.test(bg)) return;
  const num = Number.parseInt(bg.slice(1), 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;

  let sR: number;
  let sG: number;
  let sB: number;

  if (designerDraft.light) {
    sR = Math.max(0, Math.min(255, Math.round(r * 0.94)));
    sG = Math.max(0, Math.min(255, Math.round(g * 0.94)));
    sB = Math.max(0, Math.min(255, Math.round(b * 0.94)));
  } else {
    sR = Math.max(0, Math.min(255, Math.round(r + (255 - r) * 0.1)));
    sG = Math.max(0, Math.min(255, Math.round(g + (255 - g) * 0.1)));
    sB = Math.max(0, Math.min(255, Math.round(b + (255 - b) * 0.12)));
  }

  const hex = `#${[sR, sG, sB].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  designerDraft.surface = hex;

  const surfacePicker = document.getElementById("td-surface-picker") as HTMLInputElement | null;
  const surfaceHex = document.getElementById("td-surface-hex") as HTMLInputElement | null;
  if (surfacePicker) surfacePicker.value = hex;
  if (surfaceHex) surfaceHex.value = hex;
}

/** Downscales a picked photo to a JPEG data URL small enough for storage. */
function downscaleImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const max = 1920;
      const scale = Math.min(1, max / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      let data = canvas.toDataURL("image/jpeg", 0.82);
      if (data.length > 1_400_000) data = canvas.toDataURL("image/jpeg", 0.65);
      resolve(data.length < 1_900_000 ? data : null);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

async function applyThemeSceneFile(file: File): Promise<void> {
  const data = await downscaleImage(file);
  if (!data) {
    toast(t("settings.themeSceneTooBig"), "err");
    return;
  }
  designerDraft.scene = data;
  renderDesignerModal();
}

/** Saves theme from designer and applies it. */
function saveThemeFromDesigner(): void {
  const name = designerDraft.name.trim() || t("settings.themeNamePlaceholder");
  const id = saveCustomTheme({
    id: designerSourceId ?? undefined,
    name,
    bg: designerDraft.bg,
    surface: designerDraft.surface,
    accent: designerDraft.accent,
    accentHover: designerDraft.accentHover ?? designerDraft.accent,
    light: designerDraft.light,
    scene: designerDraft.scene,
    sceneBlur: designerDraft.sceneBlur,
    sceneOpacity: designerDraft.sceneOpacity,
    radius: designerDraft.radius,
  });

  if (!id) {
    toast(t("settings.themeSceneTooBig"), "err");
    return;
  }

  closeThemeDesigner();
  S.surface = applySurface(id);
  render();
  toast(t("settings.themeSaved", { name }), "ok");
}

/* ==========================================================================
   Theme Importer Modal
   ========================================================================== */

export function openThemeImporter(): void {
  importerOpen = true;
  themeModalRoot.innerHTML = `
    <div class="modal-backdrop theme-import-backdrop" data-act="theme-import-close">
      <div class="modal-box theme-import-dialog" role="dialog" aria-modal="true" data-act="prevent-modal-close">
        <div class="modal-head">
          <div class="modal-head-main">
            <h3 class="modal-title">${esc(t("settings.themeImportTitle"))}</h3>
            <span class="modal-sub">${esc(t("settings.themeImportDesc"))}</span>
          </div>
          <button type="button" class="win-btn win-close" data-act="theme-import-close" title="${esc(t("settings.themeCancel"))}">
            ${icon("x", 14)}
          </button>
        </div>

        <div class="modal-body" style="display:flex;flex-direction:column;gap:12px;padding:16px 20px;">
          <textarea id="theme-import-text" class="theme-import-textarea" placeholder='{\n  "name": "My Cyberpunk",\n  "bg": "#07080a",\n  "accent": "#fcee0a"\n}'></textarea>
          <div style="display:flex;align-items:center;gap:8px;">
            <button type="button" class="btn ghost small" data-act="theme-import-file-pick">
              ${icon("upload", 13)} <span>Dosyadan Yükle (.json)</span>
            </button>
            <input type="file" id="theme-import-file" accept=".json,application/json" hidden />
          </div>
        </div>

        <div class="modal-foot" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 20px;">
          <button type="button" class="btn ghost small" data-act="theme-import-close">
            ${esc(t("settings.themeCancel"))}
          </button>
          <button type="button" class="btn primary small" data-act="theme-import-submit">
            ${icon("download", 13)} ${esc(t("settings.themeImportBtn"))}
          </button>
        </div>
      </div>
    </div>
  `;

  const fileInput = document.getElementById("theme-import-file") as HTMLInputElement | null;
  fileInput?.addEventListener("change", (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || "");
        const textarea = document.getElementById("theme-import-text") as HTMLTextAreaElement | null;
        if (textarea) textarea.value = text;
      };
      reader.readAsText(file);
    }
  });
}

export function closeThemeImporter(): void {
  importerOpen = false;
  themeModalRoot.innerHTML = "";
}

function submitThemeImport(): void {
  const textarea = document.getElementById("theme-import-text") as HTMLTextAreaElement | null;
  const jsonStr = textarea?.value.trim() ?? "";
  if (!jsonStr) return;

  const result = importThemeJson(jsonStr);
  if (!result) {
    toast(t("settings.themeImportInvalid"), "err");
    return;
  }

  closeThemeImporter();
  S.surface = applySurface(result.id);
  render();
  toast(t("settings.themeImportSuccess"), "ok");
}

/* ==========================================================================
   Click & Action Handler
   ========================================================================== */

/**
 * Handles all theme-related actions from the global click router.
 * Returns true if the action was handled here.
 */
export function handleThemeSettingsAction(act: string | undefined, el: HTMLElement): boolean {
  if (!act) return false;

  switch (act) {
    case "theme-filter": {
      const filter = el.dataset.filter as ThemeFilter;
      if (filter && ["all", "dark", "light", "custom"].includes(filter)) {
        currentFilter = filter;
        render();
      }
      return true;
    }

    case "theme-add": {
      openThemeDesigner();
      return true;
    }

    case "theme-edit": {
      const id = el.dataset.themeId;
      if (id) openThemeDesigner(id);
      return true;
    }

    case "theme-clone": {
      const id = el.dataset.themeId;
      if (id) {
        const newId = duplicateTheme(id);
        if (newId) {
          S.surface = applySurface(newId);
          render();
          toast(t("settings.themeSaved", { name: "Kopya Tema" }), "ok");
        }
      }
      return true;
    }

    case "theme-export": {
      const id = el.dataset.themeId;
      if (id) {
        const json = exportThemeJson(id);
        void navigator.clipboard.writeText(json).then(() => {
          toast(t("settings.themeExportCopied"), "ok");
        }).catch(() => {
          toast(t("settings.themeExportCopied"), "ok");
        });
      }
      return true;
    }

    case "theme-delete": {
      const id = el.dataset.themeId;
      if (id) {
        deleteCustomTheme(id);
        if (S.surface === id) {
          S.surface = applySurface("black");
        }
        render();
        toast(t("settings.themeDeleted"), "ok");
      }
      return true;
    }

    case "theme-import-open": {
      openThemeImporter();
      return true;
    }

    case "theme-import-close": {
      closeThemeImporter();
      return true;
    }

    case "theme-import-file-pick": {
      (document.getElementById("theme-import-file") as HTMLInputElement | null)?.click();
      return true;
    }

    case "theme-import-submit": {
      submitThemeImport();
      return true;
    }

    case "td-cancel": {
      closeThemeDesigner();
      return true;
    }

    case "td-save": {
      saveThemeFromDesigner();
      return true;
    }

    case "td-scheme": {
      const scheme = el.dataset.scheme === "light";
      designerDraft.light = scheme;
      if (harmonizeSurfaces) autoHarmonizeSurface();
      renderDesignerModal();
      return true;
    }

    case "td-radius": {
      const radius = el.dataset.radius as "sharp" | "default" | "round";
      designerDraft.radius = radius;
      renderDesignerModal();
      return true;
    }

    case "td-preset": {
      const presetId = el.dataset.presetId;
      const preset = THEME_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        designerDraft.bg = preset.bg;
        designerDraft.surface = preset.surface;
        designerDraft.accent = preset.accent;
        designerDraft.accentHover = preset.accent;
        designerDraft.light = preset.light;
        renderDesignerModal();
      }
      return true;
    }

    case "td-pick-scene": {
      (document.getElementById("td-scene-file") as HTMLInputElement | null)?.click();
      return true;
    }

    case "td-clear-scene": {
      designerDraft.scene = undefined;
      renderDesignerModal();
      return true;
    }

    case "td-live-test": {
      // Temporarily applies the draft as a preview surface to test full-screen
      const tempId = saveCustomTheme({
        ...designerDraft,
        name: "Önizleme",
      });
      if (tempId) {
        applySurface(tempId, false);
        toast(t("settings.themeLiveTest"), "ok");
      }
      return true;
    }

    default:
      return false;
  }
}
