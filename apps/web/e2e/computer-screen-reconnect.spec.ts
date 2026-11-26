import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

const SCREEN_ORIGIN = "https://screen.example";
const SCREEN_URL = `${SCREEN_ORIGIN}/novnc/session/view/1.e2e_signature/embed.html`;

function stateMessage(state: string) {
  return JSON.stringify({ type: "tangow-screen-state", version: 1, state });
}

test("the bot screen says when it is connecting or reconnecting", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("screen-reconnect"), "password12", "Screen Link");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let screenReads = 0;
  await page.route(`${SCREEN_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Test screen</title><script>parent.postMessage(${JSON.stringify(
        stateMessage("connecting"),
      )}, "*")</script>`,
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) => {
    screenReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: SCREEN_URL } }),
    });
  });

  await page.getByTestId("open-computer-panel").click();
  const preview = page.getByTestId("computer-preview");
  const frame = preview.locator("iframe");
  await expect(frame).toHaveAttribute("src", SCREEN_URL);
  const status = preview.getByRole("status");
  await expect(status).toHaveText("Connecting…");
  await captureScreenshot(page, testInfo, "computer-screen-connecting");

  const screenLoaded = () => page.frames().some((candidate) => candidate.url() === SCREEN_URL);
  await expect.poll(screenLoaded).toBe(true);
  const screen = page.frames().find((candidate) => candidate.url() === SCREEN_URL);
  if (!screen) throw new Error("the screen frame did not load");
  const report = (state: string) =>
    screen.evaluate((message) => parent.postMessage(message, "*"), stateMessage(state));
  const readsBeforeDrop = screenReads;

  await report("connected");
  await expect(status).toHaveCount(0);

  await page.evaluate(async (message) => {
    window.postMessage(message, "*");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }, stateMessage("reconnecting"));
  await expect(status).toHaveCount(0);

  await report("reconnecting");
  await expect(status).toHaveText("Reconnecting");
  await captureScreenshot(page, testInfo, "computer-screen-reconnecting");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(status.locator("svg")).toHaveCSS("animation-name", "none");

  await report("connected");
  await expect(status).toHaveCount(0);
  await expect(frame).toHaveAttribute("src", SCREEN_URL);
  expect(screenReads).toBe(readsBeforeDrop);
});

test("a screen that gives up stays failed until Retry", async ({ page }, testInfo) => {
  await page.clock.install();
  await signup(page, uniqueEmail("screen-failed"), "password12", "Screen Failed");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let screenReads = 0;
  await page.route(`${SCREEN_ORIGIN}/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Test screen</title><script>parent.postMessage(${JSON.stringify(
        stateMessage("connecting"),
      )}, "*")</script>`,
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) => {
    screenReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          url: `${SCREEN_ORIGIN}/novnc/session/view/${screenReads}.e2e_signature/embed.html`,
        },
      }),
    });
  });

  const panelToggle = page.getByTestId("open-computer-panel");
  await panelToggle.click();
  const preview = page.getByTestId("computer-preview");
  const frame = preview.locator("iframe");
  await expect(preview.getByRole("status")).toHaveText("Connecting…");
  const failedSrc = await frame.getAttribute("src");

  await page.clock.fastForward(61_000);
  const alert = preview.getByRole("alert");
  await expect(alert).toHaveText(/Could not connect to the computer screen/);
  await expect(frame).toHaveCount(0);
  const readsAfterFailure = screenReads;

  await panelToggle.click();
  await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
  const threadRead = page.waitForResponse("**/rpc/threads/get");
  await panelToggle.click();
  await threadRead;
  await page.waitForTimeout(1_000);
  await expect(alert).toHaveText(/Could not connect to the computer screen/);
  await expect(frame).toHaveCount(0);
  expect(screenReads).toBe(readsAfterFailure);
  await captureScreenshot(page, testInfo, "computer-screen-failed");

  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(alert).toHaveCount(0);
  await expect(frame).toHaveAttribute(
    "src",
    `${SCREEN_ORIGIN}/novnc/session/view/${readsAfterFailure + 1}.e2e_signature/embed.html`,
  );
  expect(failedSrc).toBe(
    `${SCREEN_ORIGIN}/novnc/session/view/${readsAfterFailure}.e2e_signature/embed.html`,
  );
  await expect(preview.getByRole("status")).toHaveText("Connecting…");
});
