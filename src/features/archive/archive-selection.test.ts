import { describe, expect, it } from "vitest";

import type { LibraryItem } from "../../core/types";
import { findArchiveGame, pickArchiveGame } from "./archive-selection";

function game(key: string, id: string, title: string): LibraryItem {
  return {
    key,
    source: key.startsWith("gog::") ? "gog" : "epic",
    id,
    title,
    developer: "",
    version: "",
    installedVersion: null,
    installed: true,
    installPath: `C:\\Games\\${title}`,
    installSize: 0,
    coverUrl: null,
    heroUrl: null,
    description: "",
    updateAvailable: false,
    cloudSavesSupported: false,
    dlcCount: 0,
  };
}

describe("pickArchiveGame", () => {
  const games = [
    game("epic::Ginger", "Ginger", "Dead by Daylight"),
    game("epic::Sugar", "Sugar", "Marvel's Spider-Man Remastered"),
  ];

  it("resolves an Epic app name to its composite library key", () => {
    expect(pickArchiveGame(games, "Sugar")?.key).toBe("epic::Sugar");
  });

  it("keeps a composite key untouched", () => {
    expect(pickArchiveGame(games, "epic::Sugar")?.key).toBe("epic::Sugar");
  });

  it("falls back to the first installed game only for the screen's initial state", () => {
    expect(pickArchiveGame(games, "Gone")?.key).toBe("epic::Ginger");
    expect(pickArchiveGame([], "Sugar")).toBeUndefined();
    expect(findArchiveGame(games, "Gone")).toBeUndefined();
  });
});
