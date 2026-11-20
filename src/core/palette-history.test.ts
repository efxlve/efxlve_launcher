import { beforeEach, describe, expect, it } from "vitest";
import { PALETTE_HISTORY_KEY } from "./constants";
import { readPaletteHistory, rememberPaletteSearch } from "./palette-history";

beforeEach(() => {
  localStorage.clear();
});

describe("palette search history", () => {
  it("keeps the newest selection first and moves a repeat to the top", () => {
    rememberPaletteSearch("marvel", "Marvel's Spider-Man", true);
    rememberPaletteSearch("deadbydaylight", "Dead by Daylight", true);
    rememberPaletteSearch("marvel", "Marvel's Spider-Man", true);

    expect(readPaletteHistory().map((item) => item.id)).toEqual(["marvel", "deadbydaylight"]);
    expect(readPaletteHistory()[0]).toEqual({
      id: "marvel",
      title: "Marvel's Spider-Man",
      installed: true,
    });
  });

  it("caps the history at five entries", () => {
    for (let i = 0; i < 8; i += 1) {
      rememberPaletteSearch(`game-${i}`, `Game ${i}`, false);
    }

    const list = readPaletteHistory();
    expect(list).toHaveLength(5);
    expect(list.map((item) => item.id)).toEqual(["game-7", "game-6", "game-5", "game-4", "game-3"]);
  });

  it("ignores corrupt rows and empty ids", () => {
    localStorage.setItem(
      PALETTE_HISTORY_KEY,
      JSON.stringify([
        null,
        { id: "", title: "No id" },
        { id: "ok", title: "Valid" },
        { id: "no-title" },
        "nope",
      ]),
    );

    expect(readPaletteHistory()).toEqual([{ id: "ok", title: "Valid", installed: false }]);
  });

  it("returns an empty list for a corrupt JSON value", () => {
    localStorage.setItem(PALETTE_HISTORY_KEY, "{not-json");
    expect(readPaletteHistory()).toEqual([]);
  });
});
