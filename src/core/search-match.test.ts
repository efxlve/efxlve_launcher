import { describe, expect, it } from "vitest";
import { scoreSearchMatch } from "./search-match";

const scores = (title: string, query: string): number => scoreSearchMatch(title, query);

describe("command palette title matching", () => {
  it("matches exact titles before prefixes and substrings", () => {
    expect(scores("Grand Theft Auto V", "Grand Theft Auto V")).toBeGreaterThan(
      scores("Grand Theft Auto V Enhanced", "Grand Theft Auto V"),
    );
    expect(scores("Grand Theft Auto V Enhanced", "grand theft auto")).toBe(5000);
    expect(scores("The Wolf Among Us", "wolf among")).toBe(4000);
  });

  it("understands acronyms", () => {
    expect(scores("Grand Theft Auto V Enhanced", "gta")).toBeGreaterThan(0);
    expect(scores("Grand Theft Auto V Enhanced", "gtav")).toBeGreaterThan(0);
    expect(scores("Red Dead Redemption 2", "rdr2")).toBeGreaterThan(0);
    expect(scores("Call of Duty: Modern Warfare", "cod")).toBeGreaterThan(0);
    expect(scores("Need for Speed Heat", "nfs")).toBeGreaterThan(0);
  });

  it("treats Roman numerals and digits as the same", () => {
    expect(scores("Grand Theft Auto V", "gta 5")).toBeGreaterThan(0);
    expect(scores("Grand Theft Auto VI", "gta 6")).toBeGreaterThan(0);
    expect(scores("Grand Theft Auto V", "grand theft auto 5")).toBe(6000);
    expect(scores("Grand Theft Auto V Enhanced", "grand theft auto 5")).toBe(5000);
    expect(scores("Grand Theft Auto VI", "grand theft auto vi")).toBe(6000);
  });

  it("ignores accents, punctuation and spacing", () => {
    expect(scores("Pokémon Scarlet", "pokemon scarlet")).toBe(6000);
    expect(scores("Marvel's Spider-Man Remastered", "spiderman")).toBeGreaterThan(0);
    expect(scores("Tom & Jerry", "tom and jerry")).toBe(6000);
  });

  it("does not match unrelated titles", () => {
    expect(scores("Grand Theft Auto V", "witcher")).toBe(0);
    expect(scores("Cyberpunk 2077", "gta")).toBe(0);
  });
});
