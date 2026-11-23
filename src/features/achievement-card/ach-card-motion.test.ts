// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  achEntryKeyframes,
  achExitKeyframes,
  achMotionDirection,
  achMotionVerticalDirection,
  normalizeAchMotion,
} from "./ach-card-motion";

describe("achievement motion choreography", () => {
  it("normalizes known and unknown styles cleanly", () => {
    expect(normalizeAchMotion("minimal")).toBe("minimal");
    expect(normalizeAchMotion("slide")).toBe("slide");
    expect(normalizeAchMotion("soft")).toBe("soft");
    expect(normalizeAchMotion("pop")).toBe("pop");
    expect(normalizeAchMotion("spring")).toBe("spring");
    expect(normalizeAchMotion("drift")).toBe("drift");
    expect(normalizeAchMotion("drop")).toBe("drop");
    expect(normalizeAchMotion(undefined)).toBe("minimal");
    expect(normalizeAchMotion("unknown")).toBe("minimal");
  });

  it("calculates horizontal and vertical direction from position", () => {
    expect(achMotionDirection("top-left")).toBe(-1);
    expect(achMotionDirection("bottom-left")).toBe(-1);
    expect(achMotionDirection("top-right")).toBe(1);
    expect(achMotionDirection("center-bottom")).toBe(1);

    expect(achMotionVerticalDirection("top-right")).toBe(-1);
    expect(achMotionVerticalDirection("center-top")).toBe(-1);
    expect(achMotionVerticalDirection("bottom-right")).toBe(1);
    expect(achMotionVerticalDirection("center-bottom")).toBe(1);
  });

  it("produces entry and exit keyframes for all motion styles", () => {
    const styles = ["minimal", "slide", "soft", "pop", "spring", "drift", "drop"] as const;
    for (const style of styles) {
      const entry = achEntryKeyframes(style, 1, 1);
      expect(entry.frames.length).toBeGreaterThanOrEqual(2);
      expect(entry.duration).toBeGreaterThan(0);
      expect(typeof entry.easing).toBe("string");

      const exit = achExitKeyframes(style, 1, 1);
      expect(exit.frames.length).toBeGreaterThanOrEqual(2);
      expect(exit.duration).toBeGreaterThan(0);
      expect(typeof exit.easing).toBe("string");
    }
  });

  it("ensures spring and pop have smooth non-abrupt entry keyframes", () => {
    const pop = achEntryKeyframes("pop", 1, -1);
    expect(pop.duration).toBe(440);
    expect(pop.easing).toBe("cubic-bezier(0.2, 1.55, 0.35, 1.0)");
    expect(pop.frames).toEqual([
      { opacity: 0, transform: "scale(0.86)" },
      { opacity: 1, transform: "scale(1)" },
    ]);

    const spring = achEntryKeyframes("spring", 1, -1);
    expect(spring.duration).toBe(560);
    expect(spring.easing).toBe("linear");
    expect(spring.frames.length).toBe(15);
    expect(spring.frames[0]).toMatchObject({ opacity: 0, offset: 0 });
    expect(spring.frames[spring.frames.length - 1]).toEqual({
      offset: 1,
      opacity: 1,
      transform: "translateY(0px) scale(1)",
    });
  });
});
