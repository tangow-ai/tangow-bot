import {
  activeBotId,
  addRoutineTrigger,
  captureScreenshot,
  completeOnboarding,
  createRoutine,
  openBotPage,
  openRoutineCreate,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";
import { expect, type Page, test } from "./test";

function sidebarBotButton(page: Page, name: RegExp | string) {
  return page.locator("[data-sidebar-group] [data-roster-bot-id]").filter({
    has: page.locator("[data-roster-bot-name]").filter({ hasText: name }),
  });
}

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }, testInfo) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@tangow.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Chief").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@tangow.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Chief").first()).toBeVisible();
  await expect(pageB.getByText("Ada", { exact: true })).toHaveCount(0);

  const composer = pageA.getByPlaceholder(/Message/);
  await composer.fill("write a file in your home called notes/result.txt that says isolation-ok");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();
  await captureScreenshot(pageA, testInfo, "07-durable-bot-work");

  await a.close();
  await b.close();
});

test("takeover, routine, plugins, and export are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@tangow.test`, "password12", "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/handing you the computer|sign in to continue|protected input/i).first(),
  ).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  await captureScreenshot(page, testInfo, "08-protected-input-request");
  await page.getByTestId("open-computer-panel").click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel).toHaveCSS("width", "384px");
  // The panel lies over the thread: it ends at the viewport edge and overlaps main.
  const [mainBox, panelBox] = await Promise.all([
    page.locator("main").boundingBox(),
    sidePanel.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeCloseTo(viewportWidth, 0);
  expect(panelBox?.x ?? 0).toBeLessThan((mainBox?.x ?? 0) + (mainBox?.width ?? 0));
  await sidePanel.getByTestId("computer-preview").hover();
  await sidePanel.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByTestId("computer-take-control").click();
  await expect(page.getByRole("button", { name: "Skip", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "I’m done", exact: true }).last()).toBeVisible();
  await captureScreenshot(page, testInfo, "09-computer-takeover-outcomes");
  await page.getByRole("button", { name: "I’m done", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });

  await composer.fill("sign in again so I can skip this time");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the second protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  // The live Needs you card opens the screen in one click, without the side panel.
  const openFromCard = page.getByTestId("takeover-open-computer");
  await expect(openFromCard).toHaveCount(1, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-card");
  const screenRequested = page.waitForRequest("**/rpc/computer/screenUrl");
  await openFromCard.click();
  await screenRequested;
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.locator('iframe[title="Bot screen"]')).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/login was skipped/i).last()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-skipped");

  await openRoutineCreate(page);
  const routinePanel = page.getByTestId("side-panel");
  await routinePanel.getByLabel("Name", { exact: true }).fill("Monday briefing");
  await routinePanel
    .getByLabel("Instruction")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await addRoutineTrigger(page, { schedule: "Every day" });
  await createRoutine(page);
  await routinePanel.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await captureScreenshot(page, testInfo, "10-routine-created");

  await page.getByTestId("open-customize").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  const featured = page.getByTestId("featured-connectors");
  await expect(featured).toContainText(
    /Gmail[\s\S]*Google Calendar[\s\S]*Google Drive[\s\S]*Slack[\s\S]*Notion/,
  );
  await expect(page.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Featured", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "All integrations", exact: true })).toBeVisible();
  const installed = page.getByTestId("installed-integrations");
  await expect(installed).toContainText("Installed integrations");
  await expect(installed.getByRole("button", { name: "Added", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add Executor", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add Treg", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Add MCP server", exact: true })).toBeHidden();
  await expect(page.getByText("Tool sources", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "11-plugins-catalog");

  // Nearest ancestor with an Add/Added control (featured tile or catalog row).
  const gmailRow = featured
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await gmailRow.getByRole("button", { name: "Add", exact: true }).click();
  await expect(gmailRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await expect(page.getByTestId("connection-tile-gmail")).toBeVisible();
  // Installed section is collapsed by default and lists only connected apps once opened.
  await installed.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(installed.getByText("Gmail", { exact: true })).toBeVisible();
  await expect(installed.getByRole("button", { name: "Added", exact: true })).toHaveCount(1);
  // Collapsed again so later catalog lookups stay unambiguous.
  await installed.evaluate((element) => {
    (element as HTMLDetailsElement).open = false;
  });
  await captureScreenshot(page, testInfo, "11a-connected-plugins");

  await gmailRow.getByRole("button", { name: "Added", exact: true }).click();
  const detail = page.getByTestId("connection-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("connection-accounts")).toBeVisible();
  await expect(page.getByTestId("connection-tools")).toBeVisible();

  await detail.getByRole("button", { name: "Add another", exact: true }).click();
  await expect(detail.getByLabel("Account label")).toHaveCount(2);
  await detail.getByLabel("Account label").nth(1).fill("Work");
  const renamed = page.waitForResponse(
    (response) => response.url().includes("connections/rename") && response.ok(),
  );
  await detail.getByLabel("Account label").nth(1).blur();
  await renamed;
  await expect(detail.getByLabel("Account label").nth(1)).toHaveValue("Work");
  await captureScreenshot(page, testInfo, "11a2-multi-account-plugins");

  await page.getByRole("button", { name: "Close integrations" }).click();
  await page.getByTestId("open-customize").click();
  await expect(page.getByPlaceholder("Search apps")).toBeVisible();
  const gmailTileAgain = page.getByTestId("connection-tile-gmail");
  await expect(gmailTileAgain.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await gmailTileAgain.click();
  const detailAgain = page.getByTestId("connection-detail");
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(2);
  await expect(detailAgain.getByLabel("Account label").nth(1)).toHaveValue("Work");

  await detailAgain.getByRole("button", { name: "Remove", exact: true }).last().click();
  await expect(detailAgain.getByLabel("Account label")).toHaveCount(1);
  await detailAgain.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  const gmailRowEmpty = page
    .getByTestId("featured-connectors")
    .getByText("Gmail", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await expect(gmailRowEmpty.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  await installed.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(installed.getByText("No integrations installed yet.")).toBeVisible();
  await installed.evaluate((element) => {
    (element as HTMLDetailsElement).open = false;
  });
  await captureScreenshot(page, testInfo, "11b-connected-plugins-empty");

  const githubRow = page
    .getByText("GitHub", { exact: true })
    .locator("xpath=ancestor::*[.//button][1]");
  await githubRow.getByRole("button", { name: "Add", exact: true }).click();
  await expect(githubRow.getByRole("button", { name: "Added", exact: true })).toBeVisible();
  await githubRow.getByRole("button", { name: "Added", exact: true }).click();
  const githubDetail = page.getByTestId("connection-detail");
  await expect(githubDetail).toBeVisible();
  await githubDetail.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(page.getByTestId("connection-detail")).toHaveCount(0);
  await expect(githubRow.getByRole("button", { name: "Add", exact: true })).toBeVisible();

  await expect(page.getByTestId("integrations-advanced")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "integrations-desktop");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "integrations-phone");
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  await page.getByRole("button", { name: "Close integrations" }).click();

  await page.getByText("Chief").first().click();
  const botPage = await openBotPage(page);
  // Lifecycle actions live in the page's menu, not as buttons on the page.
  await expect(botPage.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(botPage.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await botPage.getByRole("button", { name: "Actions for Chief" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/chief-export\.json/i);
  await page.getByRole("button", { name: "Close panel" }).click();

  await page.locator("aside").first().getByRole("button", { name: /Chief/ }).first().click({
    button: "right",
  });
  const botMenu = page.getByRole("menu", { name: "Actions for Chief" });
  await expect(botMenu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  await botMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("radio", { name: /Keep memories/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Delete memories too/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await captureScreenshot(page, testInfo, "12-bot-settings");
});

test("sign-in, spawn, and stop work in the shell", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });
  const stamp = Date.now();
  const email = `shell-${stamp}@tangow.test`;
  await signup(page, email, "password12", "Shell");
  await completeOnboarding(page);
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Create bot", exact: true }).click({ timeout: 30_000 });
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible({
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "13-spawned-bot");

  await page
    .locator("[data-sidebar-group]")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("composer-steering-status")).toHaveCount(0);
  await expect(page.getByText("Messages sent now guide the next turn.")).toHaveCount(0);
  await expect(page.getByText(/^Steer /)).toHaveCount(0);
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  // The Send icon only appears once there is a draft to send.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await composer.fill("Use the newer report and keep the answer short.");
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByTestId("composer-bar").getByRole("button", { name: "Attach file", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(composer).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByTestId("composer-bar").getByRole("button", { name: "Dictate", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Use the newer report and keep the answer short."),
  ).toBeVisible();
  // The transcript opens a stretch of conversation with a day/time marker.
  await expect(page.getByTestId("transcript").locator("time").first()).toHaveText(
    /^Today \d{1,2}:\d{2}/,
  );
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "14-active-bot-work");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await captureScreenshot(page, testInfo, "14-active-bot-work-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  let releaseStopRequest: () => void = () => undefined;
  let markStopRequestStarted: () => void = () => undefined;
  const stopRequestStarted = new Promise<void>((resolve) => {
    markStopRequestStarted = resolve;
  });
  await page.route("**/rpc/threads/stop", async (route) => {
    markStopRequestStarted();
    await new Promise<void>((release) => {
      releaseStopRequest = release;
    });
    await route.continue();
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await stopRequestStarted;
  // The Send icon stays hidden with an empty draft; only Stop is left to go disabled.
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  releaseStopRequest();
  // Idle Send stays hidden with an empty draft; wait for Stop to leave instead.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(sidebarBotButton(page, /^Chief/)).toBeVisible();
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible();
  await captureScreenshot(page, testInfo, "15-restored-session");
});

test("bot context menu pins, duplicates, edits, and confirms deletion", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `menu-${stamp}@tangow.test`, "password12", "Menu");
  await completeOnboarding(page);

  const chief = page.getByRole("button", { name: /Chief/ }).first();
  await chief.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions for Chief" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Bot settings" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await captureScreenshot(page, testInfo, "16-bot-context-menu");
  await page.getByRole("menuitem", { name: "Mark as Unread" }).click();

  // Chief is the open bot, so the auto-read on window focus must not undo the manual mark.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Mark as Read" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Read" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Chief copy").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "17-pinned-and-duplicated-bot");

  const copy = page.getByRole("button", { name: /Chief copy/ }).first();
  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Chief copy?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "18-delete-confirmation");
  await page.getByRole("button", { name: "Cancel" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bot settings" }).click();
  await expect(page.getByTestId("bot-page").getByLabel("Name", { exact: true })).toHaveValue(
    "Chief",
  );
  await captureScreenshot(page, testInfo, "19-edit-profile");
});

async function threadRunStatus(page: Page) {
  const result = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
    botId: activeBotId(page),
  });
  return result.run?.status ?? "idle";
}
