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

test("shows peer chips in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("peer-msg"), "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");

  await expect
    .poll(
      async () => {
        const entries = await threadEntries(page, { botId: chiefId, includePeerRuns: true });
        return entries.some(
          (entry) =>
            (entry.type === "bot.message.sent" || entry.type === "bot.message.received") &&
            entry.payload.text.includes("peer-exchange-alpha"),
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // The composer draft is empty, so Send stays hidden; the combobox being enabled is the
  // signal that the peer exchange finished and the thread is interactive again.
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeEnabled({
    timeout: 60_000,
  });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(/Messaged Researcher|Message from Researcher/);
  // Both sides of the exchange: the bot whose thread this is, then its peer.
  await expect(chip.locator(".tangow-clay-avatar")).toHaveCount(2);
  await expect(chip.locator(".tangow-clay-avatar").first()).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(1);
  const assertChipCentered = async () => {
    const transcriptBox = await transcript.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    // A delegation is an aside between messages: centred, and narrower than a reply
    // bubble's cap (MessageBubble's max-w-41/50, 82% of the content column in a mono thread).
    const chipMid = chipBox!.x + chipBox!.width / 2;
    const transcriptMid = transcriptBox!.x + transcriptBox!.width / 2;
    expect(Math.abs(chipMid - transcriptMid)).toBeLessThanOrEqual(2);
    const contentWidth = await transcript.evaluate((element) => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(chipBox!.width).toBeLessThan(contentWidth * 0.82);
  };

  await assertChipCentered();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(composer).toBeVisible();
  await assertChipCentered();
  await captureScreenshot(page, testInfo, "peer-chip-mobile");

  const openChip = chip.getByRole("button", {
    name: /Messaged Researcher|Message from Researcher/,
  });
  await openChip.focus();
  await expect(openChip).toBeFocused();
  await openChip.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief · Researcher/ })).toBeVisible();
  await expect(view.getByText("This chat is view-only")).toBeVisible();
  await expect(view.getByRole("button", { name: "Close" })).toHaveCount(1);
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByText("Loading")).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  // Oldest-first, but the view must open on the latest exchange without scrolling.
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only");
});
