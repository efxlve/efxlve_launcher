/**
 * Overlay Achievements view: the full list, filters, detail page, community
 * guides and the pinned tracker HUD.
 *
 * One-way dependency: the page configures context/widget queries through
 * configureAchievements; this module never imports overlay.ts.
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { applyAchievementEdits } from "../../core/achievement-edits";
import {
  achievementGuideLinks,
  achievementProgress,
  achievementRarity,
  achievementStats,
  achievementTier,
  isAchievementUnlocked,
  isSafeExternalUrl,
  rarityMultiplier,
} from "../../core/achievements";
import { icon, type IconName } from "../../core/icons";
import { toast } from "../../core/toast";
import { esc, fmtAchDate, fmtDecimal1, stripEmoji } from "../../core/utils";
import { currentLanguage, t } from "../../i18n";
import {
  steamGetAchievementCommunity,
  type SteamAchievementCommunity,
} from "../../steam";

export interface AchievementItem {
  name: string;
  display_name?: string;
  description?: string;
  xp?: number;
  unlocked?: boolean;
  progress?: number;
  unlock_date?: string | null;
  hidden?: boolean;
  icon_link?: string;
  is_base?: boolean;
  set_name?: string;
  dlc_app_id?: number | null;
  tier?: { name?: string } | null;
  rarity?: { percent?: number | null } | null;
  /** Launcher-only state edit folded in by `applyAchievementEdits`. */
  user_state?: "unlocked" | "locked";
}

export interface AchievementsData {
  achievements: AchievementItem[];
  user_unlocked: number;
  total_achievements: number;
  user_xp?: number;
  total_xp?: number;
  is_platinum?: boolean;
}

export type AchievementFilter = "all" | "unlocked" | "locked" | "hidden" | "near";

export interface AchievementsContext {
  appName: string;
  title: string;
}

interface AchievementsDeps {
  context: () => AchievementsContext;
  ghostMode: () => boolean;
  isWidgetOpen: (tab: "ach") => boolean;
  isWidgetPinned: (tab: "ach") => boolean;
  viewEl: (tab: "ach") => HTMLElement | null;
  openWidget: (tab: "ach", render?: boolean) => void;
  renderHome: () => void;
  splitKey: (key: string) => { store: string; id: string };
}

let deps: AchievementsDeps | null = null;

export function configureAchievements(next: AchievementsDeps): void {
  deps = next;
}

function D(): AchievementsDeps {
  if (!deps) throw new Error("overlay achievements rendered before configuration");
  return deps;
}

let cachedAchievements: AchievementsData | null = null;
let achLoading = false;
let achLoadGeneration = 0;
let achDetail: string | null = null;
let achFilter: AchievementFilter = "all";
let achRevealed = new Set<string>();
let achCommunity = new Map<string, SteamAchievementCommunity>();
let achCommunityLoading = new Set<string>();

/* 3. Full Achievements View */
function achDisplayName(item: AchievementItem): string {
  return item.display_name || item.name;
}

export function achMasked(item: AchievementItem): boolean {
  return Boolean(item.hidden) && !isAchievementUnlocked(item) && !achRevealed.has(item.name);
}

function achCommunityKey(name: string): string {
  return `${D().context().appName}:${name}`;
}

function achGuideLinksFor(item: AchievementItem) {
  const { store, id } = D().splitKey(D().context().appName);
  return achievementGuideLinks({
    title: D().context().title,
    achievement: achDisplayName(item),
    store,
    steamAppId: store === "steam" ? id : null,
  });
}

export function openAchUrl(url: string | undefined): void {
  if (!url || !isSafeExternalUrl(url)) return;
  void invoke("overlay_browser_open", { url }).catch(() => {
    void openUrl(url).catch(() => undefined);
  });
}

