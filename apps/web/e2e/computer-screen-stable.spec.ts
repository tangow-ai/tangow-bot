import type { Locator, Page } from "@playwright/test";
import type { ComputerStatus } from "@tangow/contracts";
import { computerScreenKey } from "@tangow/core";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  realSandboxTimeout,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

// Starting a run reprovisions the computer, which revokes earlier screen URLs, so the
// baseline is taken once the run is working and the screen has settled.
test("the bot screen reconnects when the bot's run ends, then holds", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("screen-stable"), "password12", "Screen Stable");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const otherBotId = await createNamedBot(page, "Second");
  const sidebar = page.locator("aside").first();
  await sidebar.locator(`[data-roster-bot-id="${botId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let screenLoads = 0;
  let screenReads = 0;
  const screenReadsByBot = new Map<string, number>();
  let rpcCalls = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/")) rpcCalls += 1;
  });
  await page.route("https://screen.example/**", (route) => {
    screenLoads += 1;
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    });
  });
  await page.route("**/rpc/computer/screenUrl", (route) => {
    screenReads += 1;
    const requested = route.request().postDataJSON()?.json?.botId;
    screenReadsByBot.set(requested, (screenReadsByBot.get(requested) ?? 0) + 1);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { url: `https://screen.example/vnc.html?read=${screenReads}` },
      }),
    });
  });

  await page.getByPlaceholder(/Message/).fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const [thread, computer] = await Promise.all([
        rpc<{ run: { status: string } | null }>(page, "threads/get", { botId }),
        computerStatus(page, botId),
      ]);
      return (
        thread.run?.status === "running" &&
        computer.state === "running" &&
        computer.busyBotName !== null
      );
    })
    .toBe(true);

  await page.getByTestId("open-computer-panel").click();
  const frame = page.getByTestId("computer-preview").locator("iframe");
  await expect(frame).toHaveAttribute("src", /^https:\/\/screen\.example\/vnc\.html\?read=\d+$/);
  await settle(() => rpcCalls);
  const readsBeforeEnd = screenReads;
  const loadsBeforeEnd = screenLoads;
  const src = await frame.getAttribute("src");
  await markScreen(frame);
  const keyBeforeEnd = computerScreenKey(await computerStatus(page, botId));

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await rpc<{ run: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? "idle",
      { timeout: realSandboxTimeout(90_000, 20_000) },
    )
    .toBe("idle");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  // The end-of-run thread refresh and computer status events land after the run reads idle.
  await page.waitForTimeout(QUIET_WINDOW_MS);

  // Ending the run releases the screen slot, so the screen reconnects to a fresh URL.
  expect(computerScreenKey(await computerStatus(page, botId))).not.toBe(keyBeforeEnd);
  await expect(frame).not.toHaveAttribute("src", src ?? "");
  await expect(frame).toHaveAttribute("src", /^https:\/\/screen\.example\/vnc\.html\?read=\d+$/);
  expect(screenReads).toBeGreaterThan(readsBeforeEnd);
  expect(screenLoads).toBeGreaterThan(loadsBeforeEnd);
  expect(await screenMark(frame)).not.toBe("kept");
  // ...and then holds that connection.
  await settle(() => rpcCalls);
  const readsAfterReconnect = screenReads;
  const loadsAfterReconnect = screenLoads;
  const srcAfterReconnect = await frame.getAttribute("src");
  const keyAfterReconnect = computerScreenKey(await computerStatus(page, botId));
  await page.waitForTimeout(QUIET_WINDOW_MS);
  expect(screenReads).toBe(readsAfterReconnect);
  expect(screenLoads).toBe(loadsAfterReconnect);
  await captureScreenshot(page, testInfo, "computer-screen-stable-after-run");

  const panelToggle = page.getByTestId("open-computer-panel");
  await panelToggle.click();
  await expect(panelToggle).toHaveAttribute("aria-pressed", "false");
  const readsOfBotBeforeLeaving = screenReadsByBot.get(botId);
  await sidebar.locator(`[data-roster-bot-id="${otherBotId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${otherBotId}$`));
  await sidebar.locator(`[data-roster-bot-id="${botId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/app/${botId}$`));
  await panelToggle.click();
  await expect(frame).toHaveAttribute("src", srcAfterReconnect ?? "");
  await markScreen(frame);
  const loadsAfterReturn = screenLoads;
  await page.waitForTimeout(QUIET_WINDOW_MS);
  expect(computerScreenKey(await computerStatus(page, botId))).toBe(keyAfterReconnect);
  expect(screenReadsByBot.get(botId)).toBe(readsOfBotBeforeLeaving);
  expect(screenLoads).toBe(loadsAfterReturn);
  expect(await screenMark(frame)).toBe("kept");
});

/** Long enough for every refresh and status event a finished trigger causes to land. */
const QUIET_WINDOW_MS = 5_000;

/** Waits until the page makes no more RPC calls between two polls. */
async function settle(calls: () => number) {
  let last = -1;
  await expect
    .poll(
      () => {
        const now = calls();
        const quiet = now === last;
        last = now;
        return quiet;
      },
      { intervals: [1_000] },
    )
    .toBe(true);
}

/** A reload or a remount replaces the screen's document, and the new one carries no mark. */
async function markScreen(frame: Locator) {
  const document = await (await frame.elementHandle())?.contentFrame();
  if (!document) throw new Error("the screen frame has no document");
  await document.waitForLoadState();
  await document.evaluate(() => Reflect.set(window, "screenMark", "kept"));
}

async function screenMark(frame: Locator) {
  const document = await (await frame.elementHandle())?.contentFrame();
  return (await document?.evaluate(() => Reflect.get(window, "screenMark") ?? null)) ?? null;
}

function computerStatus(page: Page, botId: string) {
  return rpc<ComputerStatus>(page, "computer/status", { botId });
}
