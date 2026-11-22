import {
  captureScreenshot,
  completeOnboarding,
  createBotFromPicker,
  createNamedBot,
  openBotPage,
  openNewBot,
  saveField,
  signup,
} from "./helpers";
import { expect, test } from "./test";

test("bot creation, editing, and deletion persist", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-crud-${stamp}@tangow.test`, "password12", "Bot CRUD");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const botList = page.locator("aside").first();
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();

  let createFailed = false;
  let resolveCreateAborted!: () => void;
  const createAborted = new Promise<void>((resolve) => {
    resolveCreateAborted = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createFailed = true;
    await route.abort("failed");
    resolveCreateAborted();
  });
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill("New Bot");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await createAborted;
  // Failed create keeps the form open on the current bot chat.
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-error")).toBeVisible();
  expect(createFailed).toBe(true);
  await page.unroute("**/rpc/bots/create");
  await page.getByRole("button", { name: "Cancel new bot" }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  let failedPostCreateRefresh = false;
  await page.route("**/rpc/spaces/list", async (route) => {
    if (failedPostCreateRefresh) {
      await route.fallback();
      return;
    }
    failedPostCreateRefresh = true;
    await route.abort("failed");
  });
  await createBotFromPicker(page);
  await expect(page.getByPlaceholder("Message New Bot")).toBeVisible();
  await expect.poll(() => failedPostCreateRefresh).toBe(true);
  await page.unroute("**/rpc/spaces/list");
  await expect(botList.getByRole("button", { name: /^New Bot/ })).toBeVisible();
  await page.waitForURL(/\/app\/[^/]+$/);
  const deletedBotPath = new URL(page.url()).pathname;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname).toBe(deletedBotPath);
  await captureScreenshot(page, testInfo, "27-created-bot");

  await page.locator("main").getByRole("button", { name: "New Bot", exact: true }).click();
  const sidePanel = page.getByTestId("side-panel");
  const botPage = await openBotPage(page);
  // A bot with no instructions opens on Activity, its creation offering to write them.
  await expect(botPage.getByRole("tab")).toHaveText([
    "Activity",
    "Routines",
    "Knowledge",
    "Settings",
  ]);
  await expect(botPage.getByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const created = botPage.getByTestId("activity-created");
  await expect(created.getByText("New Bot created")).toBeVisible();
  await expect(botPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  const nameInput = botPage.getByLabel("Name", { exact: true });
  const titleInput = botPage.getByLabel("Title", { exact: true });
  await expect(titleInput).toHaveAttribute("placeholder", "What it does, in one line");
  const longTitle = `Market researcher ${"and source verifier ".repeat(9)}`;
  const normalizedLongTitle = longTitle.trim();
  expect(longTitle.length).toBeGreaterThan(160);
  await saveField(page, nameInput, "Researcher");
  await saveField(page, titleInput, longTitle);
  await expect(titleInput).toHaveValue(normalizedLongTitle);
  await expect(botList.getByRole("button", { name: /^Researcher/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Researcher")).toBeVisible();
  // An emptied name puts the old one back instead of saving.
  await nameInput.fill(" ");
  await nameInput.blur();
  await expect(nameInput).toHaveValue("Researcher");

  await botPage.getByTestId("bot-appearance-trigger").click();
  const picker = page.getByTestId("bot-appearance-picker");
  const characterSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await picker.getByRole("button", { name: "Ragnarrot" }).click();
  await characterSaved;
  await expect(picker.getByRole("button", { name: "Ragnarrot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await botPage.getByTestId("bot-appearance-trigger").click();
  await expect(picker).toBeHidden();
  await captureScreenshot(page, testInfo, "27a-new-bot");

  // Writing instructions opens the wide editor; once saved, the link to write them goes.
  await created.getByRole("button", { name: "Write its first instructions" }).click();
  await expect(sidePanel).toHaveAttribute("data-detail", "instructions");
  await expect(sidePanel).toHaveAttribute("data-size", "wide");
  const instructionsInput = botPage.getByTestId("bot-instructions");
  await instructionsInput.fill("Always cite two independent sources before answering.");
  const instructionsSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await botPage.getByRole("button", { name: "Activity", exact: true }).click();
  await instructionsSaved;
  await expect(sidePanel).toHaveAttribute("data-size", "default");
  await expect(created.getByRole("button")).toHaveCount(0);
  await botPage.getByRole("tab", { name: "Settings" }).click();
  const settings = botPage.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: /^Instructions/ })).toContainText(
    "Always cite two independent sources",
  );

  await settings.getByRole("button", { name: /^Description/ }).click();
  const descriptionInput = botPage.getByTestId("bot-description");
  await descriptionInput.fill("Finds reliable sources and turns them into concise briefs.");
  const descriptionSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await botPage.getByRole("button", { name: "Settings", exact: true }).click();
  await descriptionSaved;
  await expect(settings.getByRole("button", { name: /^Description/ })).toContainText(
    "Finds reliable sources",
  );
  await expect(settings.getByRole("button", { name: "Team" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27b-settings-tab");
  await settings.getByRole("button", { name: /^Model/ }).click();
  await expect(botPage.getByRole("combobox", { name: "Model", exact: true })).toContainText(
    "Space default",
  );
  await captureScreenshot(page, testInfo, "27c-bot-settings-model");
  // Escape outside a field goes back to the tab, and focus lands on the row that opened it.
  await page.keyboard.press("Escape");
  await expect(sidePanel).toHaveAttribute("data-panel", "bot");
  await expect(sidePanel).not.toHaveAttribute("data-detail", "model");
  await expect(settings.getByRole("button", { name: /^Model/ })).toBeFocused();

  await page.getByTestId("open-computer-panel").click();
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(page.getByTestId("open-settings-panel")).toBeVisible();
  // Overlay may flash during boot or never appear (already ready/asleep/stopped). Assert panel
  // chrome, then wait until any overlay has cleared — avoid Locator.or() strict-mode multi-hits.
  const bootOverlay = page.getByText(/Booting up .* computer/);
  await expect(sidePanel.getByTestId("computer-preview")).toBeVisible();
  await expect(bootOverlay).toBeHidden();
  await expect(sidePanel.getByText("Teach a task")).toHaveCount(0);
  await expect(sidePanel.getByTestId("teach-start-button")).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Reset computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Update computer" })).toHaveCount(0);
  await expect(sidePanel.getByRole("button", { name: "Take control" })).toHaveCount(0);
  await expect(sidePanel.getByTestId("computer-more-button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "27d-computer-panel");

  await openBotPage(page);
  await saveField(page, nameInput, "Atlas");
  await saveField(page, titleInput, "Research lead");
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await captureScreenshot(page, testInfo, "28-edited-bot-profile");

  await page.reload();
  await expect(botList.getByRole("button", { name: /^Atlas/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Atlas")).toBeVisible();
  await page.locator("main").getByRole("button", { name: "Atlas", exact: true }).click();
  await expect(nameInput).toHaveValue("Atlas");
  await expect(titleInput).toHaveValue("Research lead");
  await botPage.getByTestId("bot-appearance-trigger").click();
  await expect(picker.getByRole("button", { name: "Ragnarrot" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await botPage.getByTestId("bot-appearance-trigger").click();
  await botPage.getByRole("tab", { name: "Settings" }).click();
  await expect(settings.getByRole("button", { name: /^Description/ })).toContainText(
    "Finds reliable sources",
  );
  await expect(settings.getByRole("button", { name: /^Instructions/ })).toContainText(
    "Always cite two independent sources",
  );
  await captureScreenshot(page, testInfo, "29-reloaded-bot-profile");

  // Wrap in the narrow dialog without pushing Delete below the Playwright viewport.
  const longUnbrokenName = "A".repeat(48);
  expect(longUnbrokenName.length).toBe(48);
  await saveField(page, nameInput, longUnbrokenName);
  const longNameBot = botList.getByRole("button", {
    name: new RegExp(`^${longUnbrokenName}`),
  });
  await expect(longNameBot).toBeVisible();
  await expect(page.getByPlaceholder(`Message ${longUnbrokenName}`)).toBeVisible();

  await longNameBot.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const deleteDialog = page.getByRole("alertdialog", {
    name: `Delete ${longUnbrokenName}?`,
  });
  await expect(deleteDialog).toBeVisible();
  await captureScreenshot(page, testInfo, "30-delete-bot-confirmation");
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();

  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await page.waitForURL((url) => url.pathname !== deletedBotPath);

  await page.goto(deletedBotPath);
  await page.waitForURL((url) => url.pathname !== deletedBotPath);
  await expect(botList.getByText(longUnbrokenName, { exact: true })).toHaveCount(0);
  await expect(botList.getByRole("button", { name: /^Chief/ })).toBeVisible();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await captureScreenshot(page, testInfo, "31-deleted-bot-fallback");
});

test("an archived bot's page opens read-only from the archived list, and Restore brings it back", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-archive-${stamp}@tangow.test`, "password12", "Archive Owner");
  await completeOnboarding(page);
  const scoutId = await createNamedBot(page, "Scout");
  const panel = page.getByTestId("side-panel");

  const botPage = await openBotPage(page);
  await botPage.getByRole("button", { name: "Actions for Scout" }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Archived/ })
    .click();
  await page.getByTestId("archived-bot-open").filter({ hasText: "Scout" }).click();
  await expect(panel).toHaveAttribute("data-panel", "bot");
  const archived = panel.getByTestId("bot-page");
  await expect(archived.getByLabel("Name", { exact: true })).toHaveValue("Scout");
  await expect(archived.getByLabel("Name", { exact: true })).toBeDisabled();
  await expect(archived.getByTestId("bot-appearance-trigger")).toBeDisabled();
  await expect(archived.getByRole("tablist")).toHaveCount(0);
  await expect(archived.getByTestId("activity-created")).toContainText("Scout created");
  await captureScreenshot(page, testInfo, "bot-page-archived");

  await archived.getByRole("button", { name: "Actions for Scout" }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Restore", "Delete"]);
  await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
  await page.waitForURL(new RegExp(`/app/${scoutId}$`));
  await expect(panel).toHaveAttribute("data-panel", "bot");
  await expect(archived.getByLabel("Name", { exact: true })).toBeEnabled();
  await expect(archived.getByRole("tablist")).toBeVisible();
});