function ensureAchCommunity(name: string): void {
  const { store, id } = D().splitKey(D().context().appName);
  if (store !== "steam") return;
  const item = cachedAchievements?.achievements.find((entry) => entry.name === name);
  if (!item || achMasked(item)) return;
  const key = achCommunityKey(name);
  if (achCommunity.has(key) || achCommunityLoading.has(key)) return;
  achCommunityLoading.add(key);
  void steamGetAchievementCommunity(id, achDisplayName(item))
    .then((response) => {
      achCommunity.set(key, response);
    })
    .catch(() => {
      achCommunity.set(key, { guides: [], threads: [], supported: false });
    })
    .finally(() => {
      achCommunityLoading.delete(key);
      if (achDetail === name) renderAchView();
    });
}

export function openAchDetail(name: string): void {
  achDetail = name;
  if (!D().isWidgetOpen("ach")) D().openWidget("ach", false);
  renderAchView();
  ensureAchCommunity(name);
}

function renderAchCommunity(name: string): string {
  const key = achCommunityKey(name);
  const loading = achCommunityLoading.has(key);
  const community = achCommunity.get(key);
  if (loading) {
    return `<div class="ov-ach-community-loading"><span class="skel skel-line"></span><span class="skel skel-line short"></span></div>`;
  }
  if (!community || !community.supported) return "";

  const guideRows = community.guides
    .map(
      (guide) => `<button type="button" class="ov-ach-community-row" data-ov="ach-guide" data-url="${esc(guide.url)}">
        <span class="ov-ach-community-main">
          <span class="ov-ach-community-title">${esc(stripEmoji(guide.title) || "—")}</span>
          <span class="ov-ach-community-meta">${esc(stripEmoji(guide.author || ""))}${guide.rating != null ? ` · ${icon("star", 9)} ${guide.rating}/5` : ""}</span>
        </span>
        ${icon("external", 11)}
      </button>`,
    )
    .slice(0, 2)
    .join("");
  const threadRows = community.threads
    .map(
      (thread) => `<button type="button" class="ov-ach-community-row" data-ov="ach-guide" data-url="${esc(thread.url)}">
        <span class="ov-ach-community-main">
          <span class="ov-ach-community-title">${esc(stripEmoji(thread.title) || "—")}</span>
          <span class="ov-ach-community-meta">${thread.replies > 0 ? esc(t("ach.communityReplies", { n: thread.replies })) : ""}${thread.date ? ` · ${esc(thread.date)}` : ""}</span>
        </span>
        ${icon("external", 11)}
      </button>`,
    )
    .slice(0, 2)
    .join("");

  if (!guideRows && !threadRows) return "";
  return `<div class="ov-ach-community">
    ${guideRows ? `<div class="ov-ach-community-group"><div class="ov-ach-community-head">${esc(t("ach.communityGuides"))}</div>${guideRows}</div>` : ""}
    ${threadRows ? `<div class="ov-ach-community-group"><div class="ov-ach-community-head">${esc(t("ach.communityThreads"))}</div>${threadRows}</div>` : ""}
  </div>`;
}

