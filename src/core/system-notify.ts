/**
 * Windows toasts for feedback the launcher window cannot show.
 *
 * A capture happens while a game owns the screen: the in-app toast is drawn
 * behind it, so the user never learns that anything was saved. These helpers
 * raise a system notification instead, and only when the window is not focused
 * (a focused window already shows the toast, and two notices would be noise).
 */

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./constants";

let permission: boolean | null = null;

async function granted(): Promise<boolean> {
  if (permission !== null) return permission;
  try {
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === "granted";
    permission = allowed;
  } catch {
    permission = false;
  }
  return permission;
}

/** True when the launcher window is not the one the user is looking at. */
function backgrounded(): boolean {
  if (typeof document === "undefined") return false;
  return !document.hasFocus() || document.visibilityState === "hidden";
}

/** A system notification, but only while a game (or another window) covers us. */
export async function notifyBackgrounded(title: string, body: string): Promise<void> {
  if (!isTauri || !backgrounded()) return;
  if (!(await granted())) return;
  try {
    sendNotification({ title, body });
  } catch {
    // Nothing else to do: the in-app toast still recorded it.
  }
}
