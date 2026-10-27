/**
 * Steam integration API.
 *
 * Steamworks DRM means a game cannot run without the Steam client, so the
 * launcher reads the client's own metadata from disk (install path, library
 * folders, app manifests) and hands every game action back to Steam through
 * its `steam://` protocol. No game files are touched.
 *
 * The optional account sign-in (ROADMAP §13) additionally reads the owned
 * library through Steam's own auth service; the password is never stored and
 * the refresh token is sealed with Windows DPAPI.
 */

import { invoke } from "@tauri-apps/api/core";

export interface SteamStatus {
  installed: boolean;
  path: string;
  games: number;
  /** Persona name signed in to the Steam client (empty when unknown). */
  userName: string;
}

/** One installed Steam game read from `appmanifest_<id>.acf`. */
export interface SteamGame {
  appId: string;
  name: string;
  installDir: string;
  sizeBytes: number;
  /** Steam StateFlags: 4 = fully installed, 2 = update required. */
  stateFlags: number;
  library: string;
  /** True while the Steam client is downloading this app. */
  downloading: boolean;
  bytesDownloaded: number;
  bytesToDownload: number;
  /** Release build is not out yet. Steam still sets the update flag. */
  preloaded?: boolean;
}

/** Playtime from the Steam client's own local config, in seconds. */
export interface SteamPlaytime {
  seconds: number;
  lastPlayed: number | null;
}

/** Store metadata shown on the game page (cached on disk for 6 hours). */
export interface SteamGameDetails {
  appId: string;
  name: string;
  shortDescription: string;
  description: string;
  developers: string[];
  publishers: string[];
  genres: string[];
  /** Store category ids (1 multi-player, 2 single-player, 9 co-op, 36 online PvP ...). */
  categories: number[];
  releaseDate: string;
  headerImage: string;
  website: string;
  /** DLC app ids listed by the store (names would need one call each). */
  dlc: string[];
  requirementsMin: string[];
  requirementsRec: string[];
  /** Steam store field naming the third-party account / launcher, if any. */
  extUserAccountNotice: string;
  /** Steam store DRM / anti-cheat blurb (Easy Anti-Cheat, BattlEye, …). */
  drmNotice: string;
  metacriticScore?: number | null;
  metacriticUrl?: string | null;
  /** Store-reported supported operating systems (`windows`, `mac`, `linux`). */
  platforms?: string[];
}

/** One announcement from Steam's public news feed. */
export interface SteamNewsItem {
  title: string;
  url: string;
  /** Epoch seconds. */
  date: number;
  feed: string;
  /** Steam tagged it as a patch note. */
  patchNotes: boolean;
  /** The first picture in the body, when it has one. */
  image: string;
  /** The opening of the body as plain text. */
  snippet: string;
}

/** The last few announcements for a Steam app. Cached in Rust for half an hour. */
export const steamNews = (appId: string, count = 3) => invoke<SteamNewsItem[]>("steam_news", { appId, count });

export const steamStatus = () => invoke<SteamStatus>("steam_status");
/** Opens the Steam client itself (no game launch). */
export const steamOpenClient = () => invoke<void>("steam_open_client");
/** Opens Steam's own Downloads window (pause and queue live there). */
export const steamOpenDownloads = () => invoke<void>("steam_open_downloads");
export const steamListInstalled = () => invoke<SteamGame[]>("steam_list_installed");

/** Games family members share with the signed-in account (Steam Families). */
export const steamFamilySharedApps = (force = false) =>
  invoke<SteamSharedGame[]>("steam_family_shared_apps", { force });

/** One app's metadata, read from the Steam client's own `appcache/appinfo.vdf`. */
export interface SteamAppMetadata {
  developer?: string;
  genres: string[];
  releaseYear?: number;
  oslist?: string;
}

/** App id → client-cached studio, genres and release year. */
export const steamAppMetadata = () => invoke<Record<string, SteamAppMetadata>>("steam_app_metadata");

