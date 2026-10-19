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
import { measuredSize } from "../../core/folder-size";
import { epicPlatinumIcon, icon, type IconName } from "../../core/icons";
import { isCompanionSource, sourceOfKey } from "../../core/selectors";
import { S } from "../../core/state";
import { cleanDisplayVersion, esc, fmtAchDate, fmtBytes, fmtDecimal1, fmtHours, fmtPlaytime } from "../../core/utils";
import { currentLanguage, formatSyncStamp, t as i18nT } from "../../i18n";
import { igdbGameFor } from "./igdb-view";
import { sideCard } from "./side-widgets";
import { sessionSummaryFor, sessionWhen } from "../../core/session-summary";
import { type SteamNewsItem } from "../../steam";
import { type CriticData, type EpicAchievementItem, type EpicGame, type EpicSummary, type GameRequirementsResponse, type HltbData, type SystemDetailItem, type ThirdPartyLauncherInfo } from "../../epic";

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
  const hours = (n: number) => i18nT("hltb.hours", { n: fmtHours(n) });
  if (isLoading) {
    return `
      <div class="drawer-hltb-body loading">
        <div class="hltb-loading-text"><span class="hltb-spinner"></span> ${i18nT("hltb.searching")}</div>
      </div>
    `;
  }
  // Not asked yet: the card keeps its place with three placeholder rows. It used
  // to render nothing, so the whole right column dropped down the moment the
  // answer arrived — the page rearranging itself while the reader looks at it.
  if (!hltb) {
    return `
      <div class="drawer-hltb-body is-pending">
        <div class="hltb-list">
          <div class="hltb-row"><div class="hltb-row-top"><span class="hltb-row-label skel"></span><span class="hltb-row-val skel"></span></div><div class="hltb-bar-track"><span class="hltb-bar-fill" style="width:38%"></span></div></div>
          <div class="hltb-row"><div class="hltb-row-top"><span class="hltb-row-label skel"></span><span class="hltb-row-val skel"></span></div><div class="hltb-bar-track"><span class="hltb-bar-fill" style="width:64%"></span></div></div>
          <div class="hltb-row"><div class="hltb-row-top"><span class="hltb-row-label skel"></span><span class="hltb-row-val skel"></span></div><div class="hltb-bar-track"><span class="hltb-bar-fill" style="width:100%"></span></div></div>
        </div>
      </div>
    `;
  }
  if (!hltb.supported || (!hltb.main_story && !hltb.main_extra && !hltb.completionist)) {
    // Nothing estimated: the card goes away rather than framing an empty list.
    // The player's own time lives in the hero's SÜRE stat.
    return "";
  }
  const maxH = Math.max(hltb.main_story || 0, hltb.main_extra || 0, hltb.completionist || 0, 1);
  const rowHtml = (label: string, val?: number | null): string => {
    const pct = val && val > 0 ? Math.max(8, Math.min(100, Math.round((val / maxH) * 100))) : 0;
    return `
        <div class="hltb-row${!val ? " is-empty" : ""}">
          <div class="hltb-row-top">
            <span class="hltb-row-label">${label}</span>
            <span class="hltb-row-val num${!val ? " empty" : ""}">${val ? hours(val) : "—"}</span>
          </div>
          <div class="hltb-bar-track"><span class="hltb-bar-fill" style="width:${pct}%"></span></div>
        </div>`;
  };
  return `
    <div class="drawer-hltb-body">
      <div class="hltb-list">
        ${rowHtml(i18nT("hltb.mainStory"), hltb.main_story)}
        ${rowHtml(i18nT("hltb.mainExtra"), hltb.main_extra)}
        ${rowHtml(i18nT("hltb.completionist"), hltb.completionist)}
      </div>
    </div>
  `;
}

