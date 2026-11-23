/**
 * Exophase tab: the read-only cross-platform mirror of the profile.
 *
 * The launcher profile stays authoritative for Steam/Epic; this tab only reads
 * the public Exophase profile, never feeds its totals back into the local
 * profile and never writes to Exophase. The service explains that Exophase is
 * an independent third-party service in the note at the bottom.
 */

import { emptyState, epicPlatinumIcon, icon, type IconName } from "../../core/icons";
import { canonicalGameTitle, rawOf, storeKeysForTitle } from "../../core/selectors";
import { S } from "../../core/state";
import { steamCdnPortrait } from "../../core/steam-art-cache";
import { esc, fmtDecimal1, fmtPlaytime } from "../../core/utils";
import { epicPortrait } from "../../epic-model";
import { currentLanguage, t } from "../../i18n";
import { igdbCovers, igdbImage } from "../../igdb";
import { storeLogo } from "../store/store-logos";
import { EXOPHASE_SITE, type ExophaseAward, type ExophaseData, type ExophaseGame, type ExophaseSummary } from "../../exophase";

function fmtCount(value: number): string {
  return value.toLocaleString();
}

function fmtExoDate(ts: number): string {
  if (!ts) return "";
  try {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(currentLanguage(), {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

function relativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts * 1000);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("notif.justNow");
  if (mins < 60) return t("notif.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notif.hoursAgo", { n: hours });
  return t("notif.daysAgo", { n: Math.floor(hours / 24) });
}

/** `Nov 18, 2026, 4:35 pm` drops its time so the game name keeps the room. */
function shortEarned(value: string): string {
  return value.replace(/,\s*\d{1,2}:\d{2}(?:\s*(?:am|pm))?\s*$/i, "");
}

function errorText(code: string): string {
  const raw = code.toLowerCase();
  if (raw.includes("not_configured")) return t("profile.exophaseErrNotConfigured");
  if (raw.includes("blocked")) return t("profile.exophaseErrBlocked");
  if (raw.includes("not_found")) return t("profile.exophaseErrNotFound");
  if (raw.includes("network")) return t("profile.exophaseErrNetwork");
  return t("profile.exophaseErrGeneric");
}

/** A numeric player id has no username page; the site home is the honest link. */
function profileUrlFor(username: string): string {
  const trimmed = username.trim();
  return /^\d+$/.test(trimmed)
    ? EXOPHASE_SITE
    : `${EXOPHASE_SITE}user/${encodeURIComponent(trimmed)}/`;
}

function platformLogo(slug: string): string {
  const norm = (slug || "").toLowerCase().trim();
  if (norm === "origin" || norm === "ea" || norm === "electronicarts" || norm === "electronic-arts") return storeLogo("ea", 14, "profile-store-chip-logo");
  if (norm === "steam") return storeLogo("steam", 14, "profile-store-chip-logo");
  if (norm === "epic") return storeLogo("epic", 14, "profile-store-chip-logo");
  if (norm === "xbox" || norm === "xboxnetwork" || norm === "xboxlive") return storeLogo("xbox", 14, "profile-store-chip-logo");
  if (norm === "gog") return storeLogo("gog", 14, "profile-store-chip-logo");
  if (norm === "uplay" || norm === "ubisoft") return storeLogo("ubisoft", 14, "profile-store-chip-logo");
  if (norm === "battlenet" || norm === "blizzard") return storeLogo("battlenet", 14, "profile-store-chip-logo");
  if (norm === "psn" || norm === "playstation") return icon("globe", 14, "profile-store-chip-logo");
  if (norm === "nintendo" || norm === "switch") return icon("gamepad-2", 14, "profile-store-chip-logo");
  return icon("globe", 14, "profile-store-chip-logo");
}

function heroServiceLabel(slug: string, rawLabel: string): string {
  const norm = (slug || "").toLowerCase().trim();
  if (norm === "origin" || norm === "ea") return "EA";
  if (norm === "steam") return "Steam";
  if (norm === "epic") return "Epic Games";
  if (norm === "psn" || norm === "playstation") return "PlayStation";
  if (norm === "xbox") return "Xbox";
  if (norm === "gog") return "GOG";
  if (norm === "ubisoft" || norm === "uplay") return "Ubisoft";
  if (norm === "battlenet" || norm === "blizzard") return "Battle.net";
  if (norm === "nintendo" || norm === "switch") return "Nintendo";
  return rawLabel || slug;
}

function exophaseStoreChip(slug: string): string {
  const norm = (slug || "").toLowerCase().trim();
  let storeId = norm;
  let code = norm.slice(0, 5).toUpperCase();
  if (norm === "steam") {
    storeId = "steam";
    code = "STEAM";
  } else if (norm === "epic") {
    storeId = "epic";
    code = "EPIC";
  } else if (norm === "origin" || norm === "ea" || norm === "electronicarts" || norm === "electronic-arts") {
    storeId = "ea";
    code = "EA";
  } else if (norm === "xbox" || norm === "xboxnetwork" || norm === "xboxlive") {
    storeId = "xbox";
    code = "XBOX";
  } else if (norm === "gog") {
    storeId = "gog";
    code = "GOG";
  } else if (norm === "ubisoft" || norm === "uplay") {
    storeId = "ubisoft";
    code = "UBI";
  } else if (norm === "battlenet" || norm === "blizzard") {
    storeId = "battlenet";
    code = "BNET";
  } else if (norm === "psn" || norm === "playstation") {
    return `<span class="profile-store-chip">${icon("globe", 12)}<span>PSN</span></span>`;
  } else if (norm === "nintendo" || norm === "switch") {
    return `<span class="profile-store-chip">${icon("gamepad-2", 12)}<span>SWTCH</span></span>`;
  }
  return `<span class="profile-store-chip">${storeLogo(storeId, 12)}<span>${code}</span></span>`;
}

interface LocalCoverInfo {
  cover: string;
  isSteam: boolean;
  appId?: string;
  /** The art is wider than the portrait card, so it is contained over a blur. */
  wide: boolean;
}

function coverForApp(appName: string, fallback = ""): string {
  const custom = S.customCovers[appName];
  if (custom) return custom;
  if (appName.startsWith("steam::")) {
    const appId = appName.slice(7);
    if (/^\d+$/.test(appId)) {
      // The known portrait capsule is the safest first URL; the shared art
      // fallback repairs a missing flat capsule with the hashed library cover.
      return steamCdnPortrait(appId);
    }
  }
  const s = S.epicSummariesMap.get(appName);
  const raw = rawOf(appName);
  const gogItem = S.gogSummariesMap.get(appName) || S.allGamesMap.get(appName);
  return (raw ? epicPortrait(raw) : null) || s?.cover || gogItem?.coverUrl || fallback;
}

function findLocalGameKey(title: string): string | null {
  if (!title) return null;
  const keys = storeKeysForTitle(title);
  // The player's own pick wins, then Steam: its capsule is the most reliable
  // portrait art. Epic and GOG fall back when the title has no Steam copy.
  const custom = keys.find((key) => Boolean(S.customCovers[key]));
  if (custom) return custom;
  const steam = keys.find((key) => key.startsWith("steam::"));
  return steam ?? keys[0] ?? null;
}

function findLocalPortraitCover(game: ExophaseGame): LocalCoverInfo {
  const localKey = findLocalGameKey(game.title);
  if (localKey) {
    const isSteam = localKey.startsWith("steam::");
    const appId = isSteam ? localKey.slice(7) : undefined;
    const cov = coverForApp(localKey);
    if (cov) {
      const wide = localCoverWide(localKey, cov);
      if (wide) {
        const igdb = igdbCoverFor(game.title);
        if (igdb) return { cover: igdb, isSteam: false, wide: false };
      }
      return { cover: cov, isSteam, appId, wide };
    }
  }
  const igdb = igdbCoverFor(game.title);
  if (igdb) return { cover: igdb, isSteam: false, wide: false };
  const fallback = game.cover || game.hero || "";
  return { cover: fallback, isSteam: false, wide: Boolean(fallback) };
}

/** Companion clients that serve landscape tiles rather than portrait box art. */
const WIDE_COVER_SOURCES = new Set(["ea", "riot"]);

/** Known landscape URL families; the `Tall` variants stay portrait. */
const WIDE_COVER_URL =
  /(?:header\.jpg|library_hero|capsule_|DieselGameBox(?!Tall)|OfferImage(?!Tall)|DieselStoreFront(?!Tall))/i;

function localCoverWide(localKey: string, cover: string): boolean {
  const source = S.allGamesMap.get(localKey)?.source;
  if (source && WIDE_COVER_SOURCES.has(source)) return true;
  if (source === "epic") {
    // `epicPortrait` falls back to the wide key art when the tall store image
    // is missing; only a real tall image is safe for the portrait card.
    const images = rawOf(localKey)?.metadata?.keyImages;
    const tall =
      Array.isArray(images) &&
      images.some(
        (image) =>
          ["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall"].includes(image?.type) &&
          Boolean(image?.url),
      );
    if (!tall) return true;
  }
  return WIDE_COVER_URL.test(cover);
}

const IGDB_COVER_STORAGE = "efxlve.exophase.igdbCovers";
const IGDB_COVER_MAX = 400;
const igdbCoverCache = new Map<string, string>();
let igdbCacheLoaded = false;

function loadIgdbCoverCache(): void {
  if (igdbCacheLoaded) return;
  igdbCacheLoaded = true;
  try {
    const raw = localStorage.getItem(IGDB_COVER_STORAGE);
    if (!raw) return;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return;
    for (const [key, url] of Object.entries(value)) {
      if (key && typeof url === "string" && url) igdbCoverCache.set(key, url);
    }
  } catch {
    // A broken cache only means the next answer is fetched again.
  }
}

function saveIgdbCoverCache(): void {
  try {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [key, url] of igdbCoverCache) {
      if (count >= IGDB_COVER_MAX) break;
      out[key] = url;
      count += 1;
    }
    localStorage.setItem(IGDB_COVER_STORAGE, JSON.stringify(out));
  } catch {
    // Storage pressure must never break cover rendering.
  }
}

interface IgdbCoverQuery {
  key: string;
  title: string;
}

const igdbCoverQueue: IgdbCoverQuery[] = [];
const igdbCoverQueued = new Set<string>();
let igdbCoverBusy = false;

function igdbCoverFor(title: string): string | null {
  loadIgdbCoverCache();
  const key = canonicalGameTitle(title);
  if (!key) return null;
  const cached = igdbCoverCache.get(key);
  if (cached) return cached;
  queueIgdbCover(title);
  return null;
}

function queueIgdbCover(title: string): void {
  if (!S.igdbConfigured || S.offlineMode) return;
  const key = canonicalGameTitle(title);
  if (!key || igdbCoverCache.has(key) || igdbCoverQueued.has(key)) return;
  igdbCoverQueued.add(key);
  igdbCoverQueue.push({ key, title });
  void pumpIgdbCovers();
}

/** IGDB allows four requests per second; keep a little headroom and stay quiet on failure. */
async function pumpIgdbCovers(): Promise<void> {
  if (igdbCoverBusy) return;
  igdbCoverBusy = true;
  try {
    while (igdbCoverQueue.length > 0) {
      const item = igdbCoverQueue.shift();
      if (!item) break;
      try {
        const hits = await igdbCovers(item.title, 4);
        const hit = hits.find(
          (candidate) => candidate.coverId && canonicalGameTitle(candidate.name) === item.key,
        );
        if (hit?.coverId) {
          const url = igdbImage(hit.coverId, "cover_big_2x");
          igdbCoverCache.set(item.key, url);
          saveIgdbCoverCache();
          applyIgdbCover(item.key, url);
        }
      } catch {
        // The local safe view stays in place when IGDB is unavailable.
      }
      igdbCoverQueued.delete(item.key);
      await new Promise((resolve) => setTimeout(resolve, 320));
    }
  } finally {
    igdbCoverBusy = false;
  }
}

function applyIgdbCover(key: string, url: string): void {
  document.querySelectorAll<HTMLElement>(".profile-exophase-card").forEach((card) => {
    const title = card.dataset.exophaseTitle;
    if (!title || canonicalGameTitle(title) !== key) return;
    const art = card.querySelector<HTMLElement>(".profile-ach-art");
    if (!art) return;
    let img = art.querySelector<HTMLImageElement>("img");
    if (!img) {
      art.querySelector(".profile-ach-ph")?.remove();
      img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      art.prepend(img);
    }
    art.classList.remove("is-wide");
    art.querySelector(".profile-ach-art-fill")?.remove();
    img.removeAttribute("data-steam-app");
    img.removeAttribute("data-art-step");
    img.src = url;
  });
}

/**
 * A portrait card must not crop a landscape cover to a random vertical slice.
 * Wide art is contained over a blurred copy of itself; portrait art keeps the
 * full-bleed look. The natural size is only known after the image loads, which
 * also catches a Steam header that replaced a missing portrait capsule.
 */
function markWideCover(img: HTMLImageElement): void {
  if (!img.naturalWidth || !img.naturalHeight) return;
  const art = img.closest<HTMLElement>(".profile-ach-art");
  if (!art) return;
  if (img.naturalWidth <= img.naturalHeight * 1.08) {
    art.classList.remove("is-wide");
    art.querySelector(".profile-ach-art-fill")?.remove();
    return;
  }
  let fill = art.querySelector<HTMLElement>(".profile-ach-art-fill");
  if (!fill) {
    fill = document.createElement("span");
    fill.className = "profile-ach-art-fill";
    fill.setAttribute("aria-hidden", "true");
    art.prepend(fill);
  }
  const src = img.currentSrc || img.src;
  if (src) fill.style.setProperty("--wide-art", `url(${JSON.stringify(src)})`);
  art.classList.add("is-wide");
  const title = art.closest<HTMLElement>(".profile-exophase-card")?.dataset.exophaseTitle;
  if (title) {
    const igdb = igdbCoverFor(title);
    if (igdb) applyIgdbCover(canonicalGameTitle(title), igdb);
  }
}

let wideCoverListener = false;

function installWideCoverListener(): void {
  if (wideCoverListener) return;
  wideCoverListener = true;
  document.addEventListener(
    "load",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.closest(".profile-exophase-card")) return;
      markWideCover(img);
    },
    true,
  );
  // Cached covers can be complete before the load listener sees them; scan
  // whenever the page gains nodes so a late grid insert is still measured.
  const view = document.getElementById("view");
  if (view) {
    const observer = new MutationObserver(() => scanWideCovers());
    observer.observe(view, { childList: true, subtree: true });
  }
}