/** ProtonDB's community Linux/Steam Deck compatibility tier. */
export interface ProtonDbSummary {
  tier: string;
  bestReportedTier: string | null;
  trendingTier: string | null;
  confidence: string | null;
  score: number | null;
  total: number | null;
}

export const steamProtonDbSummary = (appId: string, offline = false) =>
  invoke<ProtonDbSummary | null>("steam_protondb_summary", { appId, offline });

/** Are We Anti-Cheat Yet?'s Linux/Wine status for a Steam app. */
export interface AntiCheatStatus {
  status: string;
  anticheats: string[];
  slug: string;
}

export const steamAntiCheatStatus = (appId: string, offline = false) =>
  invoke<AntiCheatStatus | null>("steam_anticheat_status", { appId, offline });

/** The same anti-cheat row for an Epic catalog namespace. */
export const epicAntiCheatStatus = (namespace: string, offline = false) =>
  invoke<AntiCheatStatus | null>("epic_anticheat_status", { namespace, offline });

/** Valve's Steam Deck category: 1 unsupported, 2 playable, 3 verified. */
export interface DeckStatus {
  category: number;
}

export const steamDeckStatus = (appId: string, offline = false) =>
  invoke<DeckStatus | null>("steam_deck_status", { appId, offline });

/** One Steam transfer, with the byte counter moved forward since the last exact sample. */
export interface SteamLiveDownload {
  appId: string;
  bytesDownloaded: number;
  bytesToDownload: number;
  bytesPerSec: number;
}

/** Live download rows. Steam does not write the byte total every second. */
export const steamDownloadLive = () => invoke<SteamLiveDownload[]>("steam_download_live");
export const steamCloudStatus = (appId: string) =>
  invoke<{ appId: string; lastSync: number | null }>("steam_cloud_status", { appId });
/** Hands an action (launch/install/uninstall/validate) to the Steam client. */
export const steamGameAction = (appId: string, action: "launch" | "install" | "update" | "uninstall" | "validate") =>
  invoke<void>("steam_game_action", { appId, action });
/** After a launch: hide Steam's window, then quit Steam when the game closes. */
export const steamWatchSession = (appId: string) =>
  invoke<void>("steam_watch_session", { appId });
/** Steam's own Running flag, so games started outside the launcher show up. */
export const steamWatchRunning = () =>
  invoke<string[]>("steam_watch_running");
export const steamSyncPlaytime = () =>
  invoke<Record<string, SteamPlaytime>>("steam_sync_playtime");
export const steamGetGameDetails = (appId: string, language?: string, force = false) =>
  invoke<SteamGameDetails>("steam_get_game_details", { appId, language: language ?? null, force });

/** One Steam store search hit (used for companion games' specs and add-ons). */
export interface SteamStoreHit {
  appId: string;
  name: string;
}

/**
 * Finds the Steam store app whose title matches exactly, or null. The match is
 * exact so another game's requirements can never appear on the page.
 */
export const steamFindStoreApp = (query: string, language?: string) =>
  invoke<SteamStoreHit | null>("steam_find_store_app", { query, language: language ?? null });

/* ---------- Achievements (opt-in: needs a Steam Web API key) ---------- */

export const steamGetApiKey = () => invoke<string | null>("steam_get_api_key");
export const steamSetApiKey = (apiKey: string) => invoke<void>("steam_set_api_key", { apiKey });

/**
 * Imports the Steam library collections (read-only) and returns the merged
 * collection list plus the games the user hid in Steam.
 */
export const steamImportCollections = () =>
  invoke<import("./epic").CollectionImport>("steam_import_collections");

export interface SteamLibraryArt {
  cover: string;
  hero: string;
}

/** Current library portraits and heroes for app ids whose flat CDN capsule 404s. */
export const steamLibraryArt = (appIds: string[]) =>
  invoke<Record<string, SteamLibraryArt>>("steam_library_art", { appIds });
