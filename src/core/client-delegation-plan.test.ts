import { describe, expect, it } from "vitest";
import { installHandoffAction } from "./client-delegation-plan";

describe("installHandoffAction", () => {
  it("opens a new game in the official client", () => {
    expect(installHandoffAction(true, false)).toBe("install");
  });

  it("checks an existing copy before handing it over", () => {
    expect(installHandoffAction(true, true)).toBe("check");
  });

  it("stays direct when the handoff switch is off", () => {
    expect(installHandoffAction(false, false)).toBeNull();
    expect(installHandoffAction(false, true)).toBeNull();
  });
});
