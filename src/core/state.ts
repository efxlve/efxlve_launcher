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
import { EPIC_STORE_URL } from "../epic";
import { initialLanguage } from "../i18n";
import {
  APP_AUTO_UPDATE_KEY,
  CUSTOM_AVATARS_KEY,
  CUSTOM_COVERS_KEY,
  CUSTOM_HEROES_KEY,
  DEMO_PLAT_KEY,
  FAV_KEY,
  HIDDEN_KEY,
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
  loadStrSet,
} from "./constants";
import type { AppNotification, AppUpdateStatus, DlMetrics, DrawerTab, EpicFilter, EpicPhase, EpicSort, EpicViewMode, SavedAccount, SettingsSection, View } from "./types";
import type { CriticData, DlQueueStatus, EglDetectedGame, EosOverlayStatus, EpicFriend, EpicAchievementSummary, EpicAchievementsData, EpicGame, EpicPlayerProfile, EpicSettings, EpicSummary, GameCollection, GameDlcResponse, GameInstallOptions, GameLocalSettings, GameRequirementsResponse, GameScreenshotItem, GameUpdateInfo, HltbData, MoveGameProgress, PlaytimeRecord, SaveBackupInfo, SetupStatus, SteamGridGame, SteamGridImage, SystemDriveInfo, ThirdPartyLauncher } from "../epic";


function loadJsonRecord(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
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
  customCovers: loadJsonRecord(CUSTOM_COVERS_KEY),
  customHeroes: loadJsonRecord(CUSTOM_HEROES_KEY),
  customAvatars: loadJsonRecord(CUSTOM_AVATARS_KEY),
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
  loadingSteamAboutFor: (null) as string | null,
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
  screenshotCompressionEnabled: (localStorage.getItem(SS_COMPRESS_KEY) === "true") as boolean,
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
  activeAchScope: ("all") as "all" | "base" | "dlc",
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
  epicFav: (loadStrSet(FAV_KEY)) as Set<string>,
  hiddenGames: (loadStrSet(HIDDEN_KEY)) as Set<string>,
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
  presenceEnabled: true,
  preferredCdn: "",
  eosOverlay: (null) as EosOverlayStatus | null,
  eosSupportMap: new Map<string, boolean>(),
  friends: ([]) as EpicFriend[],
  friendsLoading: false,
  friendsError: "",
  notifications: ([]) as AppNotification[],
  notifOpen: false,
  studioFilter: "",
  settingsSection: ("downloads") as SettingsSection,
  profileCardCount: PROFILE_CARD_CHUNK as number,
  settingsIntegrationsLoaded: false,
  settingsIntegrationsLoading: false,
  minimizeToTray: (localStorage.getItem(MINIMIZE_TRAY_KEY) === "true") as boolean,
  showCoverStats: (localStorage.getItem(COVER_STATS_KEY) !== "false") as boolean,
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
  appVersion: "0.1.0",
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
 * Resolves the custom avatar for the given account or the current logged-in account.
 * Checks accountId, playerProfileData.account_id, epicAccountId, and epicAccount.
 */
export function getCustomAvatar(accountId?: string | null): string | null {
  if (accountId && S.customAvatars[accountId]) {
    return S.customAvatars[accountId];
  }
  if (S.playerProfileData?.account_id && S.customAvatars[S.playerProfileData.account_id]) {
    return S.customAvatars[S.playerProfileData.account_id];
  }
  if (S.epicAccountId && S.customAvatars[S.epicAccountId]) {
    return S.customAvatars[S.epicAccountId];
  }
  if (S.epicAccount && S.customAvatars[S.epicAccount]) {
    return S.customAvatars[S.epicAccount];
  }
  return S.customAvatars["default"] || null;
}

