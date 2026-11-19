import { beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_THEME_KEY,
  applySurface,
  customThemes,
  customTokens,
  duplicateTheme,
  exportThemeJson,
  getCustomThemeInput,
  importThemeJson,
  saveCustomTheme,
  sanitizeSceneUrl,
  sanitizeThemeTokens,
  PRESET_WALLPAPERS,
  type CustomThemeInput,
} from "./themes";

const BASE: CustomThemeInput = {
  name: "Test Theme",
  bg: "#101014",
  accent: "#f97316",
  light: false,
};

beforeEach(() => localStorage.clear());

describe("theme tokens", () => {
  it("derives the full radius scale", () => {
    const sharp = customTokens({ ...BASE, radius: "sharp" });
    expect(sharp["--r-xs"]).toBe("0px");
    expect(sharp["--r-sm"]).toBe("0px");
    expect(sharp["--r-md"]).toBe("0px");
    expect(sharp["--r-lg"]).toBe("0px");
    expect(sharp["--r-pill"]).toBe("0px");

    const round = customTokens({ ...BASE, radius: "round" });
    expect(round["--r-xs"]).toBe("6px");
    expect(round["--r-sm"]).toBe("10px");
    expect(round["--r-md"]).toBe("16px");
    expect(round["--r-lg"]).toBe("20px");
    expect(round["--r-pill"]).toBe("999px");
  });

  it("drops tokens that could break out of the token stylesheet", () => {
    expect(
      sanitizeThemeTokens({
        "--ok": "#00ff00",
        "--bad": "red; } body { display:none }",
        "not-a-token": "red",
        "--comment": "red /*",
      }),
    ).toEqual({ "--ok": "#00ff00" });
  });

  it("rejects a scene that would close the CSS url string", () => {
    expect(sanitizeSceneUrl('data:image/svg+xml,") !important; } body { display:none } /*')).toBeUndefined();
    expect(sanitizeSceneUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const wallpaper of PRESET_WALLPAPERS) {
      expect(sanitizeSceneUrl(wallpaper.dataUrl)).toBe(wallpaper.dataUrl);
    }
  });
});

describe("custom theme transfer", () => {
  it("keeps the token table through export and import", () => {
    const id = saveCustomTheme({
      ...BASE,
      tokens: { "--ok": "#00ff00", "--r-sm": "2px" },
    });
    expect(id).not.toBe("");

    const imported = importThemeJson(exportThemeJson(id));
    expect(imported).not.toBeNull();

    const input = getCustomThemeInput(imported!.id);
    expect(input?.tokens?.["--ok"]).toBe("#00ff00");
    expect(input?.tokens?.["--r-sm"]).toBe("2px");
    expect(input?.name).toBe(BASE.name);
  });

  it("rejects a future schema instead of guessing", () => {
    const parsed = JSON.parse(exportThemeJson("neongrid")) as Record<string, unknown>;
    parsed.efxlve_theme = 3;
    expect(importThemeJson(JSON.stringify(parsed))).toBeNull();
  });

  it("drops unsafe fields from an imported file but keeps the palette", () => {
    const imported = importThemeJson(
      JSON.stringify({
        efxlve_theme: 2,
        name: "Imported",
        bg: "#101014",
        accent: "#ffffff",
        scene: 'data:image/svg+xml,") !important; } body { display:none } /*',
        tokens: { "--ok": "#00ff00", "--bad": "red; } body { display:none }" },
      }),
    );
    expect(imported).not.toBeNull();

    const input = getCustomThemeInput(imported!.id);
    expect(input?.bg).toBe("#101014");
    expect(input?.scene).toBeUndefined();
    expect(input?.tokens).toEqual({ "--ok": "#00ff00" });
  });

  it("keeps a cloned built-in's tokens when the theme is renamed", () => {
    const id = duplicateTheme("neongrid");
    const cloned = getCustomThemeInput(id);
    expect(cloned?.tokens?.["--accent"]).toBe("#fcee0a");

    saveCustomTheme({ ...cloned!, name: "Renamed" });
    expect(getCustomThemeInput(id)?.tokens?.["--accent"]).toBe("#fcee0a");
  });

  it("does not resurrect built-in tokens after the palette is edited", () => {
    const id = duplicateTheme("neongrid");
    const cloned = getCustomThemeInput(id)!;

    saveCustomTheme({
      ...cloned,
      accent: "#00ff00",
      sourceId: undefined,
      tokens: undefined,
    });

    const edited = getCustomThemeInput(id);
    expect(edited?.accent).toBe("#00ff00");
    expect(edited?.tokens).toBeUndefined();
  });

  it("exports built-in token overrides", () => {
    const exported = JSON.parse(exportThemeJson("neongrid")) as {
      tokens?: Record<string, string>;
    };
    expect(exported.tokens?.["--accent"]).toBe("#fcee0a");
  });

  it("recovers missing tokens from a clone's stable source id", () => {
    localStorage.setItem(
      "efxlve-custom-themes",
      JSON.stringify([
        {
          id: "custom-1",
          sourceId: "neongrid",
          name: "My Neon",
          bg: "#07080a",
          accent: "#fcee0a",
          light: false,
        },
      ]),
    );

    const recovered = customThemes().find((theme) => theme.id === "custom-1");
    expect(recovered?.tokens?.["--accent"]).toBe("#fcee0a");
  });
});

describe("boot snapshot", () => {
  it("writes the applied theme's background and tokens", () => {
    applySurface("neongrid", false);
    const raw = localStorage.getItem(BOOT_THEME_KEY);
    expect(raw).not.toBeNull();

    const snapshot = JSON.parse(raw!) as {
      id: string;
      scheme: string;
      bg: string;
      tokens: Record<string, string>;
    };
    expect(snapshot.id).toBe("neongrid");
    expect(snapshot.scheme).toBe("dark");
    expect(snapshot.bg).toBe("#07080a");
    expect(snapshot.tokens["--accent"]).toBe("#fcee0a");
  });
});
