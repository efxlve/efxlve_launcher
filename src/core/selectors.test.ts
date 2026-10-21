/**
 * Unit tests for the O(1) lookups in `core/selectors.ts`.
 *
 * These cover the pure helpers and the map invariants the library grid relies
 * on: a card is found by composite key, by bare id and by title, and copies of
 * one title on two stores stay one card.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { EpicSummary } from "../epic";
import type { LibraryItem } from "./types";
import { S } from "./state";
import {
  canonicalGameTitle,
  clearWideArtCache,
  gameStoresLabel,
  gameVersionsOf,
  isCompanionKey,
  libraryItemOf,
  libraryItemToSummary,
  libraryPlaytime,
  libraryRecentIndex,
  rebuildAllGamesMap,
  setEpicSummaries,
  setGogSummaries,
  setSteamSummaries,
  sourceOfKey,
  storeKeysForTitle,
  summaryOf,
  totalLibraryGamesCount,
} from "./selectors";

function epicSummary(overrides: Partial<EpicSummary> = {}): EpicSummary {
  return {
    appName: "Hades",
    title: "Hades",
    version: "1.0",
    cover: null,
    description: "",
    dlcCount: 0,
    installed: false,
    installPath: null,
    installSize: 0,
    installedVersion: null,
    updateAvailable: false,
    ...overrides,
  };
}

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    key: "gog::1",
    source: "gog",
    id: "1",
    title: "Hades",
    developer: "",
    version: "1.0",
    installedVersion: null,
    installed: false,
    installPath: null,
    installSize: 0,
    coverUrl: null,
    heroUrl: null,
    description: "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
    ...overrides,
  };
}

/** The store lists are module singletons, so every test starts from an empty one. */
beforeEach(() => {
  S.epicSummaries = [];
  S.epicSummariesMap = new Map();
  S.epicGamesRaw = [];
  S.epicGamesRawMap = new Map();
  S.gogSummaries = [];
  S.gogSummariesMap = new Map();
  S.steamSummaries = [];
  S.steamSummariesMap = new Map();
  S.amazonSummaries = [];
  S.companionSummaries = [];
  S.customSummaries = [];
  S.customSummariesMap = new Map();
  S.customGames = [];
  S.customHeroes = {};
  S.sharedOwners = new Map();
  S.showSharedLibrary = false;
  S.separateCopies = false;
  S.playtimeMap = new Map();
  S.epicRecent = [];
  S.hiddenGames = new Set();
  // `totalLibraryGamesCount` memoises on this revision, which never resets.
  S.libraryDataRev += 1;
  clearWideArtCache();
  rebuildAllGamesMap();
});

describe("canonicalGameTitle", () => {
  it("folds case and punctuation", () => {
    expect(canonicalGameTitle("Portal 2")).toBe("portal 2");
    expect(canonicalGameTitle("Baldur's Gate 3")).toBe("baldur s gate 3");
  });

  it("drops an edition suffix that follows a separator", () => {
    expect(canonicalGameTitle("The Witcher 3: Wild Hunt — Game of the Year Edition")).toBe(
      "the witcher 3 wild hunt",
    );
    expect(canonicalGameTitle("DOOM: Standard Edition")).toBe("doom");
  });

  it("merges Enhanced Edition into the base title but keeps standalone Enhanced", () => {
    expect(canonicalGameTitle("Dying Light: Enhanced Edition")).toBe("dying light");
    expect(canonicalGameTitle("Grand Theft Auto V Enhanced")).toBe("grand theft auto v enhanced");
  });

  it("returns an empty key for an empty title", () => {
    expect(canonicalGameTitle("")).toBe("");
  });
});

describe("sourceOfKey", () => {
  it("reads the store from the key prefix", () => {
    expect(sourceOfKey("gog::1207658924")).toBe("gog");
    expect(sourceOfKey("steam::440")).toBe("steam");
    expect(sourceOfKey("custom::abc")).toBe("custom");
    expect(sourceOfKey("ea::123")).toBe("ea");
    expect(sourceOfKey("ubisoft::123")).toBe("ubisoft");
    expect(sourceOfKey("xbox::123")).toBe("xbox");
    expect(sourceOfKey("battlenet::123")).toBe("battlenet");
    expect(sourceOfKey("riot::123")).toBe("riot");
    expect(sourceOfKey("amazon::123")).toBe("amazon");
  });

  it("treats a bare id as Epic", () => {
    expect(sourceOfKey("Hades")).toBe("epic");
  });
});

describe("isCompanionKey", () => {
  it("is true only for stores another client owns", () => {
    expect(isCompanionKey("ea::1")).toBe(true);
    expect(isCompanionKey("riot::1")).toBe(true);
    expect(isCompanionKey("amazon::1")).toBe(false);
    expect(isCompanionKey("Hades")).toBe(false);
  });
});

