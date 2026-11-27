import type { RadiusKey, SizeKey } from "@tangow/ui-tokens";
import { lightShadows, space, typography } from "@tangow/ui-tokens";
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** `rowName` -> `row-name` (mirrors the generator's `kebabCase` in `@tangow/ui-tokens`). */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Radii mapped to `--radius-*` in `styles.css`. `draft` and `pill` have no utility. */
export const MAPPED_RADIUS_KEYS = [
  "chip",
  "row",
  "card",
  "block",
  "bubble",
  "pane",
] as const satisfies readonly RadiusKey[];

/** Sizes mapped to `--spacing-*` in `styles.css`, so `size-composer-icon` resolves. */
export const MAPPED_SIZE_KEYS = [
  "hoverIcon",
  "quickReply",
  "composerIcon",
  "capsule",
  "mobileStack",
  "callButton",
  "message",
  "composerAttachmentThumb",
  "composerAttachmentTile",
  "composerRemove",
  "primaryButton",
] as const satisfies readonly SizeKey[];

/**
 * tailwind-merge only knows the stock scales, so it files `text-capsule` under
 * text colour and lets it collide with `text-sm`. Teaching it the Quiet scales
 * is what makes the `className` passthrough on every primitive predictable.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: Object.keys(typography).map(kebabCase),
      radius: MAPPED_RADIUS_KEYS.map(kebabCase),
      shadow: Object.keys(lightShadows).map(kebabCase),
      spacing: [...Object.keys(space), ...MAPPED_SIZE_KEYS].map(kebabCase),
      ease: ["quiet"],
      animate: ["arrive", "pivot"],
    },
    // `ring-selected` is a width token: filed as a colour, it would lose to `ring-foreground`.
    classGroups: { "ring-w": [{ ring: ["selected"] }] },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