export function renderCriticCard(critic?: CriticData, isLoading = false, igdbRating: number | null = null): string {
  const igdbScore = igdbRating != null ? Math.round(igdbRating) : null;
  if (isLoading) {
    return `
      <div class="drawer-critic-body loading">
        <div class="critic-loading-text"><span class="hltb-spinner"></span> ${i18nT("critic.scanning")}</div>
      </div>
    `;
  }

  // Same as the HowLongToBeat card: not asked yet is not "nothing to show", and
  // the card holds its place so the column does not jump when the answer lands.
  if (!critic && igdbScore == null) {
    const badge = `
        <div class="hub-critic-badge is-pending">
          <div class="critic-badge-score skel"></div>
          <div class="critic-badge-info">
            <div class="critic-badge-top"><div class="critic-badge-name skel"></div></div>
            <div class="critic-badge-sub skel"></div>
            <div class="critic-meter-track"><span class="critic-meter-fill" style="width:76%"></span></div>
          </div>
        </div>`;
    return `
      <div class="drawer-critic-body is-pending">
        <div class="hub-critic-grid">${badge}${badge}</div>
      </div>
    `;
  }

  if (
    !critic ||
    !critic.supported ||
    (!critic.opencritic_score && !critic.metacritic_score && igdbScore == null)
  ) {
    return "";
  }

  const hasGlobalScores = Boolean(critic.opencritic_score || critic.metacritic_score || igdbScore != null);

  let globalScoresHtml = "";
  if (hasGlobalScores) {
    const meter = (n: number) => `<div class="critic-meter-track"><span class="critic-meter-fill" style="width:${Math.max(6, Math.min(100, Math.round(n)))}%"></span></div>`;
    globalScoresHtml = `
      <div class="hub-critic-grid">
        ${
          igdbScore != null
            ? `
          <div class="hub-critic-badge igdb" title="${i18nT("critic.igdbCommunity")}">
            <div class="critic-badge-score igdb num">${igdbScore}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-top">
                <span class="critic-badge-name">IGDB</span>
                <span class="critic-scale-pill num">/ 100</span>
              </div>
              <div class="critic-badge-sub">${i18nT("critic.communityScore")}</div>
              ${meter(igdbScore)}
            </div>
          </div>`
            : ""
        }
        ${
          critic.opencritic_score
            ? `
          <div class="hub-critic-badge opencritic ${critic.opencritic_url ? "clickable" : ""}" ${critic.opencritic_url ? `role="button" tabindex="0" data-act="open-critic-url" data-url="${esc(critic.opencritic_url)}"` : ""} title="${i18nT("critic.openCriticPage")}">
            <div class="critic-badge-score num ${critic.tier ? `tier-${critic.tier.toLowerCase()}` : ""}">${critic.opencritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-top">
                <span class="critic-badge-name">OpenCritic</span>
                ${critic.tier ? `<span class="critic-tier-pill tier-${critic.tier.toLowerCase()}">${esc(critic.tier)}</span>` : `<span class="critic-scale-pill num">/ 100</span>`}
              </div>
              <div class="critic-badge-sub">${i18nT("critic.topCritic")}</div>
              ${meter(critic.opencritic_score)}
            </div>
            ${critic.opencritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
        ${
          critic.metacritic_score
            ? `
          <div class="hub-critic-badge metacritic ${critic.metacritic_url ? "clickable" : ""}" ${critic.metacritic_url ? `role="button" tabindex="0" data-act="open-critic-url" data-url="${esc(critic.metacritic_url)}"` : ""} title="${i18nT("critic.metacriticPage")}">
            <div class="critic-badge-score mc num">${critic.metacritic_score}</div>
            <div class="critic-badge-info">
              <div class="critic-badge-top">
                <span class="critic-badge-name">Metacritic</span>
                <span class="critic-scale-pill num">/ 100</span>
              </div>
              <div class="critic-badge-sub">${i18nT("critic.metascore")}</div>
              ${meter(critic.metacritic_score)}
            </div>
            ${critic.metacritic_url ? `<div class="critic-badge-ext">${icon("external", 12)}</div>` : ""}
          </div>`
            : ""
        }
      </div>
    `;
  }

  return `
    ${globalScoresHtml}
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
  reqData?: GameRequirementsResponse,
): { label: string; tooltip: string; iconName: "gamepad-2" | "keyboard"; className: string } {
  const titleLower = s.title.toLowerCase();
  const igdb = igdbGameFor(s.appName);
  const devRaw = (g?.metadata as { developer?: unknown } | undefined)?.developer;
  const devLower = [
    typeof devRaw === "string" ? devRaw : "",
    igdb?.developer ?? "",
    igdb?.publisher ?? "",
  ].join(" ").toLowerCase();
  const cats = steamCategories(s.appName);

  // Gather requirement and catalog text so controller claims are verified against
  // actual store specifications before falling back to heuristics.
  const reqDetailsText = (reqData?.systems ?? [])
    .flatMap((sys) => sys.details.map((d) => `${d.title ?? ""} ${d.minimum ?? ""} ${d.recommended ?? ""}`))
    .join(" ");
  const storeText = [
    reqDetailsText,
    ...(reqData?.tags ?? []),
    ...(igdb?.genres ?? []),
    reqData?.shortDescription ?? "",
    reqData?.description ?? "",
  ].join(" ").toLowerCase();

  // 1. Pure Keyboard & Mouse titles (Strategy, RTS, Management, City Builder, Tactical FPS)
  const isKbMouseOnly =
    storeText.includes("keyboard and mouse only") ||
    storeText.includes("mouse and keyboard only") ||
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
    titleLower.includes("rimworld") ||
    titleLower.includes("valorant") ||
    titleLower.includes("starcraft") ||
    titleLower.includes("warcraft iii") ||
    titleLower.includes("anno 1800") ||
    titleLower.includes("frostpunk");

  if (isKbMouseOnly && !cats.includes(STEAM_CAT_FULL_PAD)) {
    return {
      label: i18nT("feat.kbMouse"),
      tooltip: i18nT("feat.kbMouseTip"),
      iconName: "keyboard",
      className: "muted",
    };
  }

  // 2. Verified PC titles with native DualSense implementation (haptics / adaptive
  // triggers / lightbar on PC). Generic "gta" / "grand theft auto" / "red dead"
  // matches are excluded because the Definitive Trilogy and RDR use XInput on PC.
  const hasExplicitDualSense =
    storeText.includes("dualsense") ||
    storeText.includes("adaptive trigger") ||
    storeText.includes("haptic feedback");
  const isDualSenseNative =
    hasExplicitDualSense ||
    devLower.includes("playstation") ||
    devLower.includes("sony interactive") ||
    devLower.includes("nixxes") ||
    devLower.includes("insomniac") ||
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
    titleLower.includes("until dawn") ||
    titleLower.includes("stellar blade") ||
    titleLower.includes("death stranding") ||
    titleLower.includes("cyberpunk 2077") ||
    titleLower.includes("alan wake 2") ||
    titleLower.includes("metro exodus") ||
    titleLower.includes("witcher 3") ||
    titleLower.includes("silent hill 2") ||
    titleLower.includes("avatar: frontiers of pandora") ||
    titleLower.includes("star wars outlaws");

  if (isDualSenseNative) {
    return {
      label: i18nT("feat.dualSense"),
      tooltip: i18nT("feat.dualSenseTip"),
      iconName: "gamepad-2",
      className: "supported",
    };
  }

  // 3. Authoritative Steam store categories (when available for any store via lookup)
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

  // 4. Requirement text & genre verification when Steam categories are absent
  if (storeText.includes("partial controller") || storeText.includes("kısmi kontrolcü")) {
    return {
      label: i18nT("feat.partialPad"),
      tooltip: i18nT("feat.partialPadTip"),
      iconName: "gamepad-2",
      className: "muted",
    };
  }

  const isStrategyOnlyGenre =
    (igdb?.genres ?? []).some((genre) => /real time strategy|turn-based strategy|tactical|point-and-click|moba/i.test(genre)) &&
    !storeText.includes("controller") &&
    !storeText.includes("gamepad") &&
    !storeText.includes("xinput");

  if (s.appName.startsWith("steam::") || isStrategyOnlyGenre) {
    return {
      label: i18nT("feat.kbMouse"),
      tooltip: i18nT("feat.kbMouseTip"),
      iconName: "keyboard",
      className: "muted",
    };
  }

  // 5. Standard PC Games: Xbox / XInput Gamepad
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

  // Rockstar's Definitive trilogy is single-player only while GTA V and the
  // Red Dead titles carry an online mode too; a bare "gta" match read the
  // trilogy as multiplayer. The single-player families are checked first so
  // "GTA Vice City" cannot fall into the "GTA V" pattern.
  const singleOnly = ["vice city", "san andreas", "gta iii", "gta 3", "grand theft auto iii", "grand theft auto 3"]
    .some((name) => titleLower.includes(name));
  if (singleOnly) return "singlePlayer";

  const knownSingleAndMulti = [
    "grand theft auto v",
    "grand theft auto online",
    "gta v",
    "gta online",
    "red dead",
    "battlefield",
    "call of duty",
    "halo",
    "forza",
  ].some((name) => titleLower.includes(name));
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

/**
 * What the last session left behind: how long it ran and what it unlocked. The
 * page could already say "289 hours in total"; this says "1h 40m, 3 hours ago,
 * +2 trophies", which is the part a player comes back to look at.
 */
export function renderLastSession(appName: string): string {
  const summary = sessionSummaryFor(appName);
  if (!summary) return "";
  const when = sessionWhen(summary.at);
  const whenText =
    when.unit === "minutes"
      ? i18nT("time.minutesAgo", { n: when.n })
      : when.unit === "hours"
        ? i18nT("time.hoursAgo", { n: when.n })
        : i18nT("time.daysAgo", { n: when.n });
  return `
    <section class="gp-section gp-last-session">
      <div class="card gp-last-session-card">
        <div class="gp-last-session-main">
          <div class="gp-last-session-title">${i18nT("drawer.lastSession")}</div>
          <div class="gp-last-session-meta">
            <span class="num">${esc(fmtPlaytime(summary.seconds))}</span>
            <span class="gp-last-session-dot">·</span>
            <span>${esc(whenText)}</span>
          </div>
        </div>
        ${
          summary.unlocked > 0
            ? `<div class="gp-last-session-trophies">${icon("trophy", 13)} ${i18nT("drawer.lastSessionTrophies", { n: summary.unlocked })}</div>`
            : ""
        }
      </div>
    </section>`;
}

/**
 * What the game's own feed says today: Steam's public news endpoint, three
 * items, patch notes marked. This is the one block on the page that changes
 * without the player doing anything, which is what makes the page worth opening
 * between sessions.
 */
export function renderSteamNews(items: SteamNewsItem[] | null): string {
  if (items === null) {
    // Still on the way: two placeholder rows hold the height, like every other
    // late block on this page.
    return `
      <section class="gp-section gp-news">
        <div class="gp-progress-head"><h3 class="gp-section-title">${icon("bell", 13)} ${i18nT("drawer.news")}</h3></div>
        <div class="gp-news-list">
          <div class="gp-news-row is-pending"><span class="skel gp-news-title"></span></div>
          <div class="gp-news-row is-pending"><span class="skel gp-news-title"></span></div>
        </div>
      </section>`;
  }
  if (items.length === 0) return "";
  const when = (date: number): string => {
    if (!date) return "";
    const at = date * 1000;
    const label = sessionWhen(at);
    return label.unit === "minutes"
      ? i18nT("time.minutesAgo", { n: label.n })
      : label.unit === "hours"
        ? i18nT("time.hoursAgo", { n: label.n })
        : i18nT("time.daysAgo", { n: label.n });
  };
  return `
    <section class="gp-section gp-news">
      <div class="gp-progress-head"><h3 class="gp-section-title">${icon("bell", 13)} ${i18nT("drawer.news")}</h3></div>
      <div class="gp-news-list">${items
        .map(
          (item) => `
        <button type="button" class="gp-news-row${item.image ? " has-art" : ""}" data-act="open-external-url" data-url="${esc(item.url)}" title="${esc(item.title)}">
          ${item.image ? `<img class="gp-news-art" src="${esc(item.image)}" alt="" loading="lazy" decoding="async" />` : ""}
          <span class="gp-news-main">
            <span class="gp-news-head">
              <span class="gp-news-feed">${esc(item.feed)}</span>
              ${item.patchNotes ? `<span class="gp-news-tag">${i18nT("drawer.patchNote")}</span>` : ""}
            </span>
            <span class="gp-news-title">${esc(item.title)}</span>
            ${item.snippet ? `<span class="gp-news-snippet">${esc(item.snippet)}</span>` : ""}
            ${item.date ? `<span class="gp-news-meta">${esc(when(item.date))}</span>` : ""}
          </span>
        </button>`,
        )
        .join("")}</div>
    </section>`;
}

export function renderNextAchievements(appName: string): string {
  const loading = S.loadingAchFor === appName && !S.loadedAchievements.has(appName);
  if (loading) {
    // Three placeholder rows, the height of the three rows that replace them:
    // the spinner was a different height, so everything below it moved when the
    // store answered.
    const rows = Array.from(
      { length: 3 },
      () => `
        <div class="gp-next-row is-pending">
          <span class="skel skel-icon"></span>
          <span class="skel skel-line"></span>
        </div>`,
    ).join("");
    return sideCard(
      appName,
      "next-ach",
      i18nT("drawer.nextAchievements"),
      "trophy",
      `<div class="gp-next-list">${rows}</div>`,
      { idAttr: "gp-next-ach", extraClass: "gp-next-card" },
    );
  }
  const data = S.loadedAchievements.get(appName);
  if (!data || data.total_achievements === 0) {
    return `<div id="gp-next-ach" class="gp-side-card gp-next-card is-empty"></div>`;
  }
  const complete = Boolean(data.is_platinum) || data.user_unlocked >= data.total_achievements;
  const locked = data.achievements
    .filter((a) => !a.unlocked && !a.hidden)
    .sort((a, b) => (b.rarity?.percent ?? 0) - (a.rarity?.percent ?? 0))
    .slice(0, 3);
  const actionHtml = `<button type="button" class="gp-widget-action" data-act="drawer-tab" data-tab="achievements" data-id="${esc(appName)}">${i18nT("drawer.momentsAll")}</button>`;
  if (locked.length === 0) {
    // Nothing left to chase: celebrate the platinum instead of an empty slot.
    if (!complete) return `<div id="gp-next-ach" class="gp-side-card gp-next-card is-empty"></div>`;
    const platBody = `
      <div class="gp-plat-card">
        <span class="plat-cup">${epicPlatinumIcon(40)}<span class="plat-spark s1" aria-hidden="true">${icon("sparkles", 12)}</span><span class="plat-spark s2" aria-hidden="true">${icon("sparkles", 10)}</span></span>
        <span class="gp-plat-copy">
          <span class="gp-plat-title">${i18nT("ach.platinumEarned")}</span>
          <span class="gp-plat-sub">${i18nT("ach.platinumEarnedDesc")}</span>
        </span>
      </div>`;
    return sideCard(appName, "next-ach", i18nT("drawer.nextAchievements"), "trophy", platBody, {
      idAttr: "gp-next-ach",
      extraClass: "gp-next-card",
      metaHtml: `<span class="gp-widget-meta num">${data.user_unlocked}/${data.total_achievements}</span>`,
      actionHtml,
    });
  }
  const pct = Math.min(100, Math.round((data.user_unlocked / data.total_achievements) * 100));
  const rows = locked
    .map((a) => {
      const rarity = a.rarity?.percent;
      const desc = (a.description || "").trim();
      return `
      <button type="button" class="gp-next-row" data-act="drawer-tab" data-tab="achievements" data-id="${esc(appName)}" title="${esc(desc || a.display_name || a.name)}">
        ${a.icon_link ? `<img src="${esc(a.icon_link)}" alt="" />` : `<span class="gp-next-ph">${icon("trophy", 16)}</span>`}
        <span class="gp-next-text">
          <span class="gp-next-name">${esc(a.display_name || a.name)}</span>
          ${desc ? `<span class="gp-next-desc">${esc(desc)}</span>` : ""}
        </span>
        ${rarity != null ? `<span class="gp-next-rarity-pill num">%${fmtDecimal1(rarity)}</span>` : ""}
      </button>`;
    })
    .join("");
  const body = `
    <div class="gp-next-progress-wrap">
      <div class="gp-progress-track gp-next-progress"><span class="gp-progress-fill" style="width:${pct}%"></span></div>
      <div class="gp-next-progress-meta">
        <span class="num">${data.user_unlocked} / ${data.total_achievements}</span>
        <span class="num">%${pct}</span>
      </div>
    </div>
    <div class="gp-next-list">${rows}</div>`;
  return sideCard(appName, "next-ach", i18nT("drawer.nextAchievements"), "trophy", body, {
    idAttr: "gp-next-ach",
    extraClass: "gp-next-card",
    metaHtml: `<span class="gp-widget-meta num">${data.user_unlocked}/${data.total_achievements}</span>`,
    actionHtml,
  });
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

/** The provider's own name, for the hero's cloud chip. A brand reads the same in
 *  every language, and the chip's own label already says CLOUD: "Rockstar Games
 *  Bulut" under a BULUT heading was the same word twice, in a 300px box. */
const CLOUD_BRANDS: Record<string, string> = {
  ea: "EA",
  ubisoft: "Ubisoft",
  rockstar: "Rockstar",
  steam: "Steam",
  gog: "GOG",
  epic: "Epic",
  xbox: "Xbox",
  battlenet: "Battle.net",
  riot: "Riot",
};

/** Hero CLOUD chip: recorded sync, or an honest provider name — never a guessed yes/no. */
export function heroCloudStatus(
  s: EpicSummary,
  g: EpicGame | undefined,
  partner: ThirdPartyLauncherInfo | null,
  reqData?: GameRequirementsResponse,
): HeroCloudStatus {
  // EA and Ubisoft titles sync through their own cloud services, so the hero
  // chip names the provider instead of a state the launcher cannot observe.
  if (partner?.type === "ea") {
    return { label: CLOUD_BRANDS.ea, tooltip: i18nT("feat.eaCloudTip"), synced: false, neutral: true };
  }
  if (partner?.type === "ubisoft") {
    return { label: CLOUD_BRANDS.ubisoft, tooltip: i18nT("feat.ubiCloudTip"), synced: false, neutral: true };
  }
  // The Rockstar Games Launcher owns Social Club cloud saves for its titles;
  // the launcher only relays the start and cannot observe the upload, so the
  // chip names the provider instead of claiming a sync.
  if (partner?.type === "rockstar") {
    return {
      label: CLOUD_BRANDS.rockstar,
      tooltip: i18nT("feat.partnerCloudTip", { name: partner.name }),
      synced: false,
      neutral: true,
    };
  }
  const recorded = lastRecordedCloudSync(s.appName);
  if (recorded) {
    return {
      label: i18nT("drawer.cloudSynced"),
      tooltip: i18nT("manage.lastSync", { time: formatSyncStamp(recorded) }),
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
      label: CLOUD_BRANDS.steam,
      tooltip: i18nT("feat.steamCloudTip"),
      synced: false,
      neutral: true,
    };
  }
  if (s.appName.startsWith("gog::") && S.gogSummariesMap.get(s.appName.slice(5))?.cloudSavesSupported) {
    return {
      label: CLOUD_BRANDS.gog,
      tooltip: i18nT("feat.gogCloudTip"),
      synced: false,
      neutral: true,
    };
  }
  // Native client games (EA, Ubisoft, Xbox, Battle.net): name the provider
  // instead of guessing a sync state the launcher cannot observe.
  const source = sourceOfKey(s.appName);
  if (isCompanionSource(source)) {
    const provider = cloudSaveInfo(s, g, partner, reqData);
    return {
      label: CLOUD_BRANDS[source] ?? provider.label,
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
  // EA and Ubisoft titles sync through their own cloud services, whichever
  // store sold them (Epic, Steam or the client itself). These outrank the
  // store's cloud: the game never writes to Steam Cloud or EOS.
  if (partner?.type === "ea") {
    return { label: i18nT("feat.eaCloud"), tooltip: i18nT("feat.eaCloudTip"), synced: true };
  }
  if (partner?.type === "ubisoft") {
    return { label: i18nT("feat.ubiCloud"), tooltip: i18nT("feat.ubiCloudTip"), synced: true };
  }
  if (s.appName.startsWith("steam::") && (cats.includes(STEAM_CAT_CLOUD) || S.steamSummariesMap.get(s.appName)?.cloudSavesSupported)) {
    return { label: i18nT("feat.steamCloud"), tooltip: i18nT("feat.steamCloudTip"), synced: true };
  }
  if (s.appName.startsWith("gog::") && S.gogSummariesMap.get(s.appName.slice(5))?.cloudSavesSupported) {
    return { label: i18nT("feat.gogCloud"), tooltip: i18nT("feat.gogCloudTip"), synced: true };
  }
  const cloudFolder = customAttrs?.CloudSaveFolder?.value || customAttrs?.CloudIncludeList?.value;
  // The manage toggle only exists for Epic games; Amazon and GOG games never
  // write to Epic's cloud even while their manage panel is open.
  const epicCloudEnabled =
    sourceOfKey(s.appName) === "epic" &&
    S.activeManageSettings?.appName === s.appName &&
    S.activeManageSettings.cloudSavesEnabled;
  const hasCloud = Boolean(cloudFolder || epicCloudEnabled);
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
  tags: string[] = [],
): string {
  const canRunOffline = (g?.metadata?.customAttributes as Record<string, { value?: string }> | undefined)?.CanRunOffline?.value === "true";
  const mode = detectGameMode(s, reqData);
  const modeRequiresOnline =
    mode === "mmo" ||
    mode === "battleRoyale" ||
    mode === "multi4v1" ||
    mode === "multiAsym";
  const isOnlineOnly = isOnlineOnlyGame(s, g, reqData) || modeRequiresOnline;
  const cloud = cloudSaveInfo(s, g, partner, reqData);

  // Offline playability cross-checked against online-only mode and partner launchers
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

  // Deduplicate and clean genre tags
  const cleanTags = Array.from(
    new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 1)),
  );

  return `
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

    <div class="hub-feature-row" title="${esc(offlineTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(isOnlineOnly ? "wifi" : "globe", 12)}</div>
        <span>${i18nT("feat.offline")}</span>
      </div>
      <div class="hub-feature-val ${offlineClass}">${offlineVal}</div>
    </div>

    <div class="hub-feature-row" title="${esc(cloud.tooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("cloud", 12)}</div>
        <span>${i18nT("feat.cloud")}</span>
      </div>
      <div class="hub-feature-val ${cloud.synced ? "supported" : "muted"}">${esc(cloud.label)}</div>
    </div>

    ${
      partner
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.externalLauncherTip", { name: partner.name }))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("layers", 12)}</div>
        <span>${i18nT("feat.externalLauncher")}</span>
      </div>
      <div class="hub-feature-val muted">${esc(partner.name)}</div>
    </div>`
        : ""
    }

    ${
      antiCheat
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.antiCheatTip", { name: antiCheat }))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("shield", 12)}</div>
        <span>${i18nT("feat.antiCheat")}</span>
      </div>
      <div class="hub-feature-val accent">${esc(antiCheat)}</div>
    </div>`
        : ""
    }

    ${
      (() => {
        const igdb = igdbGameFor(s.appName);
        const rawDate = (igdb?.pcReleaseDate || igdb?.releaseDate || "").trim();
        if (!rawDate) return "";
        const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
        if (isoMatch) {
          const year = Number(isoMatch[1]);
          const maxYear = new Date().getFullYear() + 5;
          if (year < 1975 || year > maxYear) return "";
        }
        const formatted = isoMatch
          ? new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])).toLocaleDateString(
              currentLanguage(),
              { day: "numeric", month: "long", year: "numeric" },
            )
          : rawDate;
        return `
    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("calendar", 12)}</div>
        <span>${i18nT("feat.releaseDate")}</span>
      </div>
      <div class="hub-feature-val">${esc(formatted)}</div>
    </div>`;
      })()
    }

    ${
      cleanTags.length
        ? `
    <div class="hub-feature-row" title="${esc(cleanTags.join(", "))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hash", 12)}</div>
        <span>${i18nT("feat.genres")}</span>
      </div>
      <div class="hub-feature-val">${esc(cleanTags.join(", "))}</div>
    </div>`
        : ""
    }
  `;
}

/**
 * Controller support as a structured hardware card: icon tile on the left,
 * verified controller type + support badge on top, and explanation below.
 */
export function renderControllerCard(
  s: EpicSummary,
  g?: EpicGame,
  reqData?: GameRequirementsResponse,
): string {
  const ctrl = detectControllerSupport(s, g, reqData);
  const badge =
    ctrl.className === "supported"
      ? `<span class="ctrl-badge is-full">${icon("check", 12)} ${i18nT("ctrl.fullSupport")}</span>`
      : ctrl.iconName === "keyboard"
        ? `<span class="ctrl-badge is-kb">${icon("keyboard", 12)} ${i18nT("feat.kbMouse")}</span>`
        : `<span class="ctrl-badge is-partial">${i18nT("feat.partialPad")}</span>`;
  return `
    <div class="ctrl-card">
      <div class="ctrl-glyph">${icon(ctrl.iconName, 22)}</div>
      <div class="ctrl-main">
        <div class="ctrl-head">
          <span class="ctrl-label">${esc(ctrl.label)}</span>
          ${badge}
        </div>
        <p class="ctrl-note">${esc(ctrl.tooltip)}</p>
      </div>
    </div>`;
}

/**
 * The verified facts of the copy on this PC: platform, disk size, build version
 * and native EOS overlay support.
 */
export function renderInstalledCopyFacts(
  s: EpicSummary,
  partner: ThirdPartyLauncherInfo | null = null,
): string {
  const versionInfo = cleanDisplayVersion(s.installedVersion || s.version);
  const rawDisplay = versionInfo.display.trim();
  const isBogusVersion =
    !rawDisplay ||
    !/\d/.test(rawDisplay) ||
    /^(v?0(\.0+)*|unknown|none|null|undefined|default|n\/a)$/i.test(rawDisplay) ||
    /^[0-9a-f]{32,}$/i.test(rawDisplay);
  const versionOk = !isBogusVersion;

  const rawBytes = measuredSize(s.appName) ?? s.installSize;
  const validBytes =
    typeof rawBytes === "number" && Number.isFinite(rawBytes) && rawBytes >= 100 * 1024 && rawBytes < 2 * 1024 ** 4
      ? rawBytes
      : 0;

  // Games delegated to Rockstar / EA / Ubisoft launchers run that client's own
  // overlay and only ship EOSSDK as a store ticket bridge, not for Shift+F3.
  const hasNativeEos =
    S.eosSupportMap.get(s.appName) === true &&
    (!partner || (partner.type !== "rockstar" && partner.type !== "ea" && partner.type !== "ubisoft"));

  return `
    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("monitor", 12)}</div>
        <span>${i18nT("feat.platform")}</span>
      </div>
      <div class="hub-feature-val supported">Windows (PC x64)</div>
    </div>
    ${
      hasNativeEos
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
    <div class="hub-feature-row" title="${esc(i18nT("feat.installedSizeTip"))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hard-drive", 12)}</div>
        <span>${i18nT("feat.installedSize")}</span>
      </div>
      <div class="hub-feature-val">
        ${
          s.installed
            ? `<span class="hub-size-val">${validBytes > 0 ? fmtBytes(validBytes) : i18nT("common.installed")}</span>`
            : `<span class="muted">${i18nT("common.notInstalled")}</span>`
        }
      </div>
    </div>
    ${
      s.installed && versionOk
        ? `
    <div class="hub-feature-row" title="${esc(i18nT("feat.versionBuild", { v: versionInfo.full }))}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hash", 12)}</div>
        <span>${i18nT("feat.build")}</span>
      </div>
      <div class="hub-feature-val hub-build-val">${esc(rawDisplay)}</div>
    </div>`
        : ""
    }
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
              : `<div class="ach-fallback-icon ${tierClass}">${icon("trophy", 20)}</div>`
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
              ${icon("sparkles", 10)} %${fmtDecimal1(a.rarity.percent)} ${i18nT("ach.rare")}
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

export type HardwareKind =
  | "os"
  | "cpu"
  | "ram"
  | "gpu"
  | "directx"
  | "storage"
  | "sound"
  | "network"
  | "other";

export interface VerifiedHardwareItem {
  kind: HardwareKind;
  label: string;
  iconName: IconName;
  minimum: string;
  recommended: string;
}

const HW_ORDER: HardwareKind[] = [
  "os",
  "cpu",
  "ram",
  "gpu",
  "directx",
  "storage",
  "sound",
  "network",
  "other",
];

const HW_ICON: Record<HardwareKind, IconName> = {
  os: "monitor",
  cpu: "cpu",
  ram: "layers",
  gpu: "sliders",
  directx: "zap",
  storage: "hard-drive",
  sound: "volume-2",
  network: "globe",
  other: "info",
};

export function classifyHardwareKind(title: string, sampleValue = ""): HardwareKind {
  const h = title.toLowerCase().trim();
  if (h.includes("os") || h.includes("operating") || h.includes("işletim") || h.includes("système") || h.includes("betriebssystem") || h.includes("sistema")) return "os";
  if (h.includes("processor") || h.includes("işlemci") || h.includes("cpu") || h.includes("processeur") || h.includes("prozessor") || h.includes("procesador")) return "cpu";
  if (h.includes("memory") || h.includes("bellek") || h.includes("ram") || h.includes("mémoire") || h.includes("arbeitsspeicher") || h.includes("memoria")) return "ram";
  if (h.includes("storage") || h.includes("depolama") || h.includes("space") || h.includes("disk") || h.includes("hard drive") || h.includes("hdd") || h.includes("ssd") || h.includes("alan") || h.includes("speicherplatz") || h.includes("espace")) return "storage";
  if (h.includes("graphics") || h.includes("video") || h.includes("ekran") || h.includes("gpu") || h.includes("grafik") || h.includes("carte graphique") || h.includes("tarjet")) return "gpu";
  if (h.includes("direct") || h.includes("vulkan") || h.includes("opengl") || h.includes("shader")) return "directx";
  if (h.includes("sound") || h.includes("ses") || h.includes("audio")) return "sound";
  if (h.includes("net") || h.includes("ağ") || h.includes("internet") || h.includes("broadband") || h.includes("réseau")) return "network";

  // Second-pass content verification for generic or mislabeled store rows
  const v = sampleValue.toLowerCase().trim();
  if (v) {
    if (/^(windows|win\s*\d|macos|os\s*x|ubuntu|linux|64-bit\s+windows)\b/i.test(v)) return "os";
    if (/^(directx|dx\s*\d|version\s*(9|10|11|12)|11|12)\b/i.test(v)) return "directx";
    if (/^\d+\s*(gb|mb)\s*(ram|bellek|memory)?$/i.test(v)) return "ram";
    if (/^\d+([.,]\d+)?\s*(gb|mb|tb)\s*(available|free|boş|disk|ssd|hdd)\b/i.test(v)) return "storage";
    if (/^(nvidia|geforce|amd\s+radeon|radeon|intel\s+(arc|hd|iris|uhd)|gtx|rtx)\b/i.test(v)) return "gpu";
    if (/^(intel|amd\s+(ryzen|fx|phenom|athlon)|core\s+i[3579])\b/i.test(v) && !/radeon|geforce|gtx|rtx/i.test(v)) return "cpu";
  }

  return "other";
}

export function hardwareLabelForKind(kind: HardwareKind, fallbackTitle = ""): string {
  switch (kind) {
    case "os": return i18nT("hw.os");
    case "cpu": return i18nT("hw.cpu");
    case "ram": return i18nT("hw.ram");
    case "storage": return i18nT("hw.storage");
    case "gpu": return i18nT("hw.gpu");
    case "directx": return i18nT("hw.directx");
    case "sound": return i18nT("hw.sound");
    case "network": return i18nT("hw.net");
    case "other":
      return fallbackTitle && !/^(other|ek|additional|notes)$/i.test(fallbackTitle.trim())
        ? fallbackTitle.trim()
        : i18nT("hw.other");
  }
}

export function getHardwareLabel(title: string): string {
  const kind = classifyHardwareKind(title);
  return hardwareLabelForKind(kind, title);
}

function sanitizeRequirementText(raw: string | undefined, rawTitle: string, kind: HardwareKind): string {
  if (!raw) return "";
  let s = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&reg;/gi, "®")
    .replace(/&trade;/gi, "™")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/^[•·\-*:]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return "";
  // Reject placeholder / garbage values
  if (/^(n\/?a|none|null|undefined|tbd|to be (announced|determined)|unknown|unspecified|yok|belirtilmemi[şs]|—|-|\?)+$/i.test(s)) {
    return "";
  }
  const localizedLabel = hardwareLabelForKind(kind, rawTitle).toLowerCase();
  if (s.toLowerCase() === rawTitle.toLowerCase().trim() || s.toLowerCase() === localizedLabel) {
    return "";
  }

  // Normalize unit spacing: "8GB" -> "8 GB", "5GB" -> "5 GB", "3.2GHz" -> "3.2 GHz"
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(GB|MB|TB|GHz|MHz|KB)\b/gi, (_, num: string, unit: string) => {
    const u = unit.toUpperCase();
    const formattedUnit = u === "GHZ" ? "GHz" : u === "MHZ" ? "MHz" : u;
    return `${num} ${formattedUnit}`;
  });

  if (kind === "ram" && /^\d+$/.test(s)) {
    s = `${s} GB`;
  }

  if (kind === "directx") {
    const lower = s.toLowerCase();
    if (lower === "directx compatible" || lower === "directx uyumlu" || lower === "directx") {
      return "DirectX 11 / 12";
    }
    const verMatch = /^(?:directx\s*)?(?:version\s*|sürüm\s*|dx\s*)?(9\.0c|9|10|11|12)$/i.exec(s);
    if (verMatch) {
      return `DirectX ${verMatch[1]}`;
    }
  }

  return s;
}

function mergeHardwareValues(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const exLower = existing.toLowerCase();
  const inLower = incoming.toLowerCase();
  if (exLower === inLower || exLower.includes(inLower)) return existing;
  if (inLower.includes(exLower)) return incoming;
  return `${existing} / ${incoming}`;
}

/**
 * Validates, normalizes, deduplicates and orders store system requirement rows.
 * Also inherits shared baseline fields (OS, DirectX, Storage) into Recommended
 * when a store omits them on the second column.
 */
export function verifySystemDetails(details: SystemDetailItem[]): VerifiedHardwareItem[] {
  const byKind = new Map<HardwareKind, VerifiedHardwareItem>();

  for (const d of details) {
    const rawTitle = (d.title || "").trim();
    const sample = d.minimum || d.recommended || "";
    const kind = classifyHardwareKind(rawTitle, sample);
    const minVal = sanitizeRequirementText(d.minimum, rawTitle, kind);
    const recVal = sanitizeRequirementText(d.recommended, rawTitle, kind);
    if (!minVal && !recVal) continue;

    const existing = byKind.get(kind);
    if (existing) {
      existing.minimum = mergeHardwareValues(existing.minimum, minVal);
      existing.recommended = mergeHardwareValues(existing.recommended, recVal);
    } else {
      byKind.set(kind, {
        kind,
        label: hardwareLabelForKind(kind, rawTitle),
        iconName: HW_ICON[kind],
        minimum: minVal,
        recommended: recVal,
      });
    }
  }

  const list = Array.from(byKind.values()).sort(
    (a, b) => HW_ORDER.indexOf(a.kind) - HW_ORDER.indexOf(b.kind),
  );

  // If the game has real recommended hardware rows (e.g. CPU/GPU/RAM), inherit
  // shared baseline specs (OS, DirectX, Storage) when the store left them blank.
  const hasRecSpecs = list.some((item) => item.recommended && (item.kind === "cpu" || item.kind === "gpu" || item.kind === "ram"));
  if (hasRecSpecs) {
    for (const item of list) {
      if (!item.recommended && item.minimum && (item.kind === "os" || item.kind === "directx" || item.kind === "storage")) {
        item.recommended = item.minimum;
      }
    }
  }

  return list;
}

const STORE_LANG_TO_BCP47: Record<string, string> = {
  english: "en",
  turkish: "tr",
  "türkçe": "tr",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
  italian: "it",
  italiano: "it",
  japanese: "ja",
  korean: "ko",
  koreana: "ko",
  polish: "pl",
  polski: "pl",
  russian: "ru",
  arabic: "ar",
  "portuguese - brazil": "pt-BR",
  "portuguese (brazil)": "pt-BR",
  "portuguese-brazil": "pt-BR",
  "brazilian portuguese": "pt-BR",
  brazilian: "pt-BR",
  portuguese: "pt-PT",
  "portuguese - portugal": "pt-PT",
  "spanish - spain": "es-ES",
  "spanish (spain)": "es-ES",
  spanish: "es-ES",
  "spanish - latin america": "es-419",
  "spanish (latin america)": "es-419",
  "latin american spanish": "es-419",
  latam: "es-419",
  "chinese - simplified": "zh-Hans",
  "simplified chinese": "zh-Hans",
  schinese: "zh-Hans",
  "chinese (simplified)": "zh-Hans",
  "chinese - traditional": "zh-Hant",
  "traditional chinese": "zh-Hant",
  tchinese: "zh-Hant",
  "chinese (traditional)": "zh-Hant",
  chinese: "zh",
  dutch: "nl",
  czech: "cs",
  hungarian: "hu",
  ukrainian: "uk",
  thai: "th",
  vietnamese: "vi",
  swedish: "sv",
  danish: "da",
  finnish: "fi",
  norwegian: "no",
  greek: "el",
  romanian: "ro",
  bulgarian: "bg",
  hindi: "hi",
  indonesian: "id",
};

function localizeLanguageToken(rawToken: string, locale: string): { code: string; name: string } | null {
  const cleaned = rawToken
    .replace(/<[^>]*>/g, "")
    .replace(/\*+/g, "")
    .replace(/\(full audio\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2) return null;

  const key = cleaned.toLowerCase();
  const code = STORE_LANG_TO_BCP47[key] || "";
  if (code) {
    try {
      const dn = new Intl.DisplayNames([locale], { type: "language" });
      const localized = dn.of(code);
      if (localized) {
        const cap = localized.charAt(0).toLocaleUpperCase(locale) + localized.slice(1);
        return { code, name: cap };
      }
    } catch {
      // Fallback to cleaned token if Intl.DisplayNames rejects a tag
    }
  }
  return { code: key, name: cleaned };
}

/**
 * Parses raw store language strings (including Epic's "AUDIO: ... TEXT: ..."
 * format), deduplicates them, localizes every language name into the active UI
 * language, and marks full-audio languages and the user's own language.
 */
export function renderSupportedLanguages(rawLanguages: string[]): string {
  if (!rawLanguages || rawLanguages.length === 0) return "";
  const locale = currentLanguage();
  const userBaseLang = locale.toLowerCase().split("-")[0];

  const joined = rawLanguages.join(" · ");
  const audioCodes = new Set<string>();
  const allLangs = new Map<string, { code: string; name: string; hasAudio: boolean }>();

  const addTokens = (chunk: string, isAudio: boolean) => {
    for (const part of chunk.split(/[,;•·]+/)) {
      const parsed = localizeLanguageToken(part, locale);
      if (!parsed) continue;
      if (isAudio) audioCodes.add(parsed.code);
      const existing = allLangs.get(parsed.code);
      if (existing) {
        if (isAudio) existing.hasAudio = true;
      } else {
        allLangs.set(parsed.code, {
          code: parsed.code,
          name: parsed.name,
          hasAudio: isAudio || audioCodes.has(parsed.code),
        });
      }
    }
  };

  // Detect explicit AUDIO: / TEXT: segments from Epic / store catalogs
  const hasExplicitAudioText = /\b(audio|voice|ses|text|subtitles|interface|metin)\s*:/i.test(joined);
  if (hasExplicitAudioText) {
    const segments = joined.split(/\s*(?:·|\n|\|)\s*|\s+(?=(?:AUDIO|TEXT|VOICE|SUBTITLES|INTERFACE)\s*:)/i);
    for (const seg of segments) {
      const m = /^(audio|full audio|voice|ses|text|subtitles|interface|metin)\s*:\s*(.+)$/i.exec(seg.trim());
      if (m) {
        const kind = m[1].toLowerCase();
        const isAudio = kind.includes("audio") || kind.includes("voice") || kind.includes("ses");
        addTokens(m[2], isAudio);
      } else {
        addTokens(seg, false);
      }
    }
  } else {
    for (const raw of rawLanguages) {
      addTokens(raw, false);
    }
  }

  if (allLangs.size === 0) return "";

  const isUserLang = (code: string): boolean => {
    const c = code.toLowerCase();
    if (c === locale.toLowerCase()) return true;
    return c.split("-")[0] === userBaseLang;
  };

  const sorted = Array.from(allLangs.values()).sort((a, b) => {
    const aUser = isUserLang(a.code) ? 1 : 0;
    const bUser = isUserLang(b.code) ? 1 : 0;
    if (aUser !== bUser) return bUser - aUser;
    if (a.hasAudio !== b.hasAudio) return a.hasAudio ? -1 : 1;
    return a.name.localeCompare(b.name, locale);
  });

  const chips = sorted
    .map((item) => {
      const active = isUserLang(item.code);
      const leadIcon = active
        ? icon("check", 11)
        : item.hasAudio
          ? icon("volume-2", 11)
          : "";
      const audioBadge = active && item.hasAudio ? `<span class="sys-lang-audio">${icon("volume-2", 11)}</span>` : "";
      return `<span class="sys-lang-chip${active ? " is-user-lang" : ""}${item.hasAudio ? " has-audio" : ""}">${leadIcon}<span>${esc(item.name)}</span>${audioBadge}</span>`;
    })
    .join("");

  return `
    <div class="sys-lang-block">
      <div class="sys-lang-head">
        <span class="sys-lang-title">${icon("globe", 13)} <span>${i18nT("sys.languages")}</span> <span class="gp-section-meta num">${sorted.length}</span></span>
      </div>
      <div class="sys-lang-chips">${chips}</div>
    </div>`;
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

