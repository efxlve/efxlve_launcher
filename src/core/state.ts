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
import { initialLanguage } from "../i18n";
import {
  APP_AUTO_UPDATE_KEY,
  CUSTOM_AVATARS_KEY,
  CUSTOM_COVERS_KEY,
  CUSTOM_HEROES_KEY,
  DEMO_PLAT_KEY,
  FAV_KEY,
  HIDDEN_ACH_KEY,
  HIDDEN_KEY,
  IGNORED_UPDATES_KEY,
  AUTO_BACKUP_KEY,
  AUTO_SHORTCUT_KEY,
  AUTO_UPDATE_KEY,
  AUTO_UPDATE_TIME_KEY,
  INITIAL_CARD_CHUNK,
  MINIMIZE_TRAY_KEY,
  COVER_STATS_KEY,
  SURFACE_KEY,
  PAUSE_ON_PLAY_KEY,
  PROFILE_CARD_CHUNK,
  RECENT_KEY,
  SS_COMPRESS_KEY,
  SS_FORMAT_KEY,
  SS_HOTKEY_KEY,
  SS_HOTKEY_NAME_KEY,
  SS_QUALITY_KEY,
  SPEED_BITS_KEY,
  COVER_TITLES_KEY,
  STORE_BADGE_KEY,
  INSTALLED_ICON_KEY,
  HIGHLIGHT_INSTALLED_KEY,
  SHOW_SHARED_LIBRARY_KEY,
  DIM_UNINSTALLED_KEY,
  CONTRAST_TITLES_KEY,
  LIB_PAGE_SIZE_KEY,
  LIB_PAGINATION_KEY,
  normalizeLibraryPageSize,
  loadStrSet,
} from "./constants";
import type { AppNotification, AppUpdateStatus, ControllerKind, DlMetrics, DrawerTab, EpicFilter, EpicPhase, EpicSort, EpicViewMode, GogPhase, LibraryItem, SavedAccount, SettingsSection, SourceFilter, View } from "./types";
import type { CriticData, ControllerSupportStatus, DlQueueStatus, EglDetectedGame, EosOverlayStatus, EpicAchievementSummary, EpicAchievementsData, EpicGame, EpicPlayerProfile, EpicSettings, EpicSummary, GameCollection, GameDlcResponse, GameInstallOptions, GameLocalSettings, GameRequirementsResponse, GameScreenshotItem, GameUpdateInfo, HltbData, MoveGameProgress, PlaytimeRecord, SaveBackupInfo, SetupStatus, SteamGridGame, SteamGridImage, SystemDriveInfo, ThirdPartyLauncher } from "../epic";


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

