/**
 * Linux/macOS compatibility runtime manager.
 *
 * The Rust side owns the catalogue, the GitHub release check and the archives.
 * This wrapper is only the typed IPC surface; the settings page lives in
 * `src/features/settings/compat-view.ts`.
 */

import { invoke } from "@tauri-apps/api/core";

export interface CompatInstalled {
  tag: string;
  path: string;
  size: number;
  installedAt: number;
  asset: string;
}

export interface CompatLatest {
  tag: string;
  asset: string;
  size: number;
  releaseUrl: string;
  digest: string | null;
}

export interface CompatToolInfo {
  id: string;
  repo: string;
  homepage: string;
  /** `store`, `runner`, `runtime`, `translation` or `helper`. */
  kind: string;
  platforms: string[];
  supported: boolean;
  installable: boolean;
  removable: boolean;
  /** `module`, `github` or `external`. */
  source: string;
  installed: CompatInstalled[];
  /** Copies found outside the launcher (Steam compatibilitytools.d, CrossOver…). */
  detected: string[];
  latest: CompatLatest | null;
}

export interface CompatCatalog {
  /** `<os>-<arch>` the caller asked for; `current` resolves to the host. */
  target: string;
  os: string;
  arch: string;
  currentOs: string;
  currentArch: string;
  cacheAgeSeconds: number | null;
  stale: boolean;
  tools: CompatToolInfo[];
}

export interface CompatLaunchConfig {
  /** False is the explicit "start like Windows" choice. */
  enabled: boolean;
  runner: string | null;
  runnerTag: string | null;
  /** A runner outside the launcher's folder; null means the managed copy. */
  runnerPath: string | null;
  prefixDir: string;
  umuEnabled: boolean;
  /** Translation layers copied into each game's prefix (`dxvk`, `vkd3d-proton`). */
  layers: string[];
}

export interface CompatProgress {
  id: string;
  phase: "download" | "extract" | "done";
  percent: number;
  downloaded: number;
  total: number;
}

export const compatCatalog = (target: string | null = null, refresh = false) =>
  invoke<CompatCatalog>("compat_catalog", { target, refresh });

export const compatInstall = (id: string, target: string | null = null) =>
  invoke<CompatToolInfo>("compat_install", { id, target });

export const compatRemove = (id: string, target: string | null = null) =>
  invoke<void>("compat_remove", { id, target });

/** Cancels an in-flight download; the install promise rejects with `compat.cancelled`. */
export const compatCancel = (id: string) => invoke<void>("compat_cancel", { id });

export const compatToolsDir = () => invoke<string>("compat_tools_dir");

/** Bytes used by the managed runners/layers under `<app_data>/compat`. */
export const compatDiskUsage = () => invoke<number>("compat_disk_usage");

/** Removes interrupted `.part` files and extraction temp folders. */
export const compatClearPartials = () => invoke<number>("compat_clear_partials");

export const compatGetLaunchConfig = () =>
  invoke<CompatLaunchConfig>("compat_get_launch_config");

/** Opens (and creates) the shared prefix root. */
export const compatOpenPrefixRoot = () =>
  invoke<string>("compat_open_prefix_root");

export const compatSetLaunchConfig = (config: CompatLaunchConfig) =>
  invoke<void>("compat_set_launch_config", {
    enabled: config.enabled,
    runner: config.runner,
    runnerTag: config.runnerTag,
    runnerPath: config.runnerPath,
    prefixDir: config.prefixDir,
    umuEnabled: config.umuEnabled,
    layers: config.layers,
  });
