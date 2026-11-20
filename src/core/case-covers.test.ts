import { describe, expect, it } from "vitest";
import {
  CASE_COVER_STYLES,
  normalizeCaseColorMode,
  normalizeCaseCoverStyle,
} from "./constants";

describe("physical case options", () => {
  it("keeps every style unique and normalizes the new ids", () => {
    expect(new Set(CASE_COVER_STYLES).size).toBe(CASE_COVER_STYLES.length);
    expect(CASE_COVER_STYLES.length).toBe(16);

    for (const id of ["slipcase", "titanium", "carbon", "leather", "vhs", "eco"]) {
      expect(normalizeCaseCoverStyle(id)).toBe(id);
    }
    expect(normalizeCaseCoverStyle("not-a-style")).toBe("retail");
  });

  it("accepts the accent colour mode", () => {
    expect(normalizeCaseColorMode("accent")).toBe("accent");
    expect(normalizeCaseColorMode("monochrome")).toBe("monochrome");
    expect(normalizeCaseColorMode("store")).toBe("store");
    expect(normalizeCaseColorMode("other")).toBe("store");
  });
});
