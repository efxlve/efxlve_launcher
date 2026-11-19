import { beforeEach, describe, expect, it } from "vitest";
import type { EpicAchievementsData } from "../epic-commands";
import { loadAchievementAnswer, storeAchievementAnswer } from "./achievement-answer";

function answer(name: string): EpicAchievementsData {
  return {
    achievements: [
      {
        name,
        display_name: name,
        description: "",
        xp: 0,
        unlocked: false,
        progress: 0,
        unlock_date: null,
        icon_id: "",
        icon_link: "",
        hidden: false,
        is_base: true,
      },
    ],
    hidden: [],
    user_unlocked: 0,
    user_xp: 0,
    total_achievements: 1,
    total_xp: 0,
    is_platinum: false,
  };
}

beforeEach(() => localStorage.clear());

describe("shared achievement answer", () => {
  it("answers only the game the launcher resolved", () => {
    storeAchievementAnswer("epic::One", answer("first"));
    expect(loadAchievementAnswer("epic::One")?.achievements[0].name).toBe("first");
    expect(loadAchievementAnswer("epic::Two")).toBeNull();
  });

  it("keeps an empty answer out of the slot", () => {
    storeAchievementAnswer("epic::One", { ...answer("first"), achievements: [] });
    expect(loadAchievementAnswer("epic::One")).toBeNull();
  });
});
