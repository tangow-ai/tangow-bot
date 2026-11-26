import { activeBotId, captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, type Page, test } from "./test";
import { type EntryDraft, showThread } from "./thread-log";

/** One settled reply, stable enough for a hover capture. */
function motionThread(botId: string): EntryDraft[] {
  return [
    {
      id: "motion-reply",
      ts: "2026-09-17T09:24:00.000Z",
      type: "bot.text",
      botId,
      payload: {
        blocks: [{ kind: "text", text: "Tuesday afternoon is the only slot that works." }],
      },
    },
  ];
}

/** A run still in flight, so the transcript keeps its one `WorkingLine`. */
function runningRun(botId: string) {
  const startedAt = new Date(Date.now() - 41_000).toISOString();
  return {
    id: "motion-run",
    botId,
    threadId: "motion-thread",
    taskId: "motion-task",
    status: "running",
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: null,
    startedAt,
    completedAt: null,
    createdAt: startedAt,
  };
}

async function showMotionThread(page: Page, botId: string) {
  const run = runningRun(botId);
  await showThread(page, motionThread(botId), { run, activeRuns: [run] });
}

async function setAppearance(page: Page, theme: "light" | "dark") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("a working run's line and a hovered row's pill, light and dark", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("quiet-motion"), "password12", "Quiet Motion");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  await showMotionThread(page, botId);

  const transcript = page.getByTestId("transcript");
  const reply = transcript.locator('[data-message-id="motion-reply"]');
  await expect(reply).toBeVisible({ timeout: 20_000 });

  // The only thing that keeps moving during a run: one `WorkingLine`, with a
  // ticking mono clock, and nothing else in the row.
  const working = transcript.locator('[data-slot="working-line"]');
  await expect(working).toBeVisible({ timeout: 20_000 });
  await expect(working).toHaveAttribute("role", "status");
  const elapsed = working.locator('[data-slot="working-line-elapsed"]');
  const elapsedFirst = await elapsed.textContent();
  await page.waitForTimeout(300);
  const elapsedSecond = await elapsed.textContent();
  expect(elapsedFirst).not.toBe(elapsedSecond);

  await reply.hover();
  const pill = reply.getByTestId("message-hover-rail");
  await expect(pill).toHaveCSS("opacity", "1");

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-working-light");
  await reply.hover();
  await captureScreenshot(page, testInfo, "quiet-hover-pill-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-working-dark");
  await reply.hover();
  await captureScreenshot(page, testInfo, "quiet-hover-pill-dark");
});

test("reduced motion freezes the working clock", async ({ page }) => {
  await signup(page, uniqueEmail("quiet-motion-rm"), "password12", "Quiet Motion RM");
  await completeOnboarding(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);
  await showMotionThread(page, botId);

  const working = page.getByTestId("transcript").locator('[data-slot="working-line"]');
  await expect(working).toBeVisible({ timeout: 20_000 });
  const elapsed = working.locator('[data-slot="working-line-elapsed"]');
  const first = await elapsed.textContent();
  await page.waitForTimeout(500);
  const second = await elapsed.textContent();
  expect(second).toBe(first);
});
