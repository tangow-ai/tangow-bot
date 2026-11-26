import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

test.use({ viewport: { width: 390, height: 844 } });

test("the bot screen's top bar fits a phone and offers Teach a task in the menu", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("chrome-narrow"), "password12", "Chrome Narrow");
  await completeOnboarding(page);

  await page.getByTestId("open-computer-panel").click();
  const sidePanel = page.getByTestId("side-panel");
  await sidePanel.getByTestId("computer-preview").hover();
  await sidePanel.getByTestId("computer-preview-open").click();

  const chrome = page.getByTestId("computer-chrome");
  await chrome.getByTestId("computer-take-control").click();
  const pill = chrome.getByText("You have control", { exact: true });
  const release = chrome.getByRole("button", { name: "Release", exact: true });
  await expect(pill).toBeVisible();
  await expect(release).toBeVisible();

  const [pillBox, releaseBox, chromeBox] = await Promise.all([
    pill.boundingBox(),
    release.boundingBox(),
    chrome.boundingBox(),
  ]);
  expect(pillBox).not.toBeNull();
  expect(releaseBox).not.toBeNull();
  expect(chromeBox).not.toBeNull();
  expect(pillBox!.height).toBeLessThan(32);
  expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(releaseBox!.x);
  expect(chromeBox!.x + chromeBox!.width).toBeLessThanOrEqual(390);
  const closeBox = await page.getByRole("button", { name: "Close computer" }).boundingBox();
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "computer-chrome-narrow");

  await expect(chrome.getByTestId("teach-start-button")).toBeHidden();
  await chrome.getByTestId("computer-more-button").click();
  await page.getByRole("menuitem", { name: "Teach a task" }).click();
  await expect(page.getByTestId("teach-goal-input")).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-chrome-narrow-teach");
});
