// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const FIXTURE = "/e2e/fixtures/bot-page.html";
const DOTS = "••••••••••••••••";

const STATES: Array<{ name: string; query: string; trigger?: RegExp }> = [
  { name: "settings", query: "tab=settings" },
  { name: "activity", query: "tab=activity" },
  { name: "activity-new", query: "tab=activity&new=1" },
  { name: "activity-empty", query: "tab=activity&activity=empty" },
  { name: "activity-error", query: "tab=activity&activity=error" },
  { name: "activity-debug", query: "tab=activity&debug=1" },
  { name: "routines", query: "tab=routines" },
  { name: "routines-error", query: "tab=routines&read=error" },
  { name: "routine", query: "tab=routines&detail=routine&routine=routine-2" },
  {
    name: "routine-trigger",
    query: "tab=routines&detail=routine&routine=routine-2",
    trigger: /^On a schedule/,
  },
  { name: "routine-new", query: "tab=routines&detail=routine-new" },
  { name: "knowledge", query: "tab=knowledge" },
  { name: "memory", query: "tab=knowledge&detail=memory" },
  { name: "skill", query: "tab=knowledge&detail=skill" },
  { name: "instructions", query: "tab=settings&detail=instructions" },
  { name: "description", query: "tab=settings&detail=description" },
  { name: "model", query: "tab=settings&detail=model" },
  { name: "voice", query: "tab=settings&detail=voice" },
  { name: "busy", query: "tab=settings&busy=1" },
];

for (const theme of ["light", "dark"] as const) {
  for (const state of STATES) {
    test(`bot page ${state.name}, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${FIXTURE}?${state.query}&theme=${theme}`);
      const botPage = page.getByTestId("bot-page");
      await expect(botPage).toBeVisible();
      await expect(botPage).not.toHaveAttribute("aria-busy", "true");
      await expect(botPage.locator('[aria-busy="true"]')).toHaveCount(0);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (state.name === "knowledge") {
        await expect(page.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
      }
      if (state.name === "memory" || state.name === "skill") {
        await expect(botPage.locator("textarea")).not.toHaveValue("");
      }
      if (state.trigger) {
        await page.getByRole("button", { name: state.trigger }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
      }
      await captureScreenshot(page, testInfo, `bot-page-${state.name}-${theme}`);
    });
  }
}

const HERO_VIEWPORTS = [
  { name: "default", size: null },
  { name: "phone", size: { width: 390, height: 844 } },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const viewport of HERO_VIEWPORTS) {
    test(`the hero shows the clay character alive and its picker, ${viewport.name}, ${theme}`, async ({
      page,
    }, testInfo) => {
      if (viewport.size) await page.setViewportSize(viewport.size);
      // Still, so the capture shows the face at rest, as the still image draws it.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${FIXTURE}?tab=settings&theme=${theme}`);
      await expect(
        page.getByTestId("bot-appearance-trigger").locator(".tangow-clay-face"),
      ).toBeVisible();
      await captureScreenshot(page, testInfo, `bot-page-hero-${viewport.name}-${theme}`);

      await page.getByTestId("bot-appearance-trigger").click();
      const picker = page.getByTestId("bot-appearance-picker");
      await picker.getByRole("button", { name: "Ragnarrot" }).click();
      await expect(picker.getByRole("button", { name: "Ragnarrot" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect
        .poll(() =>
          picker
            .locator("img")
            .evaluateAll((images: HTMLImageElement[]) =>
              images.every((image) => image.naturalWidth > 0),
            ),
        )
        .toBe(true);
      await expect(page.getByTestId("bot-page").getByText(/^Saved/)).toBeVisible();
      // Playwright scrolled the panel to reach the tile; the capture shows the hero.
      await page.getByTestId("bot-appearance-trigger").evaluate((trigger) => {
        for (let node = trigger.parentElement; node; node = node.parentElement) node.scrollTop = 0;
      });
      await captureScreenshot(page, testInfo, `bot-page-picker-${viewport.name}-${theme}`);
    });
  }
}

test("the tabs are one tab stop, moved with the arrow keys", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=activity`);
  const tabs = page.getByRole("tablist");
  await expect(tabs.getByRole("tab")).toHaveText(["Activity", "Routines", "Knowledge", "Settings"]);
  await tabs.getByRole("tab", { name: "Activity, last run failed" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Routines" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs.getByRole("tab", { name: "Routines" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("the routines show loading rows until the page's read answers", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines&read=loading`);
  const botPage = page.getByTestId("bot-page");
  await expect(botPage).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("tabpanel").locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByRole("tabpanel")).toHaveText("");
});

