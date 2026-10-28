/**
 * Central shared mutable application state.
 *
 * All cross-feature state lives here as properties of a single object so that
 * any module can read and write it without importing mutable bindings (which ES
 * modules do not allow). Feature modules import { S } and mutate its fields
 * directly.
 *
 * This file is intentionally free of logic; it only declares state.
 */
import { EPIC_STORE_URL, type CloudBackupSettings, type CloudBackupEntry } from "../epic";
import { initialLanguage, t } from "../i18n";
import type { MtuProbe } from "../net-diag";
import {
  APP_AUTO_UPDATE_KEY,
  CUSTOM_AVATARS_KEY,
  CUSTOM_PROFILE_NAME_KEY,
  CUSTOM_PROFILE_BANNERS_KEY,
  CUSTOM_COVERS_KEY,
  CUSTOM_HEROES_KEY,
  DEMO_PLAT_KEY,
  FAV_KEY,
  HIDDEN_ACH_KEY,
  HIDDEN_KEY,
  HIDDEN_STORES_KEY,
  IGNORED_UPDATES_KEY,
  AUTO_BACKUP_KEY,
  AUTO_SHORTCUT_KEY,
  AUTO_UPDATE_KEY,
  AUTO_UPDATE_TIME_KEY,
  INITIAL_CARD_CHUNK,
  MINIMIZE_TRAY_KEY,
  MINIMIZE_ON_GAME_KEY,
  COVER_STATS_KEY,
  SURFACE_KEY,
  APP_ICON_KEY,
  CUSTOM_APP_ICON_KEY,
  PAUSE_ON_PLAY_KEY,
  STEAM_EXIT_AFTER_PLAY_KEY,
  PROFILE_CARD_CHUNK,
  PROFILE_VIEW_MODE_KEY,
  RECENT_KEY,
  REVEALED_ACH_KEY,
  SS_COMPRESS_KEY,
  SS_FORMAT_KEY,
  SS_HOTKEY_KEY,
  SS_HOTKEY_NAME_KEY,
  SS_QUALITY_KEY,
  SPEED_BITS_KEY,
  COVER_TITLES_KEY,
  STORE_BADGE_KEY,
  STORE_ICONS_KEY,
  CASE_COVERS_KEY,
  CASE_COVER_STYLE_KEY,
  normalizeCaseCoverStyle,
  type CaseCoverStyle,
  CASE_SHOW_LOGO_KEY,
  CASE_SHOW_NAME_KEY,
  CASE_SHOW_OS_KEY,
  CASE_GLARE_KEY,
  CASE_TILT_KEY,
  CASE_SHELF_SHADOW_KEY,
  CASE_GLOSS_KEY,
  normalizeCaseGloss,
  type CaseGloss,
  CASE_COLOR_MODE_KEY,
  CASE_STORE_COLORS_KEY,
  normalizeCaseColorMode,
  type CaseColorMode,
  SEPARATE_COPIES_KEY,
  FULLSCREEN_AUTO_KEY,
  FULLSCREEN_MODE_KEY,
  isSteamDeckDevice,
  INSTALLED_ICON_KEY,
  HIGHLIGHT_INSTALLED_KEY,
  SHOW_SHARED_LIBRARY_KEY,
  DIM_UNINSTALLED_KEY,
  CONTRAST_TITLES_KEY,
  LIB_PAGE_SIZE_KEY,
  STARTUP_TAB_KEY,
  PREFERRED_VERSION_KEY,
  SOURCE_FILTER_KEY,
  LIB_PAGINATION_KEY,
  normalizeLibraryPageSize,
  loadStrSet,
  loadFolderSizes,
  loadTabSorts,
  saveTabSort,
  type SortTab,
} from "./constants";
import { initialReduceEffects } from "./effects";
import { loadGameStatus, loadUiScale } from "./game-status";
import { readCustomCss } from "./custom-css";
import { normalizeSurface } from "./themes";
import type { StartupTab, AppNotification, AppUpdateStatus, ControllerKind, DlMetrics, DrawerTab, EpicFilter, EpicPhase, EpicSort, EpicViewMode, GameSource, GogPhase, LibraryItem, SavedAccount, SettingsSection, View } from "./types";
import type { CriticData, ControllerSupportStatus, DlQueueStatus, EglDetectedGame, EosOverlayStatus, EpicAchievementSummary, EpicAchievementsData, EpicGame, EpicPlayerProfile, EpicSettings, EpicSummary, GameCollection, GameDlcResponse, GameInstallOptions, GameLocalSettings, GameRequirementsResponse, GameScreenshotItem, GameUpdateInfo, HltbData, MoveGameProgress, PlaytimeRecord, SaveBackupInfo, SetupStatus, SteamGridGame, SteamGridImage, SystemDriveInfo } from "../epic";


const ALL_STORES: readonly GameSource[] = ["epic", "gog", "amazon", "steam", "ea", "ubisoft", "xbox", "battlenet", "riot", "custom"];

