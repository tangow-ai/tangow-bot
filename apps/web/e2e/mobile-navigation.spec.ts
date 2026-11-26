import type { Locator, Page } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openBotPage, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

/** At phone width the bot list is its own page, as in the iPhone app: open a chat, go back. */
test("the phone bot list is a page that a chat opens from and returns to", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("mobile-nav"), "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  const chat = page.url();

  const list = page.getByTestId("bots-sidebar");
  const main = page.locator("main");
  await expect(list).toBeHidden();
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);

  // The list takes the whole screen, on the page background Safari paints its bars in.
  await expect(list).toBeVisible();
  await expect(main).toHaveJSProperty("inert", true);
  expect(await page.getByTestId("bots-sidebar-pane").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  await captureScreenshot(page, testInfo, "mobile-bot-list");

  await list.getByRole("button", { name: /Chief/ }).first().click();
  await page.waitForURL(chat);
  await expect(list).toBeHidden();
  await expect(main).toHaveJSProperty("inert", false);

  // From a chat opened on the list, Back pops to it: the chat is still ahead in history.
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);
  await expect(list).toBeVisible();
  await page.goForward();
  await page.waitForURL(chat);
  await expect(list).toBeHidden();

  // The browser's back gesture returns to the list too.
  await page.goBack();
  await page.waitForURL(/\/app$/);
  await expect(list).toBeVisible();

  // A cold load of the bare route stays on the list, past the roster's refresh poll.
  await page.goto("/app");
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(3_500);
  expect(new URL(page.url()).pathname).toBe("/app");
  await expect(list).toBeVisible();
});

async function startOnBotList(page: Page, email: string) {
  await signup(page, email, "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("link", { name: "Back" }).click();
  await page.waitForURL(/\/app$/);
}

/** A touch hold as iOS Safari reports it: no `contextmenu`, and a click once the finger lifts. */
async function longPress(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("longPress target has no bounding box");
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  const touch = { pointerType: "touch", pointerId: 1, isPrimary: true, bubbles: true, ...point };
  await target.dispatchEvent("pointerdown", touch);
  await page.waitForTimeout(600);
  await target.dispatchEvent("pointerup", touch);
  await target.dispatchEvent("click", point);
}

test("on the phone bot list a long press opens a bot's menu, with Move to in the menu itself", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, uniqueEmail("mobile-press"));
  const list = page.getByTestId("bots-sidebar");
  const bot = list.getByRole("button", { name: /^Chief/ });
  const menu = page.getByRole("menu", { name: "Actions for Chief" });

  // Dragging would fight the scroll and the hold, so the phone reorders from the keyboard only.
  await expect(bot).toHaveAttribute("draggable", "false");
  await expect(bot).toHaveCSS("user-select", "none");

  await longPress(page, bot);
  await expect(menu).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app");
  await expect(menu.getByRole("menuitem", { name: "Move to" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Unassigned" })).toBeVisible();
  await captureScreenshot(page, testInfo, "mobile-bot-menu-long-press");

  await menu.getByRole("menuitem", { name: "New section" }).click();
  const dialog = page.getByRole("dialog", { name: "New section" });
  await dialog.getByLabel("Name").fill("Projects");
  await dialog.getByRole("button", { name: "Create" }).click();
  const projects = list.locator('[data-sidebar-group^="section:"]');
  await expect(projects).toContainText("Chief");

  // A section's header opens its own menu the same way, without folding the section.
  const header = list.getByRole("button", { name: "Collapse Projects" });
  await longPress(page, header);
  await expect(page.getByRole("menu", { name: "Actions for Projects" })).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");

  await longPress(page, bot);
  await menu.getByRole("menuitem", { name: "Unassigned" }).click();
  await expect(list.locator('[data-sidebar-group="unassigned"]')).toContainText("Chief");
});

async function openUserMenuEntry(page: Page, name: "Settings" | "Usage") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name, exact: true }).click();
}

test("phone Settings is a list of sections: a row pushes one, Back and close leave", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, uniqueEmail("mobile-settings"));

  await openUserMenuEntry(page, "Settings");
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-nav")).toHaveCount(0);
  for (const id of ["profile", "providers", "space", "models", "usage"]) {
    const row = await settings.getByTestId(`settings-list-${id}`).boundingBox();
    expect(row?.height, `${id} row`).toBeGreaterThanOrEqual(44);
  }
  // The window zooms in when it opens; measure it once it has landed.
  await settings.evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));
  const close = await settings.getByRole("button", { name: "Close user settings" }).boundingBox();
  expect(close && close.x + close.width).toBeGreaterThan(340);
  expect(close?.y).toBeLessThan(60);
  await captureScreenshot(page, testInfo, "mobile-settings-list");

  await settings.getByTestId("settings-list-models").click();
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("settings-list-profile")).toHaveCount(0);
  const sectionClose = settings.getByRole("button", { name: "Close model settings" });
  await expect(sectionClose).toBeVisible();
  const moved = await sectionClose.boundingBox();
  expect(moved?.x).toBeCloseTo(close?.x ?? 0, 0);
  expect(moved?.y).toBeCloseTo(close?.y ?? 0, 0);
  await expect(settings.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  await captureScreenshot(page, testInfo, "mobile-settings-models");

  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByTestId("settings-list-models")).toBeFocused();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toHaveCount(0);

  await openUserMenuEntry(page, "Usage");
  await expect(settings.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByTestId("settings-list-usage")).toBeVisible();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toHaveCount(0);
});