test("a first read that fails says Could not load, and Retry reads again", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines&detail=routine&routine=routine-2&read=error`);
  const botPage = page.getByTestId("bot-page");
  await expect(botPage.getByText("Could not load · Retry")).toBeVisible();
  await expect(botPage).not.toHaveAttribute("aria-busy", "true");

  await page.getByTestId("fixture-fail-reads").uncheck();
  await botPage.getByRole("button", { name: "Retry" }).click();
  await expect(botPage.getByLabel("Name", { exact: true })).toHaveValue("Weekly digest");
  await botPage.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(botPage.getByText("Morning digest")).toBeVisible();
});

test("a new bot offers its first instructions under its creation on Activity", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=activity&new=1`);
  const botPage = page.getByTestId("bot-page");
  const created = page.getByTestId("activity-created");
  await expect(created.getByText("Scout created")).toBeVisible();
  await created.getByRole("button", { name: "Write its first instructions" }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-size", "wide");
  await page.getByTestId("bot-instructions").fill("Close the books every first Monday.");
  await botPage.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(created.getByText("Scout created")).toBeVisible();
  await expect(created.getByRole("button")).toHaveCount(0);
});

test("Activity lists routine runs and creations, pages back, and opens a recap in place", async ({
  page,
}) => {
  const opened: string[] = [];
  page.on("console", (message) => opened.push(message.text()));
  await page.goto(`${FIXTURE}?tab=activity`);
  const activity = page.getByTestId("bot-activity");
  await expect(activity.getByRole("button", { name: /^Morning digest, Running/ })).toBeVisible();
  await expect(
    activity.getByRole("button", { name: /^Weekly digest, Model error, Failed/ }),
  ).toBeVisible();

  const run = activity.getByRole("button", { name: /^Invoice watch, Done/ }).first();
  await run.click();
  await expect(run).toHaveAttribute("aria-expanded", "true");
  const recap = activity.getByTestId("activity-recap");
  await expect(recap.locator("strong").first()).toHaveText("2 invoices");
  await recap.getByRole("button", { name: "Open in chat" }).click();
  expect(opened).toContain("open run from message-run-01");

  const failed = activity.getByRole("button", { name: /^Weekly digest, Model error, Failed/ });
  await failed.click();
  const failedRecap = activity.getByTestId("activity-recap").nth(1);
  await expect(failedRecap.getByRole("button", { name: "Open in chat" })).toBeVisible();
  await expect(failedRecap).not.toContainText("Model error");

  const folded = activity.getByRole("button", { name: /^Morning digest, 3 runs, Done/ }).first();
  await folded.click();
  await expect(folded).toHaveAttribute("aria-expanded", "true");
  const long = activity.getByRole("button", { name: /^Morning digest, Done/ }).first();
  await long.click();
  await expect(activity.getByRole("button", { name: "Show more" })).toBeVisible();
  await activity.getByRole("button", { name: "Show more" }).click();
  await expect(activity.getByText("The quarterly team lunch poll closes next week.")).toBeVisible();

  await activity.getByRole("button", { name: "Show earlier" }).click();
  await expect(activity.getByRole("button", { name: "Show earlier" })).toHaveCount(0);
  await expect(activity.getByText("Scout created")).toBeVisible();
  await activity.getByRole("button", { name: /^Invoice watch, Routine created by Scout/ }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-detail", "routine");
});

test("a routine's page lists only its own runs and opens one in place", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines&detail=routine&routine=routine-3`);
  const activity = page.getByTestId("routine-detail").getByTestId("bot-activity");
  // A routine's own page lists every run: no folded line to open first.
  await expect(activity.getByRole("button", { name: /8 runs/ })).toHaveCount(0);
  const runs = activity.getByTestId("activity-run");
  await expect(runs).toHaveText(Array.from({ length: 8 }, () => /^\d{1,2}:\d{2}/));
  await expect(activity.getByTestId("activity-created")).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "Show earlier" })).toHaveCount(0);

  await runs.first().click();
  await expect(activity.getByTestId("activity-recap").locator("strong").first()).toHaveText(
    "2 invoices",
  );
});

for (const theme of ["light", "dark"] as const) {
  test(`Activity with recaps open, ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${FIXTURE}?tab=activity&theme=${theme}`);
    const activity = page.getByTestId("bot-activity");
    await activity
      .getByRole("button", { name: /^Invoice watch, Done/ })
      .first()
      .click();
    await activity
      .getByRole("button", { name: /^Morning digest, 3 runs, Done/ })
      .first()
      .click();
    await activity
      .getByRole("button", { name: /^Morning digest, Done/ })
      .first()
      .click();
    await expect(activity.getByRole("button", { name: "Show more" })).toBeVisible();
    await captureScreenshot(page, testInfo, `bot-page-activity-open-${theme}`);
    await activity.getByRole("button", { name: "Show more" }).scrollIntoViewIfNeeded();
    await captureScreenshot(page, testInfo, `bot-page-activity-show-more-${theme}`);
  });
}

test("instructions save on blur, say so, and keep the text when a save fails", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&detail=instructions`);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-size", "wide");
  const field = page.getByTestId("bot-instructions");
  const meta = page.locator('[data-slot="save-meta"]').first();

  await field.fill("Flag invoices the moment they land.");
  await field.blur();
  await expect(meta).toHaveText("Saving…");
  await expect(meta).toHaveText(/^Saved \d/);

  await page.getByTestId("fixture-fail-saves").check();
  await field.fill("Flag invoices and contracts.");
  await field.blur();
  await expect(meta).toContainText("Could not save");
  await expect(field).toHaveValue("Flag invoices and contracts.");
  await page.getByTestId("fixture-fail-saves").uncheck();
  await meta.getByRole("button", { name: "Retry" }).click();
  await expect(meta).toHaveText(/^Saved \d/);

  // Retry leaves with its button, so Escape is pressed from the field again.
  await field.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-size", "default");
});