function renderAchDetail(item: AchievementItem): string {
  const unlocked = isAchievementUnlocked(item);
  const masked = achMasked(item);
  const rarity = achievementRarity(item);
  const multiplier = rarityMultiplier(item);
  const tier = achievementTier(item);
  const progress = achievementProgress(item);
  const links = achGuideLinksFor(item);
  const title = masked ? t("ach.hiddenName") : achDisplayName(item);
  const description = masked ? t("ach.hiddenDesc") : item.description || t("ach.noDesc");
  const date = item.unlock_date && unlocked ? fmtAchDate(item.unlock_date) : "";
  const xp = Number(item.xp) || 0;

  const guideButton = (url: string | undefined, label: string, glyph: IconName): string =>
    url
      ? `<button type="button" class="btn ghost small ov-ach-guide-btn" data-ov="ach-guide" data-url="${esc(url)}">${icon(glyph, 12)}<span>${esc(label)}</span></button>`
      : "";

  const meta = masked
    ? ""
    : [
        item.user_state === "unlocked" ? `<span class="ov-ach-tag">${icon("user", 10)} ${esc(t("ach.userMarked"))}</span>` : "",
        item.user_state === "locked" ? `<span class="ov-ach-tag">${icon("lock", 10)} ${esc(t("ach.userCleared"))}</span>` : "",
        tier ? `<span class="ov-ach-tag">${icon("trophy", 10)} ${esc(t(`trophy.${tier === "platinum" ? "plat" : tier}`))}</span>` : "",
        rarity != null ? `<span class="ov-ach-tag">${icon("sparkles", 10)} ${esc(t("ach.rarityShort", { n: fmtDecimal1(rarity) }))}</span>` : "",
        multiplier != null ? `<span class="ov-ach-tag">${esc(t("ach.multiplierShort", { n: fmtDecimal1(multiplier) }))}</span>` : "",
        xp > 0 ? `<span class="ov-ach-tag">+${xp} XP</span>` : "",
        !item.is_base ? `<span class="ov-ach-tag">DLC</span>` : "",
      ]
        .filter(Boolean)
        .join("");

  const guideButtons = [
    guideButton(links.video, t("ach.guideVideo"), "youtube"),
    guideButton(links.steamGuides, t("ach.guideSteamGuides"), "link"),
    guideButton(links.steamDiscussions, t("ach.guideSteamDiscussions"), "users"),
    guideButton(links.trueSteamAchievements, t("ach.guideTrueSteam"), "external"),
    guideButton(links.trueAchievements, t("ach.guideTrueAchievements"), "external"),
    guideButton(links.web, t("ach.guideWeb"), "globe"),
  ].join("");

  if (!masked) ensureAchCommunity(item.name);

  return `
    <div class="ov-ach-detail">
      <button type="button" class="btn ghost small ov-ach-back" data-ov="ach-back">${icon("arrow-left", 12)}<span>${esc(t("common.back"))}</span></button>
      <div class="ov-ach-detail-hero">
        <div class="ov-ach-detail-art${masked ? " is-masked" : ""}">
          ${masked ? icon("lock", 22) : item.icon_link ? `<img src="${esc(item.icon_link)}" alt="" loading="lazy" />` : icon("trophy", 22)}
        </div>
        <div class="ov-ach-detail-main">
          <div class="ov-ach-detail-game">${esc(D().context().title || D().context().appName)}</div>
          <div class="ov-ach-detail-name">${esc(title)}</div>
          <div class="ov-ach-detail-desc">${esc(description)}</div>
        </div>
      </div>
      ${meta ? `<div class="ov-ach-detail-meta">${meta}</div>` : ""}
      ${
        masked
          ? ""
          : `<div class="ov-ach-detail-status">
               ${
                 unlocked
                   ? `<span class="ov-ach-state is-earned">${icon("check", 12)} ${esc(t("ach.earned"))}</span>${date ? `<span class="ov-ach-state">${esc(date)}</span>` : ""}`
                   : `<span class="ov-ach-state">${icon("lock", 11)} ${esc(t("ach.locked"))}</span>`
               }
               ${
                 !unlocked && progress > 0
                   ? `<div class="ov-ach-progress"><span style="width:${Math.round(progress * 100)}%"></span></div><span class="ov-ach-progress-label tabular-nums">${Math.round(progress * 100)}%</span>`
                   : ""
               }
               ${
                 !unlocked && !masked
                   ? `<button type="button" class="btn ghost small ov-ach-track-btn${isAchievementTracked(item.name) ? " active" : ""}" data-ov="ach-track" data-ach="${esc(item.name)}">${icon("pin", 12)}<span>${esc(isAchievementTracked(item.name) ? t("overlay.trackerUntrack") : t("overlay.trackerTrack"))}</span></button>`
                   : ""
               }
             </div>`
      }
      ${
        item.hidden && !unlocked
          ? `<div class="ov-ach-spoiler">
               <span>${esc(masked ? t("ach.detailSpoiler") : t("ach.hideSpoiler"))}</span>
               <button type="button" class="btn ghost small" data-ov="ach-reveal" data-ach="${esc(item.name)}">${icon(masked ? "eye" : "eye-off", 11)} ${esc(masked ? t("ach.showSpoiler") : t("ach.hide"))}</button>
             </div>`
          : ""
      }
      ${
        masked
          ? ""
          : `<div class="ov-ach-detail-guides">
               <div class="ov-ach-detail-heading">${icon("link", 12)} ${esc(t("ach.detailHowTo"))}</div>
               <div class="ov-ach-guide-grid">${guideButtons}</div>
               ${renderAchCommunity(item.name)}
             </div>`
      }
    </div>`;
}

