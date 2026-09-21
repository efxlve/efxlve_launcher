/**
 * Detail drawer presentational widgets.
 *
 * Pure HTML builders used by the Game Hub tabs: HLTB/critic cards, feature and
 * controller-support cards, trophy/media spotlights, achievement sections and
 * hardware/system-requirement helpers. They read shared state (S) and never
 * trigger network fetches, which keeps them safe to reuse and test.
 */

import { isAppPlatinum } from "../../core/game-view";
import { epicPlatinumIcon, icon } from "../../core/icons";
import { isTurkishUser } from "../../core/selectors";
import { S } from "../../core/state";
import { cleanDisplayVersion, esc, fmtAchDate, fmtBytes, formatScreenshotDate } from "../../core/utils";
import { t as i18nT } from "../../i18n";
import { type CriticData, type EpicAchievementItem, type EpicAchievementSummary, type EpicGame, type EpicSummary, type GameRequirementsResponse, type HltbData, type ThirdPartyLauncherInfo } from "../../epic";

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
            <span class="goygoy-pulse-dot"></span>
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
    titleLower.includes("rogue company")
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

export function renderGameFeatures(
  s: EpicSummary,
  g?: EpicGame,
  partner: ThirdPartyLauncherInfo | null = null,
  antiCheat: string | null = null,
  reqData?: GameRequirementsResponse,
): string {
  const achSum = S.epicAchSummaries[s.appName];
  const customAttrs = g?.metadata?.customAttributes as Record<string, { type?: string; value?: string }> | undefined;
  const cloudFolder = customAttrs?.CloudSaveFolder?.value || customAttrs?.CloudIncludeList?.value;
  const hasCloud = Boolean(cloudFolder || (S.activeManageSettings?.appName === s.appName && S.activeManageSettings.cloudSavesEnabled));
  const canRunOffline = customAttrs?.CanRunOffline?.value === "true";

  const isOnlineOnly = isOnlineOnlyGame(s, g, reqData);

  // 1. Controller support
  const ctrl = detectControllerSupport(s, g, reqData);

  // 2. Cloud / server saves
  let cloudVal = i18nT("feat.localSave");
  let cloudClass = "";
  let cloudTooltip = i18nT("feat.localSaveTip");
  if (isOnlineOnly) {
    cloudVal = i18nT("feat.onlineServerSave");
    cloudClass = "supported";
    cloudTooltip = i18nT("feat.onlineServerSaveTip");
  } else if (hasCloud) {
    cloudVal = i18nT("feat.epicCloud");
    cloudClass = "supported";
    cloudTooltip = i18nT("feat.epicCloudTip");
  } else if (partner) {
    const pName = partner.name === "Rockstar Games Launcher" ? "Rockstar Games" : partner.name;
    cloudVal = i18nT("feat.partnerCloud", { name: pName });
    cloudClass = "accent";
    cloudTooltip = i18nT("feat.partnerCloudTip", { name: partner.name });
  }

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

  // 5. Oyun Modu Analizi
  const gameCols = S.epicCollections.filter((c) =>
    c.app_names.some((name) => name.toLowerCase() === s.appName.toLowerCase()),
  );
  const textCorpus = [
    ...(reqData?.tags || []),
    reqData?.shortDescription || "",
    reqData?.description || "",
    s.description || "",
    ...gameCols.map((c) => c.name),
  ].join(" ").toLowerCase();

  const titleLower = s.title.toLowerCase();
  const appLower = s.appName.toLowerCase();

  const hltb = S.loadedHltb.get(s.appName);
  const hasHltbStory = Boolean(hltb?.main_story && hltb.main_story > 0);

  const isKnownSingleAndMulti =
    titleLower.includes("grand theft auto") ||
    titleLower.includes("gta") ||
    titleLower.includes("red dead") ||
    titleLower.includes("battlefield") ||
    titleLower.includes("call of duty") ||
    titleLower.includes("halo") ||
    titleLower.includes("forza");

  const hasCoop = textCorpus.includes("coop") || textCorpus.includes("co-op") || textCorpus.includes("eşli");
  const hasMultiplayer =
    textCorpus.includes("multiplayer") ||
    textCorpus.includes("çok oyunculu") ||
    textCorpus.includes("online") ||
    textCorpus.includes("pvp") ||
    titleLower.includes("online");

  const hasSinglePlayer =
    hasHltbStory ||
    isKnownSingleAndMulti ||
    textCorpus.includes("single_player") ||
    textCorpus.includes("singleplayer") ||
    textCorpus.includes("single player") ||
    textCorpus.includes("tek oyunculu") ||
    textCorpus.includes("tek kişilik") ||
    textCorpus.includes("campaign") ||
    textCorpus.includes("senaryo") ||
    textCorpus.includes("hikaye") ||
    textCorpus.includes("story");

  let modeVal = i18nT("feat.singlePlayer");
  let modeClass = "supported";
  let modeTooltip = i18nT("feat.singlePlayerStoryTip");

  if (appLower === "brill" || titleLower.includes("dead by daylight")) {
    modeVal = i18nT("feat.multi4v1");
    modeClass = "accent";
    modeTooltip = i18nT("feat.multi4v1Tip");
  } else if (textCorpus.includes("4vs1") || textCorpus.includes("4v1") || textCorpus.includes("asymmetric")) {
    modeVal = i18nT("feat.multiAsym");
    modeClass = "accent";
    modeTooltip = i18nT("feat.multiAsymTip");
  } else if (textCorpus.includes("battle royale")) {
    modeVal = i18nT("feat.battleRoyale");
    modeClass = "accent";
    modeTooltip = i18nT("feat.battleRoyaleTip");
  } else if (textCorpus.includes("mmo") || textCorpus.includes("mmorpg")) {
    modeVal = i18nT("feat.mmo");
    modeClass = "accent";
    modeTooltip = i18nT("feat.mmoTip");
  } else if (isKnownSingleAndMulti || (hasSinglePlayer && (hasMultiplayer || isOnlineOnly))) {
    modeVal = i18nT("feat.singleMulti");
    modeClass = "accent";
    modeTooltip = i18nT("feat.singleMultiTip");
  } else if (hasCoop && hasSinglePlayer) {
    modeVal = i18nT("feat.singleCoop");
    modeClass = "accent";
    modeTooltip = i18nT("feat.singleCoopTip");
  } else if (hasCoop) {
    modeVal = i18nT("feat.coop");
    modeClass = "accent";
    modeTooltip = i18nT("feat.coopTip");
  } else if (hasMultiplayer || isOnlineOnly) {
    modeVal = i18nT("feat.multiplayer");
    modeClass = "accent";
    modeTooltip = i18nT("feat.multiplayerTip");
  } else {
    modeVal = i18nT("feat.singlePlayer");
    modeClass = "supported";
    modeTooltip = i18nT("feat.singlePlayerTip");
  }

  const versionInfo = cleanDisplayVersion(s.installedVersion || s.version);

  return `
    <div class="hub-feature-row" title="${esc(ctrl.tooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon(ctrl.iconName, 12)}</div>
        <span>${i18nT("feat.controller")}</span>
      </div>
      <div class="hub-feature-val ${ctrl.className}">${ctrl.label}</div>
    </div>

    <div class="hub-feature-row" title="${esc(cloudTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("cloud", 12)}</div>
        <span>${i18nT("feat.cloud")}</span>
      </div>
      <div class="hub-feature-val ${cloudClass}">${cloudVal}</div>
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

    <div class="hub-feature-row" title="${esc(modeTooltip)}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("users", 12)}</div>
        <span>${i18nT("feat.mode")}</span>
      </div>
      <div class="hub-feature-val ${modeClass}">${modeVal}</div>
    </div>

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

    <div class="hub-feature-row">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("monitor", 12)}</div>
        <span>${i18nT("feat.platform")}</span>
      </div>
      <div class="hub-feature-val supported">Windows (PC x64)</div>
    </div>

    ${
      s.installed && s.installSize
        ? `
    <div class="hub-feature-row" title="${i18nT("feat.installedSizeTip")}">
      <div class="hub-feature-label">
        <div class="hub-feature-icon">${icon("hard-drive", 12)}</div>
        <span>${i18nT("feat.installedSize")}</span>
      </div>
      <div class="hub-feature-val">
        <span class="hub-size-val">${fmtBytes(s.installSize)}</span>
        ${versionInfo.display ? `<span class="hub-version-badge" title="${esc(i18nT("feat.versionBuild", { v: versionInfo.full }))}">${esc(versionInfo.display)}</span>` : ""}
      </div>
    </div>`
        : ""
    }
  `;
}

