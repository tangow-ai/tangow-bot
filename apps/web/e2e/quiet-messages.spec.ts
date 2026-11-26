import { activeBotId, captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, type Locator, type Page, test } from "./test";
import { at, type EntryDraft, runFinished, runStarted, showThread } from "./thread-log";

/** A thread that shows the whole message grammar at once, with stable content. */
function quietThread(botId: string): EntryDraft[] {
  return [
    {
      id: "quiet-user",
      ts: at(24),
      type: "user.message",
      payload: {
        blocks: [{ kind: "text", text: "Pull the Q3 numbers.\nBoth regions." }],
        source: "app",
      },
    },
    {
      id: "quiet-peer",
      ts: at(24),
      type: "bot.message.received",
      payload: {
        from: { kind: "bot", botId: "quiet-research", name: "Research" },
        fromSessionId: "quiet-research-session",
        fromEntryId: "quiet-research-sent",
        text: "here are the Q3 numbers",
        intent: "result",
        hop: 1,
        exchangeId: "quiet-research-sent",
      },
    },
    {
      id: "quiet-handoff",
      ts: at(25),
      type: "handoff",
      payload: { fromBotId: botId, toBotId: "quiet-research", text: "the Q3 sheet", hop: 1 },
    },
    runStarted(botId, "quiet-run", 25, "quiet-user"),
    {
      id: "quiet-reply",
      ts: at(26),
      type: "assistant.text",
      botId,
      runId: "quiet-run",
      payload: {
        blocks: [
          {
            kind: "steps",
            durationMs: 124_000,
            steps: [
              { label: "Searched the drive", count: 1 },
              { label: "Read the Q3 sheet", count: 1 },
            ],
          },
          {
            kind: "text",
            text: [
              "Revenue is up in both regions.",
              "",
              "| Region | Revenue |",
              "| --- | ---: |",
              "| EU | 1,240 |",
              "| US | 2,310 |",
            ].join("\n"),
          },
        ],
      },
    },
    runFinished(botId, "quiet-run", 26, "completed"),
    runStarted(botId, "quiet-stopped", 27, "quiet-user"),
    {
      id: "quiet-note",
      ts: at(27),
      type: "assistant.text",
      botId,
      runId: "quiet-stopped",
      payload: {
        blocks: [
          { kind: "text", text: "I stopped there." },
          { kind: "meta", text: "Run stopped by you" },
        ],
      },
    },
    runFinished(botId, "quiet-stopped", 27, "cancelled"),
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

test("the thread reads as names, prose and asides", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("quiet-messages"), "password12", "Quiet Messages");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  // Reasoning only renders when the person asked to see agent steps.
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("debug-mode").click();
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await showThread(page, quietThread(botId));

  const transcript = page.getByTestId("transcript");
  const reply = transcript.locator('[data-message-id="quiet-reply"]');
  await expect(reply).toBeVisible({ timeout: 20_000 });

  // Mono (single-bot) thread: a bot message carries no per-message name or
  // avatar any more — the bot's identity lives in the header (D2-a) — but its
  // prose is now a `muted` bubble, revealing its time on hover instead of a
  // permanent clock.
  const row = reply.locator('[data-slot="message-row"]');
  await expect(row).toBeVisible();
  await expect(row.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  const prose = reply.getByTestId("message-bot-bubble");
  await expect(prose).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(reply.getByTestId("message-hover-time")).toHaveCount(1);
  // Figures line up in a markdown table, and the `---:` column reads from the end.
  const revenue = prose.locator("td").nth(1);
  await expect(revenue).toHaveCSS("font-variant-numeric", "tabular-nums");
  await expect(revenue).toHaveCSS("text-align", "end");
  await expect(prose.locator("td").first()).toHaveCSS("text-align", "start");

  // The reply is set in the system mono family wherever it shows figures.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
    ),
  ).toContain("ui-monospace");

  // What the person said keeps its bubble and its line breaks.
  const userBubble = transcript.getByTestId("message-user-bubble");
  await expect(userBubble).toHaveCSS("white-space", "pre-wrap");
  await expect(userBubble).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  const transcriptBox = await transcript.boundingBox();
  expect(transcriptBox).not.toBeNull();
  const expectCentered = async (aside: Locator) => {
    const box = await aside.boundingBox();
    expect(box).not.toBeNull();
    expect(
      Math.abs(box!.x + box!.width / 2 - (transcriptBox!.x + transcriptBox!.width / 2)),
    ).toBeLessThanOrEqual(2);
  };

  const chip = transcript.getByTestId("peer-receipt-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Message from Research/);
  await expect(chip.locator('[data-slot="stacked-avatars"]')).toHaveAttribute("data-size", "17");
  await expectCentered(chip);
  const peerRow = transcript.locator('[data-message-id="quiet-peer"]');
  await expect(peerRow.locator('[data-slot="message-row"]')).toHaveCount(0);
  await expect(peerRow.getByTestId("message-hover-actions")).toHaveCount(0);
  await expect(peerRow.getByTestId("reply-parent-preview")).toHaveCount(0);
  await expect(peerRow.getByTestId("message-hover-rail")).toHaveCount(0);

  // So is a handoff, and neither carries message actions or a clock.
  const handoff = transcript.locator('[data-message-id="quiet-handoff"]');
  await expect(handoff.locator('[data-slot="interstitial"]')).toContainText("the Q3 sheet");
  await expect(handoff.getByTestId("message-hover-rail")).toHaveCount(0);
  await expect(handoff.getByTestId("message-hover-time")).toHaveCount(0);
  await expectCentered(handoff.locator('[data-slot="interstitial"]'));

  // A message that says something and adds a note is still a normal row —
  // mono carries no per-message author any more, but its text is a bubble.
  const note = transcript.locator('[data-message-id="quiet-note"]');
  await expect(note.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(note).toContainText("I stopped there.");
  await expect(note).toContainText("Run stopped by you");

  // Reasoning folds under one line, and opens onto the steps it took.
  const toggle = reply.getByTestId("agent-steps-toggle");
  await expect(toggle).toHaveText("Thought for 2m 04s · 2 steps");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(reply.getByRole("button", { name: "Read the Q3 sheet" })).toBeVisible();

  await setAppearance(page, "light");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-messages-light");

  await setAppearance(page, "dark");
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "quiet-messages-dark");
});