/** Elements inside `root` that scroll vertically right now. */
function scrollers(root: Locator) {
  return root.evaluate(
    (element) =>
      [element, ...element.querySelectorAll("*")].filter((node) => {
        const { overflowY } = getComputedStyle(node);
        return (
          (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight
        );
      }).length,
  );
}

test("phone Providers pushes a provider's setup over the list and pops back to it", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, uniqueEmail("mobile-providers"));
  await openUserMenuEntry(page, "Settings");
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-list-providers").click();

  // The list shows first, as one page: no provider opens on its own, no box scrolls inside it.
  const models = settings.getByRole("region", { name: "Models", exact: true });
  await expect(models).toBeVisible();
  await expect(settings.getByLabel("API key")).toHaveCount(0);
  await expect.poll(() => scrollers(settings)).toBe(1);
  await captureScreenshot(page, testInfo, "mobile-providers-list");

  const scripted = models.getByRole("button", { name: /Scripted/ });
  await scripted.click();
  await expect(settings.getByRole("heading", { name: "Scripted", exact: true })).toBeVisible();
  await expect(models).toBeHidden();
  const back = settings.getByRole("button", { name: "Providers", exact: true });
  await expect(back).toBeFocused();
  const apiKey = settings.getByLabel("API key");
  await expect(apiKey).toBeInViewport();
  expect((await apiKey.boundingBox())?.height).toBeGreaterThan(0);
  expect(await scrollers(settings)).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "mobile-provider-detail");

  // The model list unfolds in the page with a 16 px search field, so iOS does not zoom.
  await settings.getByRole("combobox", { name: "Model", exact: true }).click();
  const search = settings.getByRole("combobox", { name: "Search models" });
  await expect(search).toHaveCSS("font-size", "16px");
  const option = await settings.getByRole("option").first().boundingBox();
  expect(option?.height).toBeGreaterThanOrEqual(44);
  expect(await scrollers(settings)).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "mobile-provider-model-picker");
  await search.press("Escape");

  await apiKey.fill("fake-scripted-key-one");
  await settings.getByRole("button", { name: "Connect API key" }).click();
  await expect(settings.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await back.click();
  await expect(settings.getByRole("heading", { name: "Providers", exact: true })).toBeVisible();
  await expect(scripted).toBeFocused();
  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings.getByTestId("settings-list-providers")).toBeFocused();
});

test("phone Customize is a list of its sections, pushed and popped like Settings", async ({
  page,
}, testInfo) => {
  await startOnBotList(page, uniqueEmail("mobile-customize"));

  await page.getByTestId("open-customize").click();
  const overlay = page.getByRole("dialog");
  await expect(overlay.getByRole("heading", { name: "Customize", exact: true })).toBeVisible();
  await expect(overlay.getByTestId("customize-nav-skills")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "mobile-customize-list");

  await overlay.getByTestId("customize-list-skills").click();
  await expect(overlay.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  await overlay.getByTestId("customize-list-integrations").click();
  await expect(overlay.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  await overlay.getByRole("button", { name: "Close integrations" }).click();
  await expect(overlay).toHaveCount(0);
});

test("the phone bot panel returns to the chat from its own back button", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("mobile-panel"), "password12", "Phone Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForURL(/\/app\/[^/]+$/);
  const panel = page.getByTestId("side-panel");

  const botPage = await openBotPage(page);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeHidden();
  await captureScreenshot(page, testInfo, "mobile-bot-panel");
  await botPage.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  await openBotPage(page);
  await botPage.getByRole("tab", { name: "Settings", exact: true }).click();
  await botPage.locator('[data-opens="model"]').click();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeHidden();
  await captureScreenshot(page, testInfo, "mobile-bot-panel-detail");
  await botPage.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
});

test("at desktop width the bot panel keeps its close button and hides the Chat back", async ({
  page,
}) => {
  await signup(page, uniqueEmail("desktop-panel"), "password12", "Desktop Nav");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  const botPage = await openBotPage(page);
  await expect(botPage.getByRole("button", { name: "Close panel" })).toBeVisible();
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toBeHidden();
});
