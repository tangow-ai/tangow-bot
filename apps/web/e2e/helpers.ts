import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { SettingsSection } from "../src/pages/settings-sections";

export function isRealSandboxProvider(provider = process.env.SANDBOX_PROVIDER) {
  return provider === "e2b";
}

export function realSandboxTimeout(real: number, emulated: number) {
  return isRealSandboxProvider() ? real : emulated;
}

export function activeBotId(page: Page) {
  const id = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  if (!id || id === "app") throw new Error(`missing bot id in ${page.url()}`);
  return id;
}

export async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  const parsed = (await response.json()) as { json?: T; error?: { message?: string } };
  if (!response.ok() || parsed.error) {
    throw new Error(`${procedure} ${response.status()}: ${parsed.error?.message ?? "failed"}`);
  }
  return parsed.json as T;
}

/** The link of a Space invite for `email`, made by the signed-in owner on `page`. */
export async function inviteToSpace(page: Page, spaceId: string, email: string): Promise<string> {
  const { invitations } = await rpc<{ invitations: Array<{ url: string }> }>(
    page,
    "spaces/createInvite",
    { spaceId, emails: [email] },
  );
  return invitations[0]!.url;
}

export async function completeOnboarding(page: Page, testInfo?: TestInfo) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  // Optional Server integrations step (needsSetup). Skip when shown, then the
  // first bot is created automatically — land in Chief's chat with no form.
  const integrations = page.getByRole("heading", { name: "Server integrations", exact: true });
  // Visible only: at phone width the roster is its own page, so its "Chief" row
  // is hidden behind the chat and the header carries the name instead.
  const chief = page.getByText("Chief").filter({ visible: true }).first();
  await integrations.or(chief).or(page.getByText("Opening chat…")).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) {
    if (testInfo) {
      await captureScreenshot(page, testInfo, "03-create-first-bot");
      await captureScreenshot(page, testInfo, "06-onboarding-complete");
    }
    return;
  }
  if (await integrations.isVisible().catch(() => false)) {
    if (testInfo) await captureScreenshot(page, testInfo, "02-connect-apps");
    await page.getByRole("button", { name: "Skip", exact: true }).click();
  }
  await page.waitForURL(/\/app\//, { timeout: 20_000 });
  await expect(chief).toBeVisible();
  if (testInfo) {
    await captureScreenshot(page, testInfo, "03-create-first-bot");
    await captureScreenshot(page, testInfo, "06-onboarding-complete");
  }
}

export async function signup(
  page: Page,
  email: string,
  password: string,
  name: string,
  testInfo?: TestInfo,
) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Grab some clay." })).toBeVisible();
  if (testInfo) await captureScreenshot(page, testInfo, "01-sign-up");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

export async function captureScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: screenshotPath,
  });
  await testInfo.attach(name, { contentType: "image/png", path: screenshotPath });
}

export async function openNewBot(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-bot").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-form")).toBeVisible();
}

export async function openNewGroup(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-group").click();
}

export async function openNewSpace(page: Page) {
  await page.getByTestId("create-menu-trigger").click();
  await page.getByTestId("create-new-space").click();
}

/** Open the create form from the + picker, submit, and wait for the new chat. */
export async function createBotFromPicker(
  page: Page,
  options: {
    name?: string;
    title?: string;
    description?: string;
    computerMode?: "team" | "dedicated";
  } = {},
) {
  const name = options.name ?? "New Bot";
  await openNewBot(page);
  const form = page.getByTestId("create-bot-form");
  await form.locator("label:has-text('Name') input").fill(name);
  if (options.title != null) {
    await form.locator("label:has-text('Title') input").fill(options.title);
  }
  if (options.description != null) {
    await form.locator("label:has-text('Description') textarea").fill(options.description);
  }
  if (options.computerMode === "dedicated") {
    await form.getByTestId("create-bot-private").click();
  } else if (options.computerMode === "team") {
    await form.getByTestId("create-bot-team").click();
  }
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
}

