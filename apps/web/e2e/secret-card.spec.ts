import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";
import { answerOf, threadEntries } from "./thread-log";

test("renders masked secret card and saves without putting the value in chat", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("secret-card"), "password12", "Secret Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a secret card for a masked api key");
  await page.keyboard.press("Enter");

  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");

  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("API key", { exact: true }).first()).toBeVisible();
  await expect(card.getByText("https://api.example.test", { exact: true })).toBeVisible();
  const secretField = card.getByLabel("API key");
  await expect(secretField).toHaveAttribute("type", "password");
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(secretField).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  const secretValue = `sk-test-secret-${stamp}`;
  // Clear sensitive client state before waiting for a network result, including failures.
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/rpc/threads/answer", async (route) => {
    await failureGate;
    await route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: secretValue } },
    });
  });
  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(secretField).toHaveValue("");
    await expect(secretField).toBeDisabled();
    await expect(card.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  } finally {
    releaseFailure();
  }
  await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(secretField).toHaveValue("");
  await page.unroute("**/rpc/threads/answer");

  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(composer).not.toHaveValue(secretValue);

  await expect
    .poll(
      async () => {
        const entries = await threadEntries(page, { botId });
        if (JSON.stringify(entries).includes(secretValue)) return "leaked";
        const ask = entries.find(
          (entry) => entry.type === "assistant.ask" && entry.payload.block.input === "secret",
        );
        return ask ? (answerOf(entries, ask.id)?.type ?? null) : null;
      },
      { timeout: 30_000 },
    )
    .toBe("card.answered");

  // Check again after the worker resumes, then reload to verify the durable Saved state.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          botId,
        });
        return snapshot.run?.status ?? "completed";
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  const history = await rpc(page, "threads/messages", { botId });
  expect(JSON.stringify(history)).not.toContain(secretValue);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();
  await expect(card.locator("input")).toHaveCount(0);
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "secret-card-saved");
});