export const S = {
  view: ("library") as View,
  lastNonStoreView: ("library") as Exclude<View, "store">,
  /** Accounts page: show the sign-in form under an already connected Epic account. */
  accountsAddMode: false,
  storeShown: false,
  activeStore: ("epic") as "epic" | "gog",
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
  sourceFilter: ("all") as SourceFilter,
  gogSummaries: ([]) as LibraryItem[],
  gogSummariesMap: (new Map()) as Map<string, LibraryItem>,
  gogGamesRaw: ([]) as unknown[],
  gogGamesRawMap: (new Map()) as Map<string, unknown>,
  allGamesMap: (new Map()) as Map<string, LibraryItem>,
  customCovers: loadJsonRecord(CUSTOM_COVERS_KEY),
  customHeroes: loadJsonRecord(CUSTOM_HEROES_KEY),
  customAvatars: migrateAvatarKeys(loadJsonRecord(CUSTOM_AVATARS_KEY)),
  steamGridApiKey: (null) as string | null,
  customCoverActiveTab: ("steamgrid") as "steamgrid" | "url" | "file",
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
  loadingHltbFor: (null) as string | null,
  loadedCritic: (new Map()) as Map<string, CriticData>,
  loadingCriticFor: (null) as string | null,
  loadingAboutFor: (null) as string | null,
  appLanguage: initialLanguage(),
  epicCollections: ([]) as GameCollection[],
  activeCollectionId: (null) as string | null,
  epicFilter: "all" as EpicFilter,
  epicSort: normalizeEpicSort(localStorage.getItem("efxlve-sort")),
  epicViewMode: (localStorage.getItem("efxlve-view-mode") === "list" ? "list" : "grid") as EpicViewMode,
  epicAchSummaries: ({}) as Record<string, EpicAchievementSummary>,
  demoPlatinumApps: (loadStrSet(DEMO_PLAT_KEY)) as Set<string>,
  loadedAchievements: (new Map()) as Map<string, EpicAchievementsData>,
  loadingAchFor: (null) as string | null,
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
  loadingScreenshotsFor: (null) as string | null,
  activeLightboxScreenshot: (null) as { appName: string; index: number } | null,
  activeShareScreenshot: (null) as { appName: string; item: GameScreenshotItem } | null,
  activeAchFilter: ("all") as "all" | "unlocked" | "locked" | "hidden",
  achSearchQuery: "",
  achSortOrder: ("default") as "default" | "rarity" | "xp" | "date",
  revealedAchievements: (new Set()) as Set<string>,
  currentModalAppName: (null) as string | null,
  loadedRequirements: (new Map()) as Map<string, GameRequirementsResponse>,
  loadingReqFor: (null) as string | null,
  activeSystemPlatform: ("Windows") as string,
  playtimeMap: (new Map()) as Map<string, PlaytimeRecord>,
  runningGames: (new Set()) as Set<string>,
  playerProfileData: (null) as EpicPlayerProfile | null,
  profileLoading: false,
  profileError: "",
  profileFilter: ("all") as "all" | "platinum" | "in_progress" | "not_started",
  profileSort: ("progress") as "progress" | "xp" | "playtime" | "alpha",
  profileSearchQuery: "",
  offlineMode: false,
  networkProfile: ("balanced") as string,
  gameBackupsMap: (new Map()) as Map<string, SaveBackupInfo[]>,
  isBackingUp: false,
  cloudBackupSettings: (null) as CloudBackupSettings | null,
  cloudBackupTesting: false,
  cloudBackupSyncing: false,
  cloudBackupsMap: (new Map()) as Map<string, CloudBackupEntry[]>,
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
  libSearchTimer: (null) as number | null,
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
  isColDropdownOpen: false,
  isAccountSwitcherOpen: false,
  verifyingMap: new Map<string, { current: number; total: number; percent: number; speed: string; detail?: string }>(),
  activeManageSettings: (null) as GameLocalSettings | null,
  manageSyncingSaves: false,
  activeDlMetrics: (null) as DlMetrics | null,
  peakNetSpeedBytes: 0,
  speedInBits: (localStorage.getItem(SPEED_BITS_KEY) === "true") as boolean,
  pauseOnPlay: (localStorage.getItem(PAUSE_ON_PLAY_KEY) === "true") as boolean,
  autoDesktopShortcut: (localStorage.getItem(AUTO_SHORTCUT_KEY) !== "false") as boolean,
  autoPausedDl: (null) as string | null,
  speedHistory: (new Array(60).fill(0)) as number[],
  diskHistory: (new Array(60).fill(0)) as number[],
  dlQueueStatus: ({ isPaused: false, queue: [] }) as DlQueueStatus,
  speedChartTimer: (null) as number | null,
  renderScheduled: false,
  trCollator: new Intl.Collator(initialLanguage(), { sensitivity: "base", numeric: true }),
  renderedCardCount: INITIAL_CARD_CHUNK,
  libScrollObserver: (null) as IntersectionObserver | null,
  epicSettingsCache: (null) as EpicSettings | null,
  presenceEnabled: false,
  preferredCdn: "",
  eosOverlay: (null) as EosOverlayStatus | null,
  eosSupportMap: new Map<string, boolean>(),
  notifications: ([]) as AppNotification[],
  notifOpen: false,
  studioFilter: "",
  settingsSection: ("account") as SettingsSection,
  profileCardCount: PROFILE_CARD_CHUNK as number,
  /** Profile page: the account whose stats are shown (`epic:<id>` / `gog:<id>`). Null = active account. */
  profileAccount: (null) as string | null,
  settingsIntegrationsLoaded: false,
  settingsIntegrationsLoading: false,
  minimizeToTray: (localStorage.getItem(MINIMIZE_TRAY_KEY) === "true") as boolean,
  showCoverStats: (localStorage.getItem(COVER_STATS_KEY) !== "false") as boolean,
  showCoverTitles: (localStorage.getItem(COVER_TITLES_KEY) === "true") as boolean,
  showStoreBadge: (localStorage.getItem(STORE_BADGE_KEY) === "true") as boolean,
  showInstalledIcon: (localStorage.getItem(INSTALLED_ICON_KEY) === "true") as boolean,
  /** Games from other saved accounts (Steam family-sharing style). Default ON. */
  sharedLibrary: (null) as import("../epic").SharedLibraryIndex | null,
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
  surface: (localStorage.getItem(SURFACE_KEY) === "epic" ? "epic" : "black") as "black" | "epic",
  autoBackupOnExit: localStorage.getItem(AUTO_BACKUP_KEY) !== "false",
  autoUpdateEnabled: (localStorage.getItem(AUTO_UPDATE_KEY) === "true") as boolean,
  autoUpdateTime: (localStorage.getItem(AUTO_UPDATE_TIME_KEY) || "03:00") as string,
  epicDefaultDir: "",
  eglDetectedList: ([]) as EglDetectedGame[],
  eglSyncing: false,
  thirdPartyLaunchers: ([]) as ThirdPartyLauncher[],
  activeEditingColId: (null) as string | null,
  colModalSelectedApps: (new Set()) as Set<string>,
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
  appVersion: "0.1.17",
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
 * Keys are namespaced: `global` (the combined profile), `epic:<accountId>` and
 * `gog:<userId>`. Legacy raw ids and the retired `default` key still resolve so
 * existing photos survive the migration.
 */
export function avatarFor(key: string): string | null {
  if (!key) return null;
  if (S.customAvatars[key]) return S.customAvatars[key];
  const raw = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  if (raw && S.customAvatars[raw]) return S.customAvatars[raw];
  return null;
}

/** True when the key (or its legacy alias) has a photo. */
export function hasCustomAvatar(key: string): boolean {
  return avatarFor(key) !== null;
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