function renderAchList(data: AchievementsData): string {
  const stats = achievementStats(data.achievements);
  const total = data.total_achievements || stats.total;
  const unlocked = stats.unlocked || data.user_unlocked;
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;
  const hiddenCount = data.achievements.filter((item) => Boolean(item.hidden)).length;
  const lockedCount = Math.max(0, total - unlocked);
  const nearCount = data.achievements.filter((item) => {
    const progress = achievementProgress(item);
    return !achMasked(item) && !isAchievementUnlocked(item) && progress >= 0.5 && progress < 1;
  }).length;
  if (achFilter === "near" && nearCount === 0) achFilter = "all";
  if (achFilter === "hidden" && hiddenCount === 0) achFilter = "all";

  let items = [...data.achievements];
  if (achFilter === "unlocked") {
    items = items.filter(isAchievementUnlocked);
  } else if (achFilter === "locked") {
    items = items.filter((item) => !isAchievementUnlocked(item));
  } else if (achFilter === "hidden") {
    items = items.filter((item) => Boolean(item.hidden));
  } else if (achFilter === "near") {
    items = items.filter((item) => {
      const progress = achievementProgress(item);
      return !isAchievementUnlocked(item) && progress >= 0.5 && progress < 1;
    });
  }
  items.sort((a, b) => {
    if (achFilter === "near" || achFilter === "locked") {
      const progress = achievementProgress(b) - achievementProgress(a);
      if (progress !== 0) return progress;
      return (achievementRarity(b) ?? 0) - (achievementRarity(a) ?? 0);
    }
    return Number(isAchievementUnlocked(b)) - Number(isAchievementUnlocked(a));
  });

  const chip = (
    value: typeof achFilter,
    label: string,
    count: number,
    glyph: IconName,
  ): string =>
    `<button type="button" class="ov-ach-filter ${achFilter === value ? "active" : ""}" data-ov="ach-filter" data-val="${value}" aria-pressed="${achFilter === value}">${icon(glyph, 11)}<span class="ov-ach-filter-label">${esc(label)}</span><span class="ov-ach-filter-count">${count}</span></button>`;

  const rows = items
    .map((item) => {
      const unlocked = isAchievementUnlocked(item);
      const masked = achMasked(item);
      const rarity = achievementRarity(item);
      const progress = achievementProgress(item);
      const tracked = isAchievementTracked(item.name);
      const trackButton =
        !unlocked && !masked
          ? `<button type="button" class="ov-ach-row-track${tracked ? " active" : ""}" data-ov="ach-track" data-ach="${esc(item.name)}" title="${esc(tracked ? t("overlay.trackerUntrack") : t("overlay.trackerTrack"))}">${icon("pin", 11)}</button>`
          : "";
      return `<div class="ov-ach-row${unlocked ? " unlocked" : ""}" data-ov="ach-open" data-ach="${esc(item.name)}" data-nav-row role="button" tabindex="0">
        ${item.icon_link && !masked ? `<img class="ov-ach-icon" src="${esc(item.icon_link)}" alt="" loading="lazy" />` : masked ? `<span class="ov-ach-icon ov-ach-icon-masked" title="${esc(t("ach.filterHidden"))}">${icon("eye-off", 15)}</span>` : `<span class="ov-ach-icon"></span>`}
        <div class="ov-ach-body">
          <div class="ov-ach-name">${esc(masked ? t("ach.hiddenName") : achDisplayName(item))}</div>
          <div class="ov-ach-desc">${esc(masked ? t("ach.hiddenDesc") : item.description || "")}</div>
          ${
            !unlocked && progress > 0 && progress < 1
              ? `<div class="ov-ach-progress"><span style="width:${Math.round(progress * 100)}%"></span></div>`
              : ""
          }
        </div>
        <div class="ov-ach-side">
          ${trackButton}
          ${rarity != null ? `<span class="ov-ach-rarity tabular-nums">%${fmtDecimal1(rarity)}</span>` : ""}
          ${
            item.user_state
              ? `<span class="ov-ach-edit" title="${esc(item.user_state === "unlocked" ? t("ach.userMarkedHint") : t("ach.userClearedHint"))}">${icon(item.user_state === "unlocked" ? "user" : "lock", 11)}</span>`
              : ""
          }
          ${
            unlocked
              ? `<span class="ov-ach-check" title="${esc(t("ach.earned"))}">${icon("check", 13)}</span>`
              : `<span class="ov-ach-locked" title="${esc(t("ach.locked"))}">${icon("lock", 11)}</span>`
          }
        </div>
      </div>`;
    })
    .join("");

  const body = rows;

  return `
    <div class="ov-page-title">${icon("trophy", 20)} <span>${esc(t("overlay.tabAchievements"))}</span>
      <button type="button" class="ov-ach-refresh" data-ov="ach-refresh" title="${esc(t("ach.refreshData"))}">${icon("refresh", 13)}</button>
    </div>
    <div class="ov-ach-summary">
      <div class="ov-ach-count"><strong>${unlocked}</strong> / ${total}</div>
      <div class="ov-ach-bar"><span style="width:${pct}%"></span></div>
      <div class="ov-ach-pct">%${pct}</div>
    </div>
    ${trackerSectionHtml(data)}
    <div class="ov-ach-filters">
      ${chip("all", t("ach.filterAll"), stats.total, "layers")}
      ${chip("unlocked", t("ach.filterUnlocked"), unlocked, "check")}
      ${chip("locked", t("ach.filterLocked"), lockedCount, "lock")}
      ${nearCount > 0 ? chip("near", t("ach.filterNear"), nearCount, "sparkles") : ""}
      ${hiddenCount > 0 ? chip("hidden", t("ach.filterHidden"), hiddenCount, "eye-off") : ""}
    </div>
    <div class="ov-ach-full-list">${body || `<div class="ov-empty">${esc(t("ach.emptyTitle"))}</div>`}</div>`;
}