/** Cached images do not always fire a fresh load event; scan after a paint. */
function scanWideCovers(): void {
  requestAnimationFrame(() => {
    if (S.view !== "profile" || S.profileTab !== "exophase") return;
    document
      .querySelectorAll<HTMLImageElement>(".profile-exophase-card .profile-ach-art img")
      .forEach((img) => {
        if (img.complete) markWideCover(img);
      });
  });
}

function stat(glyph: string, label: string, value: string, sub = "", platinum = false): string {
  return `<div class="profile-stat${platinum ? " is-plat-stat" : ""}">
    <span class="profile-stat-icon" aria-hidden="true">${glyph}</span>
    <span class="profile-stat-text">
      <span class="profile-stat-label">${esc(label)}</span>
      <span class="profile-stat-val tabular-nums"><span>${esc(value)}</span>${sub ? `<span class="profile-stat-sub">${esc(sub)}</span>` : ""}</span>
    </span>
  </div>`;
}

function note(): string {
  return `<div class="profile-exophase-note">
    ${icon("info", 14)}
    <p>${esc(t("profile.exophaseDisclaimer"))}</p>
  </div>`;
}

function guideGrid(): string {
  const platforms = [
    "Steam",
    "PlayStation",
    "Xbox",
    "Switch",
    "Epic Games",
    "GOG",
    "EA App",
    "Ubisoft",
    "RetroAchievements",
  ];

  const items = platforms
    .map((name) => `<li>${icon("check-circle", 12)}<span>${name}</span></li>`)
    .join("");

  return `<div class="profile-exophase-guide-grid">
    <div class="profile-exophase-guide-card">
      <div class="profile-exophase-guide-card-header">
        <span class="profile-exophase-guide-icon" aria-hidden="true">${icon("gamepad-2", 16)}</span>
        <h3 class="profile-exophase-guide-title">${esc(t("profile.exophaseGuidePlatformsTitle"))}</h3>
      </div>
      <p class="profile-exophase-guide-desc">${esc(t("profile.exophaseGuidePlatformsDesc"))}</p>
      <ul class="profile-exophase-guide-list is-inline">${items}</ul>
    </div>
    <div class="profile-exophase-guide-card">
      <div class="profile-exophase-guide-card-header">
        <span class="profile-exophase-guide-icon" aria-hidden="true">${icon("lock", 16)}</span>
        <h3 class="profile-exophase-guide-title">${esc(t("profile.exophaseGuideSafeTitle"))}</h3>
      </div>
      <p class="profile-exophase-guide-desc">${esc(t("profile.exophaseGuideSafeDesc"))}</p>
      <ul class="profile-exophase-guide-list">
        <li>${icon("check-circle", 12)}<span>${esc(t("profile.exophaseGuideSafeItem1"))}</span></li>
        <li>${icon("check-circle", 12)}<span>${esc(t("profile.exophaseGuideSafeItem2"))}</span></li>
      </ul>
    </div>
    <div class="profile-exophase-guide-card">
      <div class="profile-exophase-guide-card-header">
        <span class="profile-exophase-guide-icon" aria-hidden="true">${icon("trophy", 16)}</span>
        <h3 class="profile-exophase-guide-title">${esc(t("profile.exophaseGuideShowcaseTitle"))}</h3>
      </div>
      <p class="profile-exophase-guide-desc">${esc(t("profile.exophaseGuideShowcaseDesc"))}</p>
      <ul class="profile-exophase-guide-list">
        <li>${icon("check-circle", 12)}<span>${esc(t("profile.exophaseGuideShowcaseItem1"))}</span></li>
        <li>${icon("check-circle", 12)}<span>${esc(t("profile.exophaseGuideShowcaseItem2"))}</span></li>
      </ul>
    </div>
  </div>`;
}