export function renderOverviewTrophySpotlight(
  s: EpicSummary,
  g?: EpicGame,
  achSum?: EpicAchievementSummary,
  partner: ThirdPartyLauncherInfo | null = null,
): string {
  const isPlat = isAppPlatinum(s.appName);
  const isDemo = S.demoPlatinumApps.has(s.appName);
  const raw = (g?.achievements || (g?.metadata as any)?.achievements) as any;
  const rawList: any[] = raw?.achievements || (Array.isArray(raw) ? raw : []);

  const hasAch = Boolean(
    (achSum && achSum.supported !== false && achSum.total_achievements > 0) ||
    rawList.length > 0,
  );

  if (!hasAch) {
    if (partner) {
      return `
        <div class="hub-card hub-trophy-spotlight">
          <div class="hub-card-header">
            <h3 class="hub-card-title">${icon("trophy", 14)} <span>${i18nT("feat.partnerAchievements", { name: esc(partner.name) })}</span></h3>
            <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
              <span>${i18nT("trophy.inspect")}</span> ${icon("chevron-right", 12)}
            </button>
          </div>
          <div class="hub-media-empty">
            <div class="hub-media-empty-icon">${icon("trophy", 20)}</div>
            <div class="hub-media-empty-info">
              <div class="hub-media-empty-title">${i18nT("trophy.partnerTrackingTitle", { name: esc(partner.name) })}</div>
              <div class="hub-media-empty-desc">
                ${i18nT("trophy.partnerTrackingDesc", { name: `<strong>${esc(partner.name)}</strong>` })}
              </div>
            </div>
            <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
              ${icon("external", 12)} <span>${i18nT("trophy.detail")}</span>
            </button>
          </div>
        </div>
      `;
    }
    return "";
  }

  const cachedData = S.loadedAchievements.get(s.appName);
  const totalAch = achSum?.total_achievements || rawList.length || 0;
  const unlockedAch = isDemo ? totalAch : (achSum?.user_unlocked ?? 0);
  const pct = totalAch > 0 ? Math.min(100, Math.round((unlockedAch / totalAch) * 100)) : 0;
  const userXp = isDemo ? (achSum?.total_xp || 1000) : (achSum?.user_xp ?? 0);
  const totalXp = achSum?.total_xp || 0;

  // Medal counts (Platinum, Gold, Silver, Bronze)
  let platCount = isPlat || isDemo ? 1 : 0;
  let goldCount = 0;
  let silverCount = 0;
  let bronzeCount = 0;

  if (cachedData && cachedData.achievements.length > 0) {
    for (const a of cachedData.achievements) {
      if (a.unlocked || isDemo) {
        const t = getAchTier(a);
        if (t === "gold") goldCount++;
        else if (t === "silver") silverCount++;
        else if (t === "bronze") bronzeCount++;
        else if (t === "platinum" && !platCount) platCount = 1;
      }
    }
  } else {
    // Raw trophy distribution from disk metadata
    for (const item of rawList) {
      const ach = (item as any)?.achievement || item;
      const t = (ach.tier?.name || "").toLowerCase();
      const xp = Number(ach.XP || ach.xp || 0);
      if (t.includes("plat") || xp >= 200) platCount++;
      else if (t.includes("gold") || xp >= 100) goldCount++;
      else if (t.includes("silver") || xp >= 50) silverCount++;
      else bronzeCount++;
    }
    if (unlockedAch === 0 && !isDemo && !isPlat) {
      platCount = 0;
      goldCount = 0;
      silverCount = 0;
      bronzeCount = 0;
    }
  }

  // Next up trophies
  interface TargetTrophy {
    title: string;
    desc: string;
    icon: string;
    badgeText: string;
    tierClass: "bronze" | "silver" | "gold" | "plat";
  }
  const targets: TargetTrophy[] = [];

  if (cachedData && cachedData.achievements.length > 0) {
    const lockedItems = cachedData.achievements.filter((a) => !a.unlocked && !isDemo);
    const sourceItems = lockedItems.length > 0 ? lockedItems : cachedData.achievements;
    for (const a of sourceItems.slice(0, 2)) {
      const tier = getAchTier(a);
      const tierName = tier === "platinum" ? i18nT("trophy.plat") : tier === "gold" ? i18nT("trophy.gold") : tier === "silver" ? i18nT("trophy.silver") : i18nT("trophy.bronze");
      const xpText = a.xp > 0 ? ` • +${a.xp} XP` : "";
      targets.push({
        title: a.display_name || a.name,
        desc: a.hidden && !a.unlocked ? i18nT("trophy.hidden") : (a.description || i18nT("trophy.completeTarget")),
        icon: a.icon_link,
        badgeText: `${tierName}${xpText}`,
        tierClass: tier === "platinum" ? "plat" : tier,
      });
    }
  } else if (rawList.length > 0) {
    for (const item of rawList.slice(0, 2)) {
      const ach = (item as any)?.achievement || item;
      const t = (ach.tier?.name || "").toLowerCase();
      const xp = Number(ach.XP || ach.xp || 0);
      const tierClass: "bronze" | "silver" | "gold" | "plat" =
        t.includes("plat") || xp >= 200 ? "plat" : t.includes("gold") || xp >= 100 ? "gold" : t.includes("silver") || xp >= 50 ? "silver" : "bronze";
      const tierName = tierClass === "plat" ? i18nT("trophy.plat") : tierClass === "gold" ? i18nT("trophy.gold") : tierClass === "silver" ? i18nT("trophy.silver") : i18nT("trophy.bronze");
      const xpText = xp > 0 ? ` • +${xp} XP` : "";
      const isHidden = Boolean(ach.hidden);
      const title = ach.unlockedDisplayName || ach.lockedDisplayName || ach.name || i18nT("trophy.target");
      const desc = isHidden ? i18nT("trophy.hidden") : (ach.unlockedDescription || ach.lockedDescription || i18nT("trophy.completeTarget"));
      const iconUrl = ach.unlockedIconLink || ach.lockedIconLink || "";
      targets.push({
        title,
        desc,
        icon: iconUrl,
        badgeText: `${tierName}${xpText}`,
        tierClass,
      });
    }
  }

  const targetsHtml = targets.length > 0 ? `
    <div class="hub-trophy-next-list">
      ${targets.map((t) => `
        <button type="button" class="hub-trophy-target-card" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}" title="${esc(t.title)} - ${esc(t.desc)}">
          <div class="hub-trophy-target-icon ${t.tierClass === "plat" ? "plat" : ""}">
            ${t.icon ? `<img src="${esc(t.icon)}" alt="" loading="lazy" />` : (t.tierClass === "plat" ? epicPlatinumIcon(18) : icon("trophy", 18))}
          </div>
          <div class="hub-trophy-target-info">
            <div class="hub-trophy-target-title">${esc(t.title)}</div>
            <div class="hub-trophy-target-desc">${esc(t.desc)}</div>
            <span class="hub-trophy-target-badge ${t.tierClass}">${esc(t.badgeText)}</span>
          </div>
        </button>
      `).join("")}
    </div>
  ` : "";

  return `
    <div class="hub-card hub-trophy-spotlight ${isPlat ? "plat" : ""}">
      <div class="hub-card-header">
        <h3 class="hub-card-title">${isPlat ? epicPlatinumIcon(14) : icon("trophy", 14)} <span>${i18nT("trophy.title")}</span></h3>
        <button class="hub-card-link" data-act="drawer-tab" data-tab="achievements" data-id="${s.appName}">
          <span>${i18nT("trophy.all")}</span> ${icon("chevron-right", 12)}
        </button>
      </div>

      <!-- Trophy progress box -->
      <div class="hub-trophy-progress-box ${isPlat ? "plat" : ""}">
        <div class="hub-trophy-progress-top">
          <div class="hub-trophy-percent-badge">
            <span class="hub-trophy-percent-num ${isPlat ? "plat" : ""}">%${pct}</span>
            <span class="hub-trophy-counts">${unlockedAch} / ${totalAch} ${i18nT("trophy.trophies")} ${totalXp > 0 ? `• ${userXp} XP` : ""}</span>
          </div>
          <div class="hub-trophy-medals">
            <div class="hub-medal-item plat" title="${i18nT("trophy.platTitle")}">${epicPlatinumIcon(12)} <span>${platCount}</span></div>
            <div class="hub-medal-item gold" title="${i18nT("trophy.goldTitle")}">${icon("trophy", 12)} <span>${goldCount}</span></div>
            <div class="hub-medal-item silver" title="${i18nT("trophy.silverTitle")}">${icon("trophy", 12)} <span>${silverCount}</span></div>
            <div class="hub-medal-item bronze" title="${i18nT("trophy.bronzeTitle")}">${icon("trophy", 12)} <span>${bronzeCount}</span></div>
          </div>
        </div>
        <div class="hub-trophy-bar-track">
          <div class="hub-trophy-bar-fill ${isPlat ? "plat" : ""}" style="width: ${pct}%"></div>
        </div>
      </div>

      ${targetsHtml}
    </div>
  `;
}

