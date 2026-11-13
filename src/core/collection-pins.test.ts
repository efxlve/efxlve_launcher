import { beforeEach, describe, expect, it } from "vitest";
import type { GameCollection } from "../epic-model";
import {
  isCollectionPinned,
  movePinnedCollection,
  pinnedCollectionsForTabs,
  reorderPinnedCollections,
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

    expect(toggleCollectionPin("story")).toBe(true);
    expect(isCollectionPinned("story")).toBe(true);
    expect(toggleCollectionPin("story")).toBe(false);
    expect(isCollectionPinned("story")).toBe(false);
  });

  it("skips a pin whose collection is gone", () => {
    S.pinnedCollections.add("gone");

    expect(pinnedCollectionsForTabs()).toEqual([]);
    S.epicCollections = [collection("story")];
    expect(toggleCollectionPin("story")).toBe(true);
    expect(pinnedCollectionsForTabs().map((col) => col.id)).toEqual(["story"]);
  });

  it("reorders pinned collections", () => {
    S.pinnedCollections = new Set(["a", "b", "c"]);
    reorderPinnedCollections(["c", "a", "b"]);
    expect([...S.pinnedCollections]).toEqual(["c", "a", "b"]);
  });

  it("moves a pinned collection left and right", () => {
    S.pinnedCollections = new Set(["a", "b", "c"]);
    expect(movePinnedCollection("c", -1)).toBe(true);
    expect([...S.pinnedCollections]).toEqual(["a", "c", "b"]);
    expect(movePinnedCollection("a", -1)).toBe(false);
    expect(movePinnedCollection("b", 1)).toBe(false);
  });
});