/** The unconfigured state: a compact hero, the connect row with quick input, what you get and the note. */
function connectView(): string {
  return `
    <section class="card profile-hero profile-exophase-hero">
      <div class="profile-exophase-hero-stage is-plain">
        <div class="profile-hero-bottom">
          <div class="profile-avatar-wrap">
            <span class="profile-avatar profile-avatar-lg profile-exophase-avatar" aria-hidden="true">${icon("globe", 32)}</span>
          </div>
          <div class="profile-hero-identity">
            <div class="profile-hero-title-group">
              <div class="profile-name-row">
                <h1 class="profile-name">Exophase</h1>
                <span class="profile-exophase-pill"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t("accounts.notConnected"))}</span>
              </div>
              <p class="profile-exophase-sub">${esc(t("profile.exophaseSubtitle"))}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="profile-exophase-hero-body">
        <div class="profile-exophase-connect-copy">
          <h2 class="profile-exophase-connect-title">${esc(t("profile.exophaseConnectTitle"))}</h2>
          <p class="profile-exophase-connect-desc">${esc(t("profile.exophaseConnectDesc"))}</p>
        </div>
        <div class="profile-exophase-connect-form">
          <div class="profile-exophase-connect-input-row">
            <input
              id="profile-exophase-quick-input"
              class="input profile-exophase-quick-input"
              type="text"
              placeholder="${esc(t("settings.exophasePlaceholder"))}"
              value="${esc(S.exophaseUsername)}"
              spellcheck="false"
              autocomplete="off"
            />
            <button type="button" class="btn primary" data-act="profile-exophase-connect">${icon("link", 13)}<span>${esc(t("profile.exophaseConnectBtn"))}</span></button>
            <button type="button" class="btn ghost small" data-view="settings" data-settings-section="integrations" data-settings-detail="exophase" title="${esc(t("profile.exophaseConnectCta"))}">${icon("settings", 12)}<span>${esc(t("profile.exophaseConnectCta"))}</span></button>
            <button type="button" class="btn ghost small" data-act="open-external-url" data-url="https://www.exophase.com/" title="Exophase.com">${icon("external", 12)}<span>exophase.com</span></button>
          </div>
          <div class="profile-exophase-input-hint">${icon("check-circle", 12)}<span>${esc(t("profile.exophaseConnectHelp"))}</span></div>
        </div>
        <div class="profile-exophase-enable-row">
          <div class="profile-exophase-enable-copy">
            <span class="profile-exophase-enable-label">${esc(t("profile.exophaseShowTab"))}</span>
            <p class="profile-exophase-enable-desc">${esc(t("profile.exophaseShowTabDesc"))}</p>
          </div>
          <label class="switch">
            <input type="checkbox" data-act="exophase-enabled" aria-label="${esc(t("profile.exophaseShowTab"))}" ${S.exophaseEnabled ? "checked" : ""} />
            <span class="track"></span>
          </label>
        </div>
      </div>
    </section>
    ${guideGrid()}
    ${note()}`;
}

