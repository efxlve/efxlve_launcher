import { describe, expect, it } from "vitest";

import { burnReady, discFreeBytes } from "./archive-disc";

const blank = {
  mediaLoaded: true,
  mediaBlank: true,
  freeBytes: 1000,
  capacityBytes: 1000,
};

describe("burn readiness", () => {
  it("needs a recorder and an inserted disc", () => {
    expect(burnReady(undefined, 500)).toBe(false);
    expect(burnReady({ ...blank, mediaLoaded: false }, 500)).toBe(false);
  });

  it("needs a blank disc", () => {
    expect(burnReady({ ...blank, mediaBlank: false }, 500)).toBe(false);
  });

  it("needs enough free space for the part", () => {
    expect(burnReady(blank, 1001)).toBe(false);
    expect(burnReady(blank, 1000)).toBe(true);
    expect(burnReady(blank, 500)).toBe(true);
  });

  it("falls back to the capacity when a blank disc reports zero free", () => {
    const quirky = { ...blank, freeBytes: 0, capacityBytes: 2000 };
    expect(discFreeBytes(quirky)).toBe(2000);
    expect(burnReady(quirky, 2000)).toBe(true);
    expect(burnReady(quirky, 2001)).toBe(false);
  });

  it("does not use capacity for a non-blank disc", () => {
    expect(
      discFreeBytes({ ...blank, mediaBlank: false, capacityBytes: 2000 }),
    ).toBe(0);
  });
});
