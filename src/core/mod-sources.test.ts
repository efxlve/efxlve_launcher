import { describe, expect, it } from "vitest";
import { modSourceLinks } from "./mod-sources";

const urlOf = (links: ReturnType<typeof modSourceLinks>, key: string) =>
  links.find((link) => link.key === key);

describe("modSourceLinks", () => {
  it("opens the exact pages for a game with a full row", () => {
    const links = modSourceLinks({ title: "Valheim", steamAppId: "892970", hasWorkshop: true });
    expect(links.map((link) => link.key)).toEqual(["workshop", "nexus", "thunderstore"]);
    expect(urlOf(links, "workshop")).toMatchObject({
      url: "https://steamcommunity.com/app/892970/workshop/",
      exact: true,
    });
    expect(urlOf(links, "nexus")).toMatchObject({
      url: "https://www.nexusmods.com/games/valheim",
      exact: true,
    });
    expect(urlOf(links, "thunderstore")).toMatchObject({
      url: "https://thunderstore.io/c/valheim/",
      exact: true,
    });
  });

  it("has no workshop row for a Steam game without workshop items", () => {
    // Dead by Daylight: a Steam app id, no workshop category.
    const links = modSourceLinks({ title: "Dead by Daylight", steamAppId: "381210" });
    expect(links.some((link) => link.key === "workshop")).toBe(false);
    expect(links.map((link) => link.key)).toEqual(["nexus", "thunderstore"]);
  });

  it("matches a store copy that only has the title", () => {
    const links = modSourceLinks({ title: "The Witcher 3: Wild Hunt" });
    expect(links.some((link) => link.key === "workshop")).toBe(false);
    expect(urlOf(links, "nexus")).toMatchObject({
      url: "https://www.nexusmods.com/games/witcher3",
      exact: true,
    });
  });

  it("folds punctuation so a reworded title still matches", () => {
    expect(urlOf(modSourceLinks({ title: "BALDURS GATE 3" }), "nexus")?.exact).toBe(true);
    expect(urlOf(modSourceLinks({ title: "Baldur's Gate 3" }), "nexus")?.exact).toBe(true);
  });

  it("falls back to the site index instead of guessing a page", () => {
    const links = modSourceLinks({ title: "Some Game Nobody Listed" });
    expect(links.some((link) => link.key === "workshop")).toBe(false);
    expect(urlOf(links, "nexus")).toMatchObject({
      url: "https://www.nexusmods.com/games",
      exact: false,
    });
    expect(urlOf(links, "thunderstore")).toMatchObject({
      url: "https://thunderstore.io/communities/",
      exact: false,
    });
  });

  it("does not match an edition suffix onto the base game", () => {
    const links = modSourceLinks({ title: "The Witcher 3: Wild Hunt - Complete Edition" });
    expect(urlOf(links, "nexus")?.exact).toBe(false);
  });

  it("ignores a malformed app id but still resolves the title", () => {
    const links = modSourceLinks({
      title: "Cyberpunk 2077",
      steamAppId: "not-an-id",
      hasWorkshop: true,
    });
    expect(links.some((link) => link.key === "workshop")).toBe(false);
    expect(urlOf(links, "nexus")?.url).toBe("https://www.nexusmods.com/games/cyberpunk2077");
  });

  it("serves a row with no Nexus slug from Thunderstore alone", () => {
    const links = modSourceLinks({ title: "Risk of Rain 2", steamAppId: "632360" });
    expect(urlOf(links, "nexus")?.exact).toBe(false);
    expect(urlOf(links, "thunderstore")).toMatchObject({
      url: "https://thunderstore.io/c/riskofrain2/",
      exact: true,
    });
  });
});
