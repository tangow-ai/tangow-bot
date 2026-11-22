import { describe, expect, it } from "vitest";
import {
  AVATAR_CHARACTERS,
  botDisplayColor,
  characterById,
  cropForSize,
} from "./avatar-characters.js";
import { UpdateBotInput } from "./domain.js";

describe("avatar characters", () => {
  it("falls back to the neutral character for a missing or unknown id", () => {
    expect(characterById(null)).toBe(AVATAR_CHARACTERS[0]);
    expect(characterById("from-a-newer-server")).toBe(AVATAR_CHARACTERS[0]);
    expect(characterById("ivy").name).toBe("Windsor");
  });

  it("shows a bot in its character's clay colour, else in its own", () => {
    expect(botDisplayColor({ color: "#123456", avatarCharacter: "ivy" })).toBe("#96BCA3");
    expect(botDisplayColor({ color: "#123456", avatarCharacter: null })).toBe("#123456");
  });

  it("accepts a catalogue id on update and rejects any other", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot_1", avatarCharacter: "atlas" }).success).toBe(
      true,
    );
    expect(UpdateBotInput.safeParse({ botId: "bot_1", avatarCharacter: "nobody" }).success).toBe(
      false,
    );
  });
});

describe("cropForSize", () => {
  it.each([
    [96, "full"],
    [64, "full"],
    [56, "portrait"],
    [32, "portrait"],
    [28, "close"],
    [16, "close"],
  ])("frames a %s px avatar on the %s crop", (size, crop) => {
    expect(cropForSize(size)).toBe(crop);
  });
});
