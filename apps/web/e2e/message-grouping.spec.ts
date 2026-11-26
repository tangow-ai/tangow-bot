import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Page, test } from "./test";
import { at, type EntryDraft, runFinished, runStarted, showThread } from "./thread-log";

/**
 * A user message followed by three consecutive prose messages from the same
 * bot, close enough in time to collapse under one shared header.
 *
 * Rendered in a group (multi-bot) thread: a mono (single-bot) thread never
 * shows a per-message name or avatar any more (D2-a puts the bot's identity
 * in the header instead), so grouping's shared header only shows there — the
 * grouping *spacing* (3px within a group, 14px between groups) still applies
 * in a mono thread, but that has no header to assert on.
 */
function groupedThread(botId: string): EntryDraft[] {
  const words = (id: string, minute: number, text: string): EntryDraft => ({
    id,
    ts: at(minute),
    type: "bot.text",
    botId,
    payload: { blocks: [{ kind: "text", text }] },
  });
  return [
    {
      id: "mg-user",
      ts: at(23),
      type: "user.message",
      payload: {
        blocks: [{ kind: "text", text: "Where does the RAS note come from?" }],
        source: "app",
      },
    },
    words("g1", 24, "Looking at where that RAS note comes from."),
    words("g2", 25, "It is the evening routine: personal plus family over 48h."),
    words("g3", 26, "It comes from the daily-conflict-watch routine."),
  ];
}

/** Two replies, each from its own run of the same bot, the shape every run reply takes. */
function runRepliesThread(botId: string): EntryDraft[] {
  const run = (id: string, minute: number, text: string): EntryDraft[] => [
    runStarted(botId, id, minute, "rr-user"),
    {
      id: `${id}-reply`,
      ts: at(minute),
      type: "assistant.text",
      botId,
      runId: id,
      payload: { blocks: [{ kind: "text", text }] },
    },
    runFinished(botId, id, minute),
  ];
  return [
    {
      id: "rr-user",
      ts: at(23),
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "Check both feeds." }], source: "app" },
    },
    ...run("rr-1", 24, "The first feed is up to date."),
    ...run("rr-2", 27, "The second feed is late by a day."),
  ];
}

async function setAppearance(page: Page, theme: "light" | "dark") {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("a bot's stacked consecutive messages in a group thread share one header", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("message-grouping"), "password12", "Message Grouping");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  // A single-member group is still a "multi" thread for grouping purposes
  // (`inGroup === true`): its grammar carries a name and avatar per group,
  // unlike a mono thread.
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Solo group",
    botIds: [chiefId],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  await showThread(page, groupedThread(chiefId));

  const transcript = page.getByTestId("transcript");
  const g1 = transcript.locator('[data-message-id="g1"]');
  const g2 = transcript.locator('[data-message-id="g2"]');
  const g3 = transcript.locator('[data-message-id="g3"]');
  await expect(g1).toBeVisible({ timeout: 20_000 });
  await expect(g2).toBeVisible();
  await expect(g3).toBeVisible();

  // The first message of the group keeps the shared header: a name, and an
  // avatar reserved at the group's foot (not its own row).
  await expect(g1.locator('[data-slot="message-row-author"]')).toHaveText("Chief");
  await expect(g1.locator('[data-slot="message-row-avatar"] .tangow-clay-avatar')).toHaveCount(0);

  // The second and third messages are continuations: no repeated name.
  await expect(g2.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(g3.locator('[data-slot="message-row-author"]')).toHaveCount(0);

  // Exactly one author header across the whole group of three, and exactly
  // one avatar — at the group's foot (the last message), not its head.
  await expect(
    transcript
      .locator('[data-message-id="g1"], [data-message-id="g2"], [data-message-id="g3"]')
      .locator('[data-slot="message-row-author"]'),
  ).toHaveCount(1);
  await expect(g3.locator('[data-slot="message-row-avatar"] .tangow-clay-avatar')).toHaveCount(1);

  // Every message in the group still reveals its own time on hover, even a
  // continuation with no header of its own.
  const g2Time = g2.getByTestId("message-hover-time");
  await expect(g2Time).toHaveCount(1);
  await g2.hover();
  await expect(g2Time).toBeAttached();

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "message-grouping-dark");
});

test("two replies from two runs of the same bot group like two messages, nothing between", async ({
  page,
}) => {
  await signup(page, uniqueEmail("run-grouping"), "password12", "Run Grouping");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Solo group",
    botIds: [chiefId],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  await showThread(page, runRepliesThread(chiefId));

  const transcript = page.getByTestId("transcript");
  const first = transcript.locator('[data-message-id="rr-1-reply"]');
  const second = transcript.locator('[data-message-id="rr-2-reply"]');
  await expect(second).toBeVisible({ timeout: 20_000 });

  await expect(
    transcript
      .locator("[data-message-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-message-id"))),
  ).resolves.toEqual(["rr-user", "rr-1-reply", "rr-2-reply"]);
  await expect(
    first.evaluate((row) => row.nextElementSibling?.getAttribute("data-message-id")),
  ).resolves.toBe("rr-2-reply");

  await expect(first.locator('[data-slot="message-row-author"]')).toHaveText("Chief");
  await expect(second.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(first.locator('[data-slot="message-row-avatar"] .tangow-clay-avatar')).toHaveCount(
    0,
  );
  await expect(second.locator('[data-slot="message-row-avatar"] .tangow-clay-avatar')).toHaveCount(
    1,
  );
});
