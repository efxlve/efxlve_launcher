// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { configureWidgets, isWidgetPinned } from "./overlay-widgets";

const TABS = ["perf", "shots", "clip", "music", "audio", "ach", "notes"];

function configure(): void {
  configureWidgets({
    isWidgetOpen: () => true,
    bringToFront: () => undefined,
    tabIds: () => TABS,
  });
}

beforeEach(() => {
  localStorage.clear();
  configure();
});

describe("overlay widget pins", () => {
  it("keeps saved pins once the tab list is configured", () => {
    localStorage.setItem("efxlve-overlay-pins", JSON.stringify(["perf", "music"]));
    configure();
    expect(isWidgetPinned("perf")).toBe(true);
    expect(isWidgetPinned("music")).toBe(true);
    expect(isWidgetPinned("ach")).toBe(false);
  });

  it("drops a pin that no longer names a tab", () => {
    localStorage.setItem("efxlve-overlay-pins", JSON.stringify(["perf", "gone"]));
    configure();
    expect(isWidgetPinned("perf")).toBe(true);
    expect(isWidgetPinned("gone")).toBe(false);
  });
});
