/**
 * Discord Rich Presence bridge (optional).
 *
 * Builds already-localized activity text from the current view/game context and
 * forwards it to the Rust worker through the `epic_presence_*` commands. The
 * text is de-duplicated here so `syncPresence()` can be called from `render()`
 * without spamming the IPC channel.
 */

import { S } from "../../core/state";
import { epicGetSettings, epicPresenceClear, epicPresenceConfigure, epicPresenceUpdate } from "../../epic";
import { t } from "../../i18n";

let lastKey = "";

/** Loads the persisted presence settings and configures the backend worker. */
export async function initPresence(): Promise<void> {
  try {
    const st = await epicGetSettings();
    S.presenceEnabled = Boolean(st.presence_enabled);
    S.presenceClientId = st.presence_client_id ?? "";
  } catch {
    S.presenceEnabled = false;
    S.presenceClientId = "";
  }
  applyPresenceSettings();
}

/** Re-applies the current settings to the backend worker. */
export function applyPresenceSettings(): void {
  lastKey = "";
  void epicPresenceConfigure(S.presenceEnabled, S.presenceClientId).catch(() => {});
  syncPresence();
}

/** Builds the localized activity for the current context, or null when idle. */
function presenceContext(): { details: string; state: string } | null {
  // A running game always wins over the browsing context.
  for (const id of S.runningGames) {
    const sum = S.epicSummaries.find((s) => s.appName === id);
    const title = sum?.title || id;
    return { details: t("presence.playing", { title }), state: t("presence.playingState") };
  }

  if (S.view === "store") {
    return { details: t("presence.store"), state: t("presence.storeState") };
  }
  if (S.view === "downloads") {
    const dl = S.activeDlMetrics && !S.activeDlMetrics.done ? S.activeDlMetrics : null;
    if (dl) {
      return {
        details: t("presence.downloading", { title: dl.title }),
        state: `${Math.round(dl.progress)}%`,
      };
    }
    return { details: t("presence.downloads"), state: t("presence.downloadsState") };
  }
  if (S.view === "settings") {
    return { details: t("presence.settings"), state: t("presence.settingsState") };
  }

  // Library (and profile / DLC manager): show the open game when the drawer is up.
  if (S.currentModalAppName) {
    const sum = S.epicSummaries.find((s) => s.appName === S.currentModalAppName);
    const title = sum?.title || S.currentModalAppName;
    return { details: t("presence.viewing", { title }), state: t("presence.inLibrary") };
  }
  return {
    details: t("presence.library"),
    state: t("presence.libraryState", { count: S.epicSummaries.length }),
  };
}

/** Pushes the current activity to Discord if it changed since the last call. */
export function syncPresence(): void {
  if (!S.presenceEnabled || !S.presenceClientId) {
    if (lastKey !== "") {
      lastKey = "";
      void epicPresenceClear().catch(() => {});
    }
    return;
  }

  const ctx = presenceContext();
  if (!ctx) {
    if (lastKey !== "") {
      lastKey = "";
      void epicPresenceClear().catch(() => {});
    }
    return;
  }

  const key = `${ctx.details}\u001f${ctx.state}`;
  if (key === lastKey) return;
  lastKey = key;
  void epicPresenceUpdate(ctx.details, ctx.state).catch(() => {});
}
