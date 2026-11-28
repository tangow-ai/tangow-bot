import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  inviteToSpace,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("adds, replaces and deletes a vault key without ever showing its value", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const first = `fake-vault-key-${stamp}`;
  const second = `fake-vault-key-rotated-${stamp}`;
  await signup(page, `vault-${stamp}@tangow.test`, "password12", `Vault ${stamp}`);
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "vault");
  const dialog = page.getByTestId("vault-item-dialog");
  const row = settings.getByRole("button", { name: /example_api/ });

  await settings.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByLabel("Site").fill("api.example.test");
  await dialog.getByLabel("Name").fill("example_api");
  await dialog.getByLabel("Key").fill(first);
  await captureScreenshot(page, testInfo, "vault-add");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row).toContainText("api.example.test");
  await captureScreenshot(page, testInfo, "vault-list");

  await row.click();
  await expect(dialog.getByLabel("Key")).toHaveValue("");
  await dialog.getByLabel("Key").fill(second);
  await dialog.getByRole("button", { name: "Replace key" }).click();
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await row.click();
  await expect(dialog.getByLabel("Key")).toHaveValue("");
  await captureScreenshot(page, testInfo, "vault-replace-phone");
  for (const value of [first, second]) {
    await expect(page.locator("body")).not.toContainText(value);
  }
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toBeHidden();
});

test("an owner shares the key a bot saved with someone, who sees it under Shared with you", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  const value = `fake-shared-vault-key-${stamp}`;
  await signup(page, `vault-share-owner-${stamp}@tangow.test`, "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  await rpc(page, "spaces/rename", { spaceId, name: "Studio" });
  const guestEmail = `vault-share-guest-${stamp}@tangow.test`;
  const inviteUrl = await inviteToSpace(page, spaceId, guestEmail);
  const botId = await createNamedBot(page, "Release notes");
  const ownerRow = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ });

  // The bot saves a key through its protected card.
  await ownerRow.click();
  await page.getByPlaceholder("Message Release notes").fill("request a masked api key");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("secret-ask-card");
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByLabel("API key").fill(value);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status ?? "completed",
      { timeout: 30_000 },
    )
    .toBe("completed");

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, guestEmail, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);

  // Shared with Grace, the bot offers its key, unticked until the owner ticks it.
  await ownerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const sheet = page.getByTestId("share-bot-dialog");
  const key = sheet.getByRole("checkbox", { name: "example_api" });
  await expect(key).toHaveCount(0);
  await sheet.getByRole("checkbox", { name: "Grace Guest" }).click();
  await expect(key).not.toBeChecked();
  await key.click();
  await expect(key).toBeChecked();
  await expect(sheet.getByText(/These people can use ticked keys/)).toBeVisible();
  await captureScreenshot(page, testInfo, "vault-share-bot-keys");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "vault-share-bot-keys-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  // Sharing the bot with the whole Space never ticks a key for the whole Space.
  await sheet.getByRole("switch", { name: "Everyone in Studio" }).click();
  await expect(key).not.toBeChecked();
  await expect(sheet.getByText(/Every current and future member of Studio/)).toBeVisible();
  await page.keyboard.press("Escape");

  // The owner's list says who the key is shared with.
  const settings = await openUserSettings(page, "vault");
  await expect(settings.getByRole("button", { name: /example_api/ })).toContainText("Grace Guest");
  await captureScreenshot(page, testInfo, "vault-share-list");
  await settings.getByRole("button", { name: /example_api/ }).click();
  const dialog = page.getByTestId("vault-item-dialog");
  await expect(dialog.getByRole("checkbox", { name: "Grace Guest" })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "Everyone in Studio" })).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "vault-share-list-phone");

  // Grace sees it, read-only, with its owner and never its value.
  const guestSettings = await openUserSettings(guest, "vault");
  const shared = guestSettings.getByText("Shared with you");
  await expect(shared).toBeVisible();
  await expect(guestSettings).toContainText("api.example.test · Ada Owner");
  await captureScreenshot(guest, testInfo, "vault-shared-with-you");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "vault-shared-with-you-phone");
  for (const view of [page, guest]) await expect(view.locator("body")).not.toContainText(value);
  await guestContext.close();
});
