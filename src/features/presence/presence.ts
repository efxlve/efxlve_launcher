/**
 * Discord Rich Presence bridge (optional).
 *
 * Builds already-localized activity text from the current view/game context and
 * forwards it to the Rust worker through the `epic_presence_*` commands. The
 * text is de-duplicated here so `syncPresence()` can be called from `render()`
 * without spamming the IPC channel.
 */

import { summaryOf } from "../../core/selectors";
import { S } from "../../core/state";
import { epicGetSettings, epicPresenceClear, epicPresenceConfigure, epicPresenceUpdate } from "../../epic";
import { t } from "../../i18n";

/** Public PNG of the launcher icon. Discord fetches this over HTTPS. */
const LAUNCHER_ICON =
  "https://cdn.jsdelivr.net/gh/efxlve/efxlve_launcher@b371b6b/src-tauri/icons/icon.png";

/** Game start times so Discord's elapsed clock survives re-renders. */
const playStarted = new Map<string, number>();

/**
 * Public Efxlve Launcher Discord application id. Discord RPC client ids are not
 * secrets, so this ships as the default and the feature works with one click.
 */
export const DEFAULT_DISCORD_CLIENT_ID = "1551663205426794596";

let lastKey = "";

/** Always the built-in Efxlve Discord application id. */
export function effectivePresenceClientId(): string {
  return DEFAULT_DISCORD_CLIENT_ID;
}

/** Loads the persisted presence settings and configures the backend worker. */
export async function initPresence(): Promise<void> {
  try {
    const st = await epicGetSettings();
    S.presenceEnabled = st.presence_enabled ?? true;
  } catch {
    S.presenceEnabled = true;
  }
  applyPresenceSettings();
}

/** Re-applies the current settings to the backend worker. */
export function applyPresenceSettings(): void {
  lastKey = "";
  void epicPresenceConfigure(S.presenceEnabled, effectivePresenceClientId()).catch(() => {});
  syncPresence();
}

function httpsArt(url: string | null | undefined): string {
  return url && url.startsWith("https://") ? url : "";
}

function gameArt(appName: string): { image: string; title: string } {
  const sum = summaryOf(appName);
  const title = sum?.title || appName;
  const image = sum ? httpsArt(sum.cover) : "";
  return { image, title };
}

/** Builds the localized activity for the current context, or null when idle. */
function presenceContext(): { details: string; state: string; image: string; hover: string; small: string; start: number } | null {
  for (const id of playStarted.keys()) {
    if (!S.runningGames.has(id)) playStarted.delete(id);
  }

  // A running game always wins over the browsing context.
  for (const id of S.runningGames) {
    const { image, title } = gameArt(id);
    if (!playStarted.has(id)) playStarted.set(id, Date.now());
    return {
      details: t("presence.playing", { title }),
      state: t("presence.playingState"),
      image: image || LAUNCHER_ICON,
      hover: title,
      small: image ? LAUNCHER_ICON : "",
      start: playStarted.get(id) ?? 0,
    };
  }

  if (S.view === "store") {
    return { details: t("presence.store"), state: t("presence.storeState"), image: LAUNCHER_ICON, hover: "Efxlve Launcher", small: "", start: 0 };
  }
  if (S.view === "downloads") {
    const dl = S.activeDlMetrics && !S.activeDlMetrics.done ? S.activeDlMetrics : null;
    if (dl) {
      return {
        details: t("presence.downloading", { title: dl.title }),
        state: `${Math.round(dl.progress)}%`,
        image: gameArt(dl.id).image || LAUNCHER_ICON,
        hover: dl.title,
        small: gameArt(dl.id).image ? LAUNCHER_ICON : "",
        start: 0,
      };
    }
    return { details: t("presence.downloads"), state: t("presence.downloadsState"), image: LAUNCHER_ICON, hover: "Efxlve Launcher", small: "", start: 0 };
  }
  if (S.view === "settings") {
    return { details: t("presence.settings"), state: t("presence.settingsState"), image: LAUNCHER_ICON, hover: "Efxlve Launcher", small: "", start: 0 };
  }
  if (S.view === "profile") {
    return { details: t("presence.profile"), state: t("presence.profileState"), image: LAUNCHER_ICON, hover: "Efxlve Launcher", small: "", start: 0 };
  }

  if (S.currentModalAppName) {
    const { image, title } = gameArt(S.currentModalAppName);
    return {
      details: t("presence.viewing", { title }),
      state: t("presence.inLibrary"),
      image: image || LAUNCHER_ICON,
      hover: title,
      small: image ? LAUNCHER_ICON : "",
      start: 0,
    };
  }
  return {
    details: t("presence.library"),
    state: t("presence.libraryState", { count: S.epicSummaries.length }),
    image: LAUNCHER_ICON,
    hover: "Efxlve Launcher",
    small: "",
    start: 0,
  };
}

/** Pushes the current activity to Discord if it changed since the last call. */
export function syncPresence(): void {
  if (!S.presenceEnabled) {
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

  const key = `${ctx.details}\u001f${ctx.state}\u001f${ctx.image}\u001f${ctx.start}`;
  if (key === lastKey) return;
  lastKey = key;
  void epicPresenceUpdate(ctx.details, ctx.state, ctx.image, ctx.hover, ctx.small, ctx.start).catch(() => {});
}
