/**
 * Discord Social & Voice Hub for Stage mode.
 *
 * Provides console-grade voice status, quick mute/deafen, active friends list,
 * and direct launch to Discord.
 */

import { invoke } from "@tauri-apps/api/core";
import { icon } from "../../core/icons";
import { scheduleRender } from "../../core/render";
import { S } from "../../core/state";
import { esc } from "../../core/utils";
import { t } from "../../i18n";
import { stageFeedback } from "./stage-sound";

export interface DiscordFriendItem {
  id: string;
  username: string;
  displayName?: string;
  status: "online" | "idle" | "dnd" | "offline";
  activity?: string;
  avatarUrl?: string;
}

export interface DiscordVoiceInfo {
  inCall: boolean;
  channelName?: string;
  guildName?: string;
  muted?: boolean;
  deafened?: boolean;
}

let friendsList: DiscordFriendItem[] = [];
let voiceInfo: DiscordVoiceInfo | null = null;
let isConnected = false;
let isConnecting = false;
let pollTimer: number | null = null;
/** Sheet state without the polling noise; unchanged polls do not repaint. */
let lastSheetKey = "";

function discordSheetKey(): string {
  return [
    isConnected ? "1" : "0",
    isConnecting ? "1" : "0",
    voiceInfo?.inCall ? "1" : "0",
    voiceInfo?.channelName ?? "",
    voiceInfo?.guildName ?? "",
    voiceInfo?.muted ? "1" : "0",
    voiceInfo?.deafened ? "1" : "0",
    friendsList
      .map((friend) => `${friend.id}\u001f${friend.username}\u001f${friend.displayName ?? ""}\u001f${friend.status}\u001f${friend.activity ?? ""}\u001f${friend.avatarUrl ?? ""}`)
      .sort()
      .join("\u001e"),
  ].join("\u001f");
}

export function stageDiscordSheetChanged(): boolean {
  return discordSheetKey() !== lastSheetKey;
}

/**
 * The sheet's content key, part of the shell signature. Without it mute,
 * hang-up and connect change the module state but the signature check skips
 * the repaint, so the sheet keeps showing the old call.
 */
export function stageDiscordSheetSignature(): string {
  return S.stage.discordOpen ? discordSheetKey() : "";
}

export async function refreshStageDiscord(): Promise<void> {
  try {
    const sdk = await invoke<{ status: string; user?: { username: string } }>("discord_sdk_state").catch(() => null);
    isConnected = sdk?.status === "ready";
    isConnecting = sdk?.status === "starting";

    const voice = await invoke<any>("discord_web_voice_state").catch(() => null);
    if (voice && (voice.inCall || voice.channel_name)) {
      voiceInfo = {
        inCall: true,
        channelName: voice.channel_name || voice.channelName || t("stage.voiceChannel"),
        guildName: voice.guild_name || voice.guildName || t("stage.voiceServer"),
        muted: Boolean(voice.muted),
        deafened: Boolean(voice.deafened),
      };
    } else {
      voiceInfo = null;
    }

    if (isConnected) {
      const sdkFriends = await invoke<{ users?: any[] }>("discord_sdk_friends").catch(() => null);
      if (sdkFriends?.users) {
        friendsList = sdkFriends.users.map((u) => ({
          id: u.id || u.user_id,
          username: u.username || u.name,
          displayName: u.global_name || u.display_name || u.username,
          status: u.status || "online",
          activity: u.activity?.name || u.game || "",
          avatarUrl: u.avatar_url || u.avatar,
        }));
      }
    }
  } catch {
    /* ignore */
  }
}

/** The control the pad should land on for the current connection/call state. */
function discordInitialFocus(): string {
  if (voiceInfo?.inCall) return "discord:mute";
  return isConnected ? "discord:open-client" : "discord:connect-btn";
}

export function stageOpenDiscordSheet(): void {
  stageFeedback("select");
  S.stage.discordOpen = true;
  S.stage.browserOpen = false;
  S.stage.spotifyOpen = false;
  S.stage.quickMenu = false;
  S.stage.focusKey = discordInitialFocus();
  void refreshStageDiscord().then(() => {
    // The first refresh can reveal a call or a connection that the cached
    // state did not know about; move the ring off the fallback close button.
    if (S.stage.discordOpen && ["discord:connect-btn", "discord:close", ""].includes(S.stage.focusKey)) {
      S.stage.focusKey = discordInitialFocus();
    }
    scheduleRender();
  });

  if (!pollTimer) {
    pollTimer = window.setInterval(() => {
      if (!S.stage.active || !S.stage.discordOpen) {
        if (pollTimer) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        return;
      }
      void refreshStageDiscord().then(() => {
        if (!S.stage.active || !S.stage.discordOpen) return;
        if (stageDiscordSheetChanged()) scheduleRender();
      });
    }, 2500);
  }
  scheduleRender();
}

export function stageCloseDiscordSheet(): void {
  stageFeedback("back");
  S.stage.discordOpen = false;
  S.stage.focusKey = "";
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  scheduleRender();
}

export async function stageDiscordConnect(): Promise<void> {
  stageFeedback("launch");
  isConnecting = true;
  scheduleRender();
  await invoke("discord_sdk_start", { silent: false }).catch(() => undefined);
  await refreshStageDiscord();
  // The onboarding buttons leave with the card once the SDK is ready.
  if (isConnected) S.stage.focusKey = "discord:open-client";
  scheduleRender();
}

export async function stageDiscordToggleMute(): Promise<void> {
  stageFeedback("select");
  if (voiceInfo) {
    voiceInfo.muted = !voiceInfo.muted;
    await invoke("discord_sdk_call_mute", { mute: voiceInfo.muted }).catch(() => undefined);
    scheduleRender();
  }
}

