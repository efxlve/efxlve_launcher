import { describe, expect, it } from "vitest";
import { colorFamilyOf, themeColorFamily } from "./colors";

describe("theme colour families", () => {
  it("maps accent hues to the gallery groups", () => {
    expect(colorFamilyOf("#e5484d")).toBe("red");
    expect(colorFamilyOf("#f97316")).toBe("orange");
    expect(colorFamilyOf("#fcee0a")).toBe("yellow");
    expect(colorFamilyOf("#10b981")).toBe("green");
    expect(colorFamilyOf("#22d3ee")).toBe("cyan");
    expect(colorFamilyOf("#3b82f6")).toBe("blue");
    expect(colorFamilyOf("#8b5cf6")).toBe("purple");
    expect(colorFamilyOf("#ec4899")).toBe("pink");
  });

  it("accepts short hex colours", () => {
    expect(colorFamilyOf("#f00")).toBe("red");
    expect(colorFamilyOf("#0f0")).toBe("green");
    expect(colorFamilyOf("#00f")).toBe("blue");
  });

  it("keeps greys and near-black accents neutral", () => {
    expect(colorFamilyOf("#ffffff")).toBe("neutral");
    expect(colorFamilyOf("#111318")).toBe("neutral");
    expect(colorFamilyOf("#7b8492")).toBe("neutral");
    expect(colorFamilyOf(undefined)).toBe("neutral");
    expect(colorFamilyOf("rgba(255, 255, 255, 0.1)")).toBe("neutral");
  });

  it("falls back to the accent token when the swatch is missing", () => {
    expect(themeColorFamily({ accent: "", tokens: { "--accent": "#e5484d" } })).toBe("red");
    expect(themeColorFamily({ accent: "#3b82f6" })).toBe("blue");
  });
});
