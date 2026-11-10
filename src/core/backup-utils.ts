/**
 * Local backup helpers shared by the settings page, the drawer and launch.
 *
 * A restore writes a `pre-restore-*` snapshot before it overwrites the save
 * folder. That snapshot is an undo point, never a save state, so anything that
 * asks for "the newest backup" must skip it.
 */

import { S } from "./state";

/** True for a pre-restore safety snapshot. */
export function isRestoreSnapshotBackup(id: string): boolean {
  return id.startsWith("pre-restore-");
}

/** Marks the cached Backups page list stale after a backup was created elsewhere. */
export function invalidateBackupsPage(): void {
  S.backupsPage = null;
}
