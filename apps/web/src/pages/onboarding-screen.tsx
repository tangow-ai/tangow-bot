import pave800 from "@tangow/avatars/onboarding/pave-800.webp";
import pave1600 from "@tangow/avatars/onboarding/pave-1600.webp";
import plateau01800 from "@tangow/avatars/onboarding/plateau/p01-800.webp";
import plateau011600 from "@tangow/avatars/onboarding/plateau/p01-1600.webp";
import plateau04800 from "@tangow/avatars/onboarding/plateau/p04-800.webp";
import plateau041600 from "@tangow/avatars/onboarding/plateau/p04-1600.webp";
import type { OnboardingFrameProps } from "@tangow/ui-web";
import { OnboardingFrame } from "@tangow/ui-web";
import { desktopBridge } from "../lib/desktop";
import { WindowChrome } from "./WindowChrome";

/** `focus` keeps the clay in frame when a short phone trims the card's height. */
function scene(small: string, large: string, focus?: string) {
  return (
    <img
      style={focus ? { objectPosition: focus } : undefined}
      src={small}
      srcSet={`${small} 800w, ${large} 1600w`}
      sizes="(max-width: 860px) calc(100vw - 32px), 55vw"
      alt=""
    />
  );
}

export const paveScene = scene(pave800, pave1600);
export const welcomeScene = scene(plateau01800, plateau011600);
export const signupScene = scene(plateau04800, plateau041600, "50% 62%");

/** Every step before an account exists, with the desktop app's window controls. */
export function OnboardingScreen(props: Omit<OnboardingFrameProps, "chrome">) {
  return <OnboardingFrame {...props} chrome={desktopBridge() ? <WindowChrome /> : null} />;
}
