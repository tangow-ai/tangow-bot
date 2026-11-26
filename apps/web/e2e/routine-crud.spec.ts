import type { Bot, Routine } from "@tangow/contracts";
import {
  activeBotId,
  addRoutineTrigger,
  captureScreenshot,
  completeOnboarding,
  createRoutine,
  openRoutineCreate,
  openRoutines,
  rpc,
  saveRoutineField,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Locator, test } from "./test";

test("a new routine starts active and silent, and its switches answer the keyboard", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("routine-toggle"), "password12", "Routine Toggle");
  await completeOnboarding(page);
  await openRoutineCreate(page);

  const active = page.getByRole("switch", { name: "Active" });
  const notify = page.getByRole("switch", { name: "Notify me" });
  // Off by default: the routine stays a silent, browsable trace until the user opts in.
  await expect(active).toBeChecked();
  await expect(notify).not.toBeChecked();
  // The thumb sits inside the track, at mirrored insets on and off.
  const off = await thumbInsets(notify);
  expect(off.left).toBeGreaterThanOrEqual(0);
  expect(off.right).toBeGreaterThan(off.left);
  const expectThumb = async (toggle: Locator, on: boolean) => {
    const insets = await thumbInsets(toggle);
    expect(insets.left).toBeCloseTo(on ? off.right : off.left, 1);
    expect(insets.right).toBeCloseTo(on ? off.left : off.right, 1);
  };
  await expectThumb(active, true);
  await captureScreenshot(page, testInfo, "routine-create-switches");

  await active.click();
  await expect(active).not.toBeChecked();
  await expectThumb(active, false);
  await notify.focus();
  await page.keyboard.press("Space");
  await expect(notify).toBeChecked();
  await expectThumb(notify, true);
  // The focus ring is a box shadow (`focus-visible:ring`), not an outline.
  expect(await notify.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notify).toBeVisible();
  await expectThumb(notify, true);
  await notify.click();
  await expectThumb(notify, false);
  await active.click();
  await expectThumb(active, true);
  await captureScreenshot(page, testInfo, "routine-create-switches-mobile");
});

/** How far the switch's thumb sits from each end of its track, once it stops moving. */
async function thumbInsets(toggle: Locator) {
  const thumb = toggle.locator('[data-slot="switch-thumb"]');
  await thumb.evaluate((element) =>
    Promise.all(element.getAnimations().map(({ finished }) => finished)),
  );
  const [track, knob] = await Promise.all([toggle.boundingBox(), thumb.boundingBox()]);
  expect(track).not.toBeNull();
  expect(knob).not.toBeNull();
  return {
    left: knob!.x - track!.x,
    right: track!.x + track!.width - knob!.x - knob!.width,
  };
}

test("routine editing updates in place, preserves timezone, and deletion persists", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("routine-crud"), "password12", "Routine CRUD");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const created = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Tokyo check-in",
    prompt: "Send the original update",
    crons: ["0 9 * * *"],
    timezone: "Asia/Tokyo",
    active: true,
    notify: true,
  });
  expect(created.nextRunAt).not.toBeNull();
  expect(localSchedule(created.nextRunAt!, created.timezone)).toMatchObject({ hour: 9, minute: 0 });
  await page.reload();
  await openRoutines(page);

  const panel = page.getByTestId("side-panel");
  await page.getByRole("button", { name: /Tokyo check-in/ }).click();
  await expect(panel).toHaveAttribute("data-size", "wide");
  await saveRoutineField(page, panel.getByLabel("Name", { exact: true }), "Weekday check-in");
  await saveRoutineField(page, panel.getByLabel("Instruction"), "Send the revised update");
  await panel.getByRole("button", { name: /^On a schedule/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("How often").selectOption("Weekdays");
  const scheduled = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await scheduled;
  await expect(editor).toHaveCount(0);
  await panel.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");

  const updatedButton = page.getByRole("button", { name: /Weekday check-in/ });
  await expect(updatedButton).toHaveCount(1);
  await expect(updatedButton).toContainText("Weekdays at 9:00 AM");
  await expect(page.getByRole("button", { name: /Tokyo check-in/ })).toHaveCount(0);

  const [updated] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(updated).toMatchObject({
    name: "Weekday check-in",
    prompt: "Send the revised update",
    crons: ["0 9 * * 1-5"],
    timezone: "Asia/Tokyo",
  });
  expect(updated?.nextRunAt).not.toBeNull();
  expect(["Mon", "Tue", "Wed", "Thu", "Fri"]).toContain(
    localSchedule(updated!.nextRunAt!, updated!.timezone).weekday,
  );
  await captureScreenshot(page, testInfo, "routine-weekday-schedule");

  await updatedButton.click();
  await panel.getByRole("button", { name: "Delete routine", exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "Delete Weekday check-in?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Weekday check-in");

  await panel.getByRole("button", { name: "Delete routine", exact: true }).click();
  const removeResponse = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/remove") && response.ok(),
  );
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await removeResponse;
  await expect(panel).not.toHaveAttribute("data-detail", /./);
  await expect(updatedButton).toHaveCount(0);
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);

  // The deleted routine stays gone after a reload.
  await page.reload();
  await openRoutines(page);
  await expect(updatedButton).toHaveCount(0);
});

test("a deep link opens the routine in the bot page", async ({ page }) => {
  await signup(page, uniqueEmail("routine-link"), "password12", "Routine Link");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const routine = await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Linked routine",
    prompt: "Check in",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
  });

  await page.goto(`/app/${botId}?routine=${routine.id}`);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel", "bot");
  await expect(panel).toHaveAttribute("data-detail", "routine");
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Linked routine");
});

