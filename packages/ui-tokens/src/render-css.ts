import type {
  ColorTokens,
  RadiusKey,
  ResolvedAppearance,
  ShadowKey,
  SizeKey,
  SpaceKey,
  TypographyKey,
} from "./index.js";
import {
  darkTokens,
  lightTokens,
  motion,
  RADIUS,
  radii,
  sceneBrightness,
  shadowsForAppearance,
  sizes,
  space,
  typography,
} from "./index.js";
import type { MaterialKey } from "./materials.js";
import {
  ambient,
  materials,
  narrowBackgroundFade,
  narrowMaxWidth,
  overlayBlur,
  scrollEdgeBlur,
  threadFade,
} from "./materials.js";

/** `cardForeground` -> `card-foreground` (no leading `--`). */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${kebabCase(token)}`;
}

/** Splits a CSS list on its top-level commas, as biome breaks it, never inside a function. */
function splitTopLevel(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      layers.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

/** `biome`'s CSS formatter (100-col `lineWidth`) wraps a declaration that
 * doesn't fit on one line onto the next, indenting the value by 4 spaces and
 * filling each line with as many comma-separated layers as fit: this keeps a
 * fresh `generate` byte-identical to what `biome check --write` would
 * produce, so `tokens.css` never has to be reformatted by hand. */
function renderDeclaration(name: string, value: string, indent = "  "): string {
  const oneLine = `${indent}${name}: ${value};`;
  if (oneLine.length <= 100) return oneLine;
  const layers = splitTopLevel(value);
  const lines: string[] = [];
  let line = "";
  for (const [index, layer] of layers.entries()) {
    const end = index === layers.length - 1 ? ";" : ",";
    const candidate = line ? `${line} ${layer}${end}` : `${indent}  ${layer}${end}`;
    if (line && candidate.length > 100) {
      lines.push(line);
      line = `${indent}  ${layer}${end}`;
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return `${indent}${name}:\n${lines.join("\n")}`;
}

function renderShadowLines(appearance: ResolvedAppearance): string[] {
  const palette = shadowsForAppearance(appearance);
  return (Object.keys(palette) as ShadowKey[]).map((key) =>
    renderDeclaration(`--elevation-${kebabCase(key)}`, palette[key]),
  );
}

const materialKeys = Object.keys(materials) as MaterialKey[];

function renderMaterialLines(appearance: ResolvedAppearance): string[] {
  return [
    ...materialKeys.flatMap((key) => [
      renderDeclaration(`--material-${key}-fill`, materials[key].fill[appearance]),
      renderDeclaration(`--material-${key}-edge`, materials[key].edge[appearance]),
      `  --material-${key}-fallback: var(${cssVariableName(materials[key].fallback)});`,
    ]),
    renderDeclaration("--ambient", ambient.desktop[appearance]),
  ];
}

function renderMaterialGeometryLines(): string[] {
  return [
    ...materialKeys.flatMap((key) => [
      `  --material-${key}-blur: ${materials[key].blur}px;`,
      `  --material-${key}-saturate: ${materials[key].saturate}%;`,
    ]),
    `  --scroll-edge-blur: ${scrollEdgeBlur}px;`,
    `  --thread-fade-top-start: ${threadFade.topStart}px;`,
    `  --thread-fade-top-end: ${threadFade.topEnd}px;`,
    `  --thread-fade-bottom-start: ${threadFade.bottomStart}px;`,
    `  --thread-fade-bottom-end: ${threadFade.bottomEnd}px;`,
    `  --thread-fade-bottom-rest: ${threadFade.bottomRest}px;`,
    `  --thread-under-composer: ${threadFade.underComposer}px;`,
    `  --overlay-blur: ${overlayBlur}px;`,
  ];
}

/**
 * Phone width takes its own ambient light, higher and from the corner, ending in
 * the page background at the bottom edge for Safari's toolbar.
 */
function renderNarrowAmbientBlock(): string {
  const block = (selector: string, appearance: ResolvedAppearance) => {
    const background = (appearance === "light" ? lightTokens : darkTokens).background.toLowerCase();
    const value = `linear-gradient(to top, ${background} 0%, transparent ${narrowBackgroundFade}%), ${ambient.narrow[appearance]}`;
    return `  ${selector} {\n${renderDeclaration("--ambient", value, "    ")}\n  }`;
  };
  return `@media (max-width: ${narrowMaxWidth}px) {\n${block(':root,\n  [data-theme="dark"]', "dark")}\n\n${block('[data-theme="light"]', "light")}\n}`;
}

function renderTypographyLines(): string[] {
  return (Object.keys(typography) as TypographyKey[]).flatMap((key) => {
    const token = typography[key];
    const name = `type-${kebabCase(key)}`;
    return [
      `  --${name}-size: ${token.size}px;`,
      `  --${name}-leading: ${token.leading};`,
      `  --${name}-tracking: ${token.tracking};`,
      `  --${name}-weight: ${token.weight};`,
    ];
  });
}

function renderSpaceLines(): string[] {
  return (Object.keys(space) as SpaceKey[]).map(
    (key) => `  --space-${kebabCase(key)}: ${space[key]}px;`,
  );
}

function renderRadiiLines(): string[] {
  return (Object.keys(radii) as RadiusKey[]).map(
    (key) => `  --corner-${kebabCase(key)}: ${radii[key]}px;`,
  );
}

function renderSizeLines(): string[] {
  return (Object.keys(sizes) as SizeKey[]).map(
    (key) => `  --size-${kebabCase(key)}: ${sizes[key]}px;`,
  );
}

function renderMotionLines(): string[] {
  const lines = Object.entries(motion).flatMap(([key, value]) =>
    typeof value === "number" ? [`  --duration-${kebabCase(key)}: ${value}ms;`] : [],
  );
  lines.push(`  --motion-ease: ${motion.ease};`);
  return lines;
}

function renderBlock(
  selector: string,
  colorScheme: ResolvedAppearance,
  palette: ColorTokens,
): string {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  lines.push(`  --radius: ${RADIUS};`, `  --scene-brightness: ${sceneBrightness[colorScheme]};`);
  lines.push(...renderShadowLines(colorScheme), ...renderMaterialLines(colorScheme));
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n}`;
}

function renderThemeIndependentBlock(): string {
  const lines = [
    ...renderTypographyLines(),
    ...renderSpaceLines(),
    ...renderRadiiLines(),
    ...renderSizeLines(),
    ...renderMotionLines(),
    ...renderMaterialGeometryLines(),
  ];
  return `:root {\n${lines.join("\n")}\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @tangow/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderThemeIndependentBlock(),
    renderNarrowAmbientBlock(),
  ].join("\n\n")}\n`;
}
