/**
 * Optional hand-off to the official Epic Games Launcher / GOG Galaxy.
 *
 * Only games the official client installed are delegated; a launcher-owned
 * install keeps the direct legendary/gogdl path. The backend answers `false`
 * for those, so callers can continue as if delegation were off.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./constants";
import { S } from "./state";
import type { ClientStore } from "./client-delegation-plan";

export type { ClientStore };
export { installHandoffAction } from "./client-delegation-plan";

export function delegateEnabled(store: ClientStore): boolean {
  return store === "epic" ? S.delegateEpic : S.delegateGog;
}

export function clientName(store: ClientStore): string {
  return store === "epic" ? "Epic Games Launcher" : "GOG Galaxy";
}

/** `epic` or `gog` for a library key; `null` for other stores/custom games. */
export function delegatedStoreOf(key: string): ClientStore | null {
  if (key.startsWith("gog::")) return "gog";
  if (key.includes("::")) return null;
  return "epic";
}

/**
 * Runs `launch`, `open` or `check` through the official client. The boolean is
 * true only when the client owns this install and handled the action.
 */
export async function delegateClientAction(
  store: ClientStore,
  gameId: string,
  action: "launch" | "open" | "install" | "check",
): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("launcher_delegate", { store, gameId, action });
}