/** Stores left on in the library filter. An empty or broken save means all of them. */
function loadEnabledStores(): Set<GameSource> {
  try {
    const raw = localStorage.getItem(SOURCE_FILTER_KEY);
    if (!raw) return new Set(ALL_STORES);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set(ALL_STORES);
    const next = new Set<GameSource>();
    for (const item of parsed) {
      if (typeof item === "string" && (ALL_STORES as readonly string[]).includes(item)) {
        next.add(item as GameSource);
      }
    }
    // Amazon Games joined the filter after it shipped: existing saves predate
    // the store, so enable it once instead of hiding the new library.
    next.add("amazon");
    next.add("custom");
    return next.size > 0 ? next : new Set(ALL_STORES);
  } catch {
    return new Set(ALL_STORES);
  }
}

function loadJsonRecord(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Key of the combined profile's photo (sidebar chip and Overview header). */
export const GLOBAL_AVATAR_KEY = "global";

/**
 * One-time migration of the legacy avatar store: the old shared photo lived
 * under `default`; it becomes the combined profile's photo. Bare account ids
 * (pre-namespacing) keep working through `avatarFor`'s alias lookup.
 */
function migrateAvatarKeys(store: Record<string, string>): Record<string, string> {
  const legacy = store["default"];
  if (legacy && !store[GLOBAL_AVATAR_KEY]) {
    store[GLOBAL_AVATAR_KEY] = legacy;
    delete store["default"];
    try {
      localStorage.setItem(CUSTOM_AVATARS_KEY, JSON.stringify(store));
    } catch {
      // Storage blocked: the in-memory migration still applies for this session.
    }
  }
  return store;
}

/** Drops retired sort ids (updates, platinum) so a stored value still matches the menu. */
function normalizeEpicSort(saved: string | null): EpicSort {
  if (saved === "alpha" || saved === "alphaDesc" || saved === "recent" || saved === "played" || saved === "achievements" || saved === "installed") return saved;
  if (saved === "platinum") return "achievements";
  return saved ? "alpha" : "recent";
}

/** Sort orders restored from storage, one per library tab. */
const savedTabSorts = loadTabSorts(normalizeEpicSort(localStorage.getItem("efxlve-sort")));

function readStartupTab(): StartupTab {
  const saved = localStorage.getItem(STARTUP_TAB_KEY);
  if (saved && typeof saved === "string") return saved;
  return "all";
}
const initialStartupTab = readStartupTab();

function initialLibraryConfig(tab: string, sorts: Record<SortTab, EpicSort>): {
  activeCol: string | null;
  filter: EpicFilter;
  sort: EpicSort;
} {
  if (tab === "installed") {
    return { activeCol: null, filter: "installed", sort: sorts.installed ?? sorts.all };
  }
  if (tab === "fav") {
    return { activeCol: "fav", filter: "all", sort: sorts.fav ?? sorts.all };
  }
  if (tab === "recent") {
    return { activeCol: null, filter: "all", sort: "recent" };
  }
  if (tab === "platinum") {
    return { activeCol: null, filter: "platinum", sort: sorts.platinum ?? sorts.all };
  }
  if (tab === "uncategorized") {
    return { activeCol: "uncategorized", filter: "all", sort: sorts.collections ?? sorts.all };
  }
  if (tab.startsWith("col:")) {
    return { activeCol: tab.slice(4), filter: "all", sort: sorts.collections ?? sorts.all };
  }
  return { activeCol: null, filter: "all", sort: sorts.all };
}
const initialLibConfig = initialLibraryConfig(initialStartupTab, savedTabSorts);

/** Library tab whose sort order is in effect right now. */
export function currentSortTab(): SortTab {
  if (S.epicFilter === "installed") return "installed";
  if (S.epicFilter === "platinum") return "platinum";
  if (S.epicFilter === "updates") return "updates";
  if (S.activeCollectionId === "fav") return "fav";
  if (S.activeCollectionId && S.activeCollectionId !== "all") return "collections";
  return "all";
}

/** Apply the sort order the tab that is now open remembers. */
export function applyTabSort(): void {
  S.epicSort = S.tabSorts[currentSortTab()];
}

/** Remember a sort order for the open tab and make it active. */
export function setTabSort(sort: EpicSort): void {
  const tab = currentSortTab();
  S.tabSorts[tab] = sort;
  saveTabSort(tab, sort);
  // Keep the retired single value in step, so a brand new tab starts from the
  // most recent choice instead of the built-in default.
  localStorage.setItem("efxlve-sort", sort);
  S.epicSort = sort;
}

export const S = {
  view: ("library") as View,
  lastNonStoreView: ("library") as Exclude<View, "store">,
  /** Accounts page: show the sign-in form under an already connected Epic account. */
  accountsAddMode: false,
  storeShown: false,
  activeStore: ("epic") as "epic" | "gog" | "steam" | "battlenet" | "ubisoft" | "ea" | "xbox" | "luna",
  /** Store ids hidden from the Stores bar (Settings > Appearance). */
  hiddenStores: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HIDDEN_STORES_KEY) || "[]") as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set<string>();
    }
  })() as Set<string>,
  /** True while the active storefront webview is still loading its first page. */
  storeLoading: false,
  epicPhase: "checking" as EpicPhase,
  activeDrawerTab: "overview" as DrawerTab,
  epicBooted: false,
  epicAccount: "",
  epicAccountId: (null) as string | null,
  savedAccounts: ([]) as SavedAccount[],
  lastStoreUrl: EPIC_STORE_URL,
  epicSummaries: ([]) as EpicSummary[],
  epicSkippedCount: 0,
  epicError: "",
  epicBusy: "",
  authLoading: false,
  authStage: null as null | "authenticating" | "syncing" | "trophies" | "ready",
  authProgress: 0,
  authStageText: "",
  setupInfo: (null) as SetupStatus | null,
  setupProgress: (null) as number | null,
  setupMessage: "",
  epicBusyMsg: "",
  epicSyncing: false,
  epicSyncNote: "",
  epicGamesRaw: ([]) as EpicGame[],
  epicGamesRawMap: (new Map()) as Map<string, EpicGame>,
  epicSummariesMap: (new Map()) as Map<string, EpicSummary>,
  gogPhase: ("checking") as GogPhase,
  gogBooted: false,
  gogAccount: "",
  gogAccountId: (null) as string | null,
  gogError: "",
  gogBusy: "",
  gogSyncing: false,
  gogSyncNote: "",
  gogSavedAccounts: ([]) as import("../gog").SavedGogAccount[],
  gogAccountsAddMode: false,
  gogDefaultDir: "",
  gogGalaxyDetected: ([]) as import("../gog").GalaxyDetectedGame[],
  gogGalaxySyncing: false,
  gogUpdates: (new Map()) as Map<string, import("../gog").GogUpdateInfo>,
  /** Storefronts included in the library. More than one can be on at once. */
  enabledStores: loadEnabledStores(),
  /** Advanced library filter facets; empty sets mean no constraint. */
  libFilters: {
    status: new Set(),
    playtime: new Set(),
    size: new Set(),
    genres: new Set(),
    years: new Set(),
    developers: new Set(),
  } as import("./types").LibFilters,
  /** True while the advanced filter slide-over is open. */
  isFilterPanelOpen: false,
  /** Bumped on every facet change so pagination and the card chunk restart. */
  libFiltersRev: 0,
  /** Canonical title → chosen library key, so playtime and trophies stay on that copy. */
  preferredVersions: loadJsonRecord(PREFERRED_VERSION_KEY),
  /** Games in the current library result (filters applied). -1 until the grid is built. */
  libraryVisibleCount: -1,
  gogSummaries: ([]) as LibraryItem[],
  gogSummariesMap: (new Map()) as Map<string, LibraryItem>,
  /** Amazon Games (Nile) items, keyed `amazon::<product id>`. */
  amazonSummaries: ([]) as LibraryItem[],
  steamSummaries: ([]) as LibraryItem[],
  steamSummariesMap: (new Map()) as Map<string, LibraryItem>,
  achievementNotificationOptions: {
    enabled: true,
    sound: true,
    overlay: true,
    volume: 100,
    durationMs: 5000,
    position: "top-right",
    size: "normal",
    customSound: false,
    customSoundName: null,
    cardTheme: "gold",
    animStyle: "prism",
    exitStyle: "auto",
    disabledStores: [],
  } as import("../steam").AchievementNotificationOptions,
  customGames: ([]) as import("../custom-games").CustomGame[],
  customSummaries: ([]) as LibraryItem[],
  customSummariesMap: (new Map()) as Map<string, LibraryItem>,
  isAddCustomGameOpen: false,
  gogGamesRaw: ([]) as unknown[],
  gogGamesRawMap: (new Map()) as Map<string, unknown>,
  allGamesMap: (new Map()) as Map<string, LibraryItem>,
  customCovers: loadJsonRecord(CUSTOM_COVERS_KEY),
  customHeroes: loadJsonRecord(CUSTOM_HEROES_KEY),
  customAvatars: migrateAvatarKeys(loadJsonRecord(CUSTOM_AVATARS_KEY)),
  customProfileName: (localStorage.getItem(CUSTOM_PROFILE_NAME_KEY) || "") as string,
  customProfileBanners: loadJsonRecord(CUSTOM_PROFILE_BANNERS_KEY),
  steamGridApiKey: (null) as string | null,
  /** IGDB: the credentials live sealed in Rust; these are for the settings row. */
  igdbConfigured: false,
  igdbClientId: "" as string,
  /** Which transport is active, and the proxy address in use. */
  igdbMode: "off" as "direct" | "proxy" | "off",
  igdbProxyUrl: "" as string,
  /** null until probed; false means the shared proxy is not deployed. */
  igdbProxyReachable: null as boolean | null,
  /** Game clip recording, mirrored from the Rust recorder. */
  clipRecording: false,
  clipTitle: "" as string,
  showSettingsIgdbSecret: false,
  /** The cover modal's own IGDB search. */
  igdbCoverQuery: "",
  igdbCoverHits: [] as {
    id: number;
    name: string;
    year: number | null;
    coverId: string;
    artworks: string[];
    screenshots: string[];
  }[],
  igdbCoverLoading: false,
  igdbCoverError: "",
  customCoverActiveTab: ("steamgrid") as "steamgrid" | "igdb" | "url" | "file",
  activeCoverTarget: ("cover") as "cover" | "hero",
  sgdbSearchQuery: "",
  sgdbAssetType: ("grids") as "grids" | "heroes",
  sgdbActiveStyle: "",
  sgdbIsSearching: false,
  sgdbErrorMsg: "",
  sgdbGamesList: ([]) as SteamGridGame[],
  sgdbSelectedGameId: (null) as number | null,
  sgdbCoversList: ([]) as SteamGridImage[],
  sgdbSelectedCoverUrl: "",
  activeCustomCoverAppName: "",
  showSettingsSgdbKey: false,
  showModalSgdbKey: false,
  showModalSgdbInfo: false,
  loadedHltb: (new Map()) as Map<string, HltbData>,
  loadingHltbFor: new Set<string>(),
  loadedCritic: (new Map()) as Map<string, CriticData>,
  loadingCriticFor: new Set<string>(),
  loadingAboutFor: new Set<string>(),
  appLanguage: initialLanguage(),
  epicCollections: ([]) as GameCollection[],
  startupTab: initialStartupTab as StartupTab,
  activeCollectionId: initialLibConfig.activeCol as string | null,
  epicFilter: initialLibConfig.filter as EpicFilter,
  /** Sort order remembered per library tab (All, Installed, Favorites, ...). */
  tabSorts: savedTabSorts,
  epicSort: initialLibConfig.sort,
  epicViewMode: (localStorage.getItem("efxlve-view-mode") === "list" ? "list" : "grid") as EpicViewMode,
  epicAchSummaries: ({}) as Record<string, EpicAchievementSummary>,
  demoPlatinumApps: (loadStrSet(DEMO_PLAT_KEY)) as Set<string>,
  loadedAchievements: (new Map()) as Map<string, EpicAchievementsData>,
  loadingAchFor: new Set<string>(),
  screenshotHotkey: (Number(localStorage.getItem(SS_HOTKEY_KEY)) || 0x7B) as number,
  screenshotHotkeyName: (localStorage.getItem(SS_HOTKEY_NAME_KEY) || "F12") as string,
  screenshotCompressionEnabled: (localStorage.getItem(SS_COMPRESS_KEY) !== "false") as boolean,
  screenshotCompressionFormat: ((localStorage.getItem(SS_FORMAT_KEY) as "avif" | "webp" | "jpg") || "avif") as "avif" | "webp" | "jpg",
  screenshotCompressionQuality: (Number(localStorage.getItem(SS_QUALITY_KEY)) || 0.85) as number,
  isRecordingScreenshotHotkey: false,
  PRESET_HOTKEYS: ([
  { code: 0x7B, name: "F12" },
  { code: 0x7A, name: "F11" },
  { code: 0x79, name: "F10" },
  { code: 0x78, name: "F9" },
  { code: 0x77, name: "F8" },
  { code: 0x76, name: "F7" },
  { code: 0x75, name: "F6" },
  { code: 0x74, name: "F5" },
  { code: 0x2C, name: "Print Screen (PrtScn)" },
  { code: 0x91, name: "Scroll Lock" },
  { code: 0x13, name: "Pause / Break" },
  { code: 0x2D, name: "Insert" },
  { code: 0x24, name: "Home" },
]) as { code: number; name: string }[],
  loadedScreenshots: (new Map()) as Map<string, GameScreenshotItem[]>,
  /** Full-resolution data URLs for the galleries a consumer is viewing now. */
  screenshotFullSrc: new Map<string, string>(),
  /** Grid previews the WebView built for files the backend cannot read. */
  screenshotPreviewSrc: new Map<string, string>(),
  loadingScreenshotsFor: new Set<string>(),
  activeLightboxScreenshot: (null) as { appName: string; index: number } | null,
  activeShareScreenshot: (null) as { appName: string; item: GameScreenshotItem } | null,
  activeAchFilter: ("all") as "all" | "unlocked" | "locked" | "hidden" | "near" | "edited",
  achTierFilter: ("all") as "all" | "platinum" | "gold" | "silver" | "bronze",
  achSearchQuery: "",
  achSortOrder: ("default") as "default" | "rarity" | "xp" | "date",
  /** Hidden achievements whose spoiler is open; kept across sessions. */
  revealedAchievements: (loadStrSet(REVEALED_ACH_KEY)) as Set<string>,
  currentModalAppName: (null) as string | null,
  achSourceModalOpen: (null) as string | null,
  /** Game whose launcher-only achievement state editor is open. */
  achEditPanelOpen: (null) as string | null,
  /** Achievement name whose detail view is open in the game page. */
  achDetail: (null) as string | null,
  /** Steam guide/thread answers keyed by `<appName>:<achievement>`. */
  achCommunity: (new Map()) as Map<string, import("../steam").SteamAchievementCommunity>,
  loadingAchCommunity: (new Set()) as Set<string>,
  /** PowerPyx roadmap facts keyed by library app name. */
  powerpyxGuides: (new Map()) as Map<string, import("../guides").PowerPyxGuide>,
  loadingPowerpyx: (new Set()) as Set<string>,
  loadedRequirements: (new Map()) as Map<string, GameRequirementsResponse>,
  loadingReqFor: new Set<string>(),
  activeSystemPlatform: ("Windows") as string,
  /** Which requirements table the sidebar shows: the minimum or the recommended
   *  one. One choice for every game, the way a reader tends to look at one. */
  reqTab: ("min") as "min" | "rec",
  playtimeMap: (new Map()) as Map<string, PlaytimeRecord>,
  runningGames: (new Set()) as Set<string>,
  playerProfileData: (null) as EpicPlayerProfile | null,
  profileLoading: false,
  profileError: "",
  /**
   * Bulk achievement progress from companion stores that report it with the
   * library (Xbox gamerscore today), keyed by `<store>::<id>`.
   */
  companionAchSummaries: ({}) as Record<string, EpicAchievementSummary>,
  profileFilter: ("all") as "all" | "platinum" | "in_progress" | "not_started",
  profileSort: ("progress") as "progress" | "xp" | "playtime" | "alpha",
  /** Hero chips: which store's achievements and totals the page is showing. */
  profileStore: ("all") as "all" | "epic" | "gog" | "steam" | "amazon" | "xbox" | "battlenet" | "ubisoft" | "ea" | "riot",
  profileSearchQuery: "",
  profileViewMode: (localStorage.getItem(PROFILE_VIEW_MODE_KEY) === "list" ? "list" : "grid") as "grid" | "list",
  offlineMode: false,
  networkProfile: ("balanced") as string,
  gameBackupsMap: (new Map()) as Map<string, SaveBackupInfo[]>,
  isBackingUp: false,
  cloudBackupSettings: (null) as CloudBackupSettings | null,
  cloudBackupTesting: false,
  cloudBackupSyncing: false,
  cloudBackupSyncingApp: (null) as string | null,
  cloudBackupsMap: (new Map()) as Map<string, CloudBackupEntry[]>,
  /** Remote launcher-profile archives; null until the first check. */
  launcherProfileArchives: (null) as CloudBackupEntry[] | null,
  launcherProfileLoading: false,
  /** Bulk "back up all installed games" progress while it runs. */
  cloudBulkProgress: (null) as { done: number; total: number; failed: number } | null,
  epicFav: (loadStrSet(FAV_KEY)) as Set<string>,
  hiddenGames: (loadStrSet(HIDDEN_KEY)) as Set<string>,
  ignoredUpdates: (loadStrSet(IGNORED_UPDATES_KEY)) as Set<string>,
  hiddenAchievements: (loadStrSet(HIDDEN_ACH_KEY)) as Set<string>,
  profileShowHidden: false,
  epicRecent: ([...loadStrSet(RECENT_KEY)].slice(0, 8)) as string[],
  storeMode: ("store") as "store" | "profile",
  storeResizeTimer: 0,
  storeDestroyTimer: (null) as number | null,
  query: "",
  downloads: new Map<string, { progress: number; done: boolean; title: string }>(),
  installDialogAppName: (null) as string | null,
  installDialogDir: "",
  installDialogFolder: "",
  installDialogDownloadSize: 0,
  installDialogDiskSize: 0,
  installDialogAutoUpdate: true,
  installDialogShortcut: true,
  installDialogHasOptions: false,
  installDialogLoading: false,
  selectiveInstallDir: (null) as string | null,
  pendingShortcutApps: (new Set()) as Set<string>,
  libraryPath: "—",
  ctxMenuEl: (null) as HTMLElement | null,
  activeMoveModalAppName: (null) as string | null,
  moveSystemDrives: ([]) as SystemDriveInfo[],
  selectedMoveDriveLetter: ("") as string,
  selectedMoveTargetPath: ("") as string,
  isMovingGame: (false) as boolean,
  activeMoveProgress: (null) as MoveGameProgress | null,
  dlcCache: new Map<string, GameDlcResponse>(),
  dlcSearchQuery: "",
  dlcLoading: false,
  selectiveInstallOptions: (null) as GameInstallOptions | null,
  selectedInstallTags: new Set<string>(),
  selectedDlcAppIds: new Set<string>(),
  availableUpdates: new Map<string, GameUpdateInfo>(),
  /** Bumped when summaries / updates change so the library filter cache misses. */
  libraryDataRev: 0,
  prevRenderedUpdatesCount: (-1) as number,
  prevRenderedColId: (undefined) as string | null | undefined,
  isSortDropdownOpen: false,
  isStoreDropdownOpen: false,
  storeExtensionsState: (null) as Record<string, { id: string; name: string; version: string; installed: boolean; enabled: boolean; sizeBytes: number }> | null,
  storeExtensionDownloading: (null) as string | null,
  isColDropdownOpen: false,
  verifyingMap: new Map<string, { current: number; total: number; percent: number; speed: string; detail?: string }>(),
  /** Live cloud-sync progress per app while Legendary packs and transfers saves. */
  cloudSyncProgress: new Map<string, { phase: string; uploaded: number; total: number }>(),
  /** Path-MTU problem found after a failed sync; cleared once fixed. */
  mtuIssue: (null) as MtuProbe | null,
  activeManageSettings: (null) as GameLocalSettings | null,
  manageSyncingSaves: false,
  activeDlMetrics: (null) as DlMetrics | null,
  peakNetSpeedBytes: 0,
  speedInBits: (localStorage.getItem(SPEED_BITS_KEY) === "true") as boolean,
  pauseOnPlay: (localStorage.getItem(PAUSE_ON_PLAY_KEY) === "true") as boolean,
  steamExitAfterPlay: (localStorage.getItem(STEAM_EXIT_AFTER_PLAY_KEY) === "true") as boolean,
  autoDesktopShortcut: (localStorage.getItem(AUTO_SHORTCUT_KEY) !== "false") as boolean,
  autoPausedDl: (null) as string | null,
  speedHistory: (new Array(60).fill(0)) as number[],
  diskHistory: (new Array(60).fill(0)) as number[],
  /** Steam's live transfer: sampled once a second while its card is up. */
  steamSpeedBytes: 0,
  steamPeakSpeedBytes: 0,
  steamSpeedHistory: (new Array(60).fill(0)) as number[],
  dlQueueStatus: ({ isPaused: false, queue: [] }) as DlQueueStatus,
  /** True while the active GOG gogdl process is suspended. */
  gogDlPaused: false,
  speedChartTimer: (null) as number | null,
  renderScheduled: false,
  trCollator: new Intl.Collator(initialLanguage(), { sensitivity: "base", numeric: true }),
  renderedCardCount: INITIAL_CARD_CHUNK,
  libScrollObserver: (null) as IntersectionObserver | null,
  epicSettingsCache: (null) as EpicSettings | null,
  presenceEnabled: false,
  /** Run Comet during GOG sessions so achievements unlock without Galaxy. */
  gogCometEnabled: true,
  /** Amazon Games (Nile) account state and library. */
  amazonStatus: (null) as import("../nile").NileAuthStatus | null,
  amazonGames: ([]) as import("../nile").NileGame[],
  /** Saved Amazon accounts (multi-account switcher). */
  amazonSavedAccounts: ([]) as import("../nile").SavedAmazonAccount[],
  /** Active Amazon account id (`amzn1.account.*`), null when signed out. */
  amazonAccountId: (null) as string | null,
  /** True while the Amazon card is adding another account. */
  amazonAccountsAddMode: false,
  /** PKCE material from `nile_login_begin`, kept until sign-in finishes. */
  amazonLogin: (null) as import("../nile").NileLoginData | null,
  amazonBusy: false,
  /** Live install progress per composite Amazon id. */
  amazonProgress: (new Map()) as Map<string, { percent: number; speed: number }>,
  /** Base folder Amazon Games install into (empty = Nile's default). */
  amazonInstallDir: "",
  /** Shown default when no folder is set (`<home>\Games\Amazon`). */
  amazonDefaultDir: "",
  preferredCdn: "",
  eosOverlay: (null) as EosOverlayStatus | null,
  eosSupportMap: new Map<string, boolean>(),
  /** Install-folder health per game; filled when the drawer opens. */
  copyPathStates: new Map<string, import("../epic").InstallPathState>(),
  notifications: ([]) as AppNotification[],
  notifOpen: false,
  studioFilter: "",
  settingsSection: ("account") as SettingsSection,
  profileCardCount: PROFILE_CARD_CHUNK as number,
  /** Profile page: the account whose stats are shown (`epic:<id>` / `gog:<id>`). Null = active account. */
  profileAccount: (null) as string | null,
  settingsIntegrationsLoaded: false,
  settingsIntegrationsLoading: false,
  /** Default on: closing the window keeps downloads alive in the tray. */
  minimizeToTray: (localStorage.getItem(MINIMIZE_TRAY_KEY) !== "false") as boolean,
  /** Removes motion, glass blur and hover transitions without hiding features. */
  reduceEffects: initialReduceEffects(),
  /** Personal completion label per app; see core/game-status.ts. */
  gameStatus: loadGameStatus(),
  /** 80..150, applied as a body zoom so every control scales together. */
  uiScale: loadUiScale(),
  /** Mirrors the HKCU Run entry; loaded from the backend in loadSettingsView. */
  startWithWindows: false,
  /** Every folder the screenshot gallery scans; loaded with the settings. */
  screenshotScanRoots: [] as string[],
  /** When off, the gallery reads the chosen screenshot folder only. */
  screenshotScanAll: true,
  /** When on, the chosen and added folders are walked recursively. */
  screenshotScanSubfolders: true,
  /** Bytes the picture cache holds; null until the settings ask for it. */
  pictureCacheBytes: null as number | null,
  /** Default off: only an explicit `"true"` minimizes on game start. */
  minimizeOnGame: (localStorage.getItem(MINIMIZE_ON_GAME_KEY) === "true") as boolean,
  showCoverStats: (localStorage.getItem(COVER_STATS_KEY) !== "false") as boolean,
  showCoverTitles: (localStorage.getItem(COVER_TITLES_KEY) === "true") as boolean,
  showStoreBadge: (localStorage.getItem(STORE_BADGE_KEY) === "true") as boolean,
  /** Optional: storefront mark on grid covers. */
  showStoreIcons: (localStorage.getItem(STORE_ICONS_KEY) === "true") as boolean,
  /** Optional: physical retail box frame around grid covers (store header strip + plastic case). */
  showCaseCovers: (localStorage.getItem(CASE_COVERS_KEY) === "true") as boolean,
  /** Visual design of the physical case cover when showCaseCovers is enabled. */
  caseCoverStyle: normalizeCaseCoverStyle(localStorage.getItem(CASE_COVER_STYLE_KEY)) as CaseCoverStyle,
  caseShowLogo: (localStorage.getItem(CASE_SHOW_LOGO_KEY) !== "false") as boolean,
  caseShowName: (localStorage.getItem(CASE_SHOW_NAME_KEY) !== "false") as boolean,
  caseShowOs: (localStorage.getItem(CASE_SHOW_OS_KEY) !== "false") as boolean,
  caseGlare: (localStorage.getItem(CASE_GLARE_KEY) !== "false") as boolean,
  caseTilt: (localStorage.getItem(CASE_TILT_KEY) !== "false") as boolean,
  caseShelfShadow: (localStorage.getItem(CASE_SHELF_SHADOW_KEY) !== "false") as boolean,
  caseGloss: normalizeCaseGloss(localStorage.getItem(CASE_GLOSS_KEY)) as CaseGloss,
  caseColorMode: normalizeCaseColorMode(localStorage.getItem(CASE_COLOR_MODE_KEY)) as CaseColorMode,
  caseStoreColors: (() => {
    try {
      const raw = localStorage.getItem(CASE_STORE_COLORS_KEY);
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch {
      /* ignore */
    }
    return {} as Record<string, string>;
  })(),
  /** Show each store copy of a multi-store game as its own card. Off = combined. */
  separateCopies: (localStorage.getItem(SEPARATE_COPIES_KEY) === "true") as boolean,
  /** Full Screen Mode state and auto-enter preference. */
  isFullscreen: false,
  fullscreenAutoEnter: (() => {
    try {
      const v = localStorage.getItem(FULLSCREEN_AUTO_KEY);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch {
      /* ignore */
    }
    return isSteamDeckDevice();
  })() as boolean,
  showInstalledIcon: (localStorage.getItem(INSTALLED_ICON_KEY) === "true") as boolean,
  /** Games from other saved accounts (Steam family-sharing style). Default ON. */
  sharedOwners: new Map<string, import("../epic").SharedGame>(),
  showSharedLibrary: (localStorage.getItem(SHOW_SHARED_LIBRARY_KEY) !== "false") as boolean,
  highlightInstalled: (() => {
    const direct = localStorage.getItem(HIGHLIGHT_INSTALLED_KEY);
    if (direct !== null) return direct !== "false";
    const dim = localStorage.getItem(DIM_UNINSTALLED_KEY);
    const contrast = localStorage.getItem(CONTRAST_TITLES_KEY);
    if (dim === "false" && contrast === "false") return false;
    return true;
  })() as boolean,
  dimUninstalled: (() => {
    const direct = localStorage.getItem(HIGHLIGHT_INSTALLED_KEY);
    if (direct !== null) return direct !== "false";
    return localStorage.getItem(DIM_UNINSTALLED_KEY) !== "false";
  })() as boolean,
  contrastTitles: (() => {
    const direct = localStorage.getItem(HIGHLIGHT_INSTALLED_KEY);
    if (direct !== null) return direct !== "false";
    return localStorage.getItem(CONTRAST_TITLES_KEY) !== "false";
  })() as boolean,
  libPagination: (localStorage.getItem(LIB_PAGINATION_KEY) === "true") as boolean,
  libPageSize: normalizeLibraryPageSize(localStorage.getItem(LIB_PAGE_SIZE_KEY)),
  libPage: 1,
  screenshotDir: "",
  surface: (() => {
    let v: string | null = null;
    try {
      v = localStorage.getItem(SURFACE_KEY);
      // An explicit choice wins, including any theme the registry gained later.
      if (v && normalizeSurface(v) === v) return v;
      // "epic" was the legacy key for "soft".
      if (v === "epic") return normalizeSurface("soft");

      // For existing installations without an explicit SURFACE_KEY, preserve
      // their previous experience (black) so this change does not affect current users.
      let isExistingUser = false;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k !== SURFACE_KEY && k.startsWith("efxlve-")) {
          isExistingUser = true;
          break;
        }
      }

      const picked = normalizeSurface(isExistingUser ? "black" : "soft");
      localStorage.setItem(SURFACE_KEY, picked);
      return picked;
    } catch {
      return normalizeSurface(v);
    }
  })(),
  appIcon: (() => {
    try {
      const v = localStorage.getItem(APP_ICON_KEY);
      if (v === "classic" || v === "aero" || v === "custom") return v;
      const surface = localStorage.getItem(SURFACE_KEY);
      if (surface === "gloss") return "aero";
      return "classic";
    } catch {
      return "classic";
    }
  })() as "classic" | "aero" | "custom",
  customAppIcon: (() => {
    try {
      return localStorage.getItem(CUSTOM_APP_ICON_KEY) || "";
    } catch {
      return "";
    }
  })(),
  /** Saved user stylesheet (Settings > Appearance). */
  customCss: readCustomCss(),
  autoBackupOnExit: localStorage.getItem(AUTO_BACKUP_KEY) === "true",
  autoUpdateEnabled: (localStorage.getItem(AUTO_UPDATE_KEY) === "true") as boolean,
  autoUpdateTime: (localStorage.getItem(AUTO_UPDATE_TIME_KEY) || "03:00") as string,
  epicDefaultDir: "",
  gogInstallDir: "",
  eglDetectedList: ([]) as EglDetectedGame[],
  eglSyncing: false,
  /** Safe EGL removal: the plan shown in the confirmation dialog. */
  eglRemovalPlan: (null) as import("../egl-removal").EglRemovalPlan | null,
  /** True when the Epic Games Launcher is installed on this PC. */
  eglLauncherPresent: false,
  /** Real folder sizes measured off the filesystem, shared by the views. */
  measuredSizes: loadFolderSizes(),
  /** True while the elevated removal script runs. */
  eglRemoving: false,
  /** Store client rows for Settings > Launchers. */
  launchers: ([]) as import("../epic").LauncherStatus[],
  launchersLoading: false,
  activeEditingColId: (null) as string | null,
  /** Collection whose "merge into" target list is open in Settings. */
  colMergeSource: (null) as string | null,
  /** Collection whose delete confirmation is open in Settings. */
  colDeleteConfirm: (null) as string | null,
  colModalSelectedApps: (new Set()) as Set<string>,
  colModalCoverApps: [] as string[],
  colModalSearchQuery: ("") as string,
  colModalMarker: ("") as string,
  colModalTabFilter: ("all") as "all" | "selected" | "installed",
  isMarkerPaletteOpen: (false) as boolean,
  gameColModalAppName: (null) as string | null,
  gameColModalSelectedCols: (new Set()) as Set<string>,
  resizeRaf: (null) as number | null,
  gamepadPolling: false,
  lastGamepadActionTime: 0,
  gamepadHudEl: (null) as HTMLElement | null,
  gamepadName: "",
  gamepadKind: ("generic") as ControllerKind,
  controllerBridge: (null) as ControllerSupportStatus | null,
  steamStatus: (null) as import("../steam").SteamStatus | null,
  steamGames: [] as import("../steam").SteamGame[],
  /** Installed and linked-account games from EA, Ubisoft, Xbox and Battle.net. */
  companionSummaries: [] as import("./types").LibraryItem[],
  companionStatus: [] as import("../companion").CompanionStoreStatus[],
  companionBusy: "",
  /** Per-store "close the client after playing" toggles (Integrations page). */
  companionCloseAfterPlay: {} as Record<string, boolean>,
  steamApiKey: (null) as string | null,
  steamDetails: (new Map()) as Map<string, import("../steam").SteamGameDetails>,
  /** Steam account sign-in (ROADMAP §13). `null` until the first status call. */
  steamAuth: (null) as import("../steam").SteamLoginStatus | null,
  /** UI step of the Steam card: idle → credentials → code/confirm → pending → signed_in. */
  steamAuthStep: ("idle") as "idle" | "credentials" | "code" | "confirm" | "pending" | "qr" | "signed_in",
  steamAuthBusy: false,
  /** Account name while a sign-in is in flight (shown in the code step). */
  steamAuthUser: "",
  /** QR sign-in: inline SVG + challenge URL while the phone approves. */
  steamQrSvg: "",
  steamQrUrl: "",
  /** True when the user chose the code input over the mobile-app approval. */
  steamAuthCodeMode: false,
  /** Game page store selector: dropdown list open state. */
  isVersionDropdownOpen: false,
  /** The game page's "…" menu; kept here so a late repaint cannot close it. */
  isGameMoreMenuOpen: false,
  steamOwnedCount: 0,
  /** Keys (`steam::<id>`) of games Steam Families shares with this account. */
  steamSharedIds: new Set<string>(),
  steamLibrarySyncing: false,
  /** Saved Steam accounts in the sealed vault (switcher rows). */
  steamSavedAccounts: ([]) as import("../steam").SteamSavedAccount[],
  appVersion: "0.1.38",
  appUpdateStatus: ("idle") as AppUpdateStatus,
  appUpdateVersion: "",
  appUpdateNotes: "",
  appUpdateProgress: 0,
  appUpdateDownloaded: 0,
  appUpdateTotal: 0,
  appUpdateError: "",
  lastAppUpdateCheck: 0,
  appAutoUpdate: (localStorage.getItem(APP_AUTO_UPDATE_KEY) !== "false") as boolean,
};

