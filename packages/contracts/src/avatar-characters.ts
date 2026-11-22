import * as z from "zod";

type AvatarCharacterShape = "ball" | "capsule" | "block";

/** A crop of the character image, in the 1024 pixel square the images are exported in. */
export type AvatarCrop = { x: number; y: number; side: number };

type AvatarCharacterData = {
  id: string;
  name: string;
  shape: AvatarCharacterShape;
  crops: { full: AvatarCrop; portrait: AvatarCrop; close: AvatarCrop };
};

/** In display order. The first entry is the neutral character. */
export const AVATAR_CHARACTERS = [
  {
    id: "scout",
    name: "Helmut",
    shape: "ball",
    crops: {
      full: { x: 37.0, y: -6.5, side: 944.0 },
      portrait: { x: 87.1, y: 107.0, side: 842.7 },
      close: { x: 131.7, y: 202.5, side: 752.3 },
    },
  },
  {
    id: "atlas",
    name: "Dan",
    shape: "capsule",
    crops: {
      full: { x: 87.7, y: 63.1, side: 868.6 },
      portrait: { x: 166.7, y: 134.2, side: 710.7 },
      close: { x: 231.3, y: 192.4, side: 581.4 },
    },
  },
  {
    id: "ivy",
    name: "Windsor",
    shape: "block",
    crops: {
      full: { x: 95.8, y: 56.7, side: 847.3 },
      portrait: { x: 221.2, y: 187.7, side: 556.1 },
      close: { x: 251.5, y: 233.3, side: 455.0 },
    },
  },
  {
    id: "saint-demon",
    name: "Lucifair",
    shape: "ball",
    crops: {
      full: { x: 44.1, y: 6.7, side: 929.9 },
      portrait: { x: 93.1, y: 118.5, side: 830.1 },
      close: { x: 136.7, y: 212.6, side: 741.0 },
    },
  },
  {
    id: "sorciere",
    name: "Witchway",
    shape: "ball",
    crops: {
      full: { x: 97.8, y: 115.0, side: 822.5 },
      portrait: { x: 141.0, y: 213.9, side: 734.2 },
      close: { x: 179.5, y: 297.1, side: 655.4 },
    },
  },
  {
    id: "roi",
    name: "Dunecan",
    shape: "ball",
    crops: {
      full: { x: 44.1, y: 6.7, side: 929.9 },
      portrait: { x: 93.1, y: 118.5, side: 830.1 },
      close: { x: 136.7, y: 212.6, side: 741.0 },
    },
  },
  {
    id: "mariachi",
    name: "Ufolito",
    shape: "capsule",
    crops: {
      full: { x: 100.4, y: 93.1, side: 835.3 },
      portrait: { x: 173.3, y: 161.5, side: 683.4 },
      close: { x: 232.4, y: 217.4, side: 559.1 },
    },
  },
  {
    id: "viking",
    name: "Ragnarrot",
    shape: "capsule",
    crops: {
      full: { x: 133.7, y: 158.4, side: 772.5 },
      portrait: { x: 201.3, y: 221.6, side: 632.1 },
      close: { x: 256.0, y: 273.3, side: 517.1 },
    },
  },
  {
    id: "monstre",
    name: "Frankenbot",
    shape: "block",
    crops: {
      full: { x: 102.1, y: 57.3, side: 843.8 },
      portrait: { x: 228.6, y: 188.5, side: 552.3 },
      close: { x: 259.7, y: 233.7, side: 451.9 },
    },
  },
  {
    id: "toutankit",
    name: "Toutânkit",
    shape: "block",
    crops: {
      full: { x: 93.4, y: 66.2, side: 835.1 },
      portrait: { x: 166.7, y: 134.5, side: 683.2 },
      close: { x: 226.1, y: 190.5, side: 559.0 },
    },
  },
  {
    id: "docteur-disquette",
    name: "Floppy",
    shape: "block",
    crops: {
      full: { x: 151.1, y: 167.5, side: 738.8 },
      portrait: { x: 260.0, y: 282.4, side: 483.6 },
      close: { x: 285.2, y: 322.0, side: 395.6 },
    },
  },
] as const satisfies readonly AvatarCharacterData[];

export type AvatarCharacter = (typeof AVATAR_CHARACTERS)[number];
export type AvatarCharacterId = AvatarCharacter["id"];

export const AVATAR_CHARACTER_IDS = AVATAR_CHARACTERS.map((character) => character.id) as [
  AvatarCharacterId,
  ...AvatarCharacterId[],
];

/** Strict, for writes. Reads stay `z.string()` so an app older than the server still parses. */
export const AvatarCharacterIdSchema = z.enum(AVATAR_CHARACTER_IDS);

export function characterById(id: string | null | undefined): AvatarCharacter {
  return AVATAR_CHARACTERS.find((character) => character.id === id) ?? AVATAR_CHARACTERS[0];
}

/** At this size and below, the simplified mini image replaces the full one. */
export const CLAY_MINI_MAX_SIZE = 20;

/** Whole character when large, face when medium, close on the eyes when small. */
export function cropForSize(size: number): keyof AvatarCharacter["crops"] {
  if (size >= 64) return "full";
  if (size >= 32) return "portrait";
  return "close";
}

const SHAPE_COLORS: Record<AvatarCharacterShape, string> = {
  ball: "#A34B50",
  capsule: "#8287AD",
  block: "#96BCA3",
};

/** The clay colour of the character's body. */
function characterColor(character: AvatarCharacter): string {
  return SHAPE_COLORS[character.shape];
}

/** The colour a bot is shown in: its character's clay colour once it has one, else its own. */
export function botDisplayColor(bot: { color: string; avatarCharacter: string | null }): string {
  return bot.avatarCharacter ? characterColor(characterById(bot.avatarCharacter)) : bot.color;
}
