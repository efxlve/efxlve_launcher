import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_THEME_KEY,
  applySurface,
  builtinThemeInput,
  clearThemeCache,
  customThemes,
  customTokens,
  duplicateTheme,
  exportThemeJson,
  exportThemePack,
  getCustomThemeInput,
  importThemeJson,
  importThemePack,
  hydrateThemeScenes,
  saveCustomTheme,
  sanitizePreviewBg,
  sanitizeSceneBackground,
  sanitizeSceneUrl,
  sanitizeThemeTokens,
  contrastRatio,
  defineTheme,
  ensureThemeCatalog,
  isThemeCatalogLoaded,
  normalizeSurface,
  PRESET_WALLPAPERS,
  themeById,
  themes,
  type CustomThemeInput,
} from "./themes";
import { clearThemeSceneCache, setThemeSceneStore } from "./theme/scenes";

let sceneStore: Map<string, string>;

const BASE: CustomThemeInput = {
  name: "Test Theme",
  bg: "#101014",
  accent: "#f97316",
  light: false,
};
const SCENE = "data:image/png;base64,AAAA";

beforeEach(() => {
  localStorage.clear();
  clearThemeCache();
  clearThemeSceneCache();
  const store = new Map<string, string>();
  sceneStore = store;
  setThemeSceneStore({
    getAll: async () => new Map(store),
    put: async (id, data) => {
      store.set(id, data);
      return true;
    },
    delete: async (id) => {
      store.delete(id);
    },
  });
});

describe("lazy catalog", () => {
  it("paints the active extended theme from the boot snapshot", () => {
    localStorage.setItem(
      "efxlve-boot-theme",
      JSON.stringify({
        id: "neongrid",
        scheme: "dark",
        bg: "#07080a",
        labelKey: "settings.surfaceNeonGrid",
        tokens: {
          "--bg": "#07080a",
          "--surface-1": "#0c0e12",
          "--accent": "#fcee0a",
          "--text": "#fefefe",
          "--scene-bg": '#07080a url("../assets/neon-grid-scene.svg") 0 0 / 100vw 100vh no-repeat fixed',
        },
      }),
    );

    expect(normalizeSurface("neongrid")).toBe("neongrid");
    expect(themeById("neongrid").tokens?.["--accent"]).toBe("#fcee0a");
    expect(themeById("neongrid").tokens?.["--scene-bg"]).toContain("neon-grid-scene.svg");
    applySurface("neongrid", false);
    const snapshot = JSON.parse(localStorage.getItem("efxlve-boot-theme")!) as { id: string };
    expect(snapshot.id).toBe("neongrid");
  });

  it("keeps extended themes out until the Themes page asks", async () => {
    expect(isThemeCatalogLoaded()).toBe(false);
    expect(themes().some((theme) => theme.id === "neongrid")).toBe(false);

    await ensureThemeCatalog();

    expect(isThemeCatalogLoaded()).toBe(true);
    expect(themes().some((theme) => theme.id === "neongrid")).toBe(true);
  });
});

