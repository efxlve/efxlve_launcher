/**
 * Media archive IPC. The backend stores a game as `manifest.efxmeta.json` plus
 * one or more `*.efxpak.NNN` volumes sized for the chosen media.
 */

import { invoke } from "@tauri-apps/api/core";

export interface MediaProfileInfo {
  id: string;
  volumeBytes: number;
  frameBytes: number;
  fileSystem: string;
}

export interface ArchivePlan {
  appName: string;
  title: string;
  installPath: string;
  originalBytes: number;
  fileCount: number;
  dirCount: number;
  skippedLinks: number;
  volumeBytes: number;
  frameBytes: number;
  estimatedVolumes: number;
  targetRoot: string;
  folderName: string;
  archivePath: string;
  freeBytes: number | null;
  targetFileSystem: string | null;
  requiredBytes: number;
  enoughSpace: boolean;
  volumeFits: boolean;
}

export interface ArchiveProgress {
  id: string;
  stage:
    | "scanning"
    | "compressing"
    | "finalizing"
    | "restoring"
    | "registering"
    | "done"
    | "failed";
  percent: number;
  processedBytes: number;
  totalBytes: number;
  outputBytes: number;
  speedBytes: number;
  etaSeconds: number;
  currentFile: string;
  volume: number;
  volumeCount: number;
  error?: string | null;
}

export interface ArchiveVolumeInfo {
  index: number;
  fileName: string;
  bytes: number;
  sha256: string;
  blocks: number;
}

export interface ArchiveCompression {
  algorithm: string;
  level: number;
  windowLog: number;
  frameBytes: number;
}

export interface ArchiveStoreMeta {
  steamAppId?: string | null;
  steamAcf?: string | null;
  epicAppName?: string | null;
  gogGameId?: string | null;
  amazonProductId?: string | null;
  customGame?: unknown;
  customExeRel?: string | null;
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  createdAt: number;
  launcherVersion: string;
  appName: string;
  store: string;
  title: string;
  installDirName: string;
  originalInstallPath: string;
  originalBytes: number;
  fileCount: number;
  dirCount: number;
  skippedLinks: number;
  compression: ArchiveCompression;
  volumeBytes: number;
  volumes: ArchiveVolumeInfo[];
  storeMeta: ArchiveStoreMeta;
  complete: boolean;
  discLayout: boolean;
}

export interface ArchiveSummary {
  appName: string;
  title: string;
  store: string;
  folder: string;
  manifestPath: string;
  originalBytes: number;
  storedBytes: number;
  volumeCount: number;
  volumes: ArchiveVolumeInfo[];
  compression: ArchiveCompression;
  createdAt: number;
  discLayout: boolean;
}

export interface ArchiveDisc {
  volumeIndex: number;
  folder: string;
  manifestPath: string;
  bytes: number;
}

export interface ArchiveEstimate {
  originalBytes: number;
  estimatedBytes: number;
  ratio: number;
  estimatedVolumes: number;
  sampledFiles: number;
  sampledBytes: number;
  bypassedFiles: number;
  bypassedBytes: number;
}

export interface DiscRecorder {
  id: string;
  name: string;
  vendor: string;
  product: string;
  revision: string;
  deviceType: number;
  mediaTypes: number;
}

export interface FoundArchive {
  manifestPath: string;
  manifest: ArchiveManifest;
  missingVolumes: number[];
  storedBytes: number;
}

export interface RestoreRegistration {
  registered: boolean;
  detail: string;
  warning?: string | null;
}

export interface RestoreResult {
  target: string;
  fileCount: number;
  bytes: number;
  registration: RestoreRegistration;
}

export interface ArchiveDefaultTarget {
  targetParent: string;
  installDirName: string;
  finalPath: string;
}

export const archiveProfiles = () => invoke<MediaProfileInfo[]>("archive_profiles");

export const archivePlan = (args: {
  appName: string;
  title: string;
  installPath: string;
  targetRoot: string;
  profileId: string;
  customMib?: number;
}) =>
  invoke<ArchivePlan>("archive_plan", {
    appName: args.appName,
    title: args.title,
    installPath: args.installPath,
    targetRoot: args.targetRoot,
    profileId: args.profileId,
    customMib: args.customMib ?? null,
  });

export const archiveStart = (args: {
  appName: string;
  title: string;
  installPath: string;
  targetRoot: string;
  profileId: string;
  customMib?: number;
  level: string;
}) =>
  invoke<ArchiveSummary>("archive_start", {
    appName: args.appName,
    title: args.title,
    installPath: args.installPath,
    targetRoot: args.targetRoot,
    profileId: args.profileId,
    customMib: args.customMib ?? null,
    level: args.level,
  });

export const archiveCancel = (appName: string) =>
  invoke<boolean>("archive_cancel", { appName });

export const archiveEstimate = (args: {
  installPath: string;
  profileId: string;
  customMib?: number;
  level: string;
}) =>
  invoke<ArchiveEstimate>("archive_estimate", {
    installPath: args.installPath,
    profileId: args.profileId,
    customMib: args.customMib ?? null,
    level: args.level,
  });

export const archiveScanFolder = (root: string) =>
  invoke<FoundArchive[]>("archive_scan_folder", { root });

export const archiveInspect = (manifestPath: string) =>
  invoke<FoundArchive>("archive_inspect", { manifestPath });

export const archiveLocate = (manifestPath: string, extraDirs: string[]) =>
  invoke<number[]>("archive_locate", { manifestPath, extraDirs });

export const archiveDiscs = (manifestPath: string) =>
  invoke<ArchiveDisc[]>("archive_discs", { manifestPath });

export const discListRecorders = () =>
  invoke<DiscRecorder[]>("disc_list_recorders");

export const discBurnFolder = (folder: string, recorderId: string) =>
  invoke<void>("disc_burn_folder", { folder, recorderId });

export const archiveDefaultTarget = (appName: string, installPath: string) =>
  invoke<ArchiveDefaultTarget>("archive_default_target", { appName, installPath });

export const archiveRestore = (args: {
  manifestPath: string;
  targetParent: string;
  extraDirs: string[];
  overwrite: boolean;
}) =>
  invoke<RestoreResult>("archive_restore", {
    manifestPath: args.manifestPath,
    targetParent: args.targetParent,
    extraDirs: args.extraDirs,
    overwrite: args.overwrite,
  });