/* Achievement tracker: up to three achievements pinned to the screen. */

const TRACKER_KEY = "efxlve-overlay-ach-tracker";

function loadTrackerMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TRACKER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const map: Record<string, string[]> = {};
    for (const [game, names] of Object.entries(parsed)) {
      if (!Array.isArray(names)) continue;
      const clean = names.filter((name): name is string => typeof name === "string").slice(0, 3);
      if (clean.length > 0) map[game] = clean;
    }
    return map;
  } catch {
    return {};
  }
}

function saveTrackerMap(map: Record<string, string[]>): void {
  localStorage.setItem(TRACKER_KEY, JSON.stringify(map));
}

function trackedAchievements(): string[] {
  if (!D().context().appName) return [];
  return loadTrackerMap()[D().context().appName] ?? [];
}

function setTrackedAchievements(names: string[]): void {
  if (!D().context().appName) return;
  const map = loadTrackerMap();
  const clean = [...new Set(names)].slice(0, 3);
  if (clean.length > 0) map[D().context().appName] = clean;
  else delete map[D().context().appName];
  saveTrackerMap(map);
}

export function isAchievementTracked(name: string): boolean {
  return trackedAchievements().includes(name);
}

/** A tracked achievement that is already earned loses its pin. */
function pruneTrackedAchievements(data: AchievementsData | null): void {
  if (!data || !D().context().appName) return;
  const names = trackedAchievements();
  if (names.length === 0) return;
  const kept = names.filter((name) => {
    const item = data.achievements.find((entry) => entry.name === name);
    return item ? !isAchievementUnlocked(item) : false;
  });
  if (kept.length !== names.length) setTrackedAchievements(kept);
}

