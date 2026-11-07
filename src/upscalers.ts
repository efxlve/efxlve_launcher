/**
 * Upscaler DLL manager IPC.
 *
 * The launcher keeps its own cache of DLLs the user imported or explicitly
 * downloaded. Catalog files come from the public DLSS Swapper manifest; the
 * backend verifies the archive, the DLL and its Authenticode signature before a
 * swap can touch a game folder.
 */

import { invoke } from "@tauri-apps/api/core";

export type UpscalerKind =
  | "dlss"
  | "dlssFg"
  | "dlssRr"
  | "dlssNr"
  | "fsr31Dx12"
  | "fsr31Vk"
  | "xess"
  | "xessDx11"
  | "xessFg"
  | "xell";

export type UpscalerState = "original" | "swapped";

export interface UpscalerDll {
  kind: UpscalerKind;
  fileName: string;
  path: string;
  version: string;
  md5: string;
  size: number;
  state: UpscalerState;
  backupPath: string | null;
  backupVersion: string | null;
  backupMd5: string | null;
}

export interface ImportedDll {
  id: string;
  kind: UpscalerKind;
  fileName: string;
  version: string;
  md5: string;
  size: number;
  importedAt: number;
  sourcePath: string;
}

export interface GameUpscalers {
  gameKey: string;
  installPath: string;
  dlls: UpscalerDll[];
}

export interface CatalogEntry {
  kind: UpscalerKind;
  id: string;
  version: string;
  versionNumber: number;
  label: string;
  md5: string;
  zipMd5: string;
  downloadUrl: string;
  fileSize: number;
  zipFileSize: number;
  isDev: boolean;
  isSigned: boolean;
}

export const upscalersScanGame = (installPath: string, gameKey: string) =>
  invoke<GameUpscalers>("upscalers_scan_game", { installPath, gameKey });

export const upscalersListImported = () =>
  invoke<ImportedDll[]>("upscalers_list_imported");

export const upscalersImportDll = (path: string) =>
  invoke<ImportedDll>("upscalers_import_dll", { path });

export const upscalersCatalog = (force = false) =>
  invoke<CatalogEntry[]>("upscalers_catalog", { force });

export const upscalersDownloadLatest = (
  installPath: string,
  dllPath: string,
  kind: UpscalerKind,
) =>
  invoke<UpscalerDll>("upscalers_download_latest", {
    installPath,
    dllPath,
    kind,
  });

export const upscalersDownloadSwap = (
  installPath: string,
  dllPath: string,
  kind: UpscalerKind,
  md5: string,
) =>
  invoke<UpscalerDll>("upscalers_download_swap", {
    installPath,
    dllPath,
    kind,
    md5,
  });

export const upscalersSwap = (
  installPath: string,
  dllPath: string,
  importedId: string,
) =>
  invoke<UpscalerDll>("upscalers_swap", {
    installPath,
    dllPath,
    importedId,
  });

export const upscalersRestore = (installPath: string, dllPath: string) =>
  invoke<UpscalerDll>("upscalers_restore", { installPath, dllPath });

export const upscalersDiscardBackup = (installPath: string, dllPath: string) =>
  invoke<UpscalerDll>("upscalers_discard_backup", {
    installPath,
    dllPath,
  });

export const upscalersPickDll = (title?: string) =>
  invoke<string | null>("upscalers_pick_dll", { title: title ?? null });
