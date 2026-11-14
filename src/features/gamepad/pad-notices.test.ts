import { describe, expect, it } from "vitest";
import { PadNotices } from "./pad-notices";

const ds4 = { name: "DualShock 4", kind: "playstation" as const };

describe("pad notices", () => {
  it("does not announce a pad that was already there at startup", () => {
    const notices = new PadNotices();
    expect(notices.updateNative([ds4])).toEqual([]);
  });

  it("announces a plug and an unplug once", () => {
    const notices = new PadNotices();
    notices.updateNative([]);
    expect(notices.updateNative([ds4])).toEqual([
      { connected: true, kind: "playstation", name: "DualShock 4" },
    ]);
    expect(notices.updateNative([])).toEqual([
      { connected: false, kind: "playstation", name: "DualShock 4" },
    ]);
  });

  it("does not repeat a native pad when the browser unlocks it", () => {
    const notices = new PadNotices();
    notices.updateNative([]);
    notices.updateNative([ds4]);
    expect(notices.webConnected("playstation", "Wireless Controller")).toBeNull();
  });

  it("keeps one disconnect when both sources report it", () => {
    const notices = new PadNotices();
    notices.updateNative([ds4]);
    expect(notices.webDisconnected("playstation")).toEqual({
      connected: false,
      kind: "playstation",
      name: "DualShock 4",
    });
    expect(notices.updateNative([])).toEqual([]);
  });

  it("still notices a pad the HID list does not carry", () => {
    const notices = new PadNotices();
    notices.updateNative([]);
    expect(notices.webConnected("xbox", "Xbox 360 Controller")).toEqual({
      connected: true,
      kind: "xbox",
      name: "Xbox 360 Controller",
    });
    expect(notices.webDisconnected("xbox")).toEqual({
      connected: false,
      kind: "xbox",
      name: "Xbox 360 Controller",
    });
  });
});
