export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "tangow.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  foregroundSubtle: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  /** A bot's words: the paper every bot bubble, and what the bot produces, sits on. */
  chatBot: string;
  chatUser: string;
  chatUserForeground: string;
  mentionChip: string;
  mentionChipForeground: string;
  /** The tile behind a link mention's fallback glyph in a bot bubble: a step off `chatBot`. */
  linkMentionTile: string;
  muted: string;
  mutedForeground: string;
  /**
   * The disc behind a bot's clay character: a translucent veil, as iOS fills are, so it reads
   * over every part of the ambient light (opaque `muted` dissolves where the gradient matches it).
   */
  avatarDisc: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  outline: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  surface: string;
  /** The opaque plane of a side panel or an overlay window: content, so never glass. */
  sheet: string;
  /** A settings or activity group on a sheet, or on the page at phone width. */
  group: string;
  /** Reading matter and fields inside a decision card; a file's or the computer's icon tile. */
  well: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
  /** A question card's option tile at rest, and under the pointer. */
  optionRing: string;
  optionRingHover: string;
  /** The fill of a control being pressed. */
  pressed: string;
  /** The black behind a picture shown on its own, in both themes, like Photos. */
  mediaBackdrop: string;
  /** Text and icons on `mediaBackdrop`. */
  mediaBackdropForeground: string;
  /** Secondary text on `mediaBackdrop`. */
  mediaBackdropMuted: string;
  /** A round control, or a picture's placeholder, on `mediaBackdrop`. */
  mediaBackdropControl: string;
  /** The clay plate behind an onboarding scene, shown until its picture arrives: light in both themes. */
  plate: string;
};