describe("theme tokens", () => {
  it("keeps the full radius scale", () => {
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

describe("theme registry", () => {
  it("defines a colour theme from a compact recipe", () => {
    const theme = defineTheme({
      id: "recipe-test",
      name: "Recipe Test",
      bg: "#101014",
      accent: "#f97316",
      light: false,
      radius: "round",
      tokens: { "--accent-hover": "#111111" },
    });
    expect(theme.scheme).toBe("dark");
    expect(theme.tokens?.["--bg"]).toBe("#101014");
    expect(theme.tokens?.["--r-lg"]).toBe("20px");
    expect(theme.tokens?.["--accent-hover"]).toBe("#111111");
    expect(theme.tags).toBeUndefined();
  });

  it("has unique ids and complete core tokens", () => {
    const list = themes();
    const ids = list.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);

    const core = [
      "--bg",
      "--surface-1",
      "--surface-2",
      "--surface-3",
      "--line",
      "--line-strong",
      "--text",
      "--text-2",
      "--text-3",
      "--accent",
      "--accent-hover",
      "--accent-tint",
      "--on-accent",
      "--ok",
      "--warn",
      "--err",
    ];
    for (const theme of list) {
      if (!theme.tokens) continue;
      for (const key of core) {
        expect(theme.tokens[key], `${theme.id} ${key}`).toBeTruthy();
      }
    }
  });

  it("ships 250 built-in themes after the catalog loads", async () => {
    await ensureThemeCatalog();
    const builtins = themes().filter((theme) => !theme.custom);
    expect(builtins).toHaveLength(250);
    expect(new Set(builtins.map((theme) => theme.id)).size).toBe(250);
    expect(new Set(builtins.map((theme) => theme.name ?? theme.labelKey)).size).toBe(250);
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
    parsed.efxlve_theme = 4;
    expect(importThemeJson(JSON.stringify(parsed))).toBeNull();
  });

  it("imports a v2 palette from an older build", () => {
    const imported = importThemeJson(
      JSON.stringify({
        efxlve_theme: 2,
        name: "Old Theme",
        bg: "#101014",
        accent: "#ffffff",
      }),
    );
    expect(imported).not.toBeNull();
    expect(getCustomThemeInput(imported!.id)?.name).toBe("Old Theme");
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

  it("keeps a cloned built-in's tokens when the theme is renamed", async () => {
    await ensureThemeCatalog();
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

  it("exports built-in token overrides", async () => {
    await ensureThemeCatalog();
    const exported = JSON.parse(exportThemeJson("neongrid")) as {
      tokens?: Record<string, string>;
    };
    expect(exported.tokens?.["--accent"]).toBe("#fcee0a");
  });

  it("materializes scene-theme tokens for clone and export", async () => {
    await ensureThemeCatalog();
    for (const id of ["white", "blades", "gloss", "neongrid"]) {
      const theme = themes().find((item) => item.id === id);
      expect(theme?.tokens?.["--bg"], id).toBeTruthy();

      const cloneId = duplicateTheme(id);
      expect(getCustomThemeInput(cloneId)?.tokens?.["--bg"], id).toBe(theme?.tokens?.["--bg"]);
    }
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

  it("parses the custom theme list once", () => {
    saveCustomTheme({ ...BASE });
    clearThemeCache();
    customThemes();

    const getItem = vi.spyOn(Storage.prototype, "getItem");
    themes();
    themes();
    themeById("neongrid");
    const customReads = getItem.mock.calls.filter(([key]) => key === "efxlve-custom-themes");
    expect(customReads).toHaveLength(0);
    getItem.mockRestore();
  });
});

describe("theme cloning", () => {
  it("keeps a scene theme's backdrop, gradient preview and glass flag", async () => {
    await ensureThemeCatalog();
    const id = duplicateTheme("neongrid");
    const cloned = getCustomThemeInput(id)!;
    const source = themeById("neongrid");

    expect(cloned.sceneBg).toContain("neon-grid-scene.svg");
    expect(cloned.previewBg).toBe(source.bg);
    expect(cloned.cardGlass).toBe(false);

    applySurface(id, false);
    const css = document.getElementById("efxlve-theme-tokens")?.textContent ?? "";
    expect(css).toContain("neon-grid-scene.svg");
    expect(css).toContain('body { background: #07080a url(');
  });

  it("detects translucent panels and keeps a solid surface hint", () => {
    const blades = builtinThemeInput("blades");
    expect(blades.sceneBg).toContain("blades-scene.svg");
    expect(blades.previewBg).toContain("linear-gradient");
    expect(blades.cardGlass).toBe(true);
    expect(blades.surface).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("round-trips the extra clone fields through export and import", () => {
    const cloneId = duplicateTheme("blades");
    const imported = importThemeJson(exportThemeJson(cloneId));
    expect(imported).not.toBeNull();

    const input = getCustomThemeInput(imported!.id)!;
    expect(input.sceneBg).toContain("blades-scene.svg");
    expect(input.previewBg).toContain("linear-gradient");
    expect(input.cardGlass).toBe(true);
    expect(input.surface).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("recovers the source backdrop for clones saved by older builds", async () => {
    await ensureThemeCatalog();
    localStorage.setItem(
      "efxlve-custom-themes",
      JSON.stringify([
        {
          id: "custom-old",
          sourceId: "neongrid",
          name: "Old Neon",
          bg: "#07080a",
          accent: "#fcee0a",
          light: false,
        },
      ]),
    );

    const input = getCustomThemeInput("custom-old");
    expect(input?.sceneBg).toContain("neon-grid-scene.svg");
    expect(input?.previewBg).toContain("linear-gradient");
    expect(input?.tokens?.["--scene-bg"]).toBeUndefined();
  });

  it("rejects a foreign scene background and an unsafe preview gradient", () => {
    expect(sanitizeSceneBackground('url("https://example.com/scene.svg")')).toBeUndefined();
    expect(
      sanitizeSceneBackground('#07080a url("https://example.com/scene.svg") 0 0 / 100vw 100vh no-repeat fixed'),
    ).toBeUndefined();
    expect(sanitizePreviewBg("linear-gradient(135deg, #000 0%, #fff 100%); } body { display:none")).toBeUndefined();
    expect(sanitizePreviewBg("linear-gradient(135deg, #000 0%, #fff 100%)")).toBe(
      "linear-gradient(135deg, #000 0%, #fff 100%)",
    );
  });
});

describe("theme wallpapers", () => {
  it("stores the scene in IndexedDB and leaves metadata in localStorage", () => {
    const id = saveCustomTheme({ ...BASE, scene: SCENE });
    const raw = JSON.parse(localStorage.getItem("efxlve-custom-themes")!) as Array<Record<string, unknown>>;

    expect(raw[0].scene).toBeUndefined();
    expect(raw[0].sceneStored).toBe(true);
    expect(sceneStore.get(id)).toBe(SCENE);
    expect(getCustomThemeInput(id)?.scene).toBe(SCENE);
    expect((JSON.parse(exportThemeJson(id)) as { scene?: string }).scene).toBe(SCENE);
  });

  it("moves a legacy base64 scene out of localStorage", async () => {
    localStorage.setItem(
      "efxlve-custom-themes",
      JSON.stringify([
        {
          id: "custom-1",
          name: "Legacy",
          bg: "#101014",
          accent: "#f97316",
          light: false,
          scene: SCENE,
        },
      ]),
    );
    clearThemeCache();
    clearThemeSceneCache();

    await hydrateThemeScenes();

    const raw = JSON.parse(localStorage.getItem("efxlve-custom-themes")!) as Array<Record<string, unknown>>;
    expect(raw[0].scene).toBeUndefined();
    expect(raw[0].sceneStored).toBe(true);
    expect(sceneStore.get("custom-1")).toBe(SCENE);
    expect(getCustomThemeInput("custom-1")?.scene).toBe(SCENE);
  });

  it("reloads the wallpaper from the store after a cache reset", async () => {
    const id = saveCustomTheme({ ...BASE, scene: SCENE });
    clearThemeCache();
    clearThemeSceneCache();

    await hydrateThemeScenes();

    expect(getCustomThemeInput(id)?.scene).toBe(SCENE);
    applySurface(id, false);
    const css = document.getElementById("efxlve-theme-tokens")?.textContent ?? "";
    expect(css).toContain(SCENE);
  });

  it("removes the stored wallpaper when the designer clears it", async () => {
    const id = saveCustomTheme({ ...BASE, scene: SCENE });
    const input = getCustomThemeInput(id)!;
    saveCustomTheme({ ...input, scene: undefined, removeScene: true });
    await Promise.resolve();

    expect(sceneStore.has(id)).toBe(false);
    expect(getCustomThemeInput(id)?.scene).toBeUndefined();
    const raw = JSON.parse(localStorage.getItem("efxlve-custom-themes")!) as Array<Record<string, unknown>>;
    expect(raw[0].sceneStored).toBe(false);
  });

  it("keeps a wallpaper when a metadata-only save omits the scene", async () => {
    const id = saveCustomTheme({ ...BASE, scene: SCENE });
    const input = getCustomThemeInput(id)!;
    saveCustomTheme({ ...input, name: "Renamed", scene: undefined });
    await Promise.resolve();

    expect(sceneStore.has(id)).toBe(true);
    expect(getCustomThemeInput(id)?.scene).toBe(SCENE);
    expect(getCustomThemeInput(id)?.name).toBe("Renamed");
  });

  it("keeps the image in metadata when the store rejects the write", async () => {
    setThemeSceneStore({
      getAll: async () => new Map(),
      put: async () => false,
      delete: async () => undefined,
    });

    const id = saveCustomTheme({ ...BASE, scene: SCENE });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const raw = JSON.parse(localStorage.getItem("efxlve-custom-themes")!) as Array<Record<string, unknown>>;
    expect(raw[0].scene).toBe(SCENE);
    expect(raw[0].sceneStored).toBe(false);
    expect(getCustomThemeInput(id)?.scene).toBe(SCENE);
  });
});

describe("theme packs", () => {
  it("round-trips custom themes and a shared scene asset", () => {
    saveCustomTheme({ ...BASE, name: "Pack A", scene: SCENE });
    saveCustomTheme({ ...BASE, name: "Pack B", accent: "#22c55e", scene: SCENE });

    const pack = exportThemePack();
    expect(pack?.count).toBe(2);
    const parsed = JSON.parse(pack!.json) as {
      efxlve_pack: number;
      themes: { scene?: string }[];
      assets: Record<string, string>;
    };
    expect(parsed.efxlve_pack).toBe(1);
    expect(parsed.themes).toHaveLength(2);
    expect(Object.keys(parsed.assets)).toHaveLength(1);
    expect(parsed.themes.every((theme) => theme.scene?.startsWith("asset:"))).toBe(true);

    localStorage.clear();
    clearThemeCache();
    clearThemeSceneCache();
    sceneStore.clear();

    const result = importThemePack(pack!.json);
    expect(result).toEqual({ imported: 2, failed: 0, names: ["Pack A", "Pack B"] });
    expect(customThemes().map((theme) => theme.name).sort()).toEqual(["Pack A", "Pack B"]);
    const imported = customThemes().find((theme) => theme.name === "Pack A");
    expect(imported?.scene).toBe(SCENE);
  });

  it("rejects a future pack schema", () => {
    saveCustomTheme({ ...BASE, name: "Pack A" });
    const parsed = JSON.parse(exportThemePack()!.json) as Record<string, unknown>;
    parsed.efxlve_pack = 2;
    expect(importThemePack(JSON.stringify(parsed))).toBeNull();
  });

  it("imports valid entries and counts invalid ones", () => {
    const result = importThemePack(
      JSON.stringify({
        efxlve_pack: 1,
        themes: [
          { efxlve_theme: 3, name: "Good", bg: "#101014", accent: "#f97316" },
          { nope: true },
        ],
        assets: {},
      }),
    );
    expect(result).toEqual({ imported: 1, failed: 1, names: ["Good"] });
  });

  it("drops a missing scene asset but imports the theme", () => {
    const result = importThemePack(
      JSON.stringify({
        efxlve_pack: 1,
        themes: [
          {
            efxlve_theme: 3,
            name: "No Scene",
            bg: "#101014",
            accent: "#f97316",
            scene: "asset:missing",
          },
        ],
        assets: {},
      }),
    );
    expect(result?.imported).toBe(1);
    expect(getCustomThemeInput(customThemes()[0].id!)?.scene).toBeUndefined();
  });

  it("rejects an empty package and exports nothing when there are no custom themes", () => {
    expect(exportThemePack()).toBeNull();
    expect(importThemePack(JSON.stringify({ efxlve_pack: 1, themes: [] }))).toBeNull();
  });
});

describe("theme contrast", () => {
  it("keeps primary text readable on every built-in theme", async () => {
    await ensureThemeCatalog();
    const failures: string[] = [];
    for (const theme of themes()) {
      const tokens = theme.tokens;
      if (!tokens) continue;
      const text = tokens["--text"];
      const bg = tokens["--bg"];
      const accent = tokens["--accent"];
      const on = tokens["--on-accent"];
      if (text && bg && contrastRatio(text, bg) < 4.5) {
        failures.push(`${theme.id} text/bg ${contrastRatio(text, bg).toFixed(2)}`);
      }
      if (accent && on && contrastRatio(accent, on) < 4.5) {
        failures.push(`${theme.id} on/accent ${contrastRatio(accent, on).toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("boot snapshot", () => {
  it("writes the applied theme's background and tokens", async () => {
    await ensureThemeCatalog();
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

  it("paints built-in scene tokens without stripping their url()", () => {
    applySurface("gloss", false);
    const css = document.getElementById("efxlve-theme-tokens")?.textContent ?? "";
    expect(css).toContain("--scene-bg");
    expect(css).toContain("gloss-scene.svg");
  });
});
