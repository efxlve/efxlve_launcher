/**
 * Native open-file dialog. The archive kind lists launcher backups so an
 * `.efxprofile` export is visible without switching the dialog to "All files".
 */

import { invoke } from "@tauri-apps/api/core";

export type FilePickerKind = "executable" | "archive" | "audio";

export const openFileDialog = (
  kind: FilePickerKind,
  title?: string,
  defaultPath?: string,
) => invoke<string | null>("pick_file_dialog", { defaultPath, title, kind });

/** Import dialogs: profile exports and save archives. */
export const pickArchiveFile = (title?: string) => openFileDialog("archive", title);

/** User-supplied Stage music. */
export const pickAudioFile = (title?: string) => openFileDialog("audio", title);