test("clearing the instructions asks first", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&detail=instructions`);
  const field = page.getByTestId("bot-instructions");
  await field.fill("");
  await field.blur();
  const dialog = page.getByRole("alertdialog", { name: "Clear instructions?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(field).not.toHaveValue("");
});

test("the computer cannot change while the bot works", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&busy=1`);
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByText("Available when Scout is idle")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Team", exact: true })).toBeDisabled();
});

test("a refused computer change turns back and says why", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&refuse=1`);
  const settings = page.getByTestId("bot-settings");
  const team = settings.getByRole("button", { name: "Team", exact: true });
  const own = settings.getByRole("button", { name: "Private", exact: true });
  await expect(own).toHaveAttribute("aria-pressed", "true");
  await team.click();
  await expect(
    settings.getByText("Wait for this bot to finish before changing its computer."),
  ).toBeVisible();
  await expect(own).toHaveAttribute("aria-pressed", "true");
});

test("Knowledge shows memory, the first five files and skills", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=knowledge`);
  const knowledge = page.getByTestId("bot-knowledge");
  await expect(knowledge.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
  const files = knowledge.getByTestId("bot-knowledge-files");
  await expect(files).toContainText("inbox-report.md");
  await expect(files).not.toContainText("vendors.csv");
  await files.getByRole("button", { name: "Show more" }).click();
  await expect(files).toContainText("vendors.csv");
  await files.getByRole("button", { name: "Show less" }).click();
  await expect(files).not.toContainText("vendors.csv");
  await files.getByRole("button", { name: "notes/" }).click();
  await expect(files).toContainText("vendors.csv");
  await expect(files.getByRole("button", { name: "Show more" })).toHaveCount(0);
  await expect(knowledge.getByTestId("bot-skills")).toContainText("inbox-triage");
});

test("a memory document and a skill open wide, and the tab comes back as it was", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?tab=knowledge`);
  const panel = page.getByTestId("side-panel");
  const files = page.getByTestId("bot-knowledge-files");
  await files.getByRole("button", { name: "notes/" }).click();
  await expect(files).toContainText("vendors.csv");
  const memoryRow = page.getByTestId("bot-knowledge-memory").getByRole("button", {
    name: /MEMORY\.md/,
  });
  await memoryRow.click();
  await expect(panel).toHaveAttribute("data-detail", "memory");
  await expect(panel).toHaveAttribute("data-size", "wide");
  await expect(panel.locator("textarea")).toHaveValue(/Counsel prefers a reply before 10:00/);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(memoryRow).toBeFocused();

  const skillRow = page.getByTestId("bot-skills").getByRole("button", { name: /inbox-triage/ });
  await skillRow.click();
  await expect(panel).toHaveAttribute("data-detail", "skill");
  await expect(panel).toHaveAttribute("data-size", "wide");
  await expect(panel.getByTestId("bot-knowledge-skill-editor").locator("textarea")).toHaveValue(
    /Read every unread email/,
  );
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(skillRow).toBeFocused();
  await expect(files).toContainText("vendors.csv");
});

test("a routine row says how its last run went, and its switch saves on its own", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?tab=routines`);
  const routines = page.getByTestId("bot-routines");
  await expect(routines).toContainText("3 routines · next in 14 hr.");
  await expect(routines.getByRole("button", { name: /Weekly digest/ })).toContainText(
    "Failed yesterday · Model error",
  );
  await expect(routines.getByRole("button", { name: /Invoice watch/ })).toContainText(
    "When a webhook fires · paused",
  );

  const toggle = routines.getByRole("switch", { name: "Active: Invoice watch" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(routines.locator('[data-slot="save-meta"]').last()).toHaveText(/^Saved \d/);
  await expect(routines.getByRole("button", { name: /Invoice watch/ })).not.toContainText("paused");
});

