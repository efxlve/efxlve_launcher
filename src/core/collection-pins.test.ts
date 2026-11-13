import { beforeEach, describe, expect, it } from "vitest";
import type { GameCollection } from "../epic-model";
import {
  MAX_PINNED_COLLECTIONS,
  isCollectionPinned,
  pinnedCollectionsForTabs,
  toggleCollectionPin,
} from "./collection-pins";
import { S } from "./state";

function collection(id: string): GameCollection {
  return { id, name: id, app_names: [] };
}

beforeEach(() => {
  S.pinnedCollections = new Set();
  S.epicCollections = [];
});

describe("collection pins", () => {
  it("pins and unpins one collection", () => {
    S.epicCollections = [collection("story")];

    expect(toggleCollectionPin("story")).toBe("pinned");
    expect(isCollectionPinned("story")).toBe(true);
    expect(toggleCollectionPin("story")).toBe("unpinned");
    expect(isCollectionPinned("story")).toBe(false);
  });

  it("stops at the strip's cap", () => {
    for (let i = 0; i < MAX_PINNED_COLLECTIONS; i++) {
      S.epicCollections.push(collection(`c${i}`));
      expect(toggleCollectionPin(`c${i}`)).toBe("pinned");
    }
    S.epicCollections.push(collection("extra"));

    expect(toggleCollectionPin("extra")).toBe("limit");
    expect(pinnedCollectionsForTabs()).toHaveLength(MAX_PINNED_COLLECTIONS);
  });

  it("does not let a deleted collection hold a pin slot", () => {
    S.pinnedCollections.add("gone");

    expect(pinnedCollectionsForTabs()).toEqual([]);
    S.epicCollections = [collection("story")];
    expect(toggleCollectionPin("story")).toBe("pinned");
  });
});