test("removing the last trigger is refused, an inbound one is confirmed first", async ({
  page,
}) => {
  await signup(page, uniqueEmail("routine-trigger"), "password12", "Routine Trigger");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Hooked",
    prompt: "Check in",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    webhookEnabled: true,
  });
  await page.reload();
  await openRoutines(page);
  await page.getByRole("button", { name: /Hooked/ }).click();
  const panel = page.getByTestId("side-panel");
  const editor = page.getByRole("dialog");

  await panel.getByRole("button", { name: /^When a webhook fires/ }).click();
  await editor.getByRole("button", { name: "Remove", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove webhook?" });
  const removed = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/update") && response.ok(),
  );
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await removed;
  await expect(panel.getByRole("button", { name: /^When a webhook fires/ })).toHaveCount(0);

  await panel.getByRole("button", { name: /^On a schedule/ }).click();
  await editor.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText(
    "Add a schedule, webhook, GitHub, or message trigger",
  );
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({ crons: ["0 9 * * *"], webhookEnabled: false });
});

test("invalid advanced cron is rejected without creating a routine", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("routine-invalid"), "password12", "Invalid Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openRoutineCreate(page);
  const panel = page.getByTestId("side-panel");
  await panel.getByLabel("Name", { exact: true }).fill("Broken schedule");
  await panel.getByLabel("Instruction").fill("This should never run");
  await addRoutineTrigger(page, { schedule: "Advanced...", cron: "61 25 * * *" });
  await panel.getByRole("button", { name: "Create", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText("Enter a valid cron expression.");
  await expect(panel).toHaveAttribute("data-detail", "routine-new");
  expect(await rpc<Routine[]>(page, "routines/list", { botId })).toEqual([]);
  await captureScreenshot(page, testInfo, "invalid-cron-rejected");
});

test("a created routine opens in its own page", async ({ page }) => {
  await signup(page, uniqueEmail("routine-refresh"), "password12", "Routine Refresh");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openRoutineCreate(page);
  const panel = page.getByTestId("side-panel");
  await panel.getByLabel("Name", { exact: true }).fill("Persisted routine");
  await panel.getByLabel("Instruction").fill("Run once each morning");
  await addRoutineTrigger(page, { schedule: "Every day" });
  await createRoutine(page);
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("Persisted routine");
  await expect(page.getByRole("alert")).toHaveCount(0);

  const routines = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routines).toHaveLength(1);
  expect(routines[0]?.name).toBe("Persisted routine");
});

test("switching bots while a routine save is pending does not reopen stale state", async ({
  page,
}) => {
  await signup(page, uniqueEmail("routine-switch"), "password12", "Routine Switch");
  await completeOnboarding(page);
  const firstBotId = activeBotId(page);
  const secondBot = await rpc<Bot>(page, "bots/create", {
    name: "Second",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await Promise.all([
    rpc<Routine>(page, "routines/create", {
      botId: firstBotId,
      name: "First routine",
      prompt: "First prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
    rpc<Routine>(page, "routines/create", {
      botId: secondBot.id,
      name: "Second routine",
      prompt: "Second prompt",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
      notify: true,
    }),
  ]);
  await page.reload();

  await openRoutines(page);
  await page.getByRole("button", { name: /First routine/ }).click();
  const name = page.getByTestId("side-panel").getByLabel("Name", { exact: true });
  await name.fill("First routine updated");

  let releaseUpdate!: () => void;
  let sawUpdate!: () => void;
  const updateReleased = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const updateIntercepted = new Promise<void>((resolve) => {
    sawUpdate = resolve;
  });
  await page.route(
    "**/rpc/routines/update",
    async (route) => {
      sawUpdate();
      await updateReleased;
      await route.fulfill({ status: 500, body: "save failed" });
    },
    { times: 1 },
  );
  const updateResponse = page.waitForResponse((response) =>
    response.url().includes("/rpc/routines/update"),
  );

  await name.blur();
  await updateIntercepted;
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Second/ })
    .click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  releaseUpdate();
  await updateResponse;
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("alert")).toHaveCount(0);

  await openRoutines(page);
  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);

  let releaseStaleList!: () => void;
  let sawStaleList!: () => void;
  const staleListReleased = new Promise<void>((resolve) => {
    releaseStaleList = resolve;
  });
  const staleListIntercepted = new Promise<void>((resolve) => {
    sawStaleList = resolve;
  });
  await page.route("**/rpc/routines/list", async (route) => {
    if (route.request().postData()?.includes(firstBotId) !== true) {
      await route.continue();
      return;
    }
    sawStaleList();
    await staleListReleased;
    await route.continue();
  });
  const staleListResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/routines/list") &&
      response.request().postData()?.includes(firstBotId) === true,
  );

  const botList = page.locator("aside").first();
  await botList.getByRole("button", { name: /^Chief/ }).click();
  await staleListIntercepted;
  await botList.getByRole("button", { name: /^Second/ }).click();
  await page.waitForURL(new RegExp(`/app/${secondBot.id}$`));
  releaseStaleList();
  await staleListResponse;
  await page.unroute("**/rpc/routines/list");

  await expect(page.getByRole("button", { name: /Second routine/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /First routine/ })).toHaveCount(0);
});

function localSchedule(iso: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
  };
}
