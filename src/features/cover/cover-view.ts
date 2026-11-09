/**
 * Custom cover/hero/logo editor and SteamGridDB asset picker.
 *
 * Lets the user set a custom portrait cover, wide hero image or transparent
 * game-page logo, or pick one from SteamGridDB. State lives in S and is
 * persisted to localStorage.
 */

import { CUSTOM_COVERS_KEY, CUSTOM_HEROES_KEY, CUSTOM_LOGOS_KEY, CUSTOM_LOGO_SIZES_KEY } from "../../core/constants";
import { icon } from "../../core/icons";
import { render, repaintGameHero } from "../../core/render";
import { clearWideArtCache, epicWideArt, rawOf, storeKeysForTitle, summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import type { CustomLogoSize, LogoAnchor } from "../../core/types";

import { esc } from "../../core/utils";
import { localizeMessage, t } from "../../i18n";
import { artDataBudget, shrinkStoredArt, type CoverFileTarget } from "./cover-file";
import { compactCustomArtStorage } from "./cover-storage";

import { epicGetSteamGridCovers, epicSearchSteamGrid, type SteamGridGame, type SteamGridImage } from "../../epic";
import { igdbCovers, igdbImage } from "../../igdb";
import {
  cachedSteamCover,
  cachedSteamHero,
  cachedSteamLogo,
  isFlatSteamArt,
  rememberSteamCover,
  rememberSteamHero,
  rememberSteamLogo,
} from "../../core/steam-art-cache";
import { steamLibraryArt } from "../../steam";
import {
  LOGO_ANCHOR_ORDER,
  getLogoLayout,
  resetLogoLayout,
  setLogoScale,
} from "./logo-layout";

/** Persists one art record; rolls back when the storage quota rejects it. */
function persistArt(key: string, appName: string, url: string, record: Record<string, string>): boolean {
  const next = url.trim();
  const previous = record[appName];
  if (previous === next) return true;
  record[appName] = next;
  try {
    localStorage.setItem(key, JSON.stringify(record));
    return true;
  } catch {
    if (previous === undefined) delete record[appName];
    else record[appName] = previous;
    return false;
  }
}

/** The storage key and in-memory record behind one art target. */
function artStore(target: CoverFileTarget): { key: string; record: Record<string, string> } {
  if (target === "hero") return { key: CUSTOM_HEROES_KEY, record: S.customHeroes };
  if (target === "logo") return { key: CUSTOM_LOGOS_KEY, record: S.customLogos };
  return { key: CUSTOM_COVERS_KEY, record: S.customCovers };
}

function persistArtFor(target: CoverFileTarget, appName: string, url: string): boolean {
  const { key, record } = artStore(target);
  return persistArt(key, appName, url, record);
}

/** Repaints the library and the open game page after one art record changed. */
function afterArtSaved(target: CoverFileTarget, appName: string): void {
  // The portrait cover also feeds the wide art cache; a logo does not.
  if (target !== "logo") clearWideArtCache(appName);
  S.libraryDataRev++;
  render();
  repaintGameHero(appName);
}

/**
 * Saves custom art and, when the quota is already full, first shrinks the
 * legacy full-size images stored by older builds and retries once.
 */
export async function saveCustomArtWithRecovery(
  target: CoverFileTarget,
  appName: string,
  url: string,
): Promise<boolean> {
  // Free legacy space first when the origin is under pressure; the pass is a
  // no-op otherwise. This keeps the first `setItem` from serialising a huge
  // record on the click itself.
  await compactCustomArtStorage();
  if (persistArtFor(target, appName, url)) {
    afterArtSaved(target, appName);
    return true;
  }
  await compactCustomArtStorage(true);
  if (persistArtFor(target, appName, url)) {
    afterArtSaved(target, appName);
    return true;
  }
  if (!url.startsWith("data:image/")) return false;
  // A data URL can still be too large for the space that is left; one more
  // encode at a lower budget is better than sending the user back to pick a
  // different file.
  let candidate = url;
  for (const factor of [0.45, 0.25]) {
    try {
      candidate = await shrinkStoredArt(candidate, target, Math.round(artDataBudget(target) * factor));
    } catch {
      return false;
    }
    if (persistArtFor(target, appName, candidate)) {
      afterArtSaved(target, appName);
      return true;
    }
  }
  return false;
}

export function resetCustomCover(appName: string): void {
  delete S.customCovers[appName];
  localStorage.setItem(CUSTOM_COVERS_KEY, JSON.stringify(S.customCovers));
  clearWideArtCache(appName);
  S.libraryDataRev++;
  render();
  repaintGameHero(appName);
}

export function resetCustomHero(appName: string): void {
  delete S.customHeroes[appName];
  localStorage.setItem(CUSTOM_HEROES_KEY, JSON.stringify(S.customHeroes));
  clearWideArtCache(appName);
  S.libraryDataRev++;
  render();
  repaintGameHero(appName);
}

export function logoSizeOf(appName: string): CustomLogoSize {
  const scale = getLogoLayout(appName).scale;
  if (scale <= 0.82) return "small";
  if (scale >= 1.18) return "large";
  return "medium";
}

export function resetCustomLogo(appName: string): void {
  delete S.customLogos[appName];
  delete S.customLogoSizes[appName];
  S.isAdjustingLogo = false;
  localStorage.setItem(CUSTOM_LOGOS_KEY, JSON.stringify(S.customLogos));
  localStorage.setItem(CUSTOM_LOGO_SIZES_KEY, JSON.stringify(S.customLogoSizes));
  resetLogoLayout(appName);
  S.libraryDataRev++;
  render();
  repaintGameHero(appName);
}

/** Stores the logo size; updates scale and repaints the open game page immediately. */
export function setCustomLogoSize(appName: string, size: CustomLogoSize): void {
  S.customLogoSizes[appName] = size;
  localStorage.setItem(CUSTOM_LOGO_SIZES_KEY, JSON.stringify(S.customLogoSizes));
  const scale = size === "small" ? 0.75 : size === "large" ? 1.3 : 1;
  setLogoScale(appName, scale);
  repaintGameHero(appName);
  renderCustomCoverModalFrame(appName);
}

/* ---------- SteamGridDB state ---------- */

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

/** SteamGridDB asset family that matches the edit target. */
function assetTypeFor(target: "cover" | "hero" | "logo"): "grids" | "heroes" | "logos" {
  if (target === "hero") return "heroes";
  if (target === "logo") return "logos";
  return "grids";
}

export function openCustomCoverModal(appName: string, initialTarget: "cover" | "hero" | "logo" = "cover"): void {
  let coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) {
    coverRoot = document.createElement("div");
    coverRoot.id = "cover-modal-root";
    document.body.appendChild(coverRoot);
  }
  S.activeCustomCoverAppName = appName;
  S.activeCoverTarget = initialTarget;
  const s = summaryOf(appName);
  const title = s?.title || appName;

  S.sgdbSearchQuery = cleanSteamGridSearchTerm(title);
  S.sgdbAssetType = assetTypeFor(S.activeCoverTarget);
  S.sgdbActiveStyle = "";
  S.sgdbSelectedCoverUrl = "";
  S.customCoverActiveTab =
    S.activeCoverTarget === "logo"
      ? S.steamGridApiKey || Boolean(steamAppIdOf(appName))
        ? "steamgrid"
        : "url"
      : S.steamGridApiKey
        ? "steamgrid"
        : S.igdbConfigured
          ? "igdb"
          : "url";
  // A fresh IGDB search per game: the modal is per game.
  S.igdbCoverQuery = "";
  S.igdbCoverHits = [];
  S.igdbCoverLoading = false;
  S.igdbCoverError = "";
  S.sgdbErrorMsg = "";
  S.sgdbCoversList = [];
  S.sgdbGamesList = [];
  S.sgdbSelectedGameId = null;
  S.showModalSgdbInfo = false;

  renderCustomCoverModalFrame(appName);
  renderCustomCoverModalContent(appName);
  void warmOfficialSteamArt(appName);

  if (S.steamGridApiKey && S.sgdbSearchQuery) {
    void searchAndLoadSteamGrid(appName, S.sgdbSearchQuery);
  }
}