export function toggleTrackedAchievement(name: string): void {
  const current = trackedAchievements();
  if (current.includes(name)) {
    setTrackedAchievements(current.filter((entry) => entry !== name));
  } else {
    if (current.length >= 3) {
      toast(t("overlay.trackerFull"));
      return;
    }
    setTrackedAchievements([...current, name]);
    D().openWidget("ach");
  }
  if (D().isWidgetOpen("ach")) renderAchView();
}

function trackerRowHtml(item: AchievementItem): string {
  const progress = achievementProgress(item);
  const unlocked = isAchievementUnlocked(item);
  const pct = Math.round(progress * 100);
  return `<div class="ov-tracker-row${unlocked ? " is-earned" : ""}">
    <div class="ov-tracker-art">${item.icon_link ? `<img src="${esc(item.icon_link)}" alt="" loading="lazy" />` : icon("trophy", 16)}</div>
    <div class="ov-tracker-body">
      <div class="ov-tracker-name">${esc(achDisplayName(item))}</div>
      ${item.description ? `<div class="ov-tracker-desc">${esc(item.description)}</div>` : ""}
      <div class="ov-tracker-progress"><span style="width:${unlocked ? 100 : pct}%"></span></div>
    </div>
    <div class="ov-tracker-side">
      <span class="ov-tracker-pct tabular-nums">${unlocked ? icon("check", 12) : pct > 0 ? `%${pct}` : icon("lock", 11)}</span>
      <button type="button" class="ov-tracker-remove" data-ov="ach-untrack" data-ach="${esc(item.name)}" title="${esc(t("overlay.trackerRemove"))}">${icon("x", 11)}</button>
    </div>
  </div>`;
}

/** The tracked set lives inside the Achievements widget; the same section is
 *  the whole card in ghost mode, so pinning the widget keeps a compact HUD. */
function trackerSectionHtml(data: AchievementsData | null): string {
  const names = trackedAchievements();
  if (names.length === 0) return "";
  let body: string;
  if (!data) {
    if (!achLoading) return "";
    body = `<div class="ov-empty">${esc(t("ach.checking"))}</div>`;
  } else {
    const items = names
      .map((name) => data.achievements.find((item) => item.name === name))
      .filter((item): item is AchievementItem => Boolean(item))
      .filter((item) => !isAchievementUnlocked(item));
    if (items.length === 0) return "";
    body = `<div class="ov-tracker-list">${items.map(trackerRowHtml).join("")}</div>`;
  }
  return `<section class="ov-tracker-section">
    <div class="ov-tracker-section-head">${icon("pin", 12)} <span>${esc(t("overlay.trackedTitle"))}</span></div>
    ${body}
  </section>`;
}

let trackerPollTimer: number | null = null;

/** While the tracker is open (or pinned in ghost mode), refresh the store data
 *  so a progress bar or a new unlock appears without reopening the panel. */
export function startTrackerPolling(): void {
  if (trackerPollTimer !== null) return;
  trackerPollTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (D().ghostMode() && !D().isWidgetPinned("ach")) return;
    if (!D().isWidgetOpen("ach")) return;
    void loadAchievements(true);
  }, 30_000);
}

export function stopTrackerPolling(): void {
  if (trackerPollTimer === null) return;
  window.clearInterval(trackerPollTimer);
  trackerPollTimer = null;
}

