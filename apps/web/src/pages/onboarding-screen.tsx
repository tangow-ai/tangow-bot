import pave800 from "@tangow/avatars/onboarding/pave-800.webp";
import pave1600 from "@tangow/avatars/onboarding/pave-1600.webp";
import p01800 from "@tangow/avatars/onboarding/plateau/p01-800.webp";
import p011600 from "@tangow/avatars/onboarding/plateau/p01-1600.webp";
import p02800 from "@tangow/avatars/onboarding/plateau/p02-800.webp";
import p021600 from "@tangow/avatars/onboarding/plateau/p02-1600.webp";
import p03800 from "@tangow/avatars/onboarding/plateau/p03-800.webp";
import p031600 from "@tangow/avatars/onboarding/plateau/p03-1600.webp";
import p04800 from "@tangow/avatars/onboarding/plateau/p04-800.webp";
import p041600 from "@tangow/avatars/onboarding/plateau/p04-1600.webp";
import type { PlateBeat, PlateStep } from "@tangow/contracts";
import { plateBeats, plateForward, plateStill } from "@tangow/contracts";
import type { OnboardingFrameProps } from "@tangow/ui-web";
import { OnboardingFrame, usePrefersReducedMotion } from "@tangow/ui-web";
import { useEffect, useState } from "react";
import { useNavigationType } from "react-router-dom";
import { desktopBridge } from "../lib/desktop";
import { WindowChrome } from "./WindowChrome";

type Picture = readonly [small: string, large: string];

/** The plate's frames a step shows today; the rest arrive with their steps. */
const plate: Partial<Record<number, Picture>> = {
  1: [p01800, p011600],
  2: [p02800, p021600],
  3: [p03800, p031600],
  4: [p04800, p041600],
};

const sizes = "(max-width: 860px) calc(100vw - 32px), 55vw";
const srcSet = ([small, large]: Picture) => `${small} 800w, ${large} 1600w`;

/** `focus` keeps the clay in frame when a short phone trims the card's height. */
function Scene({
  picture,
  focus,
  hidden,
  onLoad,
}: {
  picture: Picture;
  focus?: string;
  hidden?: boolean;
  onLoad?: () => void;
}) {
  return (
    <img
      style={focus ? { objectPosition: focus } : undefined}
      src={picture[0]}
      srcSet={srcSet(picture)}
      sizes={sizes}
      alt=""
      hidden={hidden}
      onLoad={onLoad}
    />
  );
}

export const paveScene = <Scene picture={[pave800, pave1600]} />;

/** The step the plate last rested on, kept across the route change between two steps. */
let restedOn: PlateStep | undefined;
/** Frames decoded ahead: a transition shows only these and never waits for the rest. */
const decoded = new Set<number>();

function preload(frame: number) {
  const picture = plate[frame];
  if (!picture || decoded.has(frame)) return;
  const image = new Image();
  image.sizes = sizes;
  image.srcset = srcSet(picture);
  image.src = picture[0];
  image.decode().then(
    () => decoded.add(frame),
    () => {},
  );
}

/** Once a step's still is in: the frames toward every step it moves forward to, and their stills. */
function preloadForward(step: PlateStep) {
  for (const [to, beats] of Object.entries(plateForward[step] ?? {})) {
    for (const [frame] of beats) preload(frame);
    preload(plateStill[to as PlateStep]);
  }
}

type Plan = { step: PlateStep; beats: readonly PlateBeat[] };

/**
 * The clay plate of a step: its still, after the frames from the previous step when
 * the person moved forward with a link or a button. The frames stack in order, so a
 * frame slow to paint leaves the one before it showing.
 */
export function PlateScene({ step, focus }: { step: PlateStep; focus?: string }) {
  const replayed = useNavigationType() === "POP";
  const reducedMotion = usePrefersReducedMotion();
  const planFor = (to: PlateStep): Plan => ({
    step: to,
    beats: plateBeats(replayed ? undefined : restedOn, to, reducedMotion).filter(([frame]) =>
      decoded.has(frame),
    ),
  });
  const [plan, setPlan] = useState(() => planFor(step));
  const [shown, setShown] = useState(0);
  if (plan.step !== step) {
    setPlan(planFor(step));
    setShown(0);
  }

  useEffect(() => {
    restedOn = plan.step;
    let at = 0;
    const timers = plan.beats.map(([, ms], index) => {
      at += ms;
      return setTimeout(() => setShown(index + 1), at);
    });
    return () => timers.forEach(clearTimeout);
  }, [plan]);

  const still = plate[plateStill[plan.step]];
  return (
    <>
      {plan.beats.map(([frame], index) => {
        const picture = plate[frame];
        return picture ? (
          <Scene key={frame} picture={picture} focus={focus} hidden={index > shown} />
        ) : null;
      })}
      {still ? (
        <Scene
          key="still"
          picture={still}
          focus={focus}
          hidden={plan.beats.length > shown}
          onLoad={() => preloadForward(plan.step)}
        />
      ) : null}
    </>
  );
}

/** Every step before an account exists, with the desktop app's window controls. */
export function OnboardingScreen(props: Omit<OnboardingFrameProps, "chrome">) {
  return <OnboardingFrame {...props} chrome={desktopBridge() ? <WindowChrome /> : null} />;
}
