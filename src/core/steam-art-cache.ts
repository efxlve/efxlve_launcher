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
      if (id && url) map.set(id, url);
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

/** `undefined` when unknown, `""` when this session confirmed there is no art. */
export function cachedSteamCover(appId: string): string | undefined {
  if (memory.has(appId)) return memory.get(appId);
  return disk.get(appId);
}

export function rememberSteamCover(appId: string, url: string): void {
  memory.set(appId, url);
  if (!url) {
    if (disk.delete(appId)) saveDisk(STORAGE_KEY, disk);
    return;
  }
  if (disk.get(appId) === url) return;
  disk.set(appId, url);
  saveDisk(STORAGE_KEY, disk);
}

/** Drop a URL that 404'd so the next paint does not request it again. */
export function forgetSteamCover(appId: string): void {
  memory.delete(appId);
  if (disk.delete(appId)) saveDisk(STORAGE_KEY, disk);
}

/** `undefined` when unknown, `""` when this session confirmed there is no hero. */
export function cachedSteamHero(appId: string): string | undefined {
  if (heroMemory.has(appId)) return heroMemory.get(appId);
  return heroDisk.get(appId);
}

export function rememberSteamHero(appId: string, url: string): void {
  heroMemory.set(appId, url);
  if (!url) {
    if (heroDisk.delete(appId)) saveDisk(HERO_KEY, heroDisk);
    return;
  }
  if (heroDisk.get(appId) === url) return;
  heroDisk.set(appId, url);
  saveDisk(HERO_KEY, heroDisk);
}

export function steamCdnPortrait(appId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
}

export function steamHeaderPortrait(appId: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
}

/** Alternate flat CDN portraits tried before the store lookup. */
export function steamPortraitFallback(appId: string, step: number): string | null {
  if (step === 1) return `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`;
  if (step === 2) return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/library_600x900_2x.jpg`;
  return null;
}
