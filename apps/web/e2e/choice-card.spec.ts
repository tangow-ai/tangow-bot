import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";
import { threadEntries } from "./thread-log";

test("renders tappable choice buttons and submits the offered action id", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("choice-card"), "password12", "Choice Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("pick from these cities with tappable choices");
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
    await expect(page.getByPlaceholder(/Message|Answer/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  const berlin = page.getByRole("button", { name: "Berlin", exact: true });
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  const toronto = page.getByRole("button", { name: "Toronto", exact: true });
  const lisbon = page.getByRole("button", { name: "Lisbon", exact: true });
  await expect(berlin).toBeVisible();
  await expect(seoul).toBeVisible();
  await expect(toronto).toBeVisible();
  await expect(lisbon).toBeVisible();

  // Options are full-width tiles in a group named by the question, Other… last, one per row.
  const options = page.getByRole("group", { name: "Which city should I use?" });
  await expect(options.getByRole("button")).toHaveText([
    "Berlin",
    "Seoul",
    "Toronto",
    "Lisbon",
    "Other…",
  ]);
  const berlinBox = await berlin.boundingBox();
  const seoulBox = await seoul.boundingBox();
  expect(seoulBox!.y).toBeGreaterThan(berlinBox!.y + berlinBox!.height);
  expect(Math.abs(berlinBox!.width - seoulBox!.width)).toBeLessThan(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await captureScreenshot(page, testInfo, "choice-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(lisbon).toBeVisible();
  // On a phone the tiles stay inside the card.
  const narrowOptions = await options.boundingBox();
  const narrowLisbon = await lisbon.boundingBox();
  expect(narrowLisbon!.x + narrowLisbon!.width).toBeLessThanOrEqual(
    narrowOptions!.x + narrowOptions!.width + 1,
  );
  await captureScreenshot(page, testInfo, "choice-card-narrow");

  await page.setViewportSize({ width: 1440, height: 900 });
  const answered = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  // A tap selects and holds the choice before it is sent.
  await seoul.click();
  await expect(seoul).toHaveAttribute("aria-pressed", "true");
  await options.screenshot({
    path: testInfo.outputPath("choice-card-hold.png"),
    animations: "disabled",
  });
  expect((await answered).postDataJSON().json.answer).toBe("choice-2");

  await expect(page.getByRole("group", { name: "Your answer: Seoul" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Seoul", exact: true })).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const entries = await threadEntries(page, { botId });
        const ask = entries.find((entry) => entry.type === "assistant.ask");
        if (!ask) return null;
        const reply = entries.find(
          (entry) => entry.type === "user.message" && entry.payload.replyTo?.entryId === ask.id,
        );
        const answered = entries.find(
          (entry) => entry.type === "card.answered" && entry.payload.target === ask.id,
        );
        return {
          reply: reply?.type === "user.message" ? reply.payload.blocks : null,
          answer: answered?.type === "card.answered" ? answered.payload.answer : null,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ reply: [{ kind: "text", text: "Seoul" }], answer: "choice-2" });

  await captureScreenshot(page, testInfo, "choice-card-answered");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "choice-card-answered-narrow");
});
