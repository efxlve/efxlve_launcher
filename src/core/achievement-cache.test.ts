import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicAchievementSummary } from "../epic";

const RAW: EpicAchievementSummary = {
  app_name: "ea::42",
  user_unlocked: 40,
  total_achievements: 50,
  user_xp: 100,
  total_xp: 500,
  is_platinum: false,
  supported: true,
  progress_known: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("achievement summary cache", () => {
  it("keeps the last count across a restart", async () => {
    const first = await import("./achievement-cache");
    const { S } = await import("./state");
    first.loadCachedAchievementSummaries();
    first.rememberAchievementSummary("ea::42", RAW);
    first.flushAchievementSummaryCache();
    expect(S.cachedAchSummaries["ea::42"]?.user_unlocked).toBe(40);

    vi.resetModules();
    const { S: restored } = await import("./state");
    const second = await import("./achievement-cache");
    second.loadCachedAchievementSummaries();
    expect(restored.cachedAchSummaries["ea::42"]?.user_unlocked).toBe(40);
  });

  it("stores the raw answer and applies an edit only on load", async () => {
    localStorage.setItem(
      "efxlve-ach-edits",
      JSON.stringify({
        "ea::42": {
          title: "Game",
          store: "ea",
          updatedAt: 1,
          delta: { unlocked: 2, xp: 30 },
          items: { One: { state: "unlocked", at: 1, date: null } },
        },
      }),
    );
    const cache = await import("./achievement-cache");
    const { S } = await import("./state");
    cache.loadCachedAchievementSummaries();
    cache.rememberAchievementSummary("ea::42", RAW);
    expect(S.cachedAchSummaries["ea::42"]?.user_unlocked).toBe(42);
    expect(S.cachedAchSummaries["ea::42"]?.user_xp).toBe(130);

    cache.flushAchievementSummaryCache();
    const stored = JSON.parse(localStorage.getItem("ach-summary-cache-v2") ?? "{}");
    expect(stored.rows["ea::42"].user_unlocked).toBe(40);
    expect(stored.rows["ea::42"].user_xp).toBe(100);
  });

  it("ignores empty and metadata-only answers", async () => {
    const cache = await import("./achievement-cache");
    cache.loadCachedAchievementSummaries();
    cache.rememberAchievementSummary("ea::42", {
      ...RAW,
      supported: false,
      total_achievements: 0,
    });
    cache.rememberAchievementSummary("ea::43", { ...RAW, app_name: "ea::43", progress_known: false });
    cache.flushAchievementSummaryCache();
    expect(localStorage.getItem("ach-summary-cache-v2") ?? "").not.toContain("ea::42");
    expect(localStorage.getItem("ach-summary-cache-v2") ?? "").not.toContain("ea::43");
  });
});