export async function stageDiscordHangup(): Promise<void> {
  stageFeedback("back");
  await invoke("discord_sdk_hangup").catch(() => undefined);
  voiceInfo = null;
  // The call controls leave with the card; keep the ring on a control that stays.
  S.stage.focusKey = isConnected ? "discord:open-client" : "discord:connect-btn";
  scheduleRender();
}

export async function stageDiscordOpenApp(): Promise<void> {
  stageFeedback("select");
  await invoke("discord_view_show").catch(() => undefined);
  S.stage.discordOpen = false;
  scheduleRender();
}

export function renderStageDiscordSheet(entered: boolean): string {
  lastSheetKey = discordSheetKey();
  const onlineFriends = friendsList.filter((f) => f.status !== "offline");

  return `<div class="stage-overlay stage-discord-sheet${entered ? " stage-overlay-enter" : ""}">
    <div class="stage-discord-panel" role="dialog" aria-modal="true" aria-label="Discord">
      <div class="stage-discord-head">
        <div class="stage-discord-title-wrap">
          <span class="stage-discord-icon-main">${icon("discord", 26)}</span>
          <div>
            <h2 class="stage-discord-title">Discord</h2>
            ${isConnected
              ? `<span class="stage-stat stage-discord-connect-chip"><span class="stage-discord-status-dot is-online"></span><span>${esc(t("settings.connected"))}</span></span>`
              : `<span class="stage-discord-subtitle">${isConnecting ? esc(t("overlay.discordConnecting")) : esc(t("overlay.discordNotConnected"))}</span>`}
          </div>
        </div>
        <button type="button" class="stage-icon-btn" data-stage-act="close-discord-sheet" data-gp-item data-gp-key="discord:close" aria-label="${esc(t("common.close"))}">
          ${icon("x", 20)}
        </button>
      </div>

      ${voiceInfo?.inCall ? `
        <div class="stage-discord-voice-card">
          <div class="stage-voice-info">
            <span class="stage-voice-badge">${icon("mic", 16)}</span>
            <div>
              <strong>${esc(voiceInfo.channelName || t("stage.voiceChannel"))}</strong>
              <small>${esc(voiceInfo.guildName || t("stage.voiceServer"))}</small>
            </div>
          </div>
          <div class="stage-voice-actions" data-gp-row>
            <button type="button" class="stage-btn stage-btn-ghost${voiceInfo.muted ? " is-danger" : ""}" data-stage-act="discord-mute" data-gp-item data-gp-key="discord:mute">
              ${icon(voiceInfo.muted ? "mic-off" : "mic", 16)} <span>${esc(voiceInfo.muted ? t("overlay.discordCallUnmute") : t("overlay.discordCallMute"))}</span>
            </button>
            <button type="button" class="stage-btn stage-btn-danger" data-stage-act="discord-hangup" data-gp-item data-gp-key="discord:hangup">
              ${icon("x", 16)} <span>${esc(t("overlay.discordCallEnd"))}</span>
            </button>
          </div>
        </div>
      ` : ""}

      ${!isConnected ? `
        <div class="stage-discord-onboard">
          <div class="stage-discord-onboard-art">${icon("discord", 48)}</div>
          <h3>${esc(t("overlay.discordNotConnected"))}</h3>
          <p>${esc(t("overlay.discordSdkDesc"))}</p>
          <div class="stage-discord-onboard-actions" data-gp-row>
            <button type="button" class="stage-btn stage-btn-primary" data-stage-act="discord-connect" data-gp-item data-gp-key="discord:connect-btn" data-gp-default>
              ${icon("discord", 16)} <span>${esc(isConnecting ? t("overlay.discordConnecting") : t("overlay.discordConnect"))}</span>
            </button>
            <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="discord-open-app" data-gp-item data-gp-key="discord:open-app">
              ${icon("external", 16)} <span>${esc(t("overlay.openDiscord"))}</span>
            </button>
          </div>
        </div>
      ` : `
        <div class="stage-discord-body">
          <div class="stage-discord-section-head">
            <span class="stage-kicker">${esc(t("overlay.discordFriendsTitle"))}</span>
            <span class="stage-stat stage-discord-count">${icon("users", 13)}<b class="tabular-nums">${onlineFriends.length}</b></span>
          </div>

          <div class="stage-discord-friends-list">
            ${onlineFriends.length > 0 ? onlineFriends.map((f, idx) => `
              <button type="button" class="stage-discord-friend-card" data-stage-act="discord-open-app" data-gp-item data-gp-key="friend:${idx}" aria-label="${esc(f.displayName || f.username)}">
                <span class="stage-friend-avatar-wrap">
                  ${f.avatarUrl ? `<img class="stage-friend-avatar" src="${esc(f.avatarUrl)}" alt="" />` : `<span class="stage-friend-avatar-fallback">${icon("user", 16)}</span>`}
                  <span class="stage-friend-dot is-${f.status}"></span>
                </span>
                <span class="stage-friend-copy">
                  <strong class="stage-friend-name">${esc(f.displayName || f.username)}</strong>
                  <span class="stage-friend-activity">${esc(f.activity || `@${f.username}`)}</span>
                </span>
              </button>
            `).join("") : `
              <div class="stage-discord-empty">
                <p>${esc(t("overlay.discordFriendsEmpty"))}</p>
              </div>
            `}
          </div>

          <div class="stage-discord-foot-actions">
            <button type="button" class="stage-btn stage-btn-ghost" data-stage-act="discord-open-app" data-gp-item data-gp-key="discord:open-client">
              ${icon("external", 16)} <span>${esc(t("overlay.openDiscord"))}</span>
            </button>
          </div>
        </div>
      `}
    </div>
  </div>`;
}
