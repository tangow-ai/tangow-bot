// @vitest-environment jsdom
import { act, type ReactNode, useState } from "react";
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
  const { PlateScene, paveScene } = await import("./onboarding-screen");
  const router = createMemoryRouter([
    { path: "/", element: <PlateScene step="welcome" /> },
    { path: "/sign-up", element: <PlateScene step="signup" /> },
    { path: "/sign-in", element: paveScene },
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

it("plays nothing when sign-up follows a screen off the plate", async () => {
  const router = await onWelcome();
  await act(() => router.navigate("/sign-in"));
  expect(await framesAfter(() => router.navigate("/sign-up"))).toEqual(["04"]);
});

/** Sign-up with its still loaded, then a loading screen off the plate, then the model step. */
async function onSignup(onAwake: () => void) {
  const { PlateScene } = await import("./onboarding-screen");
  function Model() {
    const [awake, setAwake] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setAwake(true)} />
        <PlateScene step="model" awake={awake} onAwake={onAwake} />
      </>
    );
  }
  const router = createMemoryRouter(
    [
      { path: "/sign-up", element: <PlateScene step="signup" /> },
      { path: "/loading", element: <p>Loading…</p> },
      { path: "/onboarding", element: <Model /> },
    ],
    { initialEntries: ["/sign-up"] },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => container.querySelector("img")?.dispatchEvent(new Event("load")));
  await act(() => router.navigate("/loading", { replace: true }));
  return router;
}

async function wake() {
  await act(async () => container.querySelector("button")?.click());
  await act(async () =>
    container.querySelector("img:not([hidden])")?.dispatchEvent(new Event("load")),
  );
}

it("plays the frames toward the model step across a loading screen", async () => {
  const router = await onSignup(() => {});
  await act(() => router.navigate("/onboarding", { replace: true }));
  const seen = [onTop()];
  for (let tick = 0; tick < 6; tick++) {
    await act(async () => vi.advanceTimersByTime(150));
    seen.push(onTop());
  }
  expect(seen).toEqual(["05", "06", "07", "08", "09", "10", "11"]);
});

it("opens the eyes once a model connects, then lets the step move on", async () => {
  const awoke = vi.fn();
  const router = await onSignup(awoke);
  await act(() => router.navigate("/onboarding", { replace: true }));
  await act(async () => vi.advanceTimersByTime(900));
  await wake();
  expect(onTop()).toBe("12");
  await act(async () => vi.advanceTimersByTime(130));
  expect(onTop()).toBe("13");
  await act(async () => vi.advanceTimersByTime(649));
  expect(awoke).toHaveBeenCalledTimes(0);
  await act(async () => vi.advanceTimersByTime(1));
  expect([onTop(), awoke.mock.calls.length]).toEqual(["13", 1]);
});

it("shows the open eyes alone for 400 ms under reduced motion", async () => {
  reducedMotion = true;
  const awoke = vi.fn();
  const router = await onSignup(awoke);
  await act(() => router.navigate("/onboarding", { replace: true }));
  await wake();
  expect(onTop()).toBe("13");
  await act(async () => vi.advanceTimersByTime(399));
  expect(awoke).toHaveBeenCalledTimes(0);
  await act(async () => vi.advanceTimersByTime(1));
  expect(awoke).toHaveBeenCalledTimes(1);
});

it("plays nothing toward the model step once the plate is forgotten", async () => {
  const router = await onSignup(() => {});
  const { forgetPlate } = await import("./onboarding-screen");
  forgetPlate();
  expect(await framesAfter(() => router.navigate("/onboarding", { replace: true }))).toEqual([
    "11",
  ]);
});
