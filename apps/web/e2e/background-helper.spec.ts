import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

const phone = { width: 390, height: 844 };

test("a background helper lets the bot answer at once, then report back unprompted", async ({
  page,
}, testInfo) => {
  const desktop = page.viewportSize()!;
  await signup(page, uniqueEmail("background-helper"), "password12", "Background");
  await completeOnboarding(page);

  const ask = "research Lisbon hotels in the background";
  await page.getByPlaceholder(/Message/).fill(ask);
  await page.keyboard.press("Enter");

  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("I've started that, I'll come back with it.")).toBeVisible({
    timeout: 30_000,
  });
  const report = `the helper reported back. it found: ${ask}`;
  await expect(transcript.getByText(report)).toBeVisible({ timeout: 30_000 });
  await expect(transcript.getByText(`it found: ${ask}`)).toHaveCount(1);
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "background-helper-reply");
  await page.setViewportSize(phone);
  await expect(transcript.getByText(report)).toBeVisible();
  await captureScreenshot(page, testInfo, "background-helper-reply-phone");
  await page.setViewportSize(desktop);
});