function steamAppIdOf(appName: string): string {
  if (appName.startsWith("steam::")) return appName.slice(7);
  if (!S.separateCopies) {
    const title = summaryOf(appName)?.title;
    if (title) {
      const sibling = storeKeysForTitle(title).find((k) => k.startsWith("steam::"));
      if (sibling) return sibling.slice(7);
    }
  }
  return "";
}

function officialSteamUrl(appName: string, target: "cover" | "hero" | "logo"): string {
  const id = steamAppIdOf(appName);
  if (!/^\d+$/.test(id)) return "";
  if (target === "logo") return cachedSteamLogo(id) || "";
  const url = target === "hero" ? cachedSteamHero(id) : cachedSteamCover(id);
  return url || "";
}

/** Steam's own library art, shown ahead of community grids. */
function officialSteamCard(appName: string): SteamGridImage | null {
  if (S.sgdbActiveStyle && S.sgdbActiveStyle !== "official") return null;
  const url = officialSteamUrl(appName, S.activeCoverTarget);
  if (!url) return null;
  return {
    id: 0,
    score: 0,
    style: "official",
    url,
    thumb: url,
    author: { name: "Steam" },
  };
}

function coverGallery(appName: string): SteamGridImage[] {
  const official = officialSteamCard(appName);
  const rest = S.sgdbCoversList.filter((item) => !official || item.url !== official.url);
  return official ? [official, ...rest] : S.sgdbCoversList;
}

/** Auto-pick the Steam-id match, or a name that contains the whole query. */
function pickSteamGridGame(games: SteamGridGame[], term: string): SteamGridGame | null {
  const steamHit = games.find((game) => game.matchedSteam);
  if (steamHit) return steamHit;
  const query = term.trim().toLowerCase();
  if (!query) return null;
  return games.find((game) => game.name.toLowerCase().includes(query)) ?? null;
}

