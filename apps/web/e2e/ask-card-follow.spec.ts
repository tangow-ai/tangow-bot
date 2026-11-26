import { writeFileSync } from "node:fs";
import { activeBotId, completeOnboarding, rpc, signup, uniqueEmail } from "./helpers";
import type { Page } from "./test";
import { expect, test } from "./test";
import { finishedRuns, threadEntries } from "./thread-log";

type Frame = {
  t: number;
  flying: boolean;
  /** How far the thread's last row reaches below the composer's top edge, in px. */
  below: number;
  /** How far the list is from its end, in px. */
  fromEnd: number;
  scrollTop: number;
  /** Where the row above the card stands. */
  above: number;
  /** Rows after the card's own: the bot's reply, once it lands. */
  replies: number;
};

/** Opens the scripted cities card after a few exchanges, so the thread scrolls. */
async function openCard(page: Page, name: string) {
  await signup(page, uniqueEmail(`${name}`), "password12", "Ask Follow");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  for (let turn = 1; turn <= 3; turn++) {
    await page.getByPlaceholder(/Message/).fill(`note ${turn} for the follow check`);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => finishedRuns(await threadEntries(page, { botId })).length, {
        timeout: 60_000,
      })
      .toBe(turn);
  }
  await page.getByPlaceholder(/Message/).fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status,
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  if ((await seoul.count()) === 0) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(seoul).toBeVisible({ timeout: 15_000 });
  return seoul;
}

/** Records every frame from now until `window.followDone` is set. */
async function sample(page: Page) {
  await page.evaluate(() => {
    const transcript = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const composer = document.querySelector('[data-testid="composer-bar"]') as HTMLElement;
    const card = document.querySelector('[data-slot="question-card"]') as HTMLElement;
    const row = card.closest("[data-message-id]") as Element;
    const rows = [...transcript.querySelectorAll("[data-message-id]")];
    const above = rows[rows.indexOf(row) - 1] as Element;
    const frames: Frame[] = [];
    (window as unknown as { follow: Promise<Frame[]> }).follow = new Promise((resolve) => {
      const step = (now: number) => {
        const last = transcript.lastElementChild as HTMLElement;
        frames.push({
          t: now,
          flying: Boolean(card.firstElementChild?.childElementCount),
          below: last.getBoundingClientRect().bottom - composer.getBoundingClientRect().top,
          fromEnd: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
          scrollTop: transcript.scrollTop,
          above: above.getBoundingClientRect().top,
          replies: [...transcript.querySelectorAll("[data-message-id]")].filter(
            (element) => row.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
          ).length,
        });
        if ((window as unknown as { followDone?: boolean }).followDone) resolve(frames);
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });
}

/** A frame where the list's scroll moved and the rows on screen moved with it: a jump. */
const jumps = (frames: Frame[]) =>
  frames.slice(1).filter((frame, index) => {
    const scrolled = frame.scrollTop - frames[index]!.scrollTop;
    const moved = frame.above - frames[index]!.above;
    return Math.abs(scrolled) >= 4 && Math.abs(moved + scrolled) < Math.abs(scrolled) * 0.3;
  });

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  // The working line lands when the answer reaches the server: as the card commits, or mid-flight.
  for (const lag of [0, 300]) {
    test(`answering a card at the end of the thread keeps following the end, without a jump (${viewport.width}, answer after ${lag} ms)`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const seoul = await openCard(page, `ask-follow-${viewport.width}-${lag}`);
      if (lag) {
        await page.route("**/rpc/threads/answer", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, lag));
          await route.continue();
        });
      }
      const transcript = page.getByTestId("transcript");
      await transcript.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(
        await transcript.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);

      await sample(page);
      await seoul.click();
      await expect
        .poll(
          async () => finishedRuns(await threadEntries(page, { botId: activeBotId(page) })).length,
          { timeout: 60_000 },
        )
        .toBe(4);
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        (window as unknown as { followDone: boolean }).followDone = true;
      });
      const frames = await page.evaluate(
        () => (window as unknown as { follow: Promise<Frame[]> }).follow,
      );
      writeFileSync(testInfo.outputPath("follow-frames.json"), JSON.stringify(frames));

      const landed = frames.findIndex(
        (frame, index) => index > 0 && frames[index - 1]!.flying && !frame.flying,
      );
      const replied = frames.findIndex((frame) => frame.replies > 0);
      expect(landed).toBeGreaterThan(0);
      expect(replied).toBeGreaterThan(landed);
      // The working line joins the movement: the rows never jump with the list's scroll.
      expect(jumps(frames.slice(0, landed + 1))).toEqual([]);
      // At rest before the reply, and once the reply has landed, the thread ends right above the composer.
      for (const rest of [frames[replied - 1]!, frames.at(-1)!]) {
        expect(rest.fromEnd).toBeLessThanOrEqual(2);
        expect(rest.below).toBeLessThanOrEqual(2);
      }
    });
  }
}
