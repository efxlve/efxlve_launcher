import { beforeEach, describe, expect, it } from "vitest";
import type { EpicSummary, GameCollection } from "../epic-model";
import type { LibraryItem } from "./types";
import { collectionGames } from "./game-collections";
import {
  setAmazonSummaries,
  setCustomSummaries,
  setEpicSummaries,
  setGogSummaries,
  setSteamSummaries,
  summaryOf,
} from "./selectors";

function epic(appName: string, title: string, installed: boolean): EpicSummary {
  return {
    appName,
    title,
    version: "1.0",
    cover: null,
    description: "",
    dlcCount: 0,
    installed,
    installPath: installed ? `C:\\Games\\${appName}` : null,
    installSize: installed ? 1024 : 0,
    installedVersion: installed ? "1.0" : null,
    updateAvailable: false,
  };
}

function item(
  key: string,
  source: LibraryItem["source"],
  id: string,
  title: string,
  installed: boolean,
): LibraryItem {
  return {
    key,
    source,
    id,
    title,
    developer: "",
    version: "1.0",
    installedVersion: installed ? "1.0" : null,
    installed,
    installPath: installed ? `C:\\Games\\${id}` : null,
    installSize: installed ? 1024 : 0,
    coverUrl: null,
    heroUrl: null,
    description: "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}

function collection(...appNames: string[]): GameCollection {
  return { id: "steels", name: "Steels", app_names: appNames };
}

beforeEach(() => {
  setEpicSummaries([]);
  setGogSummaries([]);
  setAmazonSummaries([]);
  setSteamSummaries([]);
  setCustomSummaries([]);
});

describe("collectionGames", () => {
  it("counts an installed copy the collection does not store", () => {
    setEpicSummaries([epic("WutheringWaves", "Wuthering Waves", false)]);
    setSteamSummaries([item("steam::2232190", "steam", "2232190", "Wuthering Waves", true)]);

    const games = collectionGames(collection("WutheringWaves"));

    expect(games).toEqual(["steam::2232190"]);
    expect(summaryOf(games[0])?.installed).toBe(true);
  });

  it("keeps the stored copy when it is the installed one", () => {
    setEpicSummaries([epic("WutheringWaves", "Wuthering Waves", true)]);
    setSteamSummaries([item("steam::2232190", "steam", "2232190", "Wuthering Waves", true)]);

    expect(collectionGames(collection("WutheringWaves"))).toEqual(["WutheringWaves"]);
  });

  it("keeps an uninstalled stored copy when no copy is installed", () => {
    setEpicSummaries([epic("WutheringWaves", "Wuthering Waves", false)]);

    expect(collectionGames(collection("WutheringWaves"))).toEqual(["WutheringWaves"]);
  });

  it("deduplicates a title stored through two copies and prefers the installed one", () => {
    setEpicSummaries([epic("WutheringWaves", "Wuthering Waves", false)]);
    setCustomSummaries([item("custom::wuthering-waves", "custom", "wuthering-waves", "Wuthering Waves", true)]);

    expect(collectionGames(collection("WutheringWaves", "custom::wuthering-waves"))).toEqual([
      "custom::wuthering-waves",
    ]);
  });
});