export function renderOverviewMediaSpotlight(s: EpicSummary): string {
  const screenshots = S.loadedScreenshots.get(s.appName) || [];
  const recent = screenshots.slice(0, 3);

  const headerRight = `
    <div style="display:flex;align-items:center;gap:6px">
      <span class="hub-card-hotkey" title="${i18nT("media.hotkeyTitle")}">${esc(S.screenshotHotkeyName)}</span>
      <button class="hub-card-link" data-act="drawer-tab" data-tab="screenshots" data-id="${s.appName}">
        <span>${i18nT("media.all")}</span> ${icon("chevron-right", 12)}
      </button>
    </div>
  `;

  let contentHtml = "";
  if (recent.length > 0) {
    contentHtml = `
      <div class="hub-media-strip">
        ${recent.map((item, idx) => `
          <button type="button" class="hub-media-item" data-act="open-screenshot-lightbox" data-id="${s.appName}" data-idx="${idx}" title="${esc(item.file_name)}">
            <img src="${item.data_url}" alt="${esc(item.file_name)}" loading="lazy" />
            <div class="hub-media-overlay">
              <div class="hub-media-zoom-icon">${icon("eye", 12)}</div>
              <div class="hub-media-date">${esc(formatScreenshotDate(item.timestamp, item.date_str))}</div>
            </div>
          </button>
        `).join("")}
      </div>
    `;
  } else {
    contentHtml = `
      <div class="hub-media-empty">
        <div class="hub-media-empty-icon">${icon("camera", 20)}</div>
        <div class="hub-media-empty-info">
          <div class="hub-media-empty-title">${i18nT("media.emptyTitle")}</div>
          <div class="hub-media-empty-desc">
            ${i18nT("media.emptyDesc", { hotkey: `<strong>${esc(S.screenshotHotkeyName)}</strong>` })}
          </div>
        </div>
        <button class="hub-card-link" data-act="open-screenshots-folder" data-id="${s.appName}" data-title="${esc(s.title)}" title="${i18nT("media.openFolder")}">
          ${icon("folder", 12)} <span>${i18nT("media.folder")}</span>
        </button>
      </div>
    `;
  }

  return `
    <div class="hub-card hub-media-spotlight">
      <div class="hub-card-header">
        <h3 class="hub-card-title">
          ${icon("camera", 14)} <span>${i18nT("media.gallery")}</span>
          ${screenshots.length > 0 ? `<span class="hub-card-count">(${screenshots.length})</span>` : ""}
        </h3>
        ${headerRight}
      </div>
      ${contentHtml}
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
    return `<div style="color:#64748b;font-size:12px;padding:6px 0">${i18nT("ach.noBackup")}</div>`;
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
        <button class="btn ghost small" data-act="manage-delete-backup" data-id="${esc(appName)}" data-bid="${esc(b.id)}" title="${i18nT("ach.deleteTitle")}" style="color:#ef4444">
          ${icon("trash", 12)}
        </button>
      </div>
    </div>
  `
    )
    .join("");
}