// Alpha overlays from the design are flattened so every slot stays opaque
// (opacity modifiers and color-mix must keep working). The dark planes rise
// in steps: background, chatBot, surface, secondary.
export const darkTokens = {
  background: "#161618",
  foreground: "#F5F5F7",
  foregroundSubtle: "#7C7C81",
  card: "#2C2C2E",
  cardForeground: "#F5F5F7",
  popover: "#2C2C2E",
  popoverForeground: "#F5F5F7",
  primary: "#F5F5F7",
  primaryForeground: "#1D1D1F",
  secondary: "#56565A",
  secondaryForeground: "#F5F5F7",
  chatBot: "#2C2C2F",
  chatUser: "#636366",
  chatUserForeground: "#F5F5F7",
  mentionChip: "#3A3A3D",
  mentionChipForeground: "#F5F5F7",
  linkMentionTile: "#444447",
  muted: "#2A2A2D",
  mutedForeground: "#AEAEB2",
  avatarDisc: "rgba(118, 118, 128, 0.24)",
  accent: "#252527",
  accentForeground: "#F5F5F7",
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#2D2D30",
  outline: "#3F3F42",
  input: "#4A4A4D",
  ring: "#AEAEB2",
  sidebar: "#2C2C2E",
  sidebarForeground: "#F5F5F7",
  sidebarBorder: "#2D2D30",
  sidebarAccent: "#414143",
  sidebarAccentForeground: "#F5F5F7",
  surface: "#3C3C3F",
  sheet: "#232326",
  group: "#333336",
  well: "#4E4E50",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(4, 4, 5, 0.72)",
  scrollbar: "#3A3A3D",
  scrollbarHover: "#4A4A4D",
  optionRing: "#636366",
  optionRingHover: "#77777B",
  pressed: "#4A4A4D",
  mediaBackdrop: "#000000",
  mediaBackdropForeground: "#F5F5F7",
  mediaBackdropMuted: "#AEAEB2",
  mediaBackdropControl: "#2C2C2E",
  plate: "#DCD8D9",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#F2F2F4",
  foreground: "#1D1D1F",
  foregroundSubtle: "#86868B",
  card: "#FFFFFF",
  cardForeground: "#1D1D1F",
  popover: "#FFFFFF",
  popoverForeground: "#1D1D1F",
  primary: "#1D1D1F",
  primaryForeground: "#FFFFFF",
  secondary: "#E8E8EA",
  secondaryForeground: "#1D1D1F",
  chatBot: "#FFFFFF",
  chatUser: "#1D1D1F",
  chatUserForeground: "#FFFFFF",
  mentionChip: "#EDEDF0",
  mentionChipForeground: "#1D1D1F",
  linkMentionTile: "#F2F2F4",
  muted: "#E8E8EA",
  mutedForeground: "#6E6E73",
  avatarDisc: "rgba(118, 118, 128, 0.12)",
  accent: "#EBEBED",
  accentForeground: "#1D1D1F",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#E3E3E6",
  outline: "#D2D2D6",
  input: "#D8D8DC",
  ring: "#6E6E73",
  sidebar: "#F5F5F7",
  sidebarForeground: "#1D1D1F",
  sidebarBorder: "#E3E3E6",
  sidebarAccent: "#E6E6E9",
  sidebarAccentForeground: "#1D1D1F",
  surface: "#FFFFFF",
  sheet: "#F5F5F7",
  group: "#FFFFFF",
  well: "#EEEEF1",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C7C7CC",
  scrollbarHover: "#AEAEB2",
  optionRing: "#DADADD",
  optionRingHover: "#C7C7CC",
  pressed: "#E8E8EA",
  mediaBackdrop: "#000000",
  mediaBackdropForeground: "#F5F5F7",
  mediaBackdropMuted: "#AEAEB2",
  mediaBackdropControl: "#2C2C2E",
  plate: "#DCD8D9",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const botColors = [
  "#00C46A",
  "#3BC9A0",
  "#2E8CF0",
  "#8B5CF6",
  "#E45C9C",
  "#E0524A",
  "#F0913A",
] as const;

/**
 * Typography — one scale for every surface that renders prose or UI labels.
 * `tracking` is a CSS letter-spacing value (an em string, or `"0"`); `weight`
 * is the base font-weight (some screens layer a heavier weight on top, e.g.
 * a selected sidebar row or a primary capsule — see the design contract).
 */
export type TypographyToken = {
  size: number;
  leading: number;
  tracking: string;
  weight: number;
};

// Whole-pixel sizes on whole-pixel lines: `leading` is the line height over
// the size, so `size * leading` is always an integer.
export const typography = {
  body: { size: 16, leading: 24 / 16, tracking: "-0.01em", weight: 400 },
  author: { size: 13, leading: 18 / 13, tracking: "0", weight: 500 },
  time: { size: 12, leading: 16 / 12, tracking: "0", weight: 400 },
  meta: { size: 13, leading: 18 / 13, tracking: "0", weight: 400 },
  label: { size: 12, leading: 16 / 12, tracking: "0", weight: 600 },
  rowName: { size: 14, leading: 20 / 14, tracking: "-0.006em", weight: 400 },
  rowStatus: { size: 13, leading: 18 / 13, tracking: "0", weight: 400 },
  title: { size: 15, leading: 20 / 15, tracking: "-0.01em", weight: 600 },
  capsule: { size: 14, leading: 1, tracking: "0", weight: 500 },
  working: { size: 15, leading: 20 / 15, tracking: "-0.01em", weight: 400 },
  reasoning: { size: 13, leading: 18 / 13, tracking: "0", weight: 400 },
  blockHeader: { size: 12, leading: 16 / 12, tracking: "0", weight: 600 },
  question: { size: 17, leading: 22 / 17, tracking: "-0.02em", weight: 600 },
  mono: { size: 13, leading: 18 / 13, tracking: "0", weight: 400 },
  /** The mobile composer field: the native iOS body, 17/22. */
  composer: { size: 17, leading: 22 / 17, tracking: "-0.01em", weight: 400 },
  /** An onboarding step's title, and the same at phone width. */
  largeTitle: { size: 34, leading: 37 / 34, tracking: "-0.025em", weight: 650 },
  largeTitleCompact: { size: 30, leading: 33 / 30, tracking: "-0.025em", weight: 650 },
  /** The welcome statement at phone width; wider screens scale it with the column. */
  poster: { size: 60, leading: 0.94, tracking: "-0.045em", weight: 760 },
  /** A link standing alone under an onboarding step's main button. */
  link: { size: 15, leading: 20 / 15, tracking: "0", weight: 400 },
} as const satisfies Record<string, TypographyToken>;

export type TypographyKey = keyof typeof typography;
export type TypographyTokens = typeof typography;

/** Space — layout dimensions from the Quiet grid, in px. */
export const space = {
  sidebar: 280,
  thread: 800,
  header: 56,
  panel: 384,
  /** The bot page: `w-panel-wide`, and `pe-panel-wide` on the thread beside it. */
  panelWide: 640,
  /** A framed block standing alone in the thread: `max-w-block`. */
  block: 520,
  /** Web/desktop composer field: `max-h-composer-field` before it scrolls internally. */
  composerField: 220,
} as const satisfies Record<string, number>;

export type SpaceKey = keyof typeof space;
export type SpaceTokens = typeof space;

/** Radii — in px. `pill` is expressed as `rounded-full` on the surfaces, not a radius var. */
export const radii = {
  chip: 6,
  row: 8,
  card: 14,
  draft: 16,
  block: 24,
  /** The decision card on iPhone: wider padding, so a rounder corner than `block`. */
  mobileBlock: 28,
  bubble: 20,
  /** A link mention's 16 px site icon or fallback tile. */
  linkMention: 4,
  composer: 24,
  /** The floating sidebar and side panel: 26 − the 8 they float from the window's edge. */
  pane: 18,
  /** The onboarding scene card beside the form; at phone width it takes `block`. */
  scene: 28,
  /** A settings group on iPhone: the bot page's groups. */
  mobileGroup: 22,
  pill: 9999,
} as const satisfies Record<string, number>;

export type RadiusKey = keyof typeof radii;
export type RadiiTokens = typeof radii;

/** Elevation — the only shadows in the product, one per screen at most. */
export const lightShadows = {
  row: "none",
  /** A bot bubble, and everything else on the bot's paper: a whisper of an edge, no lift. */
  bubble: "0 0 0 1px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.05)",
  card: "0 0 0 1px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.05), 0 14px 32px -12px rgba(0, 0, 0, 0.18)",
  /** A decision once answered: back on the bot's paper, so it gives the thread back its one elevation. */
  settled: "0 0 0 1px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.05)",
  /** The composer at rest: a hairline, no drop shadow. */
  composerRest: "0 0 0 1px rgba(17, 17, 20, 0.09)",
  /** The composer while its field has focus: the hairline and the one drop shadow. */
  composerFocus: "0 0 0 1px rgba(17, 17, 20, 0.09), 0 12px 28px -18px rgba(17, 17, 20, 0.55)",
  floating: "0 1px 2px rgba(17, 17, 20, 0.08), 0 8px 20px -10px rgba(17, 17, 20, 0.35)",
  /** A side panel or an overlay window lifting off the ambient light. */
  sheet:
    "0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.08), 0 24px 48px -24px rgba(0, 0, 0, 0.22)",
  /** A group's hairline on its sheet. */
  group: "0 0 0 1px rgba(0, 0, 0, 0.05)",
} as const satisfies Record<string, string>;

export type ShadowKey = keyof typeof lightShadows;
export type ShadowTokens = Record<ShadowKey, string>;

export const darkShadows = {
  row: "none",
  bubble: "inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 0 1px rgba(255, 255, 255, 0.05)",
  card: "0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 16px 40px -12px rgba(0, 0, 0, 0.7)",
  settled: "inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 0 1px rgba(255, 255, 255, 0.05)",
  composerRest: "0 0 0 1px rgba(255, 255, 255, 0.08)",
  // A drop shadow barely reads on a near-black page, so focus also brightens the hairline.
  composerFocus: "0 0 0 1px rgba(255, 255, 255, 0.16), 0 12px 28px -18px rgba(0, 0, 0, 0.8)",
  floating: "0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 20px -10px rgba(0, 0, 0, 0.7)",
  sheet:
    "0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 24px 48px -20px rgba(0, 0, 0, 0.7)",
  group: "0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
} as const satisfies ShadowTokens;

export function shadowsForAppearance(appearance: ResolvedAppearance): ShadowTokens {
  return appearance === "light" ? lightShadows : darkShadows;
}

/**
 * Motion — one easing curve, everything else is a duration in ms. Nothing
 * loops continuously except the working-avatar body, its idle breathing and
 * the Stop button's contour while a reply streams.
 */
export type MotionTokens = {
  ease: string;
  arrive: number;
  press: number;
  hover: number;
  caret: number;
  /** The send arrow pivoting in with the first character. */
  pivot: number;
  /** The mobile attach button turning into a close button while its sheet is open. */
  morph: number;
  /** One lap of the Stop contour while a reply streams. */
  flow: number;
  /** A chosen answer filling with the user's bubble colour before it settles. */
  fill: number;
  /** The answer flying into its bubble while the card folds, on `spring`, until it rests. */
  flight: number;
  /** One spring for that movement: `response` in ms, `bounce` 0 (none) to 1. */
  spring: { response: number; bounce: number };
  /** A stack's answered question fading out, then the next one fading in while the card springs to its height. */
  stepOut: number;
  stepIn: number;
  /** A floating label rising out of its field. */
  label: number;
};

export const motion: MotionTokens = {
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  arrive: 240,
  press: 160,
  hover: 160,
  caret: 1000,
  pivot: 320,
  morph: 260,
  flow: 2600,
  fill: 80,
  flight: 520,
  spring: { response: 320, bounce: 0.1 },
  stepOut: 100,
  stepIn: 160,
  label: 150,
};

/** How far `motion.spring` has gone, from 0 to 1 with its small overshoot, `ms` after it starts. */
export function springAt(ms: number): number {
  const { response, bounce } = motion.spring;
  const omega = (2 * Math.PI * 1000) / response;
  const damping = 1 - bounce;
  const damped = omega * Math.sqrt(1 - damping * damping);
  const t = ms / 1000;
  const decay = Math.exp(-damping * omega * t);
  return 1 - decay * (Math.cos(damped * t) + ((damping * omega) / damped) * Math.sin(damped * t));
}

/** `motion.spring` sampled over `motion.flight` as a CSS `linear()` easing. */
export const springEasing = (() => {
  const steps = 52;
  const points = Array.from({ length: steps }, (_, step) =>
    springAt(motion.flight * (step / steps)).toFixed(4),
  );
  return `linear(${[...points, "1"].join(", ")})`;
})();

/** Sizes — avatars and round controls, in px. Consumed via primitive `size` props. */
export const sizes = {
  receipt: 14,
  stackXs: 16,
  interstitial: 17,
  chip: 18,
  stack: 20,
  message: 32,
  row: 28,
  call: 120,
  hoverIcon: 28,
  quickReply: 32,
  composerIcon: 34,
  /** Mobile: the detached attach bubble. */
  composerAttach: 48,
  /** Mobile: the touch target of a button inside the capsule. */
  composerTarget: 44,
  /** Mobile: the send / stop disc inside a target. */
  composerAction: 36,
  capsule: 36,
  mobileStack: 44,
  /** Mobile: an action in a decision card's row, round or capsule (a mail draft's). */
  mobileAction: 48,
  callButton: 52,
  /** The ring of a chosen option, or of an answer field being typed in. */
  selectedRing: 1.5,
  /** The composer's attachment thumbnail / file-tile height (both devices). */
  composerAttachmentThumb: 64,
  /** Max width of a composer file tile before its name truncates. */
  composerAttachmentTile: 200,
  /** The × disc on a composer attachment. */
  composerRemove: 22,
  /** Width of a link preview card under a message (web and desktop). */
  linkCard: 360,
  /** The square thumbnail of a compact link preview. */
  linkThumb: 56,
  /** A thumbnail in the image viewer's strip (web and iOS). */
  viewerThumb: 44,
  /** Space kept around a site icon inside its link preview thumbnail (web and iOS). */
  linkIconInset: 8,
  /** Max height of a link preview shown as a photo. */
  linkPhotoMax: 320,
  /** The site icon of a link mention, inline in a bubble's text (web and iOS). */
  linkMentionIcon: 16,
  /** Space between a link mention's icon and its label. */
  linkMentionGap: 5,
  /** The glyph of a bot, group, everyone or skill mention, inline in the text (web and iOS). */
  mentionGlyph: 16,
  /** Space between a mention's glyph and its name. */
  mentionGap: 4,
  /** Height of a share bar: the usage screen's split of spend. */
  shareBar: 8,
  /** A field with a floating label, and the same on a short phone screen. */
  field: 56,
  fieldShort: 52,
  /** The full-width main button of an onboarding step. */
  primaryButton: 52,
  /** The Tangow wordmark on an onboarding step, and its clear space above and below at phone width. */
  logo: 30,
  logoTop: 18,
  logoBottom: 12,
  /** The same on a short phone, where the scene needs the height. */
  logoShort: 24,
  logoTopShort: 12,
  logoBottomShort: 10,
} as const satisfies Record<string, number>;

/** An onboarding scene dims a little in dark mode so its light plate does not glare. */
export const sceneBrightness: Record<ResolvedAppearance, number> = { light: 1, dark: 0.9 };

/** Width over height of a large link preview's picture: the one ratio, web and iOS. */
export const linkLargeImageRatio = 1.91;

export type SizeKey = keyof typeof sizes;
export type SizeTokens = typeof sizes;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

/** WCAG relative luminance (0..1) of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const channel = (offset: number) => {
    const c = Number.parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio (1..21) between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  return (Math.max(luminanceA, luminanceB) + 0.05) / (Math.min(luminanceA, luminanceB) + 0.05);
}

/**
 * A bot's colour for a thin mark drawn in the composer (the Stop contour), or
 * `undefined` when it would not read against that appearance's `card`, the
 * composer's opaque plane (its glass falls back to it) —
 * the near-black bot colour on dark, white on light. 3:1 is WCAG's floor for
 * non-text graphics.
 */
export function botAccentOn(
  color: string | undefined,
  appearance: ResolvedAppearance,
): string | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return contrastRatio(color, tokensForAppearance(appearance).card) >= 3 ? color : undefined;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export * from "./materials.js";
