import {
  captureScreenshot,
  completeOnboarding,
  openBotPage,
  openBotTab,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

/** Documents the two-pane shell: sidebar, thread header, empty thread, light and dark. */
test("the shell is a sidebar and a centred thread", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("quiet-shell"), "password12", "Quiet Shell");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const sidebar = page.getByTestId("bots-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", "280px");
  await expect(sidebar).toHaveCSS("border-right-width", "0px");

  const header = page.getByTestId("bot-settings-trigger");
  await expect(header).toBeVisible();
  const conversation = page.getByTestId("conversation-column");
  const headerRow = conversation.locator("> div").first();
  await expect(headerRow).toHaveCSS("height", "56px");
  await expect(headerRow).toHaveCSS("border-bottom-width", "0px");

  // The thread is one centred column, with equal air on both sides.
  const main = page.locator("main");
  const column = conversation.locator("> div").nth(1);
  await expect(column).toHaveCSS("max-width", "800px");
  const [mainBox, columnBox] = await Promise.all([main.boundingBox(), column.boundingBox()]);
  expect(mainBox).not.toBeNull();
  expect(columnBox).not.toBeNull();
  const leading = (columnBox?.x ?? 0) - (mainBox?.x ?? 0);
  const trailing =
    (mainBox?.x ?? 0) + (mainBox?.width ?? 0) - ((columnBox?.x ?? 0) + (columnBox?.width ?? 0));
  expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(2);

  // The sidebar floats 8 from the window's top, bottom and start edges, 264 wide in its
  // 280 column, and the composer floats 20 above the bottom edge.
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  expect(await page.getByTestId("bots-sidebar-pane").boundingBox()).toEqual({
    x: 8,
    y: 8,
    width: 264,
    height: (viewport?.height ?? 0) - 16,
  });
  const composerBox = await page.getByTestId("composer-bar").boundingBox();
  expect((viewport?.height ?? 0) - (composerBox?.y ?? 0) - (composerBox?.height ?? 0)).toBe(20);
  // The thread runs on under the composer, so its glass has something to blur.
  const transcriptBox = await page.getByTestId("transcript").boundingBox();
  expect((transcriptBox?.y ?? 0) + (transcriptBox?.height ?? 0)).toBe(viewport?.height);

  // One header button opens the bot's screen over the thread; Escape closes it.
  const openPanel = page.getByRole("button", { name: "Screen" });
  await expect(openPanel).toHaveAttribute("data-testid", "open-computer-panel");
  const panel = page.getByTestId("side-panel");
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(panel).toHaveCSS("width", "384px");
  await expect(openPanel).toHaveAttribute("aria-pressed", "true");
  // The thread re-flows beside the panel, so the header button stays reachable.
  await expect(openPanel).toBeVisible();
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await openPanel.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await expect(openPanel).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await captureScreenshot(page, testInfo, "quiet-shell-light");

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(settings).toBeVisible();
  await settings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
  await captureScreenshot(page, testInfo, "quiet-shell-dark");
});

/** Reduce Transparency turns every material into its opaque slot; the ambient light stays. */
test("Reduce Transparency makes the glass opaque", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signup(page, uniqueEmail("quiet-opaque"), "password12", "Quiet Opaque");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const pane = page.getByTestId("bots-sidebar-pane");
  const composer = page.getByTestId("composer-bar");
  await expect(pane).toHaveCSS("background-color", "rgba(255, 255, 255, 0.58)");
  await expect(composer).toHaveCSS("background-color", "rgba(255, 255, 255, 0.5)");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-transparency", value: "reduce" },
    ],
  });
  await expect(pane).toHaveCSS("background-color", "rgb(245, 245, 247)");
  await expect(pane).toHaveCSS("backdrop-filter", "none");
  await expect(composer).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.getByTestId("shell-root")).toHaveCSS("background-image", /radial-gradient/);
});

/** Below `lg` the panel is full width over the thread, so the covered column must
 * stop being tabbable; above `lg` it reflows beside the panel and stays live. */
test("an open panel makes the conversation column inert below lg, not above", async ({ page }) => {
  await signup(page, uniqueEmail("quiet-panel-inert"), "password12", "Quiet Panel Inert");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  const column = page.getByTestId("conversation-column");
  const panel = page.getByTestId("side-panel");

  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByTestId("open-computer-panel").click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(column).toHaveAttribute("aria-hidden", "true");
  await expect(column).toHaveJSProperty("inert", true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(column).not.toHaveAttribute("aria-hidden", "true");
  await expect(column).toHaveJSProperty("inert", false);
});

/** The header carries two icon toggles (screen + bot page) instead of a text
 * label. The bot page saves as you go, so it has no Save button, and its panel
 * widens for long text without covering the thread from `xl` up. */
test("header icons toggle the screen and the bot page; the page widens for long text", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("panel-header"), "password12", "Panel Header");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.setViewportSize({ width: 1440, height: 900 });

  const panel = page.getByTestId("side-panel");
  const computer = page.getByTestId("open-computer-panel");
  const settings = page.getByTestId("open-settings-panel");
  const column = page.getByTestId("conversation-column");

  // No verbose label: both controls are icon-only, named for screen readers.
  await expect(computer).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(computer).toHaveAccessibleName("Screen");
  await expect(settings).toHaveAccessibleName("Bot settings");

  // The gear opens the bot page and reads as pressed; the screen icon does not.
  const botPage = await openBotPage(page);
  await expect(settings).toHaveAttribute("aria-pressed", "true");
  await expect(computer).toHaveAttribute("aria-pressed", "false");
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(panel).toHaveCSS("width", "384px");
  await expect(botPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "bot-page-light");

  // Instructions open wide beside the thread; Escape brings the default width back.
  await openBotTab(page, "Settings");
  await botPage
    .getByTestId("bot-settings")
    .getByRole("button", { name: /^Instructions/ })
    .click();
  await expect(panel).toHaveAttribute("data-detail", "instructions");
  await expect(panel).toHaveAttribute("data-size", "wide");
  await expect(panel).toHaveCSS("width", "640px");
  await expect(column).not.toHaveAttribute("aria-hidden", "true");
  await captureScreenshot(page, testInfo, "bot-page-instructions-wide");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(panel).toHaveCSS("width", "384px");

  // Below `xl` the wide panel lies over the thread, which stops being reachable.
  await page.setViewportSize({ width: 1100, height: 800 });
  await botPage
    .getByTestId("bot-settings")
    .getByRole("button", { name: /^Instructions/ })
    .click();
  await expect(panel).toHaveAttribute("data-size", "wide");
  await expect(column).toHaveJSProperty("inert", true);
  await page.keyboard.press("Escape");
  await expect(column).toHaveJSProperty("inert", false);
  await page.setViewportSize({ width: 1440, height: 900 });

  // The two icons switch panels between themselves; no in-panel gear is needed.
  await computer.click();
  await expect(panel).toHaveAttribute("data-panel", "computer");
  await expect(computer).toHaveAttribute("aria-pressed", "true");
  await expect(settings).toHaveAttribute("aria-pressed", "false");
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "bot");
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "closed");

  // At phone width the page covers the thread and returns to it from its own back button.
  await page.setViewportSize({ width: 375, height: 720 });
  await settings.click();
  await expect(panel).toHaveAttribute("data-panel", "bot");
  await expect(botPage.getByRole("button", { name: "Chat", exact: true })).toBeInViewport();
  await captureScreenshot(page, testInfo, "bot-page-mobile");
});