/**
 * Resolves the custom avatar for the given key.
 *
 * Keys are namespaced: `global` (the combined profile), `epic:<accountId>`,
 * `gog:<userId>` and `steam:<steamId>`. Legacy raw ids and the retired
 * `default` key still resolve so existing photos survive the migration.
 */
export function avatarFor(key: string): string | null {
  if (!key) return null;
  if (S.customAvatars[key]) return S.customAvatars[key];
  const raw = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  if (raw && S.customAvatars[raw]) return S.customAvatars[raw];
  return null;
}

/** Avatar for one specific account; never falls back to another account's photo. */
export function getCustomAvatar(accountId?: string | null): string | null {
  if (accountId) return avatarFor(accountId);
  if (S.epicAccountId) return avatarFor(`epic:${S.epicAccountId}`);
  if (S.gogAccountId) return avatarFor(`gog:${S.gogAccountId}`);
  return null;
}

/** The combined profile's own photo (sidebar chip and Overview header). */
export function globalAvatar(): string | null {
  return avatarFor(GLOBAL_AVATAR_KEY);
}

/** The active display name for the launcher user (custom name or localized 'User'). */
export function currentProfileName(): string {
  if (S.customProfileName && S.customProfileName.trim()) {
    return S.customProfileName.trim();
  }
  return t("profile.user");
}

