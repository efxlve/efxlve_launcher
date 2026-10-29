/**
 * Per-store-game achievement preferences.
 *
 * A GOG or Amazon copy often names no Steam AppID, and the exact Steam store
 * title match can miss an edition suffix or a delisted page. The AppID override
 * lets the player point the page at the right Steam app; the definition-source
 * flag remembers that they chose the manual Steam list over a local emulator.
 * Both live in localStorage by library key (`ABZU`, `gog::…`); Rust only ever
 * receives the resolved numeric AppID from the frontend.
 */

import {
  STORE_DEFINITION_SOURCES_KEY,
  STORE_STEAM_APP_IDS_KEY,
} from "./constants";

function readAppIds(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORE_STEAM_APP_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && /^\d{1,10}$/.test(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAppIds(next: Record<string, string>): void {
  try {
    localStorage.setItem(STORE_STEAM_APP_IDS_KEY, JSON.stringify(next));
  } catch {
    // A full quota should not break the game page.
  }
}

function readDefinitionSources(): string[] {
  try {
    const raw = localStorage.getItem(STORE_DEFINITION_SOURCES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function writeDefinitionSources(next: string[]): void {
  try {
    localStorage.setItem(STORE_DEFINITION_SOURCES_KEY, JSON.stringify(next));
  } catch {
    // A full quota should not break the game page.
  }
}

/** The AppID the player set for this store game, or an empty string. */
export function storeSteamAppIdFor(appName: string): string {
  return appName ? readAppIds()[appName] ?? "" : "";
}

/** Saves one override; a non-numeric id is refused. */
export function setStoreSteamAppId(appName: string, appId: string): boolean {
  const clean = appId.trim();
  if (!appName || !/^\d{1,10}$/.test(clean)) return false;
  const current = readAppIds();
  current[appName] = clean;
  writeAppIds(current);
  return true;
}

/** Removes the override so automatic detection applies again. */
export function clearStoreSteamAppId(appName: string): void {
  if (!appName) return;
  const current = readAppIds();
  if (!(appName in current)) return;
  delete current[appName];
  writeAppIds(current);
}

/** True when the player asked for the Steam definition list for this game. */
export function storeDefinitionSourceEnabled(appName: string): boolean {
  return Boolean(appName) && readDefinitionSources().includes(appName);
}

/** Remembers or drops the manual Steam-definition choice for one game. */
export function setStoreDefinitionSource(appName: string, enabled: boolean): void {
  if (!appName) return;
  const current = readDefinitionSources();
  const next = enabled
    ? Array.from(new Set([...current, appName]))
    : current.filter((key) => key !== appName);
  writeDefinitionSources(next);
}