async function warmOfficialSteamArt(appName: string): Promise<void> {
  const id = steamAppIdOf(appName);
  if (!/^\d+$/.test(id)) return;
  const knownHero = cachedSteamHero(id);
  if (
    cachedSteamCover(id) !== undefined &&
    knownHero !== undefined &&
    !isFlatSteamArt(knownHero) &&
    cachedSteamLogo(id) !== undefined
  ) {
    return;
  }
  try {
    const map = await steamLibraryArt([id]);
    const art = map[id];
    rememberSteamCover(id, art?.cover || "");
    rememberSteamHero(id, art?.hero || "");
    rememberSteamLogo(id, art?.logo || "");
  } catch {
    return;
  }
  if (S.activeCustomCoverAppName !== appName) return;
  renderCustomCoverModalFrame(appName);
  renderCustomCoverModalContent(appName);
}

function anchorLabelKey(anchor: Exclude<LogoAnchor, "custom">): string {
  switch (anchor) {
    case "top-left":
      return "cover.anchorTopLeft";
    case "top-center":
      return "cover.anchorTopCenter";
    case "center":
      return "cover.anchorCenter";
    case "bottom-left":
      return "cover.anchorBottomLeft";
    case "bottom-center":
      return "cover.anchorBottomCenter";
    case "bottom-right":
      return "cover.anchorBottomRight";
  }
}

function anchorGlyph(anchor: Exclude<LogoAnchor, "custom">): string {
  switch (anchor) {
    case "top-left":
      return "↖";
    case "top-center":
      return "↑";
    case "center":
      return "•";
    case "bottom-left":
      return "↙";
    case "bottom-center":
      return "↓";
    case "bottom-right":
      return "↘";
  }
}

