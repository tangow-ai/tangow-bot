import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("settings shell is two-pane and deep-links Providers Models Memory Decision Model Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, uniqueEmail("settings-shell"), "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-profile")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(settings.getByTestId("advanced-settings")).toHaveCount(0);
  // One space: its name labels the space group, with nothing to switch to.
  await expect(settings.getByTestId("settings-space-label")).toBeVisible();
  await expect(settings.getByTestId("settings-space-switcher")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-shell-profile");
  const profileBox = await settings.boundingBox();

  // Keys belong to the account; each space keeps only its model and voice choice.
  await settings.getByTestId("settings-nav-providers").click();
  await expect(settings).toHaveAttribute("data-settings-section", "providers");
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  const providers = settings.getByTestId("providers-settings");
  await expect(providers.getByRole("region", { name: "Models", exact: true })).toBeVisible();
  await expect(providers.getByRole("region", { name: "Voice", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-providers");

  await settings.getByTestId("settings-nav-space").click();
  await expect(settings).toHaveAttribute("data-settings-section", "space");
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByTestId("advanced-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-space-general");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await expect(settings.getByLabel("Active model", { exact: true })).toBeVisible();
  await expect(settings.getByPlaceholder("Search providers")).toHaveCount(0);
  // The window keeps one size whatever the section holds. Let any resize transition finish first.
  await settings.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  expect(await settings.boundingBox()).toEqual(profileBox);
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Provider")).toBeVisible();
  await memory.getByLabel("Provider").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");

  await settings.getByTestId("settings-nav-decision-model").click();
  await expect(settings).toHaveAttribute("data-settings-section", "decision-model");
  await expect(
    settings.getByRole("heading", { name: "Decision Model", exact: true }),
  ).toBeVisible();
  const decisionModelSettings = settings.getByTestId("decision-model-settings");
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toBeVisible();
  await expect(decisionModelSettings.getByRole("button", { name: "Connect" })).toBeDisabled();
  await decisionModelSettings.getByText("Advanced").click();
  await expect(decisionModelSettings.getByLabel("Base URL")).toBeVisible();
  await expect(decisionModelSettings.getByLabel("Model")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-decision-model");
  await decisionModelSettings.getByLabel("OpenRouter API key").fill("test-key-not-real");
  await decisionModelSettings.getByRole("button", { name: "Connect" }).click();
  await expect(decisionModelSettings.getByText("Connected", { exact: true })).toBeVisible();
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toHaveCount(0);
  await decisionModelSettings.getByRole("button", { name: "Disconnect" }).click();
  await expect(decisionModelSettings.getByLabel("OpenRouter API key")).toBeVisible();
  await expect(decisionModelSettings.getByText("Connected", { exact: true })).toHaveCount(0);

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-shell-voice");
  await settings.getByRole("button", { name: "Connect a voice provider" }).click();
  await expect(settings).toHaveAttribute("data-settings-section", "providers");

  await page.getByRole("button", { name: "Close user settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

test("settings space switcher moves to another space and keeps the section", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("settings-switch"), "password12", `Switch ${stamp}`);
  await completeOnboarding(page);
  await rpc(page, "spaces/create", { name: "Family" });
  await page.reload();

  const settings = await openUserSettings(page, "space");
  const switcher = settings.getByTestId("settings-space-switcher");
  const menu = page.getByTestId("settings-space-menu");
  await expect(switcher).not.toContainText("Family");
  await switcher.click();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await expect(menu.getByRole("menuitemradio", { checked: true })).not.toContainText("Family");
  await captureScreenshot(page, testInfo, "settings-space-switcher-open");
  await page.keyboard.press("Escape");

  // The owner renames the space in place; the switcher picks up the new name.
  const nameInput = settings.getByRole("textbox", { name: "Name" });
  await nameInput.fill("Home");
  await nameInput.press("Enter");
  await expect(switcher).toContainText("Home");
  await captureScreenshot(page, testInfo, "settings-space-name");

  // At phone width the section stays open with a way back; the switcher heads the space group of the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-phone-space-general");
  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  const phoneSwitcher = settings.getByTestId("settings-space-switcher");
  await phoneSwitcher.click();
  await expect(menu).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-phone-switcher-open");

  // The switch happens in place: settings stay open and the page never reloads.
  await page.evaluate(() => {
    (window as { beforeSwitch?: boolean }).beforeSwitch = true;
  });
  await menu.getByRole("menuitemradio", { name: "Family" }).click();
  await expect(phoneSwitcher).toContainText("Family");
  await settings.getByTestId("settings-list-space").click();
  await expect(settings.getByRole("textbox", { name: "Name" })).toHaveValue("Family");
  expect(await page.evaluate(() => (window as { beforeSwitch?: boolean }).beforeSwitch)).toBe(true);
});
