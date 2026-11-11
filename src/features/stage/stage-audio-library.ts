/**
 * The player's own Stage audio files.
 *
 * Imported tracks live in the app data folder and are served by the asset
 * protocol. Only the stable file name is stored in Stage settings, so a path
 * can change between installations without losing the choice.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../core/constants";
import { pickAudioFile } from "../../core/file-picker";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { t } from "../../i18n";

export interface StageAudioFile {
  name: string;
  label: string;
  path: string;
  size: number;
}

let files: StageAudioFile[] = [];
let ready = false;
let loading: Promise<StageAudioFile[]> | null = null;
let revision = 0;

function store(list: StageAudioFile[]): StageAudioFile[] {
  files = list;
  ready = true;
  revision += 1;
  return files;
}

/** A render guard token for the Settings and game page music labels. */
export function stageAudioRevision(): number {
  return revision;
}

/** Load once; the Settings screen and a focused game both read this cache. */
export function loadStageAudioFiles(force = false): Promise<StageAudioFile[]> {
  if (!isTauri) {
    store([]);
    return Promise.resolve(files);
  }
  if (!force && ready) return Promise.resolve(files);
  if (!force && loading) return loading;
  loading = invoke<StageAudioFile[]>("stage_audio_list")
    .then((list) => {
      store(Array.isArray(list) ? list : []);
      if (S.stage.active) scheduleRender();
      return files;
    })
    .catch(() => {
      store([]);
      return files;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function stageAudioLabel(name: string | null | undefined): string {
  if (!name) return "";
  const known = files.find((file) => file.name === name)?.label;
  if (known) return known;
  // Before the list arrives, show the player's title instead of the timestamped
  // file name that Rust stores on disk.
  const fallback = name
    .replace(/\.[^.]+$/, "")
    .replace(/-\d{10,}$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return fallback || name;
}

export function stageAudioPath(name: string | null | undefined): string {
  if (!name) return "";
  return files.find((file) => file.name === name)?.path || "";
}

/** Native picker, then one copy into the Stage audio folder. */
export async function importStageAudio(): Promise<StageAudioFile | null> {
  if (!isTauri) return null;
  const source = await pickAudioFile(t("stage.settingsMusicPickTitle")).catch(() => null);
  if (!source) return null;
  const file = await invoke<StageAudioFile>("stage_audio_import", { source });
  store([...files.filter((item) => item.name !== file.name), file].sort((a, b) => a.label.localeCompare(b.label)));
  return file;
}


