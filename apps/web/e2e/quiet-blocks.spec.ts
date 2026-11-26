import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Page, test } from "./test";

async function switchTheme(page: Page, theme: "light" | "dark") {
  const settings = await openUserSettings(page);
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

async function waitForRunStatus(page: Page, botId: string, status: string | null) {
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe(status);
}

test("framed blocks capture a pending approval and an answered question as normal bot rows, light and dark", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("quiet-blocks"), "password12", "Quiet Blocks");
  await completeOnboarding(page, testInfo);
  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);

  // The consequential approval: a normal bot row whose card is framed while it is pending.
  await rpc(page, "approvalRules/set", {
    effect: "require_approval",
    matchKind: "connector",
    matchValue: "destination.write",
  });
  await composer.fill("write this to the destination crm as a note");
  await page.keyboard.press("Enter");
  await waitForRunStatus(page, botId, "waiting_input");

  const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  if ((await allowOnce.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message|Answer/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(allowOnce).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: "Always allow this tool", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();

  const approvalMessage = page.locator("[data-message-id]").filter({ has: allowOnce });
  await expect(approvalMessage.locator('[data-slot="message-row"]')).toBeVisible();
  await expect(approvalMessage.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(approvalMessage.locator('[data-slot="message-row-avatar"]')).toHaveCount(0);
  await expect(approvalMessage.getByTestId("message-bubble-frame")).toBeVisible();
  await expect(approvalMessage.getByTestId("message-hover-time")).toHaveCount(1);
  await expect(approvalMessage.locator(".ms-10.max-w-block")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-blocks-approval-light");

  await switchTheme(page, "dark");
  await expect(allowOnce).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-blocks-approval-dark");
  await switchTheme(page, "light");

  await allowOnce.click();
  await expect(page.getByText("Allowed once", { exact: true })).toBeVisible();
  await waitForRunStatus(page, botId, null);
  await expect(composer).toBeEnabled();

  // A bot question, answered: the controls and the actions are gone, one line remains.
  await composer.fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");
  await waitForRunStatus(page, botId, "waiting_input");

  const berlin = page.getByRole("button", { name: "Berlin", exact: true });
  if ((await berlin.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message|Answer/)).toBeVisible({ timeout: 15_000 });
  }
  // The question is a normal bot row too, before it is answered.
  const questionMessage = page.locator("[data-message-id]").filter({ has: berlin });
  await expect(questionMessage.locator('[data-slot="message-row"]')).toBeVisible();
  await expect(questionMessage.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(questionMessage.getByTestId("message-bubble-frame")).toBeVisible();
  await expect(questionMessage.locator(".ms-10.max-w-block")).toHaveCount(0);

  for (const theme of ["dark", "light"] as const) {
    await switchTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(berlin).toBeVisible();
    await captureScreenshot(page, testInfo, `quiet-blocks-question-${theme}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await questionMessage.scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `quiet-blocks-question-${theme}-narrow`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }

  await berlin.click();
  const answered = page.getByRole("group", { name: "Your answer: Berlin" });
  await expect(answered).toBeVisible({ timeout: 30_000 });

  // Answered, it is still a normal bot row: only the card settles to its line
  // and the answer.
  const answeredMessage = page.locator("[data-message-id]").filter({ has: answered });
  await expect(answeredMessage.locator('[data-slot="message-row"]')).toBeVisible();
  await expect(answeredMessage.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(answeredMessage.getByTestId("message-bubble-frame")).toBeVisible();
  await expect(answeredMessage.locator(".ms-10.max-w-block")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-blocks-answered-light");

  await switchTheme(page, "dark");
  await expect(answered).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-blocks-answered-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "quiet-blocks-answered-dark-narrow");
});