export type BotTab = "Activity" | "Routines" | "Knowledge" | "Settings";

/** Open the open bot's page, once its routines are read. */
export async function openBotPage(page: Page) {
  const panel = page.getByTestId("side-panel");
  if ((await panel.getAttribute("data-panel")) !== "bot") {
    await page.getByTestId("open-settings-panel").click();
  }
  await expect(panel).toHaveAttribute("data-panel", "bot");
  const botPage = panel.getByTestId("bot-page");
  await expect(botPage).toBeVisible();
  await expect(botPage).not.toHaveAttribute("aria-busy", "true");
  return botPage;
}

/** Fill a bot setting, leave the field, and wait for its autosave. */
export async function saveField(page: Page, field: Locator, value: string) {
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await field.fill(value);
  await field.blur();
  await saved;
}

/** Open one tab of the bot page. */
export async function openBotTab(page: Page, tab: BotTab) {
  const botPage = await openBotPage(page);
  const trigger = botPage.getByRole("tab", { name: tab, exact: true });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-selected", "true");
  return botPage;
}

/** The Settings tab of the open bot's page. */
export async function openBotSettings(page: Page) {
  const botPage = await openBotTab(page, "Settings");
  return botPage.getByTestId("bot-settings");
}

/** The open bot's routine list. */
export async function openRoutines(page: Page) {
  return openBotTab(page, "Routines");
}

/**
 * The form for a new routine, from "New routine" on the Routines tab. The button and the tab
 * are found by test id, so this works in any interface language.
 */
export async function openRoutineCreate(page: Page) {
  const botPage = await openBotPage(page);
  const add = botPage.getByTestId("routine-create-button");
  if (!(await add.isVisible())) await botPage.getByTestId("bot-tab-routines").click();
  await add.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-detail", "routine-new");
}

export type RoutineTrigger =
  | { schedule: string; cron?: string }
  | "Slack message"
  | "Git event"
  | "Webhook";

/** Pick a trigger from "Add trigger" and confirm its editor with Done. */
export async function addRoutineTrigger(page: Page, trigger: RoutineTrigger) {
  await page.getByRole("button", { name: "Add trigger" }).click();
  if (typeof trigger === "string") {
    await page.getByRole("menuitem", { name: trigger, exact: true }).click();
  } else {
    await page.getByRole("menuitem", { name: "On a schedule" }).hover();
    await page.getByRole("menuitem", { name: trigger.schedule, exact: true }).click();
  }
  const editor = page.getByRole("dialog");
  if (typeof trigger !== "string" && trigger.cron !== undefined) {
    await editor.getByLabel("Cron expression").fill(trigger.cron);
  }
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

/** Create the routine being written and wait for it to open in its own page. */
export async function createRoutine(page: Page) {
  const created = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page
    .getByTestId("routine-create")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await created;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-detail", "routine");
}

/** Leave a routine field and wait for its autosave. */
export async function saveRoutineField(page: Page, field: Locator, value: string) {
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );
  await field.fill(value);
  await field.blur();
  await saved;
}

/** Open the user Settings overlay, optionally on a section: from the nav, or from the list on a phone. */
export async function openUserSettings(page: Page, section?: SettingsSection) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  if (section) {
    const nav = settings.getByTestId(`settings-nav-${section}`);
    const entry = (await nav.count()) > 0 ? nav : settings.getByTestId(`settings-list-${section}`);
    await entry.click();
  }
  return settings;
}

/** Create a named bot via RPC for test setup (skips the + picker). */
export async function createNamedBot(
  page: Page,
  name: string,
  options: { computerMode?: "team" | "dedicated" } = {},
) {
  const bot = await rpc<{ id: string; name: string }>(page, "bots/create", {
    name,
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: options.computerMode ?? "team",
  });
  await page.goto(`/app/${bot.id}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
  return bot.id;
}
