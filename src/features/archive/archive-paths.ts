/** Case-insensitive folder helpers for the archive target check. */

export function parentFolder(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "").replace(/[\\/]+$/, "").toLowerCase();
}

/** True when the chosen target is the folder that already holds the installed game. */
export function isInstallParent(targetRoot: string, installPath: string): boolean {
  if (!targetRoot.trim() || !installPath.trim()) return false;
  return parentFolder(installPath) === targetRoot.replace(/[\\/]+$/, "").toLowerCase();
}
