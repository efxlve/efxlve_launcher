import { describe, expect, it } from "vitest";
import { applyTextEdit } from "./text-entry";

describe("applyTextEdit", () => {
  it("inserts at a collapsed caret and moves the caret", () => {
    expect(applyTextEdit("cyberpunk", 9, 9, "2")).toEqual({ value: "cyberpunk2", caret: 10 });
  });

  it("replaces the selected range", () => {
    expect(applyTextEdit("hello world", 0, 5, "hi")).toEqual({ value: "hi world", caret: 2 });
  });

  it("deletes one character before a collapsed caret", () => {
    expect(applyTextEdit("hello", 5, 5, "backspace")).toEqual({ value: "hell", caret: 4 });
  });

  it("deletes the whole selection on backspace", () => {
    expect(applyTextEdit("hello world", 5, 11, "backspace")).toEqual({ value: "hello", caret: 5 });
  });

  it("does not move past either end", () => {
    expect(applyTextEdit("abc", 0, 0, "left")).toEqual({ value: "abc", caret: 0 });
    expect(applyTextEdit("abc", 3, 3, "right")).toEqual({ value: "abc", caret: 3 });
    expect(applyTextEdit("", 0, 0, "backspace")).toEqual({ value: "", caret: 0 });
  });

  it("adds a space and clears the field", () => {
    expect(applyTextEdit("portal", 6, 6, "space")).toEqual({ value: "portal ", caret: 7 });
    expect(applyTextEdit("portal", 3, 3, "clear")).toEqual({ value: "", caret: 0 });
  });

  it("respects maxlength and never inserts half a surrogate pair", () => {
    expect(applyTextEdit("abc", 3, 3, "d", 3)).toEqual({ value: "abc", caret: 3 });
    expect(applyTextEdit("abc", 3, 3, "de", 4)).toEqual({ value: "abcd", caret: 4 });
    expect(applyTextEdit("abc", 1, 7, "x", 5)).toEqual({ value: "ax", caret: 2 });
    expect(applyTextEdit("abc", 3, 3, "😀", 4)).toEqual({ value: "abc", caret: 3 });
    expect(applyTextEdit("abc", 3, 3, "😀", 5)).toEqual({ value: "abc😀", caret: 5 });
  });

  it("normalises a reversed selection", () => {
    expect(applyTextEdit("abcdef", 5, 2, "X")).toEqual({ value: "abXf", caret: 3 });
  });
});