export function renderAchView(): void {
  const el = D().viewEl("ach");
  if (!el) return;
  const data = cachedAchievements;
  if (!data || !data.achievements || data.achievements.length === 0) {
    el.innerHTML = `
      <div class="ov-page-title">${icon("trophy", 20)} <span>${esc(t("overlay.tabAchievements"))}</span></div>
      ${trackerSectionHtml(null)}
      <div class="ov-empty">${esc(t("overlay.noAchievements"))}</div>`;
    D().renderHome();
    return;
  }
  pruneTrackedAchievements(data);
  if (achDetail) {
    const item = data.achievements.find((entry) => entry.name === achDetail);
    if (item) {
      el.innerHTML = renderAchDetail(item);
      D().renderHome();
      return;
    }
    achDetail = null;
  }
  el.innerHTML = renderAchList(data);
  D().renderHome();
}

export async function loadAchievements(force = false): Promise<void> {
  const el = D().viewEl("ach");
  if (!el) return;
  if (achLoading) return;
  if (!cachedAchievements || force) {
    const generation = ++achLoadGeneration;
    achLoading = true;
    el.innerHTML = `<div class="ov-empty">${esc(t("ach.checking"))}</div>`;
    const { store, id } = D().splitKey(D().context().appName);
    try {
      let next: AchievementsData | null = null;
      if (store === "game") {
        // A title the launcher did not install: no store to ask.
        next = null;
      } else if (store === "steam") {
        next = await invoke<AchievementsData>("steam_get_achievements", { appId: id, force: false });
      } else if (store === "gog") {
        next = await invoke<AchievementsData>("gog_get_achievements", { gameId: id });
      } else if (store === "epic") {
        next = await invoke<AchievementsData>("epic_get_achievements", { appName: D().context().appName, forceRefresh: false });
      } else {
        next = await invoke<AchievementsData>("companion_achievements", {
          store,
          id,
          title: D().context().title,
          language: currentLanguage(),
        });
      }
      // The panel can open for another game while the store is answering.
      if (generation !== achLoadGeneration) return;
      // The launcher's own edits are folded in here too: marking an
      // achievement on the game page must not leave the overlay behind.
      if (next) applyAchievementEdits(D().context().appName, next);
      cachedAchievements = next;
    } catch {
      if (generation === achLoadGeneration) cachedAchievements = null;
    } finally {
      if (generation === achLoadGeneration) achLoading = false;
    }
  }
  renderAchView();
}

/** A new panel session starts from a clean achievements/tracker context. */
export function resetAchievementsSession(): void {
  stopTrackerPolling();
  cachedAchievements = null;
  achLoading = false;
  achLoadGeneration += 1;
  achDetail = null;
  achFilter = "all";
  achRevealed.clear();
  achCommunity.clear();
  achCommunityLoading.clear();
}

/** The last store answer; the home dashboard reads the same list. */
export function achievementData(): AchievementsData | null {
  return cachedAchievements;
}

/** Folds a live unlock event into the open list without refetching. */
export function applyLiveAchievementUnlock(name: string): void {
  if (!cachedAchievements) return;
  const item = cachedAchievements.achievements.find((entry) => entry.name === name);
  if (!item || isAchievementUnlocked(item)) return;
  item.unlocked = true;
  item.progress = 1;
  item.unlock_date = new Date().toISOString().slice(0, 10);
  cachedAchievements.user_unlocked = Math.min(
    cachedAchievements.total_achievements,
    (cachedAchievements.user_unlocked || 0) + 1,
  );
  renderAchView();
}

export function hasAchievementDetail(): boolean {
  return achDetail !== null;
}

/** Back button and panel reset both land on the list. */
export function clearAchievementDetail(render = true): void {
  achDetail = null;
  if (render) renderAchView();
}

export function setAchievementFilter(value: string): void {
  const allowed: AchievementFilter[] = ["all", "unlocked", "locked", "hidden", "near"];
  if (allowed.includes(value as AchievementFilter)) {
    achFilter = value as AchievementFilter;
  }
  renderAchView();
}

export function toggleAchievementReveal(name: string): void {
  if (achRevealed.has(name)) achRevealed.delete(name);
  else achRevealed.add(name);
  renderAchView();
}

