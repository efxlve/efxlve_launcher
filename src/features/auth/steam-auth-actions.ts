/**
 * Steam account sign-in lifecycle (ROADMAP §13).
 *
 * The password only travels to the backend for a single request; the UI keeps
 * no copy. Polling runs only while a sign-in is pending and stops on success,
 * cancel or a five minute deadline — never in the background at idle.
 */

import { isTauri } from "../../core/constants";
import { render } from "../../core/render";
import { S } from "../../core/state";
import { toast } from "../../core/toast";
import { localizeMessage, t } from "../../i18n";
import { steamLoginBegin, steamLoginCode, steamLoginQrBegin, steamLoginStatus, steamLogout, type SteamLoginStatus } from "../../steam";
import { loadSavedSteamAccounts } from "./steam-account-switcher";
import { loadSteamLibrary } from "../library/steam-library";

/** A pending sign-in is abandoned after this long (Steam sessions expire, too). */
const POLL_DEADLINE_MS = 5 * 60 * 1000;
const POLL_MIN_MS = 4000;
const POLL_MAX_MS = 10000;

/**
 * Poll errors that mean the attempt is over: retrying cannot help. Anything
 * else (network, throttling, a temporary Steam refusal) keeps polling until the
 * deadline, because the user may still be approving on their phone.
 */
const DEFINITIVE_POLL_ERRORS = [
  "steam.err.sessionNotFound",
  "steam.err.sessionExpired",
  "steam.err.expired",
  "steam.err.noSession",
  "steam.err.invalidPassword",
  "steam.err.guardInvalid",
  "steam.err.guardNeeded",
  "steam.err.account",
  "steam.err.captcha",
  "steam.err.need2fa",
];

let pollTimer: number | null = null;
let pollDeadline = 0;
/** Last painted auth state: avoids repainting (and wiping inputs) while typing. */
let lastPainted = "";

