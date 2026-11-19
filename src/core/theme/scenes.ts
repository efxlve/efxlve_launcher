/**
 * Theme wallpaper storage.
 *
 * The theme record in localStorage is metadata only. Scene images are blobs in
 * IndexedDB, with an in-memory cache so the synchronous theme renderer can read
 * them after `hydrateThemeScenes()` finishes. Tests inject an in-memory backend.
 */

export interface ThemeSceneStore {
  getAll(): Promise<Map<string, string>>;
  put(id: string, data: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

const DB_NAME = "efxlve-theme-scenes";
const STORE = "scenes";

const cache = new Map<string, string>();
let injected: ThemeSceneStore | null = null;
let dbPromise: Promise<IDBDatabase | null> | null = null;
let ready = false;

/** Tests replace IndexedDB with a small deterministic backend. */
export function setThemeSceneStore(store: ThemeSceneStore | null): void {
  injected = store;
  ready = store !== null;
  dbPromise = null;
}

/** True once the store is open and its contents are in the cache. */
export function isThemeSceneStoreReady(): boolean {
  return ready;
}

export function getCachedThemeScene(id: string): string | undefined {
  return cache.get(id);
}

export function setCachedThemeScene(id: string, data: string): void {
  cache.set(id, data);
}

export function deleteCachedThemeScene(id: string): void {
  cache.delete(id);
}

export function clearThemeSceneCache(): void {
  cache.clear();
}

function openDb(): Promise<IDBDatabase | null> {
  if (injected || typeof indexedDB === "undefined") return Promise.resolve(null);
  dbPromise ??= new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

function replaceCache(scenes: Map<string, string>): void {
  cache.clear();
  scenes.forEach((data, id) => cache.set(id, data));
}

/** Reads every wallpaper once; null means this environment has no store. */
export async function loadThemeScenes(): Promise<Map<string, string> | null> {
  if (injected) {
    try {
      const scenes = await injected.getAll();
      replaceCache(scenes);
      ready = true;
      return scenes;
    } catch {
      return null;
    }
  }

  const db = await openDb();
  if (!db) return null;

  const scenes = await new Promise<Map<string, string>>((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      request.onsuccess = () => {
        const map = new Map<string, string>();
        for (const row of request.result as { id?: unknown; data?: unknown }[]) {
          if (typeof row?.id === "string" && typeof row.data === "string") map.set(row.id, row.data);
        }
        resolve(map);
      };
      request.onerror = () => resolve(new Map());
    } catch {
      resolve(new Map());
    }
  });

  replaceCache(scenes);
  ready = true;
  return scenes;
}

export async function putThemeScene(id: string, data: string): Promise<boolean> {
  setCachedThemeScene(id, data);
  if (injected) {
    try {
      return await injected.put(id, data);
    } catch {
      return false;
    }
  }

  const db = await openDb();
  if (!db) return false;
  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ id, data });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function deleteThemeScene(id: string): Promise<void> {
  deleteCachedThemeScene(id);
  if (injected) {
    try {
      await injected.delete(id);
    } catch {
      /* the metadata is already gone */
    }
    return;
  }

  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
