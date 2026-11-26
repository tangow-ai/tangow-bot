import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Page, test } from "./test";

async function createBot(page: Page, name: string) {
  return createNamedBot(page, name);
}

test("mention picker completes with Enter and Tab", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("mention-keys"), "password12", "Mention Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");
  expect(researcherId).toBeTruthy();
  expect(writerId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Mention keys team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Researcher" }).click();
  await panel.getByRole("button", { name: "Research Writer" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Mention keys team" });
  await expect(composer).toBeVisible();

  await composer.fill("@Res");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-open");

  await composer.press("ArrowDown");
  await expect(picker.getByRole("option", { name: "@Research Writer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await composer.press("Enter");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  const tokens = page.getByTestId("composer-bar").locator('[data-slot="entity-mention-field"]');
  await expect(tokens).toHaveText(["@Research Writer"]);
  await expect(composer).toHaveValue("@Research Writer ");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-completed");

  // Backspace takes the space, then selects the token whole, then deletes it as one.
  await composer.press("Backspace");
  await composer.press("Backspace");
  await expect(tokens).toHaveAttribute("data-selected", "true");
  await expect(composer).toHaveValue("@Research Writer");
  await composer.press("Backspace");
  await expect(composer).toHaveValue("");
  await expect(tokens).toHaveCount(0);

  // The picker opens at the caret, mid-sentence, and Tab completes in place.
  await composer.fill("ask  to check");
  await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(4, 4));
  await page.keyboard.insertText("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Tab");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("ask @Researcher to check");
  await expect(tokens).toHaveText(["@Researcher"]);
  await expect(composer).toBeFocused();

  // The caret steps over the token.
  await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(15, 15));
  await composer.press("ArrowLeft");
  expect(await composer.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(4);

  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Res");
  await expect(tokens).toHaveCount(0);
  await expect(composer).toBeFocused();

  await composer.fill("hello without a picker");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("hello without a picker", {
    timeout: 60_000,
  });
});

test("mentions stay inline where typed, in the composer and the sent bubble", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("mention-inline"), "password12", "Mention Inline");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await createBot(page, "Ivy");
  await createBot(page, "Atlas");
  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Launch");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Ivy" }).click();
  await panel.getByRole("button", { name: "Atlas" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Launch" });
  await composer.fill("Draft this week's notes, then ask @Iv");
  await page.getByRole("option", { name: "@Ivy" }).click();
  await page.keyboard.insertText("to check tone with @Atl");
  await page.getByRole("option", { name: "@Atlas" }).click();
  await page.keyboard.insertText("before it goes out.");
  const tokens = page.getByTestId("composer-bar").locator('[data-slot="entity-mention-field"]');
  await expect(tokens).toHaveText(["@Ivy", "@Atlas"]);
  await captureScreenshot(page, testInfo, "inline-mentions-composer");
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "inline-mentions-composer-phone");
  if (desktop) await page.setViewportSize(desktop);

  await composer.press("Enter");
  const bubble = page.getByTestId("message-user-bubble").last();
  await expect(bubble).toContainText("before it goes out.", { timeout: 60_000 });
  // Sent as typed: the names stay mid-sentence, drawn in place.
  await expect(bubble.locator('[data-slot="entity-mention"]')).toHaveText(["Ivy", "Atlas"]);
  await captureScreenshot(page, testInfo, "inline-mentions-bubble");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "inline-mentions-bubble-phone");
});
