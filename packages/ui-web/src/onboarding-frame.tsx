import { wordmark } from "@tangow/avatars/brand/wordmark";
import type { FormEvent, ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";

const PHONE_MAX_WIDTH = 860;

export type OnboardingFrameProps = {
  /** The scene card's content: a picture laid over the clay plate. */
  scene: ReactNode;
  title: ReactNode;
  /** The step's fields. */
  children?: ReactNode;
  /** Anchored at the bottom of the step, main button first. */
  actions: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** The desktop app's window controls, laid in a draggable band across the window's top. */
  chrome?: ReactNode;
  /** The title is a poster statement (the welcome step). */
  poster?: boolean;
};

/**
 * One frame for every step before an account exists: the wordmark, the clay scene
 * card and a step box of fixed height whose actions sit at its foot, so the main
 * button lands at the same place on every step. On a short phone the card takes
 * the room a step's missing fields would leave, so it grows on shorter steps.
 */
export function OnboardingFrame({
  scene,
  title,
  children,
  actions,
  onSubmit,
  chrome,
  poster = false,
}: OnboardingFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  useKeyboardInset(frame);
  return (
    <div
      ref={frame}
      className="rk-onboarding"
      data-slot="onboarding-frame"
      data-poster={poster || undefined}
    >
      {chrome ? <div className="rk-onboarding-chrome">{chrome}</div> : null}
      <div className="rk-onboarding-top">
        <svg
          className="rk-onboarding-logo"
          viewBox={wordmark.viewBox}
          role="img"
          aria-label="Tangow"
        >
          <path fill="currentColor" fillRule="evenodd" d={wordmark.path} />
        </svg>
      </div>
      <div className="rk-onboarding-pane">
        <form className="rk-onboarding-screen" onSubmit={onSubmit}>
          <h1>{title}</h1>
          {children}
          <div className="rk-onboarding-actions">{actions}</div>
        </form>
      </div>
      <div className="rk-onboarding-stage">{scene}</div>
    </div>
  );
}

/**
 * Phone keyboard: the actions close up under the fields and the page scrolls the
 * main button to just above the keyboard, the focused field above it. iOS 27
 * Safari measures client rects from the visual viewport's top, so its height is
 * where the keyboard bar starts; a fixed button placed from it floats mid-screen.
 */
function useKeyboardInset(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const frame = ref.current;
    const viewport = window.visualViewport;
    if (!frame || !viewport) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = (reveal: boolean) => {
      const layout = document.documentElement.clientHeight;
      const covered = layout - viewport.height;
      const open = covered > 80 && viewport.scale < 1.05 && frame.clientWidth <= PHONE_MAX_WIDTH;
      const opening = open && !frame.hasAttribute("data-keyboard");
      frame.toggleAttribute("data-keyboard", open);
      document.body.style.paddingBottom = open ? `${covered}px` : "";
      const field = document.activeElement;
      if (!open || !(opening || reveal) || !(field instanceof HTMLElement)) return;
      if (!field.matches("input, select")) return;
      const button = frame.querySelector(".rk-onboarding-actions > :first-child");
      if (button) window.scrollBy(0, button.getBoundingClientRect().bottom + 12 - viewport.height);
    };
    const onViewport = () => update(false);
    // Moving between fields with the keyboard already up fires no viewport event.
    const onFocus = () => {
      clearTimeout(settle);
      settle = setTimeout(() => update(true), 350);
    };
    viewport.addEventListener("resize", onViewport);
    viewport.addEventListener("scroll", onViewport);
    document.addEventListener("focusin", onFocus);
    return () => {
      clearTimeout(settle);
      viewport.removeEventListener("resize", onViewport);
      viewport.removeEventListener("scroll", onViewport);
      document.removeEventListener("focusin", onFocus);
      document.body.style.paddingBottom = "";
    };
  }, [ref]);
}
