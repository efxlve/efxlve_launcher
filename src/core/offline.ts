/**
 * Offline mode: one gate in front of every network call the launcher makes.
 *
 * The switch already existed, but only a couple of call sites honoured it, so
 * an "offline" start still hit the Epic API, the Steam Web API, the companion
 * sessions and the update checker. Everything that needs the network now asks
 * here first, which keeps an offline start instant (the disk caches are all
 * that is read) and makes the chip tell the truth.
 *
 * The gate is deliberately cheap: state plus one toast, no DOM work.
 */

import { S } from "./state";
import { toast } from "./toast";
import { t } from "../i18n";

/** True when the user asked for offline mode. */
export function isOffline(): boolean {
  return S.offlineMode;
}

/** Guards one network action: `true` means "stop, the user is offline".
 * `what` is an already-translated phrase, e.g. "Library sync". */
export function blockedOffline(what: string): boolean {
  if (!S.offlineMode) return false;
  toast(t("net.blocked", { what }), "");
  return true;
}

/** The chip's third state: the OS says there is no connection at all. */
export function hasConnection(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** Keeps the chip honest when Windows reports a lost/restored connection. */
export function watchConnection(onChange: () => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
}
