/**
 * Detail drawer presentational widgets.
 *
 * Pure HTML builders used by the Game Hub tabs: HLTB/critic cards, feature and
 * controller-support cards, trophy/media spotlights, achievement sections and
 * hardware/system-requirement helpers. They read shared state (S) and never
 * trigger network fetches, which keeps them safe to reuse and test.
 */

import { isAppPlatinum } from "../../core/game-view";
import { achSummaryOf } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { isTurkishUser, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { cleanDisplayVersion, esc, fmtAchDate, fmtBytes, fmtPlaytime } from "../../core/utils";
import { t as i18nT } from "../../i18n";
import { type CriticData, type EpicAchievementItem, type EpicGame, type EpicSummary, type GameRequirementsResponse, type HltbData, type ThirdPartyLauncherInfo } from "../../epic";

/** Map an achievement to its trophy tier. */
export function getAchTier(a: EpicAchievementItem): "platinum" | "gold" | "silver" | "bronze" {
  if (a.tier?.name) {
    const n = a.tier.name.toLowerCase();
    if (n.includes("plat")) return "platinum";
    if (n.includes("gold")) return "gold";
    if (n.includes("silver")) return "silver";
    if (n.includes("bronze")) return "bronze";
  }
  if (a.xp >= 200) return "platinum";
  if (a.xp >= 100) return "gold";
  if (a.xp >= 50) return "silver";
  return "bronze";
}
export function renderHltbCard(hltb?: HltbData, isLoading = false): string {
  if (isLoading) {
    return `
      <div class="drawer-hltb-card loading">
        <div class="hltb-head">
          <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
          <div class="hltb-loading-text"><span class="hltb-spinner"></span> ${i18nT("hltb.searching")}</div>
        </div>
      </div>
    `;
  }
  if (!hltb || !hltb.supported || (!hltb.main_story && !hltb.main_extra && !hltb.completionist)) {
    return "";
  }
  return `
    <div class="drawer-hltb-card">
      <div class="hltb-head">
        <div class="hltb-title">${icon("timer", 13)} <span>HowLongToBeat</span></div>
        <div class="hltb-source">${i18nT("hltb.times")}</div>
      </div>
      <div class="hltb-grid">
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_story ? i18nT("hltb.hours", { n: hltb.main_story }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.mainStory")}</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.main_extra ? i18nT("hltb.hours", { n: hltb.main_extra }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.mainExtra")}</div>
        </div>
        <div class="hltb-item">
          <div class="hltb-val">${hltb.completionist ? i18nT("hltb.hours", { n: hltb.completionist }) : "—"}</div>
          <div class="hltb-label">${i18nT("hltb.completionist")}</div>
        </div>
      </div>
    </div>
  `;
}

export function renderCriticCard(critic?: CriticData, isLoading = false): string {
  if (isLoading) {
    return `
      <div class="hub-card hub-critic-card loading">
        <div class="hub-card-header">
          <h3 class="hub-card-title">${icon("star", 14)} <span>${i18nT("critic.title")}</span></h3>
        </div>
        <div class="critic-loading-text"><span class="hltb-spinner"></span> ${i18nT("critic.scanning")}</div>
      </div>
    `;
  }

  // The Goygoy Engine review is only shown to Turkish users.
  const showGoygoy = isTurkishUser() && Boolean(critic?.goygoy_review);
  const goygoy = showGoygoy ? critic?.goygoy_review : null;

  if (
    !critic ||
    !critic.supported ||
    (!critic.opencritic_score && !critic.metacritic_score && !critic.igdb_score && !goygoy)
  ) {
    return "";
  }

  const hasGlobalScores = Boolean(critic.opencritic_score || critic.metacritic_score || critic.igdb_score);

  const tierPill = critic.tier
    ? `<span class="critic-tier-pill tier-${critic.tier.toLowerCase()}">${critic.tier}</span>`
    : goygoy && !hasGlobalScores
      ? `<span class="critic-tier-pill tier-goygoy">Goygoy Engine</span>`
      : "";

  let globalScoresHtml = "";
  if (hasGlobalScores) {
    globalScoresHtml = `
      <div class="hub-critic-grid">
        ${
          critic.opencritic_score
            ? `
          <div class="hub-critic-badge opencritic ${critic.opencritic_url ? "clickable" : ""}" ${critic.opencritic_url ? `data-act="open-critic-url" data-url="${esc(critic.opencritic_url)}"` : ""} title="${i18nT("critic.openCriticPage")}">
            <div class="critic-badge-score ${critic.tier ? `tier-${critic.tier.toLowerCase()}` : ""}">${critic.opencritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">OpenCritic</div>
              <div class="critic-badge-sub">${i18nT("critic.topCritic")}</div>
            </div>
            ${critic.opencritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
        ${
          critic.metacritic_score
            ? `
          <div class="hub-critic-badge metacritic ${critic.metacritic_url ? "clickable" : ""}" ${critic.metacritic_url ? `data-act="open-critic-url" data-url="${esc(critic.metacritic_url)}"` : ""} title="${i18nT("critic.metacriticPage")}">
            <div class="critic-badge-score mc">${critic.metacritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">Metacritic</div>
              <div class="critic-badge-sub">${i18nT("critic.metascore")}</div>
            </div>
            ${critic.metacritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
        ${
          critic.igdb_score
            ? `
          <div class="hub-critic-badge igdb" title="${i18nT("critic.igdbCommunity")}">
            <div class="critic-badge-score igdb">${Math.round(critic.igdb_score <= 10 ? critic.igdb_score * 10 : critic.igdb_score)}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-name">IGDB</div>
              <div class="critic-badge-sub">${i18nT("critic.communityScore")}</div>
            </div>
          </div>`
            : ""
        }
      </div>
    `;
  }

  let goygoyHtml = "";
  if (goygoy) {
    goygoyHtml = `
      <div class="hub-goygoy-box clickable" data-act="open-critic-url" data-url="${esc(goygoy.url)}" title="${i18nT("critic.readOnGoygoy")}">
        <div class="goygoy-box-top">
          <div class="goygoy-badge-top">
            <span class="goygoy-brand"><strong>Goygoy</strong> Engine</span>
            <span class="goygoy-chip">${i18nT("critic.specialReview")}</span>
          </div>
          ${
            goygoy.score
              ? `<div class="goygoy-score-pill">
                  <span class="goygoy-score-num">${goygoy.score}</span>
                  <span class="goygoy-score-denom">/100</span>
                </div>`
              : ""
          }
        </div>
        <div class="goygoy-box-title">${esc(goygoy.title)}</div>
        ${goygoy.summary ? `<div class="goygoy-box-summary">“${esc(goygoy.summary)}”</div>` : ""}
        <div class="goygoy-box-footer">
          <div class="goygoy-writer">
            ${icon("users", 12)}
            <span>${esc(goygoy.writer || "Goygoy Engine")}</span>
          </div>
          <div class="goygoy-read-action">
            <span>${i18nT("critic.readReview")}</span>
            ${icon("external", 12)}
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="hub-card hub-critic-card">
      <div class="hub-card-header">
        <h3 class="hub-card-title">${icon("star", 14)} <span>${i18nT("critic.title")}</span></h3>
        ${tierPill}
      </div>
      ${globalScoresHtml}
      ${goygoyHtml}
    </div>
  `;
}

export function cleanStoreDescription(raw: string): string {
  if (!raw) return "";
  let t = raw;
  t = t.replace(/^#+\s*.*$/gm, "").trim();
  t = t.replace(/!\[.*?\]\(.*?\)/g, "").trim();
  t = t.replace(/<[^>]*>/g, "").trim();
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

export function detectControllerSupport(
  s: EpicSummary,
  g?: EpicGame,
  _reqData?: GameRequirementsResponse,
): { label: string; tooltip: string; iconName: "gamepad-2" | "keyboard"; className: string } {
  const titleLower = s.title.toLowerCase();
  const devRaw = (g?.metadata as { developer?: unknown } | undefined)?.developer;
  const devLower = typeof devRaw === "string" ? devRaw.toLowerCase() : "";
  const cats = steamCategories(s.appName);

  // 1. Sony / PlayStation PC titles and games with native DualSense PC implementation
  const isDualSenseNative =
    devLower.includes("playstation") ||
    devLower.includes("sony interactive") ||
    titleLower.includes("spider-man") ||
    titleLower.includes("god of war") ||
    titleLower.includes("last of us") ||
    titleLower.includes("horizon zero dawn") ||
    titleLower.includes("horizon forbidden west") ||
    titleLower.includes("days gone") ||
    titleLower.includes("ratchet & clank") ||
    titleLower.includes("returnal") ||
    titleLower.includes("ghost of tsushima") ||
    titleLower.includes("uncharted") ||
    titleLower.includes("sackboy") ||
    titleLower.includes("helldivers") ||
    titleLower.includes("death stranding") ||
    titleLower.includes("cyberpunk 2077") ||
    titleLower.includes("alan wake 2") ||
    titleLower.includes("metro exodus") ||
    titleLower.includes("witcher 3") ||
    titleLower.includes("grand theft auto") ||
    titleLower.includes("gta") ||
    titleLower.includes("red dead");

  if (isDualSenseNative) {
    return {
      label: i18nT("feat.dualSense"),
      tooltip: i18nT("feat.dualSenseTip"),
      iconName: "gamepad-2",
      className: "supported",
    };
  }

  // 2. Pure Keyboard & Mouse titles (Strategy, RTS, Simulation, City Builder)
  const isKbMouseOnly =
    titleLower.includes("civilization") ||
    titleLower.includes("total war") ||
    titleLower.includes("cities: skylines") ||
    titleLower.includes("football manager") ||
    titleLower.includes("crusader kings") ||
    titleLower.includes("europa universalis") ||
    titleLower.includes("hearts of iron") ||
    titleLower.includes("stellaris") ||
    titleLower.includes("age of empires") ||
    titleLower.includes("command & conquer") ||
    titleLower.includes("simcity") ||
    titleLower.includes("factorio") ||
    titleLower.includes("rimworld");

  if (isKbMouseOnly) {
    return {
      label: i18nT("feat.kbMouse"),
      tooltip: i18nT("feat.kbMouseTip"),
      iconName: "keyboard",
      className: "muted",
    };
  }

  if (cats.length > 0) {
    if (cats.includes(STEAM_CAT_FULL_PAD)) {
      return {
        label: i18nT("feat.xboxGamepad"),
        tooltip: i18nT("feat.xboxGamepadTip"),
        iconName: "gamepad-2",
        className: "supported",
      };
    }
    if (cats.includes(STEAM_CAT_PARTIAL_PAD)) {
      return {
        label: i18nT("feat.partialPad"),
        tooltip: i18nT("feat.partialPadTip"),
        iconName: "gamepad-2",
        className: "muted",
      };
    }
    return {
      label: i18nT("feat.kbMouse"),
      tooltip: i18nT("feat.kbMouseTip"),
      iconName: "keyboard",
      className: "muted",
    };
  }

  if (s.appName.startsWith("steam::")) {
    return {
      label: i18nT("feat.kbMouse"),
      tooltip: i18nT("feat.kbMouseTip"),
      iconName: "keyboard",
      className: "muted",
    };
  }

  // 3. Standard PC Games: Xbox / XInput Gamepad (e.g. Dead by Daylight, etc.)
  return {
    label: i18nT("feat.xboxGamepad"),
    tooltip: i18nT("feat.xboxGamepadTip"),
    iconName: "gamepad-2",
    className: "supported",
  };
}

export function isOnlineOnlyGame(
  s: EpicSummary,
  _g?: EpicGame,
  reqData?: GameRequirementsResponse,
): boolean {
  const titleLower = s.title.toLowerCase();
  const appLower = s.appName.toLowerCase();
  const cats = steamCategories(s.appName);
  if (cats.length > 0) {
    const alwaysOnline = cats.includes(STEAM_CAT_ONLINE_PVP) || cats.includes(STEAM_CAT_MMO[0]);
    const single = cats.includes(STEAM_CAT_SINGLE[0]);
    if (alwaysOnline && !single) return true;
  }

  // Known online-only titles (Brill = Dead by Daylight)
  if (
    appLower === "brill" ||
    titleLower.includes("dead by daylight") ||
    titleLower.includes("fortnite") ||
    titleLower.includes("rocket league") ||
    titleLower.includes("fall guys") ||
    titleLower.includes("destiny 2") ||
    titleLower.includes("rainbow six siege") ||
    titleLower.includes("apex legends") ||
    titleLower.includes("valorant") ||
    titleLower.includes("warframe") ||
    titleLower.includes("overwatch") ||
    titleLower.includes("the division") ||
    titleLower.includes("genshin impact") ||
    titleLower.includes("honkai") ||
    titleLower.includes("pubg") ||
    titleLower.includes("the finals") ||
    titleLower.includes("world of warships") ||
    titleLower.includes("paladins") ||
    titleLower.includes("smite") ||
    titleLower.includes("rogue company") ||
    titleLower.includes("counter-strike") ||
    titleLower.includes("counter strike") ||
    titleLower.includes("cs2") ||
    titleLower.includes("cs:go")
  ) {
    return true;
  }

  // Check description and tags for explicit online-only signals
  const allText = [
    ...(reqData?.tags || []),
    reqData?.shortDescription || "",
    reqData?.description || "",
    s.description || "",
  ].join(" ").toLowerCase();

  if (
    allText.includes("multiplayer (4vs1)") ||
    allText.includes("multiplayer (4v1)") ||
    allText.includes("online-only") ||
    allText.includes("requires internet connection") ||
    allText.includes("internet connection required") ||
    allText.includes("persistent internet connection") ||
    allText.includes("sadece çevrimiçi") ||
    allText.includes("sürekli internet bağlantısı")
  ) {
    return true;
  }

  return false;
}

export type GameMode =
  | "singlePlayer"
  | "multiplayer"
  | "coop"
  | "singleCoop"
  | "singleMulti"
  | "multi4v1"
  | "multiAsym"
  | "battleRoyale"
  | "mmo";

/** Steam store category ids (stable across store languages). */
const STEAM_CAT_SINGLE = [2];
const STEAM_CAT_MULTI = [1, 27, 36, 37, 47, 49];
const STEAM_CAT_COOP = [9, 38, 39, 48];
const STEAM_CAT_MMO = [20];
const STEAM_CAT_ONLINE_PVP = 36;
const STEAM_CAT_CLOUD = 23;
const STEAM_CAT_FULL_PAD = 28;
const STEAM_CAT_PARTIAL_PAD = 18;
const STEAM_CAT_VAC = 8;

function steamCategories(appName: string): number[] {
  return S.steamDetails.get(appName)?.categories ?? [];
}

function modeFromFlags(single: boolean, multi: boolean, coop: boolean): GameMode | null {
  if (single && multi) return "singleMulti";
  if (single && coop) return "singleCoop";
  if (coop && !multi) return "coop";
  if (multi || coop) return "multiplayer";
  if (single) return "singlePlayer";
  return null;
}

/**
 * Game mode for the features list. Steam games use the store's category ids;
 * other stores fall back to title / text heuristics. Returns null when there is
 * no real evidence, so the page never guesses "Single-player".
 */
export function detectGameMode(s: EpicSummary, reqData?: GameRequirementsResponse): GameMode | null {
  const titleLower = s.title.toLowerCase();
  if (s.appName.toLowerCase() === "brill" || titleLower.includes("dead by daylight")) return "multi4v1";

  const cats = steamCategories(s.appName);
  if (cats.length > 0) {
    const has = (ids: number[]) => ids.some((id) => cats.includes(id));
    if (has(STEAM_CAT_MMO)) return "mmo";
    return modeFromFlags(has(STEAM_CAT_SINGLE), has(STEAM_CAT_MULTI), has(STEAM_CAT_COOP));
  }

  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );
  // Hyphens are dropped so "Multi-player" / "Single-player" / "Co-op" match too.
  const text = [
    ...(reqData?.tags || []),
    reqData?.shortDescription || "",
    reqData?.description || "",
    s.description || "",
    ...gameCols.map((c) => c.name),
  ].join(" ").toLowerCase().replace(/-/g, "");

  if (text.includes("4vs1") || text.includes("4v1") || text.includes("asymmetric")) return "multiAsym";
  if (text.includes("battle royale")) return "battleRoyale";
  if (/\bmmo(rpg)?\b/.test(text)) return "mmo";

  const knownSingleAndMulti = ["grand theft auto", "gta", "red dead", "battlefield", "call of duty", "halo", "forza"]
    .some((name) => titleLower.includes(name));
  if (knownSingleAndMulti) return "singleMulti";

  const onlineOnly = isOnlineOnlyGame(s, undefined, reqData);
  const coop = text.includes("coop") || text.includes("eşli");
  const multi = onlineOnly || ["multiplayer", "çok oyunculu", "pvp"].some((k) => text.includes(k));
  const explicitSingle = ["singleplayer", "single player", "single_player", "tek oyunculu", "tek kişilik", "campaign", "senaryo"]
    .some((k) => text.includes(k));
  // A HowLongToBeat story time also exists for many pure multiplayer games, so it
  // only counts as single-player evidence when nothing points to multiplayer.
  const hltb = S.loadedHltb.get(s.appName);
  const single = explicitSingle || (Boolean(hltb?.main_story) && !multi && !coop);
  return modeFromFlags(single, multi, coop);
}

/** True for games where a campaign length makes no sense (HLTB card is hidden). */
export function isMultiplayerOnlyMode(mode: GameMode | null): boolean {
  return mode === "multiplayer" || mode === "battleRoyale" || mode === "mmo" || mode === "multi4v1" || mode === "multiAsym";
}

export function renderProgressStrip(s: EpicSummary): string {
  const reqData = S.loadedRequirements.get(s.appName);
  if (isMultiplayerOnlyMode(detectGameMode(s, reqData))) return `<div id="gp-progress"></div>`;
  const hltb = S.loadedHltb.get(s.appName);
  if (S.loadingHltbFor === s.appName && !hltb) {
    return `
      <section id="gp-progress" class="gp-side-card gp-progress">
        <h3 class="gp-section-title">${icon("timer", 13)} ${i18nT("drawer.progressStory")}</h3>
        <div class="hltb-loading-text"><span class="hltb-spinner"></span> ${i18nT("hltb.searching")}</div>
      </section>`;
  }
  const target = hltb?.supported ? (hltb.main_story || hltb.main_extra || hltb.completionist || 0) : 0;
  if (!target) return `<div id="gp-progress"></div>`;
  const playedSec = S.playtimeMap.get(s.appName)?.total_seconds ?? 0;
  const playedH = playedSec / 3600;
  const pct = Math.min(100, Math.round((playedH / target) * 100));
  const over = playedH >= target;
  const extras = [
    over ? i18nT("drawer.progressOver") : "",
    hltb?.main_extra && hltb.main_extra !== target ? `${i18nT("hltb.mainExtra")} ${i18nT("hltb.hours", { n: hltb.main_extra })}` : "",
    hltb?.completionist && hltb.completionist !== target ? `${i18nT("hltb.completionist")} ${i18nT("hltb.hours", { n: hltb.completionist })}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <section id="gp-progress" class="gp-side-card gp-progress">
      <div class="gp-progress-head">
        <h3 class="gp-section-title">${icon("timer", 13)} ${i18nT("drawer.progressStory")}</h3>
        <span class="gp-progress-pct num">${pct}%</span>
      </div>
      <div class="gp-progress-track" title="${esc(i18nT("drawer.progressTypical"))}">
        <span class="gp-progress-fill" style="width:${pct}%"></span>
      </div>
      <div class="gp-progress-meta">
        <span class="num">${esc(fmtPlaytime(playedSec))}</span>
        <span class="num">${i18nT("hltb.hours", { n: target })}</span>
      </div>
      ${extras ? `<p class="gp-progress-extra">${esc(extras)}</p>` : ""}
    </section>`;
}

export function renderNextAchievements(appName: string): string {
  const loading = S.loadingAchFor === appName && !S.loadedAchievements.has(appName);
  if (loading) {
    return `
      <section id="gp-next-ach" class="gp-section gp-next">
        <h3 class="gp-section-title">${i18nT("drawer.nextAchievements")}</h3>
        <div class="hltb-loading-text"><span class="hltb-spinner"></span> ${i18nT("ach.loadingStore")}</div>
      </section>`;
  }
  const data = S.loadedAchievements.get(appName);
  if (!data || data.total_achievements === 0) return `<div id="gp-next-ach"></div>`;
  const locked = data.achievements
    .filter((a) => !a.unlocked && !a.hidden)
    .sort((a, b) => (b.rarity?.percent ?? 0) - (a.rarity?.percent ?? 0))
    .slice(0, 3);
  if (locked.length === 0) return `<div id="gp-next-ach"></div>`;
  const rows = locked.map((a) => {
    const rarity = a.rarity?.percent;
    return `
      <button type="button" class="gp-next-row" data-act="drawer-tab" data-tab="achievements" data-id="${esc(appName)}" title="${esc(a.description || a.display_name)}">
        ${a.icon_link ? `<img src="${esc(a.icon_link)}" alt="" />` : `<span class="gp-next-ph">${icon("trophy", 16)}</span>`}
        <span class="gp-next-text">
          <span class="gp-next-name">${esc(a.display_name || a.name)}</span>
          ${rarity != null ? `<span class="gp-next-rarity num">${i18nT("drawer.nextAchRarity", { n: rarity.toFixed(1) })}</span>` : ""}
        </span>
      </button>`;
  }).join("");
  return `
    <section id="gp-next-ach" class="gp-section gp-next">
      <div class="gp-progress-head">
        <h3 class="gp-section-title">${i18nT("drawer.nextAchievements")}</h3>
        <button type="button" class="btn ghost small" data-act="drawer-tab" data-tab="achievements" data-id="${esc(appName)}">${i18nT("drawer.momentsAll")}</button>
      </div>
      <div class="gp-next-list">${rows}</div>
    </section>`;
}

export interface CloudSaveInfo {
  label: string;
  tooltip: string;
  /** False for plain local saves. */
  synced: boolean;
}

export interface HeroCloudStatus {
  label: string;
  tooltip: string;
  /** True when Efxlve (or EOS / Steam remotecache) recorded a completed sync. */
  synced: boolean;
  /** True when the label is a provider name, not a yes/no status. */
  neutral?: boolean;
}

const cloudSyncStamp = new Map<string, string>();

function lastRecordedCloudSync(appName: string): string | null {
  const remembered = cloudSyncStamp.get(appName);
  if (remembered) return remembered;
  if (S.activeManageSettings?.appName === appName && S.activeManageSettings.lastCloudSync) {
    return S.activeManageSettings.lastCloudSync;
  }
  const latest = S.cloudBackupsMap.get(appName)?.[0];
  if (latest?.formattedDate) return latest.formattedDate;
  return null;
}

/** Records a completed cloud sync so the hero CLOUD chip can show Synced. */
export function rememberCloudSync(appName: string, stamp: string): void {
  if (appName && stamp) cloudSyncStamp.set(appName, stamp);
}

/** Hero CLOUD chip: recorded sync, or an honest provider name — never a guessed yes/no. */
export function heroCloudStatus(
  s: EpicSummary,
  g: EpicGame | undefined,
  partner: ThirdPartyLauncherInfo | null,
  reqData?: GameRequirementsResponse,
): HeroCloudStatus {
  const recorded = lastRecordedCloudSync(s.appName);
  if (recorded) {
    return {
      label: i18nT("drawer.cloudSynced"),
      tooltip: i18nT("manage.lastSync", { time: recorded }),
      synced: true,
    };
  }
  if (isOnlineOnlyGame(s, g, reqData)) {
    return {
      label: i18nT("drawer.cloudSynced"),
      tooltip: i18nT("drawer.cloudSynced"),
      synced: true,
    };
  }
  const cats = steamCategories(s.appName);
  if (s.appName.startsWith("steam::") && (cats.includes(STEAM_CAT_CLOUD) || S.steamSummariesMap.get(s.appName)?.cloudSavesSupported)) {
    return {
      label: i18nT("feat.steamCloud"),
      tooltip: i18nT("feat.steamCloudTip"),
      synced: false,
      neutral: true,
    };
  }
  if (s.appName.startsWith("gog::") && S.gogSummariesMap.get(s.appName.slice(5))?.cloudSavesSupported) {
    return {
      label: i18nT("feat.gogCloud"),
      tooltip: i18nT("feat.gogCloudTip"),
      synced: false,
      neutral: true,
    };
  }
  // Native client games (EA, Ubisoft, Xbox, Battle.net): name the provider
  // instead of guessing a sync state the launcher cannot observe.
  const source = sourceOfKey(s.appName);
  if (source === "ea" || source === "ubisoft" || source === "xbox" || source === "battlenet") {
    const provider = cloudSaveInfo(s, g, partner, reqData);
    return {
      label: provider.label,
      tooltip: provider.tooltip,
      synced: false,
      neutral: true,
    };
  }
  const provider = cloudSaveInfo(s, g, partner, reqData);
  if (provider.synced) {
    return {
      label: i18nT("drawer.cloudNotSynced"),
      tooltip: i18nT("drawer.cloudNotSyncedTip"),
      synced: false,
    };
  }
  return {
    label: "—",
    tooltip: i18nT("feat.localSaveTip"),
    synced: false,
  };
}

/** Where the game keeps its saves: server-side, Epic cloud, a partner cloud or local only. */
export function cloudSaveInfo(
  s: EpicSummary,
  g: EpicGame | undefined,
  partner: ThirdPartyLauncherInfo | null,
  reqData?: GameRequirementsResponse,
): CloudSaveInfo {
  const customAttrs = g?.metadata?.customAttributes as Record<string, { type?: string; value?: string }> | undefined;
  const cats = steamCategories(s.appName);
  if (s.appName.startsWith("steam::") && (cats.includes(STEAM_CAT_CLOUD) || S.steamSummariesMap.get(s.appName)?.cloudSavesSupported)) {
    return { label: i18nT("feat.steamCloud"), tooltip: i18nT("feat.steamCloudTip"), synced: true };
  }
  if (s.appName.startsWith("gog::") && S.gogSummariesMap.get(s.appName.slice(5))?.cloudSavesSupported) {
    return { label: i18nT("feat.gogCloud"), tooltip: i18nT("feat.gogCloudTip"), synced: true };
  }
  const cloudFolder = customAttrs?.CloudSaveFolder?.value || customAttrs?.CloudIncludeList?.value;
  const hasCloud = Boolean(cloudFolder || (S.activeManageSettings?.appName === s.appName && S.activeManageSettings.cloudSavesEnabled));
  if (isOnlineOnlyGame(s, g, reqData)) {
    return { label: i18nT("feat.onlineServerSave"), tooltip: i18nT("feat.onlineServerSaveTip"), synced: true };
  }
  if (hasCloud) return { label: i18nT("feat.epicCloud"), tooltip: i18nT("feat.epicCloudTip"), synced: true };
  if (partner) {
    const pName = partner.name === "Rockstar Games Launcher" ? "Rockstar Games" : partner.name;
    return { label: i18nT("feat.partnerCloud", { name: pName }), tooltip: i18nT("feat.partnerCloudTip", { name: partner.name }), synced: true };
  }
  return { label: i18nT("feat.localSave"), tooltip: i18nT("feat.localSaveTip"), synced: false };
}

export function renderGameFeatures(
  s: EpicSummary,
  g?: EpicGame,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
  reqData?: GameRequirementsResponse,
): string {
  const achSum = achSummaryOf(s.appName);
  const customAttrs = g?.metadata?.customAttributes as Record<string, { type?: string; value?: string }> | undefined;
  const canRunOffline = customAttrs?.CanRunOffline?.value === "true";

  const isOnlineOnly = isOnlineOnlyGame(s, g, reqData);
  const ctrl = detectControllerSupport(s, g, reqData);
  const cloud = cloudSaveInfo(s, g, partner, reqData);
  const cats = steamCategories(s.appName);
  const cheat = antiCheat || (s.appName.startsWith("steam::") && cats.includes(STEAM_CAT_VAC) ? "VAC" : null);
  const versionInfo = cleanDisplayVersion(s.installedVersion || s.version);
  const versionOk = Boolean(versionInfo.display && /\d/.test(versionInfo.display));

  // 3. Achievement status
  let achVal = i18nT("feat.none");
  let achClass = "";
  if (achSum && achSum.total_achievements > 0) {
    const totalXp = achSum.total_xp || 0;
    achVal = i18nT("feat.trophiesXp", {
      count: achSum.total_achievements,
      extra: totalXp > 0 ? ` • ${totalXp} XP` : "",
    });
    achClass = isAppPlatinum(s.appName) ? "plat" : "gold";
  } else if (partner) {
    achVal = i18nT("feat.partnerAchievements", { name: partner.name });
    achClass = "accent";
  }

  // 4. Offline play
  let offlineVal = i18nT("feat.supportedOffline");
  let offlineClass = "supported";
  let offlineTooltip = i18nT("feat.supportedOfflineTip");
  if (isOnlineOnly) {
    offlineVal = i18nT("feat.alwaysOnline");
    offlineClass = "accent";
    offlineTooltip = i18nT("feat.alwaysOnlineTip");
  } else if (partner) {
    offlineVal = i18nT("feat.partnerRequired", { name: partner.name });
    offlineClass = "muted";
    offlineTooltip = i18nT("feat.partnerRequiredTip", { name: partner.name });
  } else if (canRunOffline) {
    offlineVal = i18nT("feat.supportedOffline");
    offlineClass = "supported";
  }

  // 5. Game mode (row hidden when the mode cannot be determined)
  const mode = detectGameMode(s, reqData);

  return `
    <div class="hub-feature-row" title="${esc(ctrl.tooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(ctrl.iconName, 12)}</div>
        <span>${i18nT("feat.controller")}</span>
      </div>
      <div class="hub-feature-val ${ctrl.className}">${ctrl.label}</div>
    </div>

    <div class="hub-feature-row" title="${esc(cloud.tooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("cloud", 12)}</div>
        <span>${i18nT("feat.cloud")}</span>
      </div>
      <div class="hub-feature-val ${cloud.synced ? "supported" : ""}">${esc(cloud.label)}</div>
    </div>

    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${isAppPlatinum(s.appName) ? epicPlatinumIcon(12) : icon("trophy", 12)}</div>
        <span>${i18nT("feat.achievements")}</span>
      </div>
      <div class="hub-feature-val ${achClass}">${achVal}</div>
    </div>

    <div class="hub-feature-row" title="${esc(offlineTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(isOnlineOnly ? "wifi" : "globe", 12)}</div>
        <span>${i18nT("feat.offline")}</span>
      </div>
      <div class="hub-feature-val ${offlineClass}">${offlineVal}</div>
    </div>

    ${
      mode
        ? `
    <div class="hub-feature-row" title="${esc(i18nT(`feat.${mode}Tip`))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("users", 12)}</div>
        <span>${i18nT("feat.mode")}</span>
      </div>
      <div class="hub-feature-val ${mode === "singlePlayer" ? "supported" : "accent"}">${i18nT(`feat.${mode}`)}</div>
    </div>`
        : ""
    }

    ${
      partner
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.externalLauncherTip", { name: partner.name }))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("layers", 12)}</div>
        <span>${i18nT("feat.externalLauncher")}</span>
      </div>
      <div class="hub-feature-val accent">${esc(partner.name)}</div>
    </div>`
        : ""
    }

    ${
      cheat
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.antiCheatTip", { name: cheat }))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("shield", 12)}</div>
        <span>${i18nT("feat.antiCheat")}</span>
      </div>
      <div class="hub-feature-val accent">${esc(cheat)}</div>
    </div>`
        : ""
    }

    ${
      S.eosSupportMap.get(s.appName) === true
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.eosTip"))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("users", 12)}</div>
        <span>${i18nT("feat.eos")}</span>
      </div>
      <div class="hub-feature-val supported">${i18nT("feat.eosSupported")}</div>
    </div>`
        : ""
    }

    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("monitor", 12)}</div>
        <span>${i18nT("feat.platform")}</span>
      </div>
      <div class="hub-feature-val supported">Windows (PC x64)</div>
    </div>

    <div class="hub-feature-row" title="${esc(i18nT("feat.installedSizeTip"))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hard-drive", 12)}</div>
        <span>${i18nT("feat.installedSize")}</span>
      </div>
      <div class="hub-feature-val">
        ${
          s.installed
            ? `<span class="hub-size-val">${s.installSize ? fmtBytes(s.installSize) : i18nT("common.installed")}</span>${
                versionOk ? `<span class="hub-version-badge" title="${esc(i18nT("feat.versionBuild", { v: versionInfo.full }))}">${esc(versionInfo.display)}</span>` : ""
              }`
            : i18nT("common.notInstalled")
        }
      </div>
    </div>
  `;
}

export function renderAchievementSections(
  items: EpicAchievementItem[],
  s: EpicSummary,
  shouldGroup: boolean,
  allAchievements?: EpicAchievementItem[],
): string {
  if (items.length === 0) {
    return `
      <div class="ach-empty-state">
        <div class="ach-empty-state-icon">${icon("search", 28)}</div>
        <div class="ach-empty-state-title">${i18nT("ach.emptyTitle")}</div>
        <div class="ach-empty-state-sub">${i18nT("ach.emptyDesc")}</div>
      </div>
    `;
  }

  const isDemo = S.demoPlatinumApps.has(s.appName);

  if (!shouldGroup) {
    return `<div class="ach-cards-grid">${items.map((a) => renderAchievementCard(a, s)).join("")}</div>`;
  }

  // SteamHunters category groups: base game and add-on packs
  const baseItems = items.filter((a) => a.is_base);
  const dlcItems = items.filter((a) => !a.is_base);

  // Category stats and completion ratios must be computed from ALL of the game's
  // achievements, not just the filtered list. Otherwise, under the "Unlocked" filter,
  // locked ones are filtered out and the category total collapses to the unlocked count, looking 100% complete.
  const allSource = allAchievements && allAchievements.length > 0 ? allAchievements : items;
  const allBase = allSource.filter((a) => a.is_base);
  const allDlc = allSource.filter((a) => !a.is_base);

  const baseTotal = allBase.length;
  const baseUnlocked = isDemo ? baseTotal : allBase.filter((a) => a.unlocked).length;
  const basePct = baseTotal > 0 ? Math.round((baseUnlocked / baseTotal) * 100) : 0;
  const baseXp = allBase.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  const dlcTotal = allDlc.length;
  const dlcUnlocked = isDemo ? dlcTotal : allDlc.filter((a) => a.unlocked).length;
  const dlcPct = dlcTotal > 0 ? Math.round((dlcUnlocked / dlcTotal) * 100) : 0;
  const dlcXp = allDlc.filter((a) => a.unlocked || isDemo).reduce((sum, a) => sum + a.xp, 0);

  let html = "";

  if (baseItems.length > 0) {
    html += `
      <div class="ach-group-section">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("gamepad-2", 14)}</span>
            <span class="ach-group-heading">${i18nT("ach.baseGame")}</span>
            <span class="ach-group-badge ${baseUnlocked === baseTotal ? "complete" : ""}">${baseUnlocked}/${baseTotal} (%${basePct})</span>
          </div>
          <div class="ach-group-xp">${baseXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill gold" style="width: ${basePct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${baseItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  if (dlcItems.length > 0) {
    html += `
      <div class="ach-group-section dlc">
        <div class="ach-group-header">
          <div class="ach-group-title">
            <span class="ach-group-icon">${icon("package", 14)}</span>
            <span class="ach-group-heading">${i18nT("ach.dlcPacks")}</span>
            <span class="ach-group-badge ${dlcUnlocked === dlcTotal ? "complete" : ""}">${dlcUnlocked}/${dlcTotal} (%${dlcPct})</span>
          </div>
          <div class="ach-group-xp">${dlcXp} XP</div>
        </div>
        <div class="ach-group-bar">
          <div class="ach-group-bar-fill purple" style="width: ${dlcPct}%"></div>
        </div>
        <div class="ach-cards-grid">
          ${dlcItems.map((a) => renderAchievementCard(a, s)).join("")}
        </div>
      </div>
    `;
  }

  return html;
}

export function renderAchievementCard(a: EpicAchievementItem, s: EpicSummary): string {
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const isUnlocked = a.unlocked || isDemo;
  const isHidden = a.hidden;
  const isSecretMasked = isHidden && !isUnlocked;
  const isRevealed = S.revealedAchievements.has(`${s.appName}:${a.name}`);

  const title = isSecretMasked && !isRevealed ? i18nT("ach.hiddenName") : (a.display_name || a.name);
  const desc = isSecretMasked && !isRevealed
    ? i18nT("ach.hiddenDesc")
    : (a.description || i18nT("ach.noDesc"));
  const tier = getAchTier(a);
  const tierClass = tier;
  const tierIcon = icon("trophy", 11);
  const tierName = fmtTierName(tier);

  return `
    <div class="ach-card ${isUnlocked ? "unlocked" : "locked"} ${isSecretMasked ? (isRevealed ? "revealed-secret" : "hidden-secret") : ""}"
         ${isSecretMasked ? `data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" role="button" tabindex="0" title="${isRevealed ? i18nT("ach.hideTitle") : i18nT("ach.revealTitle")}"` : ""}>
      
      <!-- Left: 52px icon -->
      <div class="ach-icon-wrapper">
        ${
          isSecretMasked && !isRevealed
            ? `<div class="ach-mystery-box">${icon("lock", 20)}</div>`
            : a.icon_link
              ? `<img class="ach-art" src="${esc(a.icon_link)}" alt="" loading="lazy" />`
              : `<div class="ach-fallback-icon">${icon("trophy", 20)}</div>`
        }
        ${!isUnlocked && (!isSecretMasked || isRevealed) ? `<div class="ach-locked-badge">${icon("lock", 12)}</div>` : ""}
      </div>

      <!-- Middle: title, description & meta -->
      <div class="ach-content">
        <div class="ach-title-row">
          <span class="ach-name">${isSecretMasked && !isRevealed ? icon("lock", 11) + " " : ""}${esc(title)}</span>
          ${
            isSecretMasked
              ? (isRevealed
                  ? `<button class="ach-reveal-btn revealed" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="${i18nT("ach.hideSpoiler")}">${icon("eye-off", 10)} ${i18nT("ach.hide")}</button>`
                  : `<button class="ach-reveal-btn" data-act="ach-reveal" data-id="${s.appName}" data-ach="${esc(a.name)}" title="${i18nT("ach.showSpoiler")}">${icon("eye", 10)} ${i18nT("ach.show")}</button>`)
              : isHidden && isUnlocked
                ? `<span class="ach-pill secret">${icon("lock", 9)} ${i18nT("ach.secret")}</span>`
                : ""
          }
          ${!a.is_base ? `<span class="ach-pill dlc">${icon("package", 9)} DLC</span>` : ""}
        </div>

        <p class="ach-description">${esc(desc)}</p>

        <div class="ach-meta-row">
          <span class="ach-pill tier ${tierClass}">${tierIcon} ${esc(tierName)}</span>
          ${a.unlock_date && isUnlocked ? `<span class="ach-pill date">${fmtAchDate(a.unlock_date)}</span>` : ""}
          ${a.rarity?.percent != null && a.rarity.percent < 10 ? `
            <span class="ach-pill rarity ultra-rare">
              ${icon("sparkles", 10)} %${a.rarity.percent.toFixed(1)} ${i18nT("ach.rare")}
            </span>` : ""}
        </div>
      </div>

      <!-- Right: XP & status -->
      <div class="ach-aside">
        <div class="ach-xp-chip ${isUnlocked ? "unlocked" : "locked"}">+${a.xp} XP</div>
        ${isUnlocked
          ? `<div class="ach-status-icon earned" title="${i18nT("ach.earned")}">${icon("check", 13)}</div>`
          : `<div class="ach-status-icon locked" title="${i18nT("ach.locked")}">${icon("lock", 12)}</div>`
        }
      </div>
    </div>
  `;
}

export function fmtTierName(name: string): string {
  const n = name.toLowerCase().trim();
  if (n === "bronze") return i18nT("trophy.bronze");
  if (n === "silver") return i18nT("trophy.silver");
  if (n === "gold") return i18nT("trophy.gold");
  if (n === "platinum") return i18nT("trophy.plat");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function getHardwareIcon(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("os") || t.includes("işletim") || t.includes("windows") || t.includes("system")) return icon("layers", 13);
  if (t.includes("processor") || t.includes("işlemci") || t.includes("cpu")) return icon("cpu", 13);
  if (t.includes("memory") || t.includes("bellek") || t.includes("ram")) return icon("server", 13);
  if (t.includes("storage") || t.includes("depolama") || t.includes("disk") || t.includes("hdd") || t.includes("ssd") || t.includes("space")) return icon("hard-drive", 13);
  if (t.includes("graphics") || t.includes("ekran") || t.includes("gpu") || t.includes("video") || t.includes("direct")) return icon("monitor", 13);
  if (t.includes("sound") || t.includes("ses") || t.includes("audio")) return icon("volume-2", 13);
  if (t.includes("net") || t.includes("ağ") || t.includes("broadband") || t.includes("internet")) return icon("globe", 13);
  return icon("shield", 13);
}

export function getHardwareLabel(title: string): string {
  const h = title.toLowerCase().trim();
  if (h.includes("os") || h.includes("işletim")) return i18nT("hw.os");
  if (h.includes("processor") || h.includes("işlemci") || h.includes("cpu")) return i18nT("hw.cpu");
  if (h.includes("memory") || h.includes("bellek") || h.includes("ram")) return i18nT("hw.ram");
  if (h.includes("storage") || h.includes("depolama") || h.includes("space")) return i18nT("hw.storage");
  if (h.includes("graphics") || h.includes("ekran") || h.includes("gpu")) return i18nT("hw.gpu");
  if (h.includes("direct")) return i18nT("hw.directx");
  if (h.includes("sound") || h.includes("ses") || h.includes("audio")) return i18nT("hw.sound");
  if (h.includes("net") || h.includes("ağ") || h.includes("internet")) return i18nT("hw.net");
  if (h.includes("other") || h.includes("ek")) return i18nT("hw.other");
  return title;
}

export function isWinSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("win") || s.includes("pc");
}

export function isMacSys(type: string): boolean {
  const s = type.toLowerCase();
  return s.includes("mac") || s.includes("osx") || s.includes("apple");
}

export function renderBackupListHtml(appName: string): string {
  const list = S.gameBackupsMap.get(appName) || [];
  if (list.length === 0) {
    return `<div class="backup-empty">${i18nT("ach.noBackup")}</div>`;
  }
  return list
    .map(
      (b) => `
    <div class="backup-item">
      <div class="backup-item-meta">
        <span class="backup-item-title">${esc(b.formatted_date)}</span>
        <span class="backup-item-sub">${b.file_count} ${i18nT("ach.files")} • ${fmtBytes(b.size_bytes)}</span>
      </div>
      <div class="backup-item-actions">
        <button class="btn ghost small" data-act="manage-restore-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="${i18nT("ach.restoreTitle")}">
          ${i18nT("ach.restore")}
        </button>
        <button class="icon-btn danger" data-act="manage-delete-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="${i18nT("ach.deleteTitle")}">
          ${icon("trash", 14)}
        </button>
      </div>
    </div>
  `
    )
    .join("");
}