function profileHero(
  name: string,
  username: string,
  avatar: string,
  hero: string,
  stats: string,
  loading: boolean,
  profileUrl: string,
  connected: boolean,
  summary?: ExophaseSummary,
  selectedService = "all",
): string {
  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" loading="lazy" decoding="async" />`
    : icon("globe", 32);
  const handle = username ? `@${username}` : "Exophase";
  const art = hero
    ? `<div class="profile-exophase-hero-backdrop" style="background-image:url('${esc(hero)}')" aria-hidden="true"></div>
       <div class="profile-exophase-hero-art" style="background-image:url('${esc(hero)}')" aria-hidden="true"></div>
       <div class="profile-exophase-hero-scrim" aria-hidden="true"></div>`
    : "";

  const storesHtml = summary?.services?.filter((s) => s.games > 0)
    ? `<div class="profile-hero-stores">
        <button type="button" class="profile-hero-store-chip${selectedService === "all" ? " selected" : ""}" data-act="exophase-service" data-val="all" title="${esc(t("profile.filterAll"))}" aria-pressed="${selectedService === "all"}">
          ${icon("layers", 13, "profile-store-chip-logo")}
          <span class="profile-hero-chip-name">${esc(t("profile.filterAll"))}</span>
          <span class="profile-hero-chip-count tabular-nums">${fmtCount(summary.totalGames)}</span>
        </button>
        ${summary.services
          .filter((s) => s.games > 0)
          .map(
            (s) => `
            <button type="button" class="profile-hero-store-chip${selectedService === s.slug ? " selected" : ""}" data-act="exophase-service" data-val="${esc(s.slug)}" title="${esc(heroServiceLabel(s.slug, s.label))}" aria-pressed="${selectedService === s.slug}">
              ${platformLogo(s.slug)}
              <span class="profile-hero-chip-name">${esc(heroServiceLabel(s.slug, s.label))}</span>
              <span class="profile-hero-chip-count tabular-nums">${fmtCount(s.games)}</span>
            </button>`,
          )
          .join("")}
       </div>`
    : "";

  return `<section class="card profile-hero profile-exophase-hero">
    <div class="profile-exophase-hero-stage${hero ? " has-art" : " is-plain"}">
      ${art}
      <div class="profile-hero-top-bar">
        <div class="profile-hero-actions">
          ${profileUrl ? `<button type="button" class="btn small profile-hero-tool" data-act="copy-exophase-url" data-url="${esc(profileUrl)}" title="${esc(t("profile.exophaseCopyTip"))}" aria-label="${esc(t("profile.exophaseCopy"))}">${icon("copy", 12)}<span>${esc(t("profile.exophaseCopy"))}</span></button>` : ""}
          <button type="button" class="btn small profile-hero-tool profile-exophase-refresh${loading ? " is-busy" : ""}" data-act="exophase-refresh" title="${esc(t("profile.exophaseRefresh"))}" aria-label="${esc(t("profile.exophaseRefresh"))}">${icon("refresh", 13)}<span>${esc(t("overlay.refresh"))}</span></button>
          <button type="button" class="btn small profile-hero-tool" data-act="open-external-url" data-url="${esc(profileUrl)}">${icon("external", 12)}<span>Exophase</span></button>
        </div>
      </div>
      <div class="profile-hero-bottom">
        <div class="profile-avatar-wrap">
          <span class="profile-avatar profile-avatar-lg profile-exophase-avatar" aria-hidden="true">${avatarHtml}</span>
        </div>
        <div class="profile-hero-identity">
          <div class="profile-hero-title-group">
            <div class="profile-name-row">
              <h1 class="profile-name">${esc(name)}</h1>
              <span class="profile-exophase-pill${connected ? " is-connected" : ""}"><span class="profile-exophase-dot" aria-hidden="true"></span>${esc(t(connected ? "settings.connected" : "accounts.notConnected"))}</span>
            </div>
            <p class="profile-exophase-sub">${esc(handle)}</p>
          </div>
          ${storesHtml ? `<div class="profile-scope-bar">${storesHtml}</div>` : ""}
        </div>
      </div>
    </div>
    ${stats ? `<div class="profile-stats profile-exophase-stats">${stats}</div>` : ""}
  </section>`;
}

