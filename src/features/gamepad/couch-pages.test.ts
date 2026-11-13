import { describe, expect, it } from "vitest";
import { COUCH_PAGES, stepCouchPage } from "./couch-pages";

describe("stepCouchPage", () => {
  it("walks the five pages in both directions", () => {
    expect(stepCouchPage("library", 1)).toBe("downloads");
    expect(stepCouchPage("downloads", 1)).toBe("store");
    expect(stepCouchPage("settings", 1)).toBe("library");
    expect(stepCouchPage("library", -1)).toBe("settings");
    expect(stepCouchPage("store", -1)).toBe("downloads");
  });

  it("admits every page exactly once", () => {
    expect(new Set(COUCH_PAGES).size).toBe(COUCH_PAGES.length);
  });

  it("starts from a known edge when another view is open", () => {
    expect(stepCouchPage("notes", 1)).toBe("downloads");
    expect(stepCouchPage("notes", -1)).toBe("settings");
    expect(stepCouchPage("store", 1)).toBe("profile");
  });
});
