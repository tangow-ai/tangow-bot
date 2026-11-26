import { activeBotId, captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";
import { blocksOf, threadEntries } from "./thread-log";

test("a bot asks before creating a bot, and Cancel creates nothing", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("spawn-approval"), "password12", "Spawn Approval");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByPlaceholder(/Message/).fill("spawn a bot named Veille to watch competitors");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Create bot “Veille”?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  const detail = page.locator("pre").filter({ hasText: "Title: Veille specialist" });
  await expect(detail).toContainText("Instructions:");
  await expect(detail).toContainText("You are Veille.");
  await expect(detail).toContainText("First message:");
  await expect(detail).toContainText("Start on the assigned work.");
  await expect(page.getByRole("button", { name: "Create bot", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(
    page
      .locator('[data-slot="framed-block-actions"]')
      .filter({
        has: page.getByRole("button", { name: "Create bot", exact: true }),
      })
      .getByRole("button"),
  ).toHaveText(["Cancel", "Edit", "Create bot"]);
  await expect(page.getByRole("button", { name: "Create space", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "spawn-bot-approval-card");

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();

  expect(
    blocksOf(await threadEntries(page, { botId })).some((block) => block.kind === "child_bot"),
  ).toBe(false);
});

test("Edit changes the name before Create bot, and the bot is created with it", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("spawn-edit"), "password12", "Spawn Edit");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.getByPlaceholder(/Message/).fill("spawn a bot named Veille to watch competitors");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Create bot “Veille”?", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page
      .locator('[data-slot="framed-block-actions"]')
      .filter({
        has: page.getByRole("button", { name: "Edit", exact: true }),
      })
      .getByRole("button"),
  ).toHaveText(["Cancel", "Edit", "Create bot"]);
  await page.getByRole("button", { name: "Edit", exact: true }).click();

  await expect(page.getByText("Create bot?", { exact: true })).toBeVisible();
  const name = page.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Veille");
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(
    /You are Veille\./,
  );
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "spawn-bot-approval-card-editing");

  await name.fill("Veille EU");
  await page.getByRole("button", { name: "Create bot", exact: true }).click();
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  await expect
    .poll(async () =>
      blocksOf(await threadEntries(page, { botId })).flatMap((block) =>
        block.kind === "child_bot" ? [block.name] : [],
      ),
    )
    .toContain("Veille EU");
});
