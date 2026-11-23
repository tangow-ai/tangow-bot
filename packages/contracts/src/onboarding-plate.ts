/**
 * The clay stop-motion behind the steps before an account exists, read by the web
 * and iPhone players: one plate photographed in 18 frames
 * (`@tangow/avatars/onboarding/plateau/pNN`). Each step rests on a still, and only
 * moving forward plays the frames between two stills.
 */
export type PlateStep =
  | "welcome"
  | "invite"
  | "signup"
  | "check"
  | "model"
  | "integrations"
  | "picker"
  | "done";

/** A frame of the plate and how long it holds, in ms. */
export type PlateBeat = readonly [frame: number, ms: number];

export const plateStill: Readonly<Record<PlateStep, number>> = {
  welcome: 1,
  invite: 1,
  signup: 4,
  check: 4,
  model: 11,
  integrations: 11,
  picker: 17,
  done: 17,
};

const frameMs = 150;
const run = (first: number, last: number): PlateBeat[] =>
  Array.from({ length: last - first + 1 }, (_, i) => [first + i, frameMs]);

/** The frames between two stills, by step left then step reached. The email check keeps signup's still. */
export const plateForward: Readonly<
  Partial<Record<PlateStep, Partial<Record<PlateStep, readonly PlateBeat[]>>>>
> = {
  welcome: { signup: run(2, 3) },
  invite: { signup: run(2, 3) },
  signup: { model: run(5, 10), picker: run(5, 16) },
  check: { model: run(5, 10), picker: run(5, 16) },
  // The eyes opened on the model step (`plateModelConnected`); Dan wakes on arrival.
  model: {
    picker: [
      [14, 140],
      [15, 140],
      [16, 240],
    ],
  },
};

/** Played on the model step once a model connects, its button held until the last frame ends. */
export const plateModelConnected: Readonly<Record<"motion" | "reduced", readonly PlateBeat[]>> = {
  motion: [
    [12, 130],
    [13, 650],
  ],
  reduced: [[13, 400]],
};

/**
 * The frames to play before `to`'s still. Nothing without a step to come from (a
 * reload or the browser's back button), nothing backward, nothing under reduced motion.
 */
export function plateBeats(
  from: PlateStep | undefined,
  to: PlateStep,
  reducedMotion: boolean,
): readonly PlateBeat[] {
  if (from === undefined || reducedMotion) return [];
  return plateForward[from]?.[to] ?? [];
}
