import { describe, expect, it } from "vitest";
import { matchAchievementImport, parseAchievementImport } from "./achievement-import";

const ITEMS = [
  { name: "onemoretime", display_name: "One More Time" },
  { name: "powerandresponsibility", display_name: "Power and Responsibility" },
  { name: "superiorspiderman", display_name: "Superior Spider-Man" },
];

describe("achievement bulk import", () => {
  it("splits a pasted list on lines, commas and JSON leftovers", () => {
    expect(parseAchievementImport('["One More Time",\n  "Power and Responsibility";\n\n')).toEqual([
      "One More Time",
      "Power and Responsibility",
    ]);
    expect(parseAchievementImport("   ")).toEqual([]);
  });

  it("matches the internal name and the title on screen", () => {
    const { matched, missed } = matchAchievementImport(
      ["onemoretime", "power and responsibility", "SUPERIOR SPIDER-MAN"],
      ITEMS,
    );
    expect(matched.map((item) => item.name)).toEqual([
      "onemoretime",
      "powerandresponsibility",
      "superiorspiderman",
    ]);
    expect(missed).toBe(0);
  });

  it("counts a name the set does not have instead of inventing one", () => {
    const { matched, missed } = matchAchievementImport(
      ["onemoretime", "not a real achievement", "one more time"],
      ITEMS,
    );
    expect(matched.map((item) => item.name)).toEqual(["onemoretime"]);
    expect(missed).toBe(1);
  });
});
