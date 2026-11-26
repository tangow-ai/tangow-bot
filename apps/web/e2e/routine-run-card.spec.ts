import type { Routine } from "@tangow/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPage,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import type { Page, TestInfo } from "./test";
import { expect, test } from "./test";
import { blocksOf, threadEntries } from "./thread-log";

async function captureRoutineMessage(page: Page, testInfo: TestInfo, name: string) {
  const viewport = page.viewportSize();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await captureScreenshot(page, testInfo, `${name}-${colorScheme}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await captureScreenshot(page, testInfo, `${name}-phone-${colorScheme}`);
    if (viewport) await page.setViewportSize(viewport);
  }
  await page.emulateMedia({ colorScheme: null });
}

test("renders a routine run's words as a message in a sub-bot's own thread", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("routine-run-card"), "password12", "Routine Run Card");
  await completeOnboarding(page);
  const orchestratorId = activeBotId(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("Spawn a bot named Aide whose only job is quick status checks.");
  await page.keyboard.press("Enter");

  // A bot never creates a bot on its own: the approval card comes first.
  await page.getByRole("button", { name: "Create bot", exact: true }).click({ timeout: 30_000 });
  await expect(page.getByText("Created", { exact: true })).toBeVisible();

  let subBotId: string | undefined;
  await expect
    .poll(
      async () => {
        const block = blocksOf(await threadEntries(page, { botId: orchestratorId })).find(
          (candidate) => candidate.kind === "child_bot",
        );
        subBotId = block?.kind === "child_bot" ? block.botId : undefined;
        return subBotId;
      },
      { timeout: 60_000 },
    )
    .not.toBeUndefined();
  if (!subBotId) throw new Error("spawn_bot did not create a sub-bot");

  const routine = await rpc<Routine>(page, "routines/create", {
    botId: subBotId,
    name: "Status check",
    prompt:
      "Reply with a short status digest formatted as markdown: a **bolded** one-word verdict, " +
      "then a bullet list of two short items. No preamble, no images.",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
  });
  await rpc(page, "routines/testRun", { routineId: routine.id });

  await page.goto(`/app/${subBotId}`);
  const bubble = page.getByTestId("routine-message");
  await expect(bubble).toBeVisible({ timeout: 60_000 });
  await expect(bubble.locator("strong")).toBeVisible();
  await expect(bubble.locator("img")).toHaveCount(0);
  const name = page.getByTestId("item-origin").filter({ hasText: "Status check" });
  await expect(name).toBeVisible();
  await expect(page.getByTestId("routine-run-line")).toHaveCount(0);
  await captureRoutineMessage(page, testInfo, "routine-message");

  await name.click();
  const session = page.getByTestId("session-view");
  await expect(session.getByRole("heading", { name: "Status check" })).toBeVisible();
  await expect(session.getByRole("textbox")).toHaveCount(0);
  // A card run keeps its report only on its line, which its own view leaves out: the view shows it.
  await expect(session.locator("strong")).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-session-view");
  await page.keyboard.press("Escape");

  // The bot's Activity reads the same report, and Open in chat lands on the run's line.
  const botPage = await openBotPage(page);
  await botPage.getByRole("tab", { name: "Activity" }).click();
  const activity = botPage.getByTestId("bot-activity");
  await activity.getByRole("button", { name: /^Status check, Done/ }).click();
  const recap = activity.getByTestId("activity-recap");
  await expect(recap.locator("strong")).toBeVisible();
  await expect(recap).not.toContainText("No report");
  await captureScreenshot(page, testInfo, "routine-activity-recap");
  await recap.getByRole("button", { name: "Open in chat" }).click();
  await expect(page).toHaveURL(/[?&]m=/);
});

test("renders a webhook-woken routine as a routine message, not a user message", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("webhook-run-card"), "password12", "Webhook Run Card");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await rpc<Routine>(page, "routines/create", {
    botId,
    name: "Deploy watch",
    prompt: "Reply with a one-line status digest of the delivery. No preamble, no images.",
    active: true,
    notify: true,
    webhookEnabled: true,
    requireToolApproval: false,
  });
  const { secret, path } = await rpc<{ secret: string; path: string }>(
    page,
    "bots/rotateWebhookSecret",
    { botId },
  );
  const delivered = await page.request.post(path, {
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `deploy-${stamp}` },
    data: { event: "deploy.finished", service: "checkout" },
  });
  expect(delivered.ok()).toBe(true);

  await expect(page.getByTestId("routine-message")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("item-origin").filter({ hasText: "Deploy watch" })).toBeVisible();
  await expect(page.getByTestId("routine-run-line")).toHaveCount(0);
  await expect(page.getByText(/Run routine "Deploy watch"/)).toHaveCount(0);
  await expect(page.getByText("deploy.finished")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "webhook-routine-message");

  const entries = await threadEntries(page, { botId });
  expect(
    entries.some(
      (entry) => entry.type === "user.message" && JSON.stringify(entry.payload).includes("deploy."),
    ),
  ).toBe(false);

  // A routine's words take the same actions as any bot message: time, reply, react, copy.
  const routineRow = page
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("routine-message") });
  const pill = routineRow.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await routineRow.hover();
      return pill.evaluate((element) => getComputedStyle(element).opacity);
    })
    .toBe("1");
  await expect(pill.getByTestId("message-hover-time")).toHaveText(/\d/);
  await expect(pill.getByRole("button", { name: "React" })).toBeVisible();
  await expect(pill.getByRole("button", { name: "Copy" })).toBeVisible();
  const reply = pill.getByRole("button", { name: "Reply" });
  await reply.focus();
  await captureRoutineMessage(page, testInfo, "routine-message-actions");

  const routineWords = (await page.getByTestId("routine-message").innerText()).trim();
  await reply.click();
  const replyText = `routine-reply-${stamp}`;
  await page.getByRole("combobox", { name: /^Message/ }).fill(replyText);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const replyRow = page.locator("[data-message-id]").filter({ hasText: replyText }).first();
  await expect(replyRow.getByTestId("reply-parent-preview")).toContainText(
    (routineWords.split("\n")[0] ?? "").slice(0, 20),
  );
  await captureScreenshot(page, testInfo, "routine-message-reply");
});
