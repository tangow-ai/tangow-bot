import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("search palette opens from the header and ⌘K, and finds bots, chats and settings", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("cmdk-bots"), "password12", "CmdK Bots");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "research lead",
    description: "Finds sources and writes briefs.",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Voyage team",
    botIds: [chiefId, researcher.id],
  });
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /^Researcher/ })).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Search" });
  await aside.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog).toBeVisible();
  const chiefRow = page.getByTestId(`command-palette-bot-${chiefId}`);
  const researcherRow = page.getByTestId(`command-palette-bot-${researcher.id}`);
  await expect(chiefRow).toBeVisible();
  await expect(researcherRow).toBeVisible();
  await expect(page.getByTestId(`command-palette-group-${group.id}`)).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-bots");

  const search = page.getByTestId("command-palette-search");
  await search.fill("Research");
  await expect(researcherRow).toBeVisible();
  await expect(chiefRow).toHaveCount(0);
  await captureScreenshot(page, testInfo, "command-palette-filtered");

  await researcherRow.click();
  await expect(dialog).toBeHidden();
  await page.waitForURL(new RegExp(`/app/${researcher.id}$`));
  expect(activeBotId(page)).toBe(researcher.id);
  await expect(page.getByRole("combobox", { name: "Message Researcher" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog).toBeVisible();
  await search.fill("Voyage");
  await page.getByTestId(`command-palette-group-${group.id}`).click();
  await page.waitForURL(new RegExp(`/app/g/${group.id}$`));

  await page.keyboard.press("ControlOrMeta+K");
  await search.fill("Voice");
  await expect(page.getByTestId("command-palette-settings-voice")).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-settings");
  await page.getByTestId("command-palette-settings-voice").click();
  await expect(dialog).toBeHidden();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Close voice settings" }).click();
  await expect(settings).toBeHidden();

  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog).toBeVisible();
  await chiefRow.click();
  await page.waitForURL(new RegExp(`/app/${chiefId}$`));
  expect(activeBotId(page)).toBe(chiefId);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Back" }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(dialog).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-phone");
});