export function renderCustomCoverModalFrame(appName: string): void {
  const coverRoot = document.getElementById("cover-modal-root");
  if (!coverRoot) return;
  const s = summaryOf(appName);
  const title = s?.title || appName;
  const g = rawOf(appName);
  const devRaw = g ? g.metadata?.developer : undefined;
  const dev = typeof devRaw === "string" ? devRaw : "";

  const hasCustomCover = Boolean(S.customCovers[appName]);
  const hasCustomHero = Boolean(S.customHeroes[appName]);
  const hasCustomLogo = Boolean(S.customLogos[appName]);
  const isCustomForTarget =
    S.activeCoverTarget === "hero" ? hasCustomHero : S.activeCoverTarget === "logo" ? hasCustomLogo : hasCustomCover;

  const currentCoverArt = S.customCovers[appName] || officialSteamUrl(appName, "cover") || s?.cover || "";
  const currentHeroArt = S.customHeroes[appName] || officialSteamUrl(appName, "hero") || (s ? epicWideArt(s) : null) || s?.cover || "";
  const currentLogoArt = S.customLogos[appName] || "";
  const activeCurrentImg =
    S.sgdbSelectedCoverUrl ||
    (S.activeCoverTarget === "hero" ? currentHeroArt : S.activeCoverTarget === "logo" ? currentLogoArt : currentCoverArt);
  const hasAnyCustom = hasCustomCover || hasCustomHero || hasCustomLogo;
  const previewClass = S.activeCoverTarget === "hero" ? "wide" : S.activeCoverTarget === "logo" ? "logo" : "portrait";
  const targetLabel =
    S.activeCoverTarget === "cover" ? t("cover.portraitCard") : S.activeCoverTarget === "hero" ? t("cover.heroCard") : t("cover.logoCard");
  const targetDesc =
    S.activeCoverTarget === "cover" ? t("cover.portraitDesc") : S.activeCoverTarget === "hero" ? t("cover.heroDesc") : t("cover.logoDesc");
  const targetReset =
    S.activeCoverTarget === "cover" ? t("cover.resetPortrait") : S.activeCoverTarget === "hero" ? t("cover.resetHero") : t("cover.resetLogo");
  const targetSave =
    S.activeCoverTarget === "cover" ? t("cover.savePortrait") : S.activeCoverTarget === "hero" ? t("cover.saveHero") : t("cover.saveLogo");
  const logoLayout = getLogoLayout(appName, title);
  const logoScalePct = Math.round(logoLayout.scale * 100);

  coverRoot.innerHTML = `
    <div class="cover-overlay" data-act="cover-modal-backdrop">
      <div class="cover-dialog wide" data-act="prevent-modal-close">
        <div class="cover-dialog-header">
          <div class="cover-dialog-title-group">
            <div class="cover-dialog-icon">${icon("image", 18)}</div>
            <div>
              <h2>${t("cover.title")}</h2>
              <div class="cover-dialog-sub">${esc(title)}${dev ? ` • ${esc(dev)}` : ""}</div>
            </div>
          </div>
          <button class="manage-head-close" data-act="close-custom-cover" title="${t("common.close")}">${icon("x", 16)}</button>
        </div>

        <div class="cover-dialog-body">
          <!-- Edit target segment control -->
          <div class="cover-target-segment">
            <button class="target-segment-pill ${S.activeCoverTarget === "cover" ? "active" : ""}" data-act="set-cover-target" data-target="cover" data-id="${appName}">
              <div class="target-segment-icon">${icon("image", 15)}</div>
              <div class="target-segment-text">
                <span class="target-segment-title">${t("cover.portraitTab")}</span>
                <span class="target-segment-sub">2:3 • Library</span>
              </div>
            </button>
            <button class="target-segment-pill ${S.activeCoverTarget === "hero" ? "active" : ""}" data-act="set-cover-target" data-target="hero" data-id="${appName}">
              <div class="target-segment-icon">${icon("rows", 15)}</div>
              <div class="target-segment-text">
                <span class="target-segment-title">${t("cover.heroTab")}</span>
                <span class="target-segment-sub">16:9 • Banner</span>
              </div>
            </button>
            <button class="target-segment-pill ${S.activeCoverTarget === "logo" ? "active" : ""}" data-act="set-cover-target" data-target="logo" data-id="${appName}">
              <div class="target-segment-icon">${icon("sparkles", 15)}</div>
              <div class="target-segment-text">
                <span class="target-segment-title">${t("cover.logoTab")}</span>
                <span class="target-segment-sub">PNG • Title</span>
              </div>
            </button>
          </div>

          <!-- Inspector card: Live preview & controls -->
          <div class="cover-inspector-card">
            <div class="cover-preview-card ${previewClass}">
              ${activeCurrentImg ? `<img id="cover-preview-img" src="${esc(activeCurrentImg)}" alt="${t("cover.previewAlt")}" />` : `<div id="cover-preview-img" class="cover-preview-empty">${icon("image", 36)}</div>`}
              <div class="cover-preview-badge">${S.sgdbSelectedCoverUrl ? t("cover.selectedPreview") : isCustomForTarget ? t("cover.customImage") : t("cover.original")}</div>
            </div>
            <div class="cover-preview-meta">
              <div class="cover-meta-header">
                <span class="cover-meta-badge ${S.activeCoverTarget}">
                  ${icon(S.activeCoverTarget === "hero" ? "rows" : S.activeCoverTarget === "logo" ? "sparkles" : "image", 12)} ${targetLabel}
                </span>
                ${isCustomForTarget ? `<span class="cover-status-tag custom">${icon("sparkles", 11)} ${t("cover.customInUse")}</span>` : `<span class="cover-status-tag">${icon("check", 11)} ${appName.startsWith("steam::") || appName.startsWith("gog::") ? t("cover.original") : t("cover.originalEpic")}</span>`}
                <div style="flex:1"></div>
                ${isCustomForTarget ? `
                  <button class="btn ghost small danger cover-reset-target-btn" data-act="reset-active-target" data-id="${appName}">
                    ${icon("refresh", 12)} <span>${targetReset}</span>
                  </button>
                ` : ""}
              </div>
              <div class="cover-meta-desc">
                ${targetDesc}
              </div>
              ${
                S.activeCoverTarget === "logo"
                  ? `<div class="cover-logo-layout-panel">
                      <div class="cover-logo-row">
                        <span class="cover-meta-label">${esc(t("cover.logoPosition"))}</span>
                        <div class="cover-logo-anchors" role="group" aria-label="${esc(t("cover.logoPosition"))}">
                          ${LOGO_ANCHOR_ORDER.map(
                            (anchor) =>
                              `<button type="button" class="cover-anchor-btn ${logoLayout.anchor === anchor ? "active" : ""}" data-act="set-logo-anchor" data-anchor="${anchor}" data-logo-anchor-btn data-id="${esc(appName)}" title="${esc(t(anchorLabelKey(anchor)))}">
                                <span class="cover-anchor-glyph">${anchorGlyph(anchor)}</span>
                                <span class="cover-anchor-name">${esc(t(anchorLabelKey(anchor)))}</span>
                              </button>`,
                          ).join("")}
                          ${logoLayout.anchor === "custom" ? `<div class="cover-anchor-custom-pill">${icon("crosshair", 11)} ${esc(t("cover.anchorCustom"))}</div>` : ""}
                        </div>
                      </div>
                      <div class="cover-logo-row">
                        <span class="cover-meta-label">${esc(t("cover.logoScale"))}</span>
                        <div class="cover-logo-scale-wrap">
                          <input
                            id="cover-logo-scale-range"
                            type="range"
                            min="40"
                            max="180"
                            step="5"
                            value="${logoScalePct}"
                            data-act="logo-scale-input"
                            data-id="${esc(appName)}"
                            aria-label="${esc(t("cover.logoScale"))}"
                          />
                          <span id="cover-logo-scale-pct" class="cover-logo-scale-val tabular-nums">${logoScalePct}%</span>
                        </div>
                        <button type="button" class="btn ghost small cover-hero-adjust-btn" data-act="start-logo-hero-adjust" data-id="${esc(appName)}" title="${esc(t("cover.logoAdjustHint"))}">
                          ${icon("crosshair", 12)} <span>${esc(t("cover.logoAdjustOnHero"))}</span>
                        </button>
                      </div>
                    </div>`
                  : `<div class="cover-aspect-spec-hint">
                      ${icon("info", 12)}
                      <span>${S.activeCoverTarget === "hero" ? "16:9 • 1920×1080 px" : "2:3 • 600×900 px"}</span>
                    </div>`
              }
            </div>
          </div>

          <!-- Source tabs -->
          <div class="cover-modal-tabs">
            <button class="cover-tab-btn ${S.customCoverActiveTab === "steamgrid" ? "active" : ""}" data-act="switch-cover-tab" data-tab="steamgrid" data-id="${appName}">
              ${icon("globe", 13)} <span>${t("cover.tabSteamgrid")}</span>
            </button>
            ${
              S.activeCoverTarget === "logo"
                ? ""
                : `<button class="cover-tab-btn ${S.customCoverActiveTab === "igdb" ? "active" : ""}" data-act="switch-cover-tab" data-tab="igdb" data-id="${appName}">
              ${icon("sparkles", 13)} <span>${t("cover.tabIgdb")}</span>
            </button>`
            }
            <button class="cover-tab-btn ${S.customCoverActiveTab === "url" ? "active" : ""}" data-act="switch-cover-tab" data-tab="url" data-id="${appName}">
              ${icon("link", 13)} <span>${t("cover.tabUrl")}</span>
            </button>
            <button class="cover-tab-btn ${(S.customCoverActiveTab as string) === "file" ? "active" : ""}" data-act="switch-cover-tab" data-tab="file" data-id="${appName}">
              ${icon("upload", 13)} <span>${t("cover.tabFile")}</span>
            </button>
          </div>

          <div id="cover-tab-content-area"></div>
        </div>

        <div class="cover-dialog-footer">
          ${hasAnyCustom ? `
            <button class="btn ghost danger" data-act="reset-all-art" data-id="${appName}" title="${t("cover.resetAllTip")}">
              ${icon("refresh", 13)} ${t("cover.resetAll")}
            </button>
          ` : ""}
          <div style="flex:1"></div>
          <button class="btn ghost" data-act="close-custom-cover">${t("move.discard")}</button>
          <button class="btn primary" data-act="save-custom-cover" data-id="${appName}">
            ${icon("check", 14)} ${targetSave}
          </button>
        </div>
      </div>
    </div>
  `;
}

