/**
 * Remembered Steam portrait URLs.
 *
 * Successes are kept in localStorage so the next launch paints the real cover
 * immediately. A confirmed miss (empty string) stays in memory for this
 * session only, so a later launch can try again.
 */

const STORAGE_KEY = "efx.steamArt.v1";
const HERO_KEY = "efx.steamHero.v1";

const memory = new Map<string, string>();
const disk = loadDisk(STORAGE_KEY);
const heroMemory = new Map<string, string>();
const heroDisk = loadDisk(HERO_KEY);

function loadDisk(key: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, string>;
    for (const [id, url] of Object.entries(parsed)) {
      if (id && typeof url === "string") map.set(id, url);
    }
  } catch {
    /* a corrupt cache just means the CDN path is tried again */
  }
  return map;
}

function saveDisk(key: string, store: Map<string, string>): void {
  const obj: Record<string, string> = {};
  for (const [id, url] of store) obj[id] = url;
  try {
    localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    /* quota errors must not break the library */
  }
}

/**
 * Disk writes are debounced: the first cover resolution pass remembers one URL
 * per game, and writing the whole map for each of them would hammer the
 * synchronous localStorage API. One write per idle window is enough.
 */
const dirtyKeys = new Set<string>();
let saveTimer = 0;

function scheduleDiskSave(key: string): void {
  dirtyKeys.add(key);
  if (saveTimer) return;
  saveTimer = window.setTimeout(flushDiskSaves, 1500);
}

function flushDiskSaves(): void {
  saveTimer = 0;
  if (dirtyKeys.has(STORAGE_KEY)) saveDisk(STORAGE_KEY, disk);
  if (dirtyKeys.has(HERO_KEY)) saveDisk(HERO_KEY, heroDisk);
  dirtyKeys.clear();
}

window.addEventListener("pagehide", flushDiskSaves);

/** `undefined` when unknown, `""` when confirmed there is no art. */
export function cachedSteamCover(appId: string): string | undefined {
  if (memory.has(appId)) return memory.get(appId);
  return disk.get(appId);
}

export function rememberSteamCover(appId: string, url: string): void {
  memory.set(appId, url);
  if (disk.get(appId) === url) return;
  disk.set(appId, url);
  scheduleDiskSave(STORAGE_KEY);
}

/** Drop a URL that 404'd so the next paint does not request it again. */
export function forgetSteamCover(appId: string): void {
  memory.delete(appId);
  if (disk.delete(appId)) scheduleDiskSave(STORAGE_KEY);
}

/** `undefined` when unknown, `""` when this session confirmed there is no hero. */
export function cachedSteamHero(appId: string): string | undefined {
  if (heroMemory.has(appId)) return heroMemory.get(appId);
  return heroDisk.get(appId);
}

export function rememberSteamHero(appId: string, url: string): void {
  heroMemory.set(appId, url);
  if (!url) {
    if (heroDisk.delete(appId)) scheduleDiskSave(HERO_KEY);
    return;
  }
  if (heroDisk.get(appId) === url) return;
  heroDisk.set(appId, url);
  scheduleDiskSave(HERO_KEY);
}

export function steamCdnPortrait(appId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

export function steamHeaderPortrait(appId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}
