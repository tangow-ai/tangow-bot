import { activeBotId, captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";
import type { EntryDraft } from "./thread-log";
import { at, showThread } from "./thread-log";

test("internal run memory stays out of chat and a cancelled recap retires its question on reload", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("run-memory"), "password12", "Run Memory");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const drafts: EntryDraft[] = [
    {
      id: "memory-request",
      ts: at(10),
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: "Prepare the regional report." }], source: "app" },
    },
    {
      id: "memory-opened",
      ts: at(11),
      type: "run.opened",
      botId,
      runId: "memory-run",
      payload: { sessionId: "memory-internal-session" },
    },
    {
      id: "memory-person-update",
      ts: at(12),
      type: "assistant.text",
      botId,
      runId: "memory-run",
      payload: {
        toPerson: true,
        midTurn: true,
        originSessionId: "memory-internal-session",
        blocks: [{ kind: "text", text: "I am checking the regional report." }],
      },
    },
    {
      id: "memory-person-reply",
      ts: at(12),
      type: "assistant.text",
      botId,
      runId: "memory-run",
      payload: {
        toPerson: true,
        midTurn: true,
        originSessionId: "memory-internal-session",
        blocks: [{ kind: "text", text: "The regional report is ready for review." }],
      },
    },
    {
      id: "memory-question",
      ts: at(13),
      type: "assistant.ask",
      botId,
      runId: "memory-run",
      payload: {
        originSessionId: "memory-internal-session",
        block: { kind: "ask", text: "Which region should I send first?", status: "pending" },
      },
    },
  ];
  const recap: EntryDraft = {
    id: "memory-recap",
    ts: at(14),
    type: "run.recap",
    botId,
    runId: "memory-run",
    payload: {
      version: 1,
      sessionId: "memory-internal-session",
      outcome: { status: "cancelled", usage: { inputTokens: 120, outputTokens: 30 } },
      recap: {
        state: "available",
        facts: {
          version: 1,
          results: ["Internal result: regional totals reconciled."],
          decisions: ["Internal decision: defer distribution."],
          limits: ["Internal limit: distribution was cancelled."],
          references: [],
        },
      },
    },
  };
  await showThread(page, drafts, { run: null });

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "domcontentloaded" });
    const transcript = page.getByTestId("transcript");
    const composer = page.locator('textarea[name="chat-message"]');
    await expect(
      transcript.getByText("Prepare the regional report.", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("The regional report is ready for review.", { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByTestId("message-bot-bubble")).toHaveText([
      "I am checking the regional report.",
      "The regional report is ready for review.",
    ]);
    await expect(
      transcript.getByText("Which region should I send first?", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Answer", exact: true })).toBeVisible();
    await expect(composer).toHaveAttribute("placeholder", "Answer Chief…");
    await expect(transcript.locator('[data-message-id="memory-opened"]')).toHaveCount(0);
    await expect(transcript.getByTestId("item-origin")).toHaveCount(0);

    drafts.push(recap);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(transcript.getByTestId("message-bot-bubble")).toHaveText([
      "I am checking the regional report.",
      "The regional report is ready for review.",
    ]);
    await expect(
      transcript.getByText("Which region should I send first?", { exact: true }),
    ).toBeVisible();
    await expect(transcript.getByText("No longer active", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Answer", exact: true })).toHaveCount(0);
    await expect(composer).toHaveAttribute("placeholder", "Message Chief");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await expect(
      transcript.locator('[data-message-id="memory-opened"], [data-message-id="memory-recap"]'),
    ).toHaveCount(0);
    await expect(transcript).not.toContainText("memory-internal-session");
    await expect(transcript).not.toContainText("Internal result:");
    await expect(transcript).not.toContainText("Internal decision:");
    await expect(transcript).not.toContainText("Internal limit:");
    await captureScreenshot(page, testInfo, `interactive-run-memory-${viewport.width}`);
    drafts.pop();
  }
});