describe("libraryItemToSummary", () => {
  it("maps the unified item onto the legacy summary shape", () => {
    const summary = libraryItemToSummary(
      libraryItem({
        coverUrl: "https://cdn.example/cover.jpg",
        installed: true,
        installSize: 42,
        downloading: true,
        bytesDownloaded: 10,
        bytesToDownload: 100,
      }),
    );
    expect(summary.appName).toBe("gog::1");
    expect(summary.title).toBe("Hades");
    expect(summary.cover).toBe("https://cdn.example/cover.jpg");
    expect(summary.installed).toBe(true);
    expect(summary.installSize).toBe(42);
    expect(summary.downloading).toBe(true);
    expect(summary.bytesDownloaded).toBe(10);
    expect(summary.bytesToDownload).toBe(100);
  });
});

describe("library maps", () => {
  it("finds an Epic game by app name and reports an unknown one as missing", () => {
    const hades = epicSummary();
    setEpicSummaries([hades]);
    expect(summaryOf("Hades")).toBe(hades);
    expect(summaryOf("Nothing Here")).toBeUndefined();
  });

  it("finds a GOG game by composite key, and a bare id through libraryItemOf", () => {
    setGogSummaries([libraryItem()]);
    expect(summaryOf("gog::1")?.title).toBe("Hades");
    // `summaryOf` only resolves bare ids for the stores that have no key of
    // their own in the legacy views (companion clients and Amazon).
    expect(summaryOf("1")).toBeUndefined();
    expect(libraryItemOf("1")?.title).toBe("Hades");
    expect(libraryItemOf("1", "gog")?.title).toBe("Hades");
  });

  it("finds a Steam game by composite key", () => {
    setSteamSummaries([
      libraryItem({ key: "steam::440", source: "steam", id: "440", title: "Team Fortress 2" }),
    ]);
    expect(summaryOf("steam::440")?.title).toBe("Team Fortress 2");
  });

  it("keeps both copies of a title reachable by title", () => {
    setEpicSummaries([epicSummary()]);
    setGogSummaries([libraryItem()]);
    expect(gameStoresLabel("Hades")).toBe("Epic, GOG");
    expect(storeKeysForTitle("Hades")).toEqual(["Hades", "gog::1"]);
  });

  it("lists one version per store that owns the title", () => {
    setEpicSummaries([epicSummary()]);
    setGogSummaries([libraryItem({ installed: true })]);
    const versions = gameVersionsOf("Hades");
    expect(versions.map((v) => v.source)).toEqual(["epic", "gog"]);
    expect(versions.map((v) => v.installed)).toEqual([false, true]);
  });
});

describe("libraryPlaytime", () => {
  beforeEach(() => {
    setEpicSummaries([epicSummary()]);
    setGogSummaries([libraryItem()]);
    S.playtimeMap.set("Hades", { total_seconds: 3600, session_count: 2, last_played_timestamp: 100 });
    S.playtimeMap.set("gog::1", { total_seconds: 60, session_count: 1, last_played_timestamp: 200 });
  });

  it("sums every copy of the title while the copies are combined", () => {
    expect(libraryPlaytime({ appName: "Hades", title: "Hades" })).toEqual({
      seconds: 3660,
      lastPlayed: 200,
    });
  });

  it("stays with the card's own copy when copies are separate", () => {
    S.separateCopies = true;
    expect(libraryPlaytime({ appName: "Hades", title: "Hades" })).toEqual({
      seconds: 3600,
      lastPlayed: 100,
    });
  });
});

describe("libraryRecentIndex", () => {
  beforeEach(() => {
    setEpicSummaries([epicSummary()]);
    setGogSummaries([libraryItem()]);
    S.epicRecent = ["gog::1"];
  });

  it("takes the best position across the copies of the title", () => {
    expect(libraryRecentIndex({ appName: "Hades", title: "Hades" })).toBe(0);
  });

  it("ignores the other copies when they are separate", () => {
    S.separateCopies = true;
    expect(libraryRecentIndex({ appName: "Hades", title: "Hades" })).toBe(-1);
  });
});

describe("totalLibraryGamesCount", () => {
  it("counts one title once across stores and drops hidden games", () => {
    setEpicSummaries([epicSummary()]);
    setGogSummaries([libraryItem()]);
    expect(totalLibraryGamesCount()).toBe(1);

    S.hiddenGames = new Set(["Hades", "gog::1"]);
    S.libraryDataRev += 1;
    expect(totalLibraryGamesCount()).toBe(0);
  });
});
