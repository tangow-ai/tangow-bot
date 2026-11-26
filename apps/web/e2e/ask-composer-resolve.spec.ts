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

// A run parked on an ask_user card can be answered from the main composer instead of the card
// (feature ask-answer-via-composer, PR 1). Typing a reply must resolve the ask and resume the
// run, never the old "Answer the pending ask first." block.
test("resolves a pending ask from the main composer", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("ask-composer"), "password12", "Ask Composer");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("ask me which city to use");
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
  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await prompt.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(composer).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  // While the question waits, the composer says it answers Chief, and Stop stays.
  await expect(composer).toHaveAttribute("placeholder", "Answer Chief…");
  await expect(page.getByRole("combobox", { name: "Answer Chief…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  // The card offers its own field, but the composer is a first-class answer channel too.
  await expect(page.getByRole("textbox", { name: "Answer", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ask-composer-pending");

  // Answer in the main composer, not the card. Prose avoids any scripted-runtime trigger so the
  // resumed run falls through to the default completing turn.
  await composer.fill("Go with the northern one.");
  await page.keyboard.press("Enter");

  // The old hostile guard must be gone: no error strip.
  await expect(page.getByText("Answer the pending ask first.", { exact: true })).toHaveCount(0);

  // The user's own words appear as a message bubble.
  await expect(page.getByText("Go with the northern one.", { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  await expect
    .poll(
      async () => {
        const entries = await threadEntries(page, { botId });
        const ask = entries.find((entry) => entry.type === "assistant.ask");
        return ask ? (answerOf(entries, ask.id)?.type ?? null) : null;
      },
      { timeout: 30_000 },
    )
    .toBe("card.answered");

  // The card no longer repeats the reply: exactly one instance of the prose (the bubble).
  await expect(page.getByText("Go with the northern one.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Answer", exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: /^Your answer/ })).toHaveCount(0);
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await expect(page.getByRole("combobox", { name: "Message Chief", exact: true })).toBeVisible();
  await expect(
    page.getByText("on it. i will work this in the background and come back with a result.", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, testInfo, "ask-composer-resolved");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "ask-composer-resolved-mobile");
});