/** Schema + the player's unlocks + global rarity; cached on disk for an hour. */
export const steamGetAchievements = (appId: string, force = false) =>
  invoke<import("./epic").EpicAchievementsData>("steam_get_achievements", { appId, force });

/**
 * Achievements for a custom/emulator-owned title: definitions from the public
 * Steam Community schema, unlocks from the local achievements.ini/json.
 */
export const steamGetEmulatorAchievements = (
  appId: string,
  force = false,
  installDir?: string,
) =>
  invoke<import("./epic").EpicAchievementsData>("steam_get_emulator_achievements", {
    appId,
    force,
    installDir: installDir ?? null,
  });
/** Cached summaries for library covers (disk only, no network). */
export const steamGetAchievementsSummary = () =>
  invoke<Record<string, import("./epic").EpicAchievementSummary>>("steam_get_achievements_summary");

export interface SteamGuideHit {
  title: string;
  url: string;
  author: string;
  description: string;
  rating?: number | null;
}

export interface SteamThreadHit {
  title: string;
  url: string;
  snippet: string;
  replies: number;
  date: string;
}

export interface SteamAchievementCommunity {
  guides: SteamGuideHit[];
  threads: SteamThreadHit[];
  supported: boolean;
}

/**
 * Public Steam Community guides and discussions for one achievement. Results
 * are cached by the backend for a day; the rows open the real pages.
 */
export const steamGetAchievementCommunity = (appId: string, query: string) =>
  invoke<SteamAchievementCommunity>("steam_get_achievement_community", { appId, query });
export interface AchievementSourceConfig {
  mode: "auto" | "custom" | "disabled";
  customPath?: string;
  detectedPath?: string;
}

export const steamGetAchievementSource = (appId: string) =>
  invoke<AchievementSourceConfig>("steam_get_achievement_source", { appId });

export const steamSetAchievementSource = (appId: string, mode: string, customPath?: string) =>
  invoke<void>("steam_set_achievement_source", { appId, mode, customPath });

export const steamDetectAchievementPath = (appId: string) =>
  invoke<string | null>("steam_detect_achievement_path", { appId });

export interface AchievementNotificationOptions {
  enabled: boolean;
  sound: boolean;
  overlay: boolean;
  volume: number;
  durationMs: number;
  position: string;
  size: string;
  customSound: boolean;
  customSoundName: string | null;
  /** "gold", "launcher", "rarity", "cyber", "emerald", "crimson", or "amethyst". */
  cardTheme: string;
  /** "prism", "cyber", "shatter", or "jackpot". */
  animStyle: string;
}

/** The card palette, resolved from the live CSS tokens by the frontend. */
export interface AchievementCardColors {
  background: string;
  accent: string;
  border: string;
  icon: string;
  title: string;
  body: string;
}

export const achievementGetNotificationOptions = () =>
  invoke<AchievementNotificationOptions>("achievement_get_notification_options");

export const achievementSetNotificationOptions = (options: AchievementNotificationOptions) =>
  invoke<void>("achievement_set_notification_options", { options });

export const achievementSetNotificationColors = (colors: AchievementCardColors) =>
  invoke<void>("achievement_set_notification_colors", { colors });

export const achievementTestNotification = (
  title: string,
  body: string,
  tag?: string,
  rarityTier?: number,
) =>
  invoke<void>("achievement_test_notification", {
    title,
    body,
    tag,
    rarityTier: rarityTier ?? null,
  });

export const achievementPickCustomSound = () =>
  invoke<string | null>("achievement_pick_custom_sound");

export const achievementClearCustomSound = () =>
  invoke<void>("achievement_clear_custom_sound");

export const steamStartAchievementWatcher = (appId: string) =>
  invoke<void>("steam_start_achievement_watcher", { appId });

export const steamStartEmulatorWatcher = (appId: string, installDir?: string) =>
  invoke<void>("steam_start_emulator_watcher", { appId, installDir: installDir ?? null });

