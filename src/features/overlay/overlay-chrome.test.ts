// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { configureChrome, shellHtml } from "./overlay-chrome";

describe("overlay shell", () => {
  it("refuses to render before its modules are configured", () => {
    expect(() => shellHtml()).toThrow("overlay chrome rendered before configuration");
  });

  it("renders the shell after configuration", () => {
    configureChrome({
      context: () => ({ appName: "steam::1", title: "Test Game" }),
      launcherMode: () => false,
      visibleTabs: () => [],
      allTabs: () => [],
      isWidgetOpen: () => false,
      isWidgetPinned: () => false,
    });
    const html = shellHtml();
    expect(html).toContain('id="ov-shell"');
    expect(html).toContain('id="ov-lightbox"');
  });
});
