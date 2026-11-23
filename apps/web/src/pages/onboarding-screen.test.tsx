// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: String.raw }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@lingui/core/macro", () => ({ t: String.raw }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let reducedMotion = false;
let undecodable: string[] = [];
let container: HTMLDivElement;
let root: Root;

const frameOf = (image: HTMLImageElement) => /p(\d\d)-800\.webp/.exec(image.src)?.[1];

/** The frame on top of the plate: the last picture not hidden. */
function onTop() {
  const shown = [...container.querySelectorAll("img")].filter((image) => !image.hidden);
  return frameOf(shown[shown.length - 1] as HTMLImageElement);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  reducedMotion = false;
  undecodable = [];
  vi.stubGlobal("matchMedia", () => ({
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  }));
  HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
    const frame = frameOf(this);
    return frame && undecodable.includes(frame) ? Promise.reject(new Error()) : Promise.resolve();
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Welcome, with its still loaded so the frames toward sign-up preload behind it. */
async function onWelcome() {
  // A fresh module per test: the plate keeps the step it rested on and what it decoded.
  const { PlateScene } = await import("./onboarding-screen");
  const router = createMemoryRouter([
    { path: "/", element: <PlateScene step="welcome" /> },
    { path: "/sign-up", element: <PlateScene step="signup" /> },
  ]);
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => container.querySelector("img")?.dispatchEvent(new Event("load")));
  return router;
}

async function framesAfter(navigate: () => Promise<void>) {
  await act(navigate);
  const seen = [onTop()];
  for (let tick = 0; tick < 3; tick++) {
    await act(async () => vi.advanceTimersByTime(150));
    if (seen[seen.length - 1] !== onTop()) seen.push(onTop());
  }
  return seen;
}

it("plays the frames between welcome and sign-up when moving forward", async () => {
  const router = await onWelcome();
  expect(await framesAfter(() => router.navigate("/sign-up"))).toEqual(["02", "03", "04"]);
});

it("shows the still at once when going back", async () => {
  const router = await onWelcome();
  await framesAfter(() => router.navigate("/sign-up"));
  expect(await framesAfter(() => router.navigate(-1))).toEqual(["01"]);
  expect(await framesAfter(() => router.navigate(1))).toEqual(["04"]);
});

it("goes straight to the still under reduced motion", async () => {
  reducedMotion = true;
  const router = await onWelcome();
  expect(await framesAfter(() => router.navigate("/sign-up"))).toEqual(["04"]);
});

it("skips a frame that has not loaded instead of waiting for it", async () => {
  undecodable = ["02"];
  const router = await onWelcome();
  expect(await framesAfter(() => router.navigate("/sign-up"))).toEqual(["03", "04"]);
});