export const steamStopAchievementWatcher = (appId: string) =>
  invoke<void>("steam_stop_achievement_watcher", { appId });
/**
 * Screenshots taken by the Steam client for one app (read-only gallery: the
 * files belong to the client, so they are never edited or deleted here).
 */
export const steamGetGameScreenshots = (appId: string) =>
  invoke<import("./epic").GameScreenshotItem[]>("steam_get_game_screenshots", { appId });

/** Full-resolution data URL for one Steam screenshot, read on demand. */
export const steamGetScreenshotFullData = (appId: string, filePath: string) =>
  invoke<string>("steam_get_screenshot_full_data", { appId, filePath });

/* ---------- Account sign-in (ROADMAP §13, the web auth flow) ---------- */

/** Sign-in state from `steam_login_begin` / `steam_login_code` / `steam_login_status`. */
export interface SteamLoginStatus {
  /** `idle` | `code` | `confirm` | `pending` | `signed_in` */
  state: "idle" | "code" | "confirm" | "pending" | "signed_in";
  accountName: string;
  steamId: string;
  /** Email domain hint when Steam Guard sent a code by mail. */
  emailHint: string;
  /** Poll interval suggested by Steam, in seconds. */
  interval: number;
  /**
   * Steam also accepts a one-tap approval in the mobile app (or an email link)
   * for this session, so the code is optional.
   */
  confirm: boolean;
}

/** One owned Steam game read through `IPlayerService/GetOwnedGames`. */
export interface SteamOwnedGame {
  appId: string;
  name: string;
  /** Total playtime in minutes (Steam's own unit). */
  playtimeForever: number;
  playtimeTwoWeeks: number;
  iconUrl: string;
}

export interface SteamOwnedGames {
  gameCount: number;
  games: SteamOwnedGame[];
}

/** One game shared with the account through Steam Families. */
export interface SteamSharedGame {
  appId: string;
  name: string;
  /** True when this is the account's own copy inside the family group. */
  owned: boolean;
  /** Steam ids of the members whose copy is being shared. */
  ownerSteamIds: string[];
}

/**
 * Starts a sign-in: the password is sent RSA encrypted for this one request and
 * is never stored. `remember` seals the refresh token with Windows DPAPI.
 */
export const steamLoginBegin = (accountName: string, password: string, remember: boolean) =>
  invoke<SteamLoginStatus>("steam_login_begin", { accountName, password, remember });
/** QR sign-in: the phone scans the code; no password is involved. */
export interface SteamQrLogin {
  challengeUrl: string;
  /** Inline SVG markup for the QR code. */
  svg: string;
  interval: number;
}
export const steamLoginQrBegin = (remember = true) =>
  invoke<SteamQrLogin>("steam_login_qr_begin", { remember });
/** Submits the Steam Guard code (email or mobile authenticator). */
export const steamLoginCode = (code: string) => invoke<SteamLoginStatus>("steam_login_code", { code });
/**
 * Reports the current session, and polls the pending sign-in while one exists
 * (no login in flight means no network request at all).
 */
export const steamLoginStatus = () => invoke<SteamLoginStatus>("steam_login_status");
/** Drops the session from memory and deactivates the sealed token file. */
export const steamLogout = () => invoke<void>("steam_logout");

/** One saved Steam account in the vault (sealed refresh token). */
export interface SteamSavedAccount {
  steamId: string;
  accountName: string;
  lastUsed: number;
  isActive: boolean;
}

export const steamGetSavedAccounts = () => invoke<SteamSavedAccount[]>("steam_get_saved_accounts");
export const steamSwitchAccount = (steamId: string) =>
  invoke<SteamLoginStatus>("steam_switch_account", { steamId });
export const steamRemoveSavedAccount = (steamId: string) =>
  invoke<void>("steam_remove_saved_account", { steamId });
/** Every owned game (installed or not); refreshes the access token silently. */
export const steamOwnedGames = (force = false) =>
  invoke<SteamOwnedGames>("steam_owned_games", { force });
