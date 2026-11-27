import { describe, expect, it } from "vitest";
import { PadDirectionInput, type PadDirectionSample } from "./pad-direction";

function sample(overrides: Partial<PadDirectionSample> = {}): PadDirectionSample {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    lx: 0,
    ly: 0,
    ...overrides,
  };
}

describe("PadDirectionInput", () => {
  it("does not double-press during a normal D-pad tap shorter than firstDelayMs", () => {
    const input = new PadDirectionInput();
    expect(input.update(sample({ right: true }), 0)).toEqual({
      step: "right",
      activeDir: "right",
      isInitial: true,
    });
    // Previously 85 ms already triggered a repeat; normal 100–250 ms taps must stay single.
    for (const t of [16, 85, 140, 220, 300]) {
      expect(input.update(sample({ right: true }), t)).toEqual({
        step: null,
        activeDir: "right",
        isInitial: false,
      });
    }
    expect(input.update(sample(), 310)).toEqual({
      step: null,
      activeDir: null,
      isInitial: false,
    });
  });

  it("repeats cleanly after firstDelayMs and accelerates on long holds", () => {
    const input = new PadDirectionInput();
    expect(input.update(sample({ down: true }), 0).step).toBe("down");
    expect(input.update(sample({ down: true }), 319).step).toBeNull();
    expect(input.update(sample({ down: true }), 320).step).toBe("down");
    expect(input.update(sample({ down: true }), 420).step).toBeNull();
    expect(input.update(sample({ down: true }), 425).step).toBe("down");

    // Past accel1AfterMs (900ms), interval drops to 72ms.
    expect(input.update(sample({ down: true }), 920).step).toBe("down");
    expect(input.update(sample({ down: true }), 991).step).toBeNull();
    expect(input.update(sample({ down: true }), 992).step).toBe("down");
  });

  it("uses hysteresis on the analog stick to prevent threshold chatter", () => {
    const input = new PadDirectionInput();
    // Below engage (0.50): ignored.
    expect(input.update(sample({ lx: 0.44 }), 0).step).toBeNull();
    // Crosses engage: fires once.
    expect(input.update(sample({ lx: 0.52 }), 16).step).toBe("right");
    // Drops to 0.36 (above release 0.30) and rises again: must NOT fire a second press.
    expect(input.update(sample({ lx: 0.36 }), 32)).toEqual({
      step: null,
      activeDir: "right",
      isInitial: false,
    });
    expect(input.update(sample({ lx: 0.58 }), 48)).toEqual({
      step: null,
      activeDir: "right",
      isInitial: false,
    });
  });

  it("picks the dominant stick axis and ignores diagonal drift", () => {
    const input = new PadDirectionInput();
    expect(input.update(sample({ lx: 0.85, ly: -0.52 }), 0).step).toBe("right");
    // Fluctuating diagonal Y must not bounce right -> up -> right.
    expect(input.update(sample({ lx: 0.80, ly: -0.60 }), 16).step).toBeNull();
    expect(input.update(sample({ lx: 0.85, ly: -0.20 }), 32).step).toBeNull();
  });

  it("suppresses opposite-axis stick snapback right after a firm flick", () => {
    const input = new PadDirectionInput();
    expect(input.update(sample({ lx: 0.95 }), 0).step).toBe("right");
    // Release across center and overshoot to -0.60 within 40 ms.
    expect(input.update(sample({ lx: 0.10 }), 32).step).toBeNull();
    expect(input.update(sample({ lx: -0.60 }), 48).step).toBeNull();
    expect(input.update(sample({ lx: 0.0 }), 70).step).toBeNull();

    // A deliberate push held past the snapback window (110 ms after release at 32) works.
    expect(input.update(sample({ lx: -0.65 }), 150).step).toBe("left");
  });

  it("latches D-pad direction so adjacent graze does not double-fire", () => {
    const input = new PadDirectionInput();
    expect(input.update(sample({ right: true }), 0).step).toBe("right");
    // Thumb grazes Up while Right remains held, then releases Up.
    expect(input.update(sample({ right: true, up: true }), 20)).toEqual({
      step: null,
      activeDir: "right",
      isInitial: false,
    });
    expect(input.update(sample({ right: true }), 40)).toEqual({
      step: null,
      activeDir: "right",
      isInitial: false,
    });
    // Rolling cleanly from Right into Down fires Down once Right lets go.
    expect(input.update(sample({ right: true, down: true }), 60).step).toBeNull();
    expect(input.update(sample({ down: true }), 80).step).toBe("down");
  });

  it("suppresses an already-held direction when synced on focus regain", () => {
    const input = new PadDirectionInput();
    input.syncHeld(sample({ left: true }), 100);
    expect(input.update(sample({ left: true }), 116).step).toBeNull();
    expect(input.update(sample({ left: true }), 420).step).toBe("left");
  });
});
