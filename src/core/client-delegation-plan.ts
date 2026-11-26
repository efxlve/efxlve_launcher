/** Which client call an install action should make. */
export type ClientStore = "epic" | "gog";

/**
 * A new game has no copy for the client to check yet, so it must be opened in
 * the client (`install`). An existing game is first checked (`check`) before it
 * is handed over; a launcher-owned copy keeps the direct update path.
 */
export function installHandoffAction(
  enabled: boolean,
  installed: boolean,
): "install" | "check" | null {
  if (!enabled) return null;
  return installed ? "check" : "install";
}
