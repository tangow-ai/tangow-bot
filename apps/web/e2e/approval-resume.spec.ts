import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

test.describe.configure({ mode: "serial" });

test("approval input resumes durable work", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("approval"), "password12", "Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");

  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Reply with one city name.", { exact: true })).toBeVisible();
  const answer = page.getByRole("textbox", { name: "Answer", exact: true });
  const send = page
    .getByRole("group", { name: "Which city should I use?" })
    .getByRole("button", { name: "Send", exact: true });
  await expect(answer).toBeVisible();
  await expect(send).toBeDisabled();
  await captureScreenshot(page, testInfo, "20-approval-input-request");

  await answer.fill("ask me which city to use again");
  await expect(send).toBeEnabled();
  await captureScreenshot(page, testInfo, "21-approval-custom-answer");
  await send.click();

  await expect(prompt).toHaveCount(2, { timeout: 30_000 });
  await expect(
    page.getByRole("group", { name: "Your answer: ask me which city to use again" }),
  ).toBeVisible();
  await expect(answer).toHaveCount(1);
  await captureScreenshot(page, testInfo, "22-second-approval-prompt");

  await answer.fill("Paris");
  await captureScreenshot(page, testInfo, "23-second-approval-answer");
  await answer.press("Enter");

  const resumed = page.getByText(
    "on it. i will work this in the background and come back with a result.",
    { exact: true },
  );
  await expect(resumed).toBeVisible({ timeout: 30_000 });
  const handledAnswer = page.getByText("done. i handled: Paris", { exact: true });
  await expect(handledAnswer).toBeVisible();
  const paris = page.getByRole("group", { name: "Your answer: Paris" });
  await expect(paris).toBeVisible();

  await page.reload();
  await expect(resumed).toBeVisible({ timeout: 20_000 });
  await expect(handledAnswer).toBeVisible();
  await expect(paris).toBeVisible();
  await captureScreenshot(page, testInfo, "24-approval-resumed-after-reload");

  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(3, { timeout: 30_000 });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("No longer active", { exact: true })).toBeVisible();
  await expect(answer).toHaveCount(0);
  await captureScreenshot(page, testInfo, "25-stopped-approval-prompt");
});
