import { isWorkingStatus } from "@tangow/core";
import { memo } from "react";
import { ClayAvatar } from "./clay-avatar.js";
import { faceFor } from "./clay-face-data.js";
import { useClayFaceState } from "./use-clay-face-state.js";

export interface BotAvatarProps {
  size?: number;
  status?: string;
  /** Catalogue character; missing or unknown shows the neutral character. */
  character?: string | null;
  /** Keeps the face alive at rest too; otherwise it only comes alive while the bot works. */
  live?: boolean;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  size = 38,
  status,
  character,
  live = false,
  className,
}: BotAvatarProps) {
  const face = useClayFaceState(status, faceFor(character).defaut, live);
  return (
    <ClayAvatar
      character={character ?? null}
      size={size}
      isWorking={isWorkingStatus(status)}
      face={face}
      className={className}
    />
  );
});
