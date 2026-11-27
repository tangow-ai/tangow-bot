import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  botAccentOn,
  type ColorTokens,
  contrastRatio,
  darkTokens,
  lightTokens,
  materials,
  normalizeAppearancePreference,
  persistAppearancePreference,
  resolveAppearance,
  resolveAppearancePreference,
  tokensForAppearance,
  UI_APPEARANCE_STORAGE_KEY,
} from "./index.js";
import { cssVariableName, renderTokensCss } from "./render-css.js";

describe("appearance preference", () => {
  it("defaults unknown values to system", () => {
    expect(normalizeAppearancePreference(null)).toBe("system");
    expect(normalizeAppearancePreference("nope")).toBe("system");
    expect(normalizeAppearancePreference("light")).toBe("light");
  });

  it("resolves system from the platform scheme", () => {
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("dark", "light")).toBe("dark");
  });

  it("reads and writes storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(resolveAppearancePreference({ storage })).toBe("system");
    persistAppearancePreference("light", storage);
    expect(store.get(UI_APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(resolveAppearancePreference({ storage })).toBe("light");
  });

  it("returns distinct light and dark token sets", () => {
    expect(tokensForAppearance("dark")).toBe(darkTokens);
    expect(tokensForAppearance("light")).toBe(lightTokens);
    for (const key of Object.keys(darkTokens) as (keyof ColorTokens)[]) {
      if (key === "destructiveForeground" || key === "plate" || key.startsWith("mediaBackdrop")) {
        continue;
      }
      expect(darkTokens[key], key).not.toBe(lightTokens[key]);
    }
  });

  it("keeps user message surfaces muted, not cream invert", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.secondary).not.toBe(dark.primary);
    expect(light.secondary).not.toBe(light.primary);
    expect(dark.secondaryForeground).not.toBe(dark.primaryForeground);
  });

  it("separates user bubbles from bot bubbles and the sidebar from the app", () => {
    const dark = tokensForAppearance("dark");
    const light = tokensForAppearance("light");
    expect(dark.chatUser).not.toBe(dark.chatBot);
    expect(light.chatUser).not.toBe(light.chatBot);
    expect(dark.sidebar).not.toBe(dark.background);
    expect(light.sidebar).not.toBe(light.background);
  });

  it("tolerates a throwing localStorage getter", () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      expect(resolveAppearancePreference()).toBe("system");
      persistAppearancePreference("light");
      expect(resolveAppearancePreference()).toBe("system");
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe("tokens.css", () => {
  it("derives kebab-case variable names", () => {
    expect(cssVariableName("background")).toBe("--background");
    expect(cssVariableName("mutedForeground")).toBe("--muted-foreground");
    expect(cssVariableName("sidebarAccentForeground")).toBe("--sidebar-accent-foreground");
  });

  it("is generated from the TS palette", () => {
    const onDisk = readFileSync(fileURLToPath(new URL("./tokens.css", import.meta.url)), "utf8");
    expect(onDisk).toBe(renderTokensCss());
  });

  it("scopes light and dark under data-theme", () => {
    const css = renderTokensCss();
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css).toContain('[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain(`--background: ${lightTokens.background.toLowerCase()};`);
    expect(css).toContain(`--background: ${darkTokens.background.toLowerCase()};`);
  });

  it("emits typography, space, corner, elevation, motion and size tokens", () => {
    const css = renderTokensCss();
    expect(css).toContain("--elevation-card");
    expect(css).toContain("--type-body-size: 16px");
    expect(css).toContain("--corner-block: 24px");
    expect(css).toContain("--space-sidebar: 280px");
    expect(css).toContain("--duration-arrive: 240ms");
    expect(css).toContain("--motion-ease");
  });

  it("emits the materials per theme and a phone-width ambient light", () => {
    const css = renderTokensCss();
    const [dark, light, geometry, narrow] = css.split(
      /\n\[data-theme="light"\] \{|\n:root \{|\n@media /,
    );
    expect(dark).toContain(`--material-chrome-fill: ${materials.chrome.fill.dark};`);
    expect(light).toContain(`--material-chrome-fill: ${materials.chrome.fill.light};`);
    expect(light).toContain("--material-chrome-fallback: var(--sidebar);");
    expect(light).not.toContain("--material-control-blur");
    expect(geometry).toContain("--scroll-edge-blur: 20px;");
    expect(narrow).toMatch(/^\(max-width: 767px\) \{\n {2}:root,/);
    expect(narrow).toContain("#36363c 0%");
  });
});

// The composer placeholder uses `mutedForeground`: `foregroundSubtle` falls
// short of 4.5:1 on `surface` in both themes.
describe("composer placeholder contrast", () => {
  it("keeps mutedForeground over surface at or above 4.5:1 in both themes", () => {
    expect(contrastRatio(lightTokens.mutedForeground, lightTokens.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(darkTokens.mutedForeground, darkTokens.surface)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("is a real improvement over the retired foregroundSubtle, which fell short", () => {
    expect(contrastRatio(lightTokens.foregroundSubtle, lightTokens.surface)).toBeLessThan(4.5);
    expect(contrastRatio(darkTokens.foregroundSubtle, darkTokens.surface)).toBeLessThan(4.5);
  });
});

describe("botAccentOn", () => {
  it("keeps a bot colour that reads in the composer", () => {
    expect(botAccentOn("#E0714F", "light")).toBe("#E0714F");
    expect(botAccentOn("#E0714F", "dark")).toBe("#E0714F");
  });

  it("keeps every palette colour on the dark composer, violet and red included", () => {
    expect(botAccentOn("#8B5CF6", "dark")).toBe("#8B5CF6");
    expect(botAccentOn("#E0524A", "dark")).toBe("#E0524A");
  });

  it("drops the near-black bot colour on dark and white on light", () => {
    expect(botAccentOn("#17181A", "dark")).toBeUndefined();
    expect(botAccentOn("#17181A", "light")).toBe("#17181A");
    expect(botAccentOn("#FFFFFF", "light")).toBeUndefined();
    expect(botAccentOn("#FFFFFF", "dark")).toBe("#FFFFFF");
  });

  it("drops a missing or non-hex colour", () => {
    expect(botAccentOn(undefined, "light")).toBeUndefined();
    expect(botAccentOn("tomato", "dark")).toBeUndefined();
  });
});
