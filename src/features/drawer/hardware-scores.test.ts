import { describe, expect, it } from "vitest";
import { compareHardwareScore, hardwareScore } from "./hardware-scores";

describe("bare CPU tier requirements", () => {
  it("compares a detected model against the weakest CPU of the named tier", () => {
    // No Man's Sky's store row names "Intel Core i3" without a model, so the
    // row used to stay manual even on a much faster CPU.
    expect(compareHardwareScore("cpu", "Intel(R) Core(TM) i7-14650HX", "Intel Core i3")).toBe("ok");
    expect(compareHardwareScore("cpu", "Intel(R) Core(TM) i7-14650HX", "AMD Ryzen 5")).toBe("ok");
  });

  it("does not let the tier hide a model the table does not know", () => {
    expect(hardwareScore("cpu", "Intel Core i3-99999K")).toBeNull();
    expect(
      compareHardwareScore("cpu", "Intel(R) Core(TM) i7-14650HX", "Intel Core i3-99999K"),
    ).toBeNull();
  });

  it("still ranks a model row on the model score", () => {
    expect(compareHardwareScore("cpu", "Intel(R) Core(TM) i7-14650HX", "Intel Core i3-12100")).toBe("ok");
    expect(compareHardwareScore("cpu", "Intel(R) Core(TM) i7-14650HX", "Intel Core i9-14900K")).toBe("partial");
  });
});