/** The IGDB pane: portrait covers for the cover target, key art for the wide one. */
function igdbCoverPaneHtml(appName: string): string {
  if (!S.igdbConfigured) {
    return `
      <div class="cover-tab-pane">
        <div class="sgdb-setup-box">
          <div class="sgdb-setup-header">
            <div class="sgdb-setup-icon">${icon("sparkles", 20)}</div>
            <div>
              <div class="sgdb-setup-title">${t("cover.igdbSetupTitle")}</div>
              <div class="sgdb-setup-desc">${t("cover.igdbSetupDesc")}</div>
            </div>
          </div>
          <div style="display:flex;justify-content:center;width:100%">
            <button class="btn primary small" data-view="settings" data-settings-section="integrations">
              ${icon("settings", 13)} <span>${t("cover.igdbOpenSettings")}</span>
            </button>
          </div>
        </div>
      </div>`;
  }

  const wide = S.activeCoverTarget === "hero";
  const items: { url: string; thumb: string; label: string }[] = [];
  for (const hit of S.igdbCoverHits) {
    if (wide) {
      for (const art of hit.artworks) {
        items.push({ url: igdbImage(art, "1080p"), thumb: igdbImage(art, "720p"), label: hit.name });
      }
      for (const shot of hit.screenshots) {
        items.push({
          url: igdbImage(shot, "screenshot_huge"),
          thumb: igdbImage(shot, "screenshot_big"),
          label: hit.name,
        });
      }
    } else if (hit.coverId) {
      items.push({
        url: igdbImage(hit.coverId, "cover_big_2x"),
        thumb: igdbImage(hit.coverId, "cover_big"),
        label: `${hit.name}${hit.year ? ` (${hit.year})` : ""}`,
      });
    }
  }

  return `
    <div class="cover-tab-pane">
      <div class="sgdb-container">
        <div class="sgdb-search-bar">
          <input id="igdb-cover-search-input" class="text-input" placeholder="${t("cover.searchPlaceholder")}" value="${esc(S.igdbCoverQuery || S.sgdbSearchQuery)}" spellcheck="false" autocomplete="off" />
          <button class="btn primary small" data-act="igdb-cover-search" data-id="${appName}" ${S.igdbCoverLoading ? "disabled" : ""}>
            ${S.igdbCoverLoading ? icon("refresh", 12) : icon("search", 12)}
            <span>${S.igdbCoverLoading ? t("cover.searching") : t("cover.search")}</span>
          </button>
        </div>
        <div class="sgdb-gallery">
          ${
            S.igdbCoverLoading
              ? `<div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">${icon("refresh", 16)} ${t("cover.scanning")}</div>`
              : S.igdbCoverError
                ? `<div style="padding:24px;text-align:center;color:#f87171;font-size:12px">${esc(S.igdbCoverError)}</div>`
                : items.length === 0
                  ? `<div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">${t("cover.igdbSearchHint")}</div>`
                  : `<div class="${wide ? "sgdb-grid-horizontal" : "sgdb-grid-vertical"}">
                      ${items
                        .map((item) => {
                          const selected = S.sgdbSelectedCoverUrl === item.url;
                          return `
                          <div class="sgdb-card ${selected ? "selected" : ""}" role="button" tabindex="0" data-act="igdb-select-image" data-url="${esc(item.url)}" title="${esc(item.label)}">
                            <img src="${esc(item.thumb)}" loading="lazy" alt="Cover" />
                            <div class="sgdb-card-badges"><span class="sgdb-style-tag">IGDB</span><span></span></div>
                            <div class="sgdb-card-footer">${esc(item.label)}</div>
                            ${selected ? `<div class="sgdb-selected-check">${icon("check", 14)}</div>` : ""}
                          </div>`;
                        })
                        .join("")}
                    </div>`
          }
        </div>
      </div>
    </div>`;
}

/** Runs the modal's IGDB search (the tab switch and the button both call it). */
export function runIgdbCoverSearch(appName: string, query?: string): void {
  const term = (query ?? S.igdbCoverQuery ?? "").trim() || S.sgdbSearchQuery.trim();
  if (!term) return;
  S.igdbCoverQuery = term;
  S.igdbCoverLoading = true;
  S.igdbCoverError = "";
  renderCustomCoverModalContent(appName);
  igdbCovers(term, 6)
    .then((hits) => {
      S.igdbCoverHits = hits;
    })
    .catch((error) => {
      S.igdbCoverHits = [];
      S.igdbCoverError = sgdbErrorText(error);
    })
    .finally(() => {
      S.igdbCoverLoading = false;
      if (S.activeCustomCoverAppName === appName) renderCustomCoverModalContent(appName);
    });
}

export function renderCustomCoverModalContent(appName: string): void {
  const container = document.getElementById("cover-tab-content-area");
  if (!container) return;

  if (S.customCoverActiveTab === "url") {
    const currentVal =
      S.sgdbSelectedCoverUrl ||
      (S.activeCoverTarget === "hero"
        ? S.customHeroes[appName]
        : S.activeCoverTarget === "logo"
          ? S.customLogos[appName]
          : S.customCovers[appName]) ||
      "";
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-url-card">
          <div class="cover-url-card-header">
            <div class="cover-url-card-icon">${icon("link", 18)}</div>
            <div>
              <div class="cover-url-card-title">${t("cover.urlLabel")}</div>
              <div class="cover-url-card-desc">${t("cover.urlHint", { button: `<strong>${t("cover.preview")}</strong>` })}</div>
            </div>
          </div>
          <div class="cover-url-row">
            <input id="custom-cover-url-input" class="text-input" placeholder="${t("cover.urlPlaceholder")}" value="${esc(currentVal)}" spellcheck="false" autocomplete="off" />
            <button class="btn primary small" data-act="preview-custom-cover-url" title="${t("cover.preview")}">
              ${icon("eye", 13)} <span>${t("cover.preview")}</span>
            </button>
          </div>
          <div class="cover-formats-row">
            <span class="cover-formats-label">Supported formats:</span>
            <span class="cover-format-tag">PNG</span>
            <span class="cover-format-tag">JPG / JPEG</span>
            <span class="cover-format-tag">WEBP</span>
            <span class="cover-format-tag">GIF</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (S.customCoverActiveTab === "file") {
    container.innerHTML = `
      <div class="cover-tab-pane">
        <div class="cover-dropzone" id="cover-dropzone" data-act="trigger-file-browse">
          <input id="custom-cover-file-input" type="file" accept="image/*" style="display:none;" />
          <div class="cover-dropzone-icon">${icon("upload", 28)}</div>
          <div class="cover-dropzone-title">${t("cover.fileLabel")}</div>
          <div class="cover-dropzone-desc">${t("cover.fileHint")}</div>
          <label class="btn primary small cover-file-browse-btn" for="custom-cover-file-input">
            ${icon("folder", 14)} <span>${t("cover.fileBtn")}</span>
          </label>
          <div class="cover-formats-row" style="margin-top:6px">
            <span class="cover-format-tag">PNG</span>
            <span class="cover-format-tag">JPG</span>
            <span class="cover-format-tag">WEBP</span>
            <span class="cover-format-tag">Max 15MB</span>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (S.customCoverActiveTab === "igdb") {
    container.innerHTML = igdbCoverPaneHtml(appName);
    return;
  }

  // SteamGridDB tab
  if (!S.steamGridApiKey) {
    const official = officialSteamCard(appName);
    const officialBlock = official
      ? `<div class="sgdb-official-strip" style="margin-bottom:14px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px">${esc(t("cover.steamOfficialLogo"))}</div>
          <div class="${S.activeCoverTarget === "hero" ? "sgdb-grid-horizontal" : S.activeCoverTarget === "logo" ? "sgdb-grid-logo" : "sgdb-grid-vertical"}">
            <div class="sgdb-card ${S.activeCoverTarget === "logo" ? "is-logo" : ""} ${S.sgdbSelectedCoverUrl === official.url ? "selected" : ""}" role="button" tabindex="0" data-act="sgdb-select-card" data-url="${esc(official.url)}" title="Steam">
              <img src="${esc(official.thumb || official.url)}" loading="lazy" alt="Steam" />
              <div class="sgdb-card-badges"><span class="sgdb-style-tag">${esc(t("cover.styleOfficial"))}</span><span></span></div>
              <div class="sgdb-card-footer">Steam</div>
              ${S.sgdbSelectedCoverUrl === official.url ? `<div class="sgdb-selected-check">${icon("check", 14)}</div>` : ""}
            </div>
          </div>
        </div>`
      : "";
    container.innerHTML = `
      <div class="cover-tab-pane">
        ${officialBlock}
        <div class="sgdb-setup-box">
          <div class="sgdb-setup-header">
            <div class="sgdb-setup-icon">${icon("globe", 20)}</div>
            <div>
              <div class="sgdb-setup-title">${t("cover.sgdbSetupTitle")}</div>
              <div class="sgdb-setup-desc">
                ${t("cover.sgdbSetupDesc")}
              </div>
            </div>
          </div>

          <div class="sgdb-info-card">
            <div class="sgdb-info-header">
              <div class="sgdb-info-title">
                ${icon("info", 13)}
                <span>${t("cover.sgdbWhatTitle")}</span>
              </div>
            </div>
            <div class="sgdb-info-content">
              <p style="margin:0;line-height:1.45">
                ${t("cover.sgdbWhatBody")}
              </p>
              <div class="sgdb-info-steps">
                <div class="sgdb-step">
                  <span class="sgdb-step-num">1</span>
                  <span>${t("cover.sgdbStep1")}</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">2</span>
                  <span>${t("cover.sgdbStep2")}</span>
                </div>
                <div class="sgdb-step">
                  <span class="sgdb-step-num">3</span>
                  <span>${t("cover.sgdbStep3")}</span>
                </div>
              </div>
            </div>
          </div>

          <div style="display:flex;justify-content:center;width:100%">
            <button class="btn ghost small sgdb-key-guide-btn" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api">
              ${icon("external", 12)} <span>${t("cover.sgdbGetKey")}</span>
            </button>
          </div>

          <div class="sgdb-setup-input-row">
            <input id="modal-sgdb-key-input" type="${S.showModalSgdbKey ? "text" : "password"}" class="text-input" placeholder="${t("cover.sgdbKeyPlaceholder")}" spellcheck="false" autocomplete="off" />
            <button class="btn ghost small" data-act="toggle-modal-sgdb-key-visibility" title="${t("cover.showHide")}">${icon(S.showModalSgdbKey ? "eye-off" : "eye", 13)}</button>
            <button class="btn primary small" data-act="save-inline-sgdb-key" data-id="${appName}">${t("cover.saveAndSearch")}</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const gallery = coverGallery(appName);
  container.innerHTML = `
    <div class="cover-tab-pane">
      <div class="sgdb-container">
        <div class="sgdb-search-bar">
          <input id="sgdb-search-input" class="text-input" placeholder="${t("cover.searchPlaceholder")}" value="${esc(S.sgdbSearchQuery)}" spellcheck="false" autocomplete="off" />
          <button class="btn primary small" data-act="sgdb-search" data-id="${appName}" ${S.sgdbIsSearching ? "disabled" : ""}>
            ${S.sgdbIsSearching ? icon("refresh", 12) : icon("search", 12)}
            <span>${S.sgdbIsSearching ? t("cover.searching") : t("cover.search")}</span>
          </button>
          <button class="btn ghost small ${S.showModalSgdbInfo ? "active" : ""}" data-act="toggle-sgdb-modal-info" title="${t("cover.sgdbInfoTip")}">
            ${icon("info", 13)}
          </button>
        </div>

        ${S.showModalSgdbInfo ? `
        <div class="sgdb-info-card compact">
          <div class="sgdb-info-header">
            <div class="sgdb-info-title">${icon("info", 13)} <span>${t("cover.sgdbLibTitle")}</span></div>
            <button data-act="toggle-sgdb-modal-info" title="${t("common.close")}">${icon("x", 12)}</button>
          </div>
          <div class="sgdb-info-content">
            <p style="margin:0">${t("cover.sgdbLibBody")}</p>
            <div style="display:flex;align-items:center;gap:12px;margin-top:2px;font-size:11px;color:#94a3b8">
              <span>${t("cover.savedKey")} <code>${esc(S.steamGridApiKey.slice(0, 5))}••••••</code></span>
              <button class="btn ghost small" data-act="open-external-url" data-url="https://www.steamgriddb.com/profile/preferences/api" style="font-size:10.5px;padding:2px 8px">
                ${icon("external", 11)} ${t("cover.manageKey")}
              </button>
            </div>
          </div>
        </div>
        ` : ""}

        ${S.sgdbGamesList.length > 1 ? `
        <div class="sgdb-matching-games-bar">
          <span class="sgdb-matching-label">${icon("gamepad-2", 12)} ${t("cover.gamesLabel")}</span>
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
            <button class="sgdb-chip ${S.sgdbActiveStyle === "" ? "active" : ""}" data-act="sgdb-set-style" data-style="" data-id="${appName}">${t("cover.styleAll")}</button>
            <button class="sgdb-chip ${S.sgdbActiveStyle === "official" ? "active" : ""}" data-act="sgdb-set-style" data-style="official" data-id="${appName}">${t("cover.styleOfficial")}</button>
            ${S.activeCoverTarget !== "logo" ? `<button class="sgdb-chip ${S.sgdbActiveStyle === "no_logo" ? "active" : ""}" data-act="sgdb-set-style" data-style="no_logo" data-id="${appName}">${t("cover.styleNoLogo")}</button>` : ""}
            <button class="sgdb-chip ${S.sgdbActiveStyle === "alternate" ? "active" : ""}" data-act="sgdb-set-style" data-style="alternate" data-id="${appName}">${t("cover.styleAlternate")}</button>
          </div>
        </div>

        <div class="sgdb-gallery">
          ${S.sgdbIsSearching ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px;display:flex;align-items:center;justify-content:center;gap:8px">
              ${icon("refresh", 16)} ${t("cover.scanning")}
            </div>
          ` : S.sgdbErrorMsg ? `
            <div style="padding:24px;text-align:center;color:#f87171;font-size:12px">
              ${esc(S.sgdbErrorMsg)}
            </div>
          ` : gallery.length === 0 ? `
            <div style="padding:40px;text-align:center;color:var(--muted);font-size:12.5px">
              ${t("cover.noResults")}
            </div>
          ` : `
            <div class="${S.sgdbAssetType === "heroes" ? "sgdb-grid-horizontal" : S.sgdbAssetType === "logos" ? "sgdb-grid-logo" : "sgdb-grid-vertical"}">
              ${gallery.map(item => {
                const isSel = S.sgdbSelectedCoverUrl === item.url;
                const thumbUrl = item.thumb || item.url;
                const authorName = item.author?.name || t("cover.community");
                const styleLabel = item.style === "no_logo" ? t("cover.styleNoLogo") : item.style === "alternate" ? t("cover.styleAlternate") : item.style === "official" ? t("cover.styleOfficial") : "";
                const showScore = item.style !== "official" || item.score > 0;
                return `
                <div class="sgdb-card ${S.sgdbAssetType === "logos" ? "is-logo" : ""} ${isSel ? "selected" : ""}" role="button" tabindex="0" data-act="sgdb-select-card" data-url="${esc(item.url)}" title="${showScore ? t("cover.authorScore", { author: esc(authorName), score: item.score }) : esc(authorName)}">
                  <img src="${esc(thumbUrl)}" loading="lazy" alt="Cover" />
                  <div class="sgdb-card-badges">
                    ${styleLabel ? `<span class="sgdb-style-tag">${esc(styleLabel)}</span>` : "<span></span>"}
                    ${showScore ? `<span class="sgdb-score-tag">${icon("chevron-up", 10)} ${item.score}</span>` : ""}
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

function sgdbErrorText(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  return localizeMessage(raw);
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
    const steamId = steamAppIdOf(appName);
    const games = await epicSearchSteamGrid(term, steamId || null);
    S.sgdbGamesList = games;
    const pick = pickSteamGridGame(games, term);
    if (pick) {
      S.sgdbSelectedGameId = pick.id;
      await loadSteamGridCovers(appName, pick.id);
    } else {
      S.sgdbSelectedGameId = null;
      S.sgdbCoversList = [];
      S.sgdbIsSearching = false;
      renderCustomCoverModalContent(appName);
    }
  } catch (err) {
    S.sgdbErrorMsg = sgdbErrorText(err);
    S.sgdbCoversList = [];
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

export async function loadSteamGridCovers(appName: string, gameId: number): Promise<void> {
  if (S.activeCoverTarget === "logo" && S.customCoverActiveTab === "igdb") {
    S.customCoverActiveTab = S.steamGridApiKey ? "steamgrid" : "url";
  }
  S.sgdbIsSearching = true;
  S.sgdbErrorMsg = "";
  renderCustomCoverModalContent(appName);
  try {
    const covers = await epicGetSteamGridCovers(gameId, S.sgdbAssetType, S.sgdbActiveStyle || undefined);
    S.sgdbCoversList = covers;
  } catch (err) {
    S.sgdbErrorMsg = sgdbErrorText(err);
    S.sgdbCoversList = [];
  } finally {
    S.sgdbIsSearching = false;
    renderCustomCoverModalContent(appName);
  }
}

