import { describe, expect, it } from "vitest";

import { ARCHIVE_SPACE_PAD, archiveFits, archiveRequiredBytes } from "./archive-space";

describe("archive space check", () => {
  it("falls back to the plan requirement before an estimate exists", () => {
    expect(archiveRequiredBytes(10_000, null)).toBe(10_000);
  });

  it("uses the estimate plus the safety pad", () => {
    expect(archiveRequiredBytes(10_000, 4_000)).toBe(4_000 + ARCHIVE_SPACE_PAD);
  });

  it("treats an unknown free space as a fit", () => {
    expect(archiveFits(null, 10_000, null)).toBe(true);
  });

  it("accepts a compressed archive on a drive that the uncompressed size would fill", () => {
    expect(archiveFits(5_000 + ARCHIVE_SPACE_PAD, 10_000, 5_000)).toBe(true);
    expect(archiveFits(5_000 + ARCHIVE_SPACE_PAD - 1, 10_000, 5_000)).toBe(false);
  });
});