test("a routine opens wide, saves its name on blur, and edits a trigger in a dialog", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?tab=routines`);
  const panel = page.getByTestId("side-panel");
  await page.getByRole("button", { name: /Weekly digest/ }).click();
  await expect(panel).toHaveAttribute("data-size", "wide");

  const name = panel.getByLabel("Name", { exact: true });
  await name.fill("Monday digest");
  await name.blur();
  await expect(panel.locator('[data-slot="save-meta"]').first()).toHaveText(/^Saved \d/);

  await panel.getByRole("button", { name: /^On a schedule/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("How often").selectOption("Weekdays");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^On a schedule/ })).toContainText(
    "Weekdays at 9:00 AM",
  );

  await panel.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(page.getByRole("button", { name: /Monday digest/ })).toBeFocused();
});

test("a new routine is only created once it has a trigger", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines&detail=routine-new`);
  const form = page.getByTestId("routine-create");
  await form.getByLabel("Name", { exact: true }).fill("Friday wrap-up");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Add a schedule, webhook, GitHub, or message trigger",
  );

  await form.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every week", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("routine-detail").getByLabel("Name", { exact: true })).toHaveValue(
    "Friday wrap-up",
  );
});

test("a routine's webhook key stays behind dots until shown, copies whole, and rotates on confirm", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${FIXTURE}?tab=routines&detail=routine&routine=routine-2`);
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Webhook", exact: true }).click();

  const editor = page.getByRole("dialog");
  await expect(editor.getByText(/\/api\/v1\/bots\/bot-scout\/webhook$/)).toBeVisible();
  await expect(editor.getByText(`Authorization: Bearer ${DOTS}`)).toBeVisible();
  await expect(editor).not.toContainText("whsec_fixture_0000");
  await captureScreenshot(page, testInfo, "bot-page-routine-key");

  await editor.getByRole("button", { name: "Copy key" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("whsec_fixture_0000");
  await editor.getByRole("button", { name: "Show key" }).click();
  await expect(editor.getByText("Authorization: Bearer whsec_fixture_0000")).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-page-routine-key-shown");

  await editor.getByRole("button", { name: "Rotate key" }).click();
  await page.getByRole("button", { name: "Rotate", exact: true }).click();
  await expect(editor.getByText(`Authorization: Bearer ${DOTS}`)).toBeVisible();
  await editor.getByRole("button", { name: "Show key" }).click();
  await expect(editor.getByText("Authorization: Bearer whsec_fixture_0001")).toBeVisible();

  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^When a webhook fires/ })).toBeVisible();
});

test("bot page activity in debug mode, at phone width", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${FIXTURE}?tab=activity&debug=1`);
  const activity = page.getByTestId("bot-activity");
  await expect(
    activity.getByRole("button", { name: /^Compare flights from Paris to Copenhagen/ }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-page-activity-debug-phone");
});

test("in debug mode a run's dialog shows its facts and copies a diagnostic without the raw error", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${FIXTURE}?tab=activity&debug=1`);
  await page
    .getByTestId("bot-activity")
    .getByRole("button", { name: /^Prepare the agenda for Thursday/ })
    .click();

  const details = page.getByTestId("session-view").getByTestId("run-details");
  await expect(details).toContainText("anthropic/claude-sonnet · failed");
  await details.getByTestId("run-details-toggle").click();
  await expect(details).toContainText("1,840 in · 96 out");
  await expect(details).toContainText("run-52");
  await captureScreenshot(page, testInfo, "run-dialog-debug");

  await details.getByRole("button", { name: "Copy diagnostic" }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.run).toMatchObject({
    runId: "run-52",
    status: "failed",
    failureKind: "missing_model",
  });
  expect(copied.entries).toHaveLength(5);
  expect(JSON.stringify(copied)).not.toContain("Connect a model in Settings");

  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "run-dialog-debug-phone");
});
