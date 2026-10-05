/**
 * Amazon Games through the Nile CLI (account + library).
 *
 * Nile is downloaded on demand into `<app_data>/bin` and pointed at a
 * launcher-owned config directory; these wrappers only expose the account and
 * library surface for now. Install, launch and update follow the same CLI.
 */

import { invoke } from "@tauri-apps/api/core";

export interface NileAuthStatus {
  /** True when the Nile binary is already on disk (no download was made). */
  binary: boolean;
  logged_in: boolean;
  username: string | null;
}

export interface NileLoginData {
  /** Amazon sign-in URL to open in the browser. */
  url: string;
  client_id: string;
  code_verifier: string;
  serial: string;
}

export interface NileGame {
  /** Amazon product id every Nile command takes. */
  id: string;
  title: string;
  art: string | null;
  installed: boolean;
  install_path: string | null;
  version: string | null;
}

export const nileAuthStatus = () => invoke<NileAuthStatus>("nile_auth_status");

/** Starts sign-in and returns the PKCE material plus the Amazon URL. */
export const nileLoginBegin = () => invoke<NileLoginData>("nile_login_begin");

/** Finishes sign-in with the redirect URL (or bare code) the user pasted. */
export const nileLoginFinish = (
  redirect: string,
  clientId: string,
  codeVerifier: string,
  serial: string,
) => invoke<string>("nile_login_finish", { redirect, clientId, codeVerifier, serial });

export const nileLogout = () => invoke<void>("nile_logout");

/** Library list; `sync` refreshes it from Amazon first. */
export const nileLibrary = (sync = false) => invoke<NileGame[]>("nile_library", { sync });