function stopSteamPoll(): void {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function paintIfChanged(status: SteamLoginStatus): void {
  const signature = `${status.state}|${status.accountName}|${S.steamAuthStep}|${S.steamAuthBusy}`;
  if (signature !== lastPainted) {
    lastPainted = signature;
    render();
  }
}

/** Applies a backend status to the Steam card state machine. */
export function applySteamStatus(status: SteamLoginStatus, paint = true): void {
  S.steamAuth = status;
  if (status.state === "signed_in") {
    stopSteamPoll();
    S.steamAuthStep = "signed_in";
    S.steamAuthBusy = false;
  } else if (status.state === "code") {
    if (S.steamAuthStep !== "qr") S.steamAuthStep = "code";
  } else if (status.state === "confirm") {
    if (S.steamAuthStep !== "qr") S.steamAuthStep = "confirm";
  } else if (status.state === "pending") {
    // The QR view keeps showing the code while the phone approves.
    if (S.steamAuthStep !== "qr") S.steamAuthStep = "pending";
  } else if (S.steamAuthStep !== "credentials") {
    S.steamAuthStep = "idle";
  }
  if (paint) paintIfChanged(status);
}

/**
 * Boot check: reports the sealed session without touching the network. The
 * library load reads `S.steamAuth` itself (and asks the backend once if this
 * has not finished yet), so no duplicate owned-games fetch happens.
 */
export async function hydrateSteamAuth(): Promise<void> {
  if (!isTauri) return;
  try {
    const status = await steamLoginStatus();
    applySteamStatus(status, false);
    // The switcher rows come from the sealed vault (disk only).
    void loadSavedSteamAccounts();
  } catch {
    // Stay signed out; the Accounts card offers the sign-in.
  }
}

/** Shows the credential form inside the Steam card. */
export function promptSteamLogin(): void {
  stopSteamPoll();
  S.steamAuthStep = "credentials";
  S.steamAuthBusy = false;
  S.steamAuthCodeMode = false;
  render();
}

/** Switches the Steam Guard step from app approval to the code input. */
export function promptSteamCodeMode(): void {
  S.steamAuthCodeMode = true;
  render();
}

/** QR sign-in: fetch the challenge, show the code and poll for approval. */
export async function beginSteamQrLogin(): Promise<void> {
  stopSteamPoll();
  S.steamAuthStep = "qr";
  S.steamAuthBusy = true;
  S.steamQrSvg = "";
  S.steamQrUrl = "";
  render();
  try {
    const qr = await steamLoginQrBegin();
    S.steamQrSvg = qr.svg;
    S.steamQrUrl = qr.challengeUrl;
    S.steamAuthBusy = false;
    S.steamAuth = {
      state: "pending",
      accountName: "",
      steamId: "",
      emailHint: "",
      interval: qr.interval,
      confirm: true,
    };
    render();
    startSteamPoll();
  } catch (e) {
    S.steamAuthBusy = false;
    S.steamAuthStep = "idle";
    toast(localizeMessage(String(e)), "err");
    render();
  }
}

/** Leaves the sign-in flow; a server-side session is simply abandoned. */
export function cancelSteamLogin(): void {
  stopSteamPoll();
  S.steamAuthStep = S.steamAuth?.state === "signed_in" ? "signed_in" : "idle";
  S.steamAuthBusy = false;
  S.steamAuthCodeMode = false;
  S.steamQrSvg = "";
  S.steamQrUrl = "";
  render();
}

/** Step 1: account name + password (+ "keep this session"). */
export async function submitSteamCredentials(): Promise<void> {
  const user = (document.getElementById("steam-user") as HTMLInputElement | null)?.value.trim() ?? "";
  const pass = (document.getElementById("steam-pass") as HTMLInputElement | null)?.value ?? "";
  const remember = (document.getElementById("steam-remember") as HTMLInputElement | null)?.checked ?? true;
  if (!user || !pass) {
    toast(t("steam.err.empty"), "err");
    return;
  }
  S.steamAuthBusy = true;
  S.steamAuthUser = user;
  render();
  try {
    const status = await steamLoginBegin(user, pass, remember);
    S.steamAuthBusy = false;
    applySteamStatus(status);
    // Poll from the start: Steam allows approving on the mobile app even while
    // the code field is shown, and that approval completes the session.
    if (status.state !== "signed_in") startSteamPoll();
  } catch (e) {
    S.steamAuthBusy = false;
    toast(localizeMessage(String(e)), "err");
    if (S.view === "accounts") render();
  } finally {
    // The password is never needed again; wipe the field the moment the
    // request returns (success or failure).
    const input = document.getElementById("steam-pass") as HTMLInputElement | null;
    if (input) input.value = "";
  }
}

/** Step 2: the Steam Guard code from the mail or the mobile authenticator. */
export async function submitSteamGuardCode(): Promise<void> {
  const code = (document.getElementById("steam-guard") as HTMLInputElement | null)?.value.trim() ?? "";
  if (!code) {
    toast(t("steam.err.code"), "err");
    return;
  }
  S.steamAuthBusy = true;
  render();
  try {
    const status = await steamLoginCode(code);
    S.steamAuthBusy = false;
    applySteamStatus(status);
    startSteamPoll();
  } catch (e) {
    S.steamAuthBusy = false;
    toast(localizeMessage(String(e)), "err");
    if (S.view === "accounts") render();
  }
}

/** Polls the pending sign-in until Steam approves it or the deadline passes. */
function startSteamPoll(): void {
  stopSteamPoll();
  pollDeadline = Date.now() + POLL_DEADLINE_MS;

  // Steam suggests ~5 s; slower avoids rate limits, and the deadline keeps a
  // forgotten attempt from polling forever.
  const nextDelay = (): number => {
    const seconds = S.steamAuth?.interval ?? 0;
    return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, Math.round((seconds > 0 ? seconds : 5) * 1000)));
  };

  const giveUp = (message: string): void => {
    stopSteamPoll();
    S.steamAuthBusy = false;
    S.steamAuthStep = "idle";
    toast(message, "err");
    if (S.view === "accounts") render();
  };

  const tick = async (): Promise<void> => {
    pollTimer = null;
    if (Date.now() > pollDeadline) {
      S.steamAuthBusy = false;
      S.steamAuthStep = "idle";
      toast(t("steam.err.expired"), "err");
      render();
      return;
    }
    try {
      const status = await steamLoginStatus();
      applySteamStatus(status);
      if (status.state === "signed_in") {
        toast(t("accounts.connected"), "ok");
        void loadSteamLibrary();
        return;
      }
    } catch (e) {
      const message = String(e);
      const definitive = DEFINITIVE_POLL_ERRORS.some((key) => message.includes(key));
      if (definitive) {
        giveUp(localizeMessage(message));
        return;
      }
      // A network hiccup or a temporary Steam refusal must not kill the
      // attempt: keep waiting until the deadline and report only then.
      if (Date.now() > pollDeadline) {
        giveUp(localizeMessage(message));
        return;
      }
      pollTimer = window.setTimeout(() => void tick(), nextDelay());
      return;
    }
    pollTimer = window.setTimeout(() => void tick(), nextDelay());
  };

  pollTimer = window.setTimeout(() => void tick(), nextDelay());
}

/** Refreshes the owned list; `notify` is used by the manual refresh button. */
export async function syncSteamOwnedGames(notify = false): Promise<void> {
  if (!isTauri || S.steamAuth?.state !== "signed_in") return;
  const error = await loadSteamLibrary();
  if (error === "@t:steam.err.sessionExpired") {
    // The sealed refresh token stopped working: clear the card instead of
    // pretending the account is still connected.
    await logoutSteam();
    toast(localizeMessage(error), "err");
    return;
  }
  if (notify) {
    toast(error ? localizeMessage(error) : t("steam.libraryRefreshed"), error ? "err" : "ok");
  }
}

/** Sign out: clears memory, deactivates the vault entry and drops owned games. */
export async function logoutSteam(): Promise<void> {
  stopSteamPoll();
  try {
    await steamLogout();
  } catch {
    // The local state is cleared either way.
  }
  S.steamAuth = null;
  S.steamAuthStep = "idle";
  S.steamAuthUser = "";
  S.steamOwnedCount = 0;
  void loadSavedSteamAccounts();
  void loadSteamLibrary();
  render();
}