function infoCard(summary: ExophaseSummary): string {
  const syncDate = summary.lastSync ? fmtExoDate(summary.lastSync) : "";
  const sync = syncDate ? `${t("profile.exophaseSync")}: ${syncDate}` : "";
  const updated = summary.fetchedAt
    ? t("profile.exophaseUpdated", { when: relativeTime(summary.fetchedAt) })
    : "";
  return `<div class="profile-exophase-info-card">
    <div class="profile-exophase-info-meta">
      <div class="profile-exophase-meta-left">
        ${sync ? `<span class="profile-exophase-meta-item">${icon("calendar", 13)}<span>${esc(sync)}</span></span>` : ""}
        <span class="profile-exophase-hint">(${esc(t("profile.exophaseSyncHint"))})</span>
      </div>
      <div class="profile-exophase-meta-right">
        ${updated ? `<span class="profile-exophase-meta-item">${icon("clock", 13)}<span class="profile-exophase-updated">${esc(updated)}</span></span>` : ""}
      </div>
    </div>
    <div class="profile-exophase-info-disclaimer">
      ${icon("info", 14)}
      <p>${esc(t("profile.exophaseDisclaimer"))}</p>
    </div>
  </div>`;
}

function gameCard(game: ExophaseGame): string {
  const percent = Math.round(game.percent);
  const total = game.totalAwards;
  const earned = game.earnedAwards;
  const count = total > 0 ? `${earned} / ${total}` : `${earned}`;
  const playtime = game.playtimeMinutes > 0 ? fmtPlaytime(game.playtimeMinutes * 60) : "";
  const isComplete = percent >= 100 || (total > 0 && earned >= total);
  const tip = `${game.title} · ${game.platform} · ${percent}%${playtime ? ` · ${playtime}` : ""}`;
  const action = game.url
    ? ` data-act="open-external-url" data-url="${esc(game.url)}"`
    : "";

  const { cover, isSteam, appId, wide } = findLocalPortraitCover(game);
  const steamAttrs = isSteam && appId && /^\d+$/.test(appId)
    ? ` data-steam-app="${appId}" data-art-step="0"`
    : "";
  const artStyle = wide && cover ? ` style="--wide-art:url('${esc(cover)}')"` : "";

  return `
    <div class="profile-ach-card profile-exophase-card${isComplete ? " is-plat" : ""}" role="button" tabindex="0" data-exophase-title="${esc(game.title)}"${action} title="${esc(tip)}">
      <div class="profile-ach-art${wide ? " is-wide" : ""}"${artStyle}>
        ${wide && cover ? `<span class="profile-ach-art-fill" aria-hidden="true"></span>` : ""}
        ${cover
          ? `<img${steamAttrs} src="${esc(cover)}" alt="" loading="lazy" decoding="async" />`
          : `<span class="profile-ach-ph">${icon("gamepad-2", 24)}</span>`
        }
        ${isComplete
          ? `<span class="profile-ach-badge plat" title="${t("profile.filterPlatinum")}">${epicPlatinumIcon(13)}<span>100%</span></span>`
          : total > 0 && percent > 0
            ? `<span class="profile-ach-badge pct tabular-nums">${percent}%</span>`
            : ""
        }
        <span class="profile-ach-badge store">${exophaseStoreChip(game.platformSlug)}</span>
      </div>
      ${total > 0
        ? `<div class="profile-ach-bar${isComplete ? " is-plat-bar" : ""}"><span style="width:${Math.min(100, Math.max(0, percent))}%"></span></div>`
        : `<div class="profile-ach-bar is-empty"></div>`
      }
      <div class="profile-ach-info">
        <div class="profile-ach-title-line">
          <span class="profile-ach-title">${esc(game.title)}</span>
        </div>
        <div class="profile-ach-meta-row tabular-nums">
          <span class="profile-ach-count">${icon("trophy", 11)}<span>${esc(count)}</span></span>
          ${playtime ? `<span class="profile-ach-sub-right">${esc(playtime)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

export function getExophaseGamesGridHtml(data: ExophaseData, selected: string): { count: string; html: string } {
  installWideCoverListener();
  const q = (S.exophaseSearchQuery || "").trim().toLowerCase();
  const sort = S.exophaseSort || "recent";

  let list = selected === "all" ? data.games : data.games.filter((game) => game.platformSlug === selected);

  if (q) {
    list = list.filter((g) => g.title.toLowerCase().includes(q) || g.platform.toLowerCase().includes(q));
  }

  const sorted = [...list].sort((a, b) => {
    if (sort === "progress") {
      return b.percent !== a.percent ? b.percent - a.percent : b.lastPlayed - a.lastPlayed;
    }
    if (sort === "trophies") {
      return b.earnedAwards !== a.earnedAwards ? b.earnedAwards - a.earnedAwards : b.percent - a.percent;
    }
    if (sort === "playtime") {
      return b.playtimeMinutes !== a.playtimeMinutes ? b.playtimeMinutes - a.playtimeMinutes : b.lastPlayed - a.lastPlayed;
    }
    if (sort === "alpha") {
      return S.trCollator.compare(a.title, b.title);
    }
    // "recent" (default)
    return b.lastPlayed - a.lastPlayed;
  });

  const shown = sorted.slice(0, S.exophaseGameCount || 60);
  const more = sorted.length > shown.length
    ? `<div class="row profile-more"><button type="button" class="btn ghost small" data-act="exophase-show-more">${t("profile.showMore")} (${fmtCount(sorted.length - shown.length)})</button></div>`
    : "";
  const body = shown.length > 0
    ? `<div class="profile-ach-list profile-exophase-grid">${shown.map(gameCard).join("")}${more}</div>`
    : emptyState("gamepad-2", t("profile.exophaseEmptyFilter"));

  scanWideCovers();
  return {
    count: fmtCount(sorted.length),
    html: body,
  };
}

export function patchExophaseGamesGrid(): void {
  if (!S.exophaseData) return;
  const summary = S.exophaseData.summary;
  const serviceAvailable = summary.services.some((service) => service.slug === S.exophaseService);
  const selected = serviceAvailable ? S.exophaseService : "all";
  const { count, html } = getExophaseGamesGridHtml(S.exophaseData, selected);
  const countEl = document.getElementById("exophase-games-count");
  if (countEl) countEl.textContent = count;
  const wrap = document.getElementById("exophase-games-grid-wrap");
  if (wrap) {
    wrap.innerHTML = html;
    // Search/sort/show-more patches are not page entries; the section-in
    // animation would restart on every keystroke and read as a flicker.
    wrap.querySelector<HTMLElement>(".profile-ach-list")?.style.setProperty("animation", "none");
  }
}

function gamesSection(data: ExophaseData, selected: string): string {
  const sort = S.exophaseSort || "recent";
  const { count, html } = getExophaseGamesGridHtml(data, selected);

  return `<section class="profile-row profile-exophase-games">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.games"))}</h3>
        <span id="exophase-games-count" class="profile-row-count tabular-nums">${count}</span>
      </div>
      <div class="profile-exophase-controls">
        <label class="search gp-search profile-exophase-search">
          ${icon("search", 14)}
          <input type="text" id="exophase-search" placeholder="${esc(t("profile.bannerSearchPlaceholder"))}" aria-label="${esc(t("profile.bannerSearchPlaceholder"))}" value="${esc(S.exophaseSearchQuery || "")}" spellcheck="false" autocomplete="off" />
          <button type="button" id="exophase-search-clear-btn" class="profile-search-clear-btn" data-act="exophase-search-clear" title="${esc(t("lib.clearSearch"))}" aria-label="${esc(t("lib.clearSearch"))}"${S.exophaseSearchQuery ? "" : " hidden"}>${icon("x", 12)}</button>
        </label>
        <div class="profile-sort-wrap">
          <select id="exophase-sort-select" class="profile-sort-select" aria-label="${esc(t("ach.sortTitle"))}">
            <option value="recent"${sort === "recent" ? " selected" : ""}>${esc(t("lib.sortRecent"))}</option>
            <option value="progress"${sort === "progress" ? " selected" : ""}>${esc(t("profile.sortProgress"))}</option>
            <option value="trophies"${sort === "trophies" ? " selected" : ""}>${esc(t("profile.trophies"))}</option>
            <option value="playtime"${sort === "playtime" ? " selected" : ""}>${esc(t("profile.sortPlaytime"))}</option>
            <option value="alpha"${sort === "alpha" ? " selected" : ""}>${esc(t("profile.sortAlpha"))}</option>
          </select>
        </div>
      </div>
    </div>
    <div id="exophase-games-grid-wrap">
      ${html}
    </div>
  </section>`;
}

function awardCard(award: ExophaseAward): string {
  const isRare = award.rarity != null && award.rarity < 5;
  const rarityText = award.rarity != null
    ? (currentLanguage() === "tr" ? `%${fmtDecimal1(award.rarity)}` : `${fmtDecimal1(award.rarity)}%`)
    : "";
  const action = award.url
    ? ` data-act="open-external-url" data-url="${esc(award.url)}"`
    : "";
  const art = award.icon
    ? `<img class="profile-unlock-art" src="${esc(award.icon)}" alt="" loading="lazy" decoding="async" />`
    : `<span class="profile-unlock-placeholder">${icon("trophy", 18)}</span>`;
  const rarityBadge = rarityText
    ? `<span class="profile-unlock-badge${isRare ? " is-rare" : ""} tabular-nums">${isRare ? icon("trophy", 10) : ""}<span>${rarityText}</span></span>`
    : "";
  const tip = [award.name, award.game, award.earned, rarityText, award.description]
    .filter(Boolean)
    .join(" · ");
  const earned = shortEarned(award.earned);

  return `<button type="button" class="profile-unlock-card${isRare ? " is-rare-card" : ""}"${action} title="${esc(tip)}">
    <div class="profile-unlock-art-wrap">${art}</div>
    <div class="profile-unlock-main">
      <div class="profile-unlock-top">
        <span class="profile-unlock-title">${esc(award.name)}</span>
      </div>
      <div class="profile-unlock-sub">
        <span class="profile-unlock-game">${esc(award.game)}</span>
        ${earned ? `<span class="profile-unlock-dot" aria-hidden="true">·</span><span class="profile-unlock-date tabular-nums">${esc(earned)}</span>` : ""}
      </div>
    </div>
    ${rarityBadge}
  </button>`;
}

function awardsSection(data: ExophaseData): string {
  if (data.awards.length === 0) return "";
  return `<section class="profile-row profile-exophase-awards">
    <div class="profile-row-head">
      <div class="profile-row-title-group">
        <h3 class="profile-row-title">${esc(t("profile.unlocksTitle"))}</h3>
        <span class="profile-row-count tabular-nums">${data.awards.length}</span>
      </div>
    </div>
    <div class="profile-unlock-row">${data.awards.map(awardCard).join("")}</div>
  </section>`;
}

function loadedView(data: ExophaseData): string {
  const summary = data.summary;
  const platRatio = summary.totalGames > 0
    ? `${Math.round((summary.completedGames / summary.totalGames) * 100)}% (${summary.completedGames}/${summary.totalGames})`
    : "";
  const stats = [
    stat(icon("gamepad-2", 21), t("profile.games"), fmtCount(summary.totalGames)),
    stat(icon("trophy", 21), t("profile.trophies"), fmtCount(summary.totalAwards)),
    stat(icon("clock", 21), t("profile.played"), summary.playtimeMinutes > 0 ? fmtPlaytime(summary.playtimeMinutes * 60) : "—"),
    stat(epicPlatinumIcon(22), t("profile.statCompleted"), fmtCount(summary.completedGames), platRatio, true),
    ...(summary.rank > 0 ? [stat(icon("globe", 21), t("profile.exophaseRank"), `#${fmtCount(summary.rank)}`)] : []),
  ].join("");

  const serviceAvailable = summary.services.some((service) => service.slug === S.exophaseService);
  const selected = serviceAvailable ? S.exophaseService : "all";
  const lead = [...data.games].sort((left, right) => right.lastPlayed - left.lastPlayed)[0];
  const heroArt = lead?.hero || lead?.cover || "";

  return `
    ${profileHero(summary.displayName || summary.username, summary.username, summary.avatar, heroArt, stats, S.exophaseLoading, summary.profileUrl, true, summary, selected)}
    ${infoCard(summary)}
    ${awardsSection(data)}
    ${gamesSection(data, selected)}`;
}

function loadingView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", "", true, profileUrlFor(S.exophaseUsername), true)}
    <div class="profile-exophase-loading"><span class="spinner"></span><p>${esc(t("profile.exophaseLoading"))}</p></div>`;
}

function errorView(): string {
  return `${profileHero(S.exophaseUsername, S.exophaseUsername, "", "", "", false, profileUrlFor(S.exophaseUsername), false)}
    ${emptyState(
      "info",
      t("profile.errorTitle"),
      errorText(S.exophaseError),
      `<button type="button" class="btn primary" data-act="exophase-refresh">${esc(t("profile.retry"))}</button>
       <button type="button" class="btn ghost small" data-view="settings">${esc(t("profile.exophaseConnectCta"))}</button>`,
    )}
    ${note()}`;
}

export function renderExophaseTab(): string {
  if (!S.exophaseConfigured) return connectView();
  if (!S.exophaseData) {
    if (S.exophaseLoading) return loadingView();
    if (S.exophaseError) return errorView();
    return loadingView();
  }
  return loadedView(S.exophaseData);
}
