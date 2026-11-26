import { activeBotId, captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, type Locator, type Page, test } from "./test";
import {
  at,
  finishedRuns,
  reshapeThreadPages,
  runFinished,
  runStarted,
  showThread,
  threadEntries,
} from "./thread-log";

test("widgets omit bubble hover actions", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("widget-hover"), "password12", "Widget Hover");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  // Supply a widget artifact and transcript to exercise hover without an external model;
  // HTTP caching does not affect toolbar visibility.
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({
      json: { json: { contentBase64: Buffer.from("<h1>Launch overview</h1>").toString("base64") } },
    }),
  );
  await showThread(page, [
    runStarted(botId, "widget-hover-text-run", 19, "widget-hover-trigger"),
    {
      id: "widget-hover-text",
      ts: at(20),
      type: "assistant.text",
      botId,
      runId: "widget-hover-text-run",
      payload: { blocks: [{ kind: "text", text: "Here is the launch overview." }] },
    },
    runFinished(botId, "widget-hover-text-run", 20, "completed"),
    runStarted(botId, "widget-hover-run", 21, "widget-hover-trigger"),
    {
      id: "widget-hover-card",
      ts: at(21),
      type: "assistant.text",
      botId,
      runId: "widget-hover-run",
      payload: {
        blocks: [{ kind: "widget", title: "Launch overview", artifactId: "widget-hover-artifact" }],
      },
    },
    runFinished(botId, "widget-hover-run", 22, "completed"),
  ]);
  const textRow = page.locator('[data-message-id="widget-hover-text"]');
  await revealHoverPill(textRow);
  await expect(textRow.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  const widgetRow = page.locator('[data-message-id="widget-hover-card"]');
  await expect(
    widgetRow.frameLocator("iframe").getByRole("heading", { name: "Launch overview" }),
  ).toBeVisible();
  await widgetRow.hover();
  await expect(widgetRow.getByTestId("message-hover-rail")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "widget-without-hover-actions-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "widget-without-hover-actions-phone");
});

/** Submit from the Send control so an in-flight prior send cannot swallow Enter. */
async function sendComposerMessage(page: Page, composer: Locator, text: string) {
  await composer.fill(text);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer).toHaveValue("");
}

/** Hover the row and wait for its floating pill to reveal, then park focus on Reply for stable screenshots. */
async function revealHoverPill(row: Locator): Promise<Locator> {
  const pill = row.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await row.hover();
      return pill.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    })
    .toEqual({ opacity: "1", pointerEvents: "auto" });
  // Incoming replies can move the row away from the pointer; keep real focus for screenshots.
  await pill.getByRole("button", { name: "Reply" }).focus();
  return pill;
}

/** Park the pointer outside the message and blur focus so the pill returns to opacity-0. */
async function expectPillAtRest(page: Page, row: Locator) {
  const pill = row.getByTestId("message-hover-rail");
  const box = await row.boundingBox();
  if (box) {
    // (0,0) can still sit on the first transcript row; leave below the row instead.
    await page.mouse.move(Math.max(0, box.x) + 8, box.y + box.height + 32);
  }
  // A focused action keeps focus once released; blur so focus-within does not leave the pill visible.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect(pill).toHaveCSS("opacity", "0");
  await expect(pill).toHaveCSS("pointer-events", "none");
  // A bot row carries no permanent clock: the time rides in the pill.
  await expect(pill.getByTestId("message-hover-time")).toHaveCount(1);
}

/**
 * The pill sits next to the bubble it acts on — beside it when there is room,
 * over its top corner when the bubble is too wide — level with its first line
 * and inside the row, never at the far edge of a short message's row.
 */
async function expectPillNextToBubble(pill: Locator, bubble: Locator, row: Locator) {
  await expect
    .poll(async () => {
      const pillBox = await pill.boundingBox();
      const bubbleBox = await bubble.boundingBox();
      const rowBox = await row.boundingBox();
      if (!pillBox || !bubbleBox || !rowBox) return null;
      const gap = Math.max(
        bubbleBox.x - (pillBox.x + pillBox.width),
        pillBox.x - (bubbleBox.x + bubbleBox.width),
        0,
      );
      return {
        besideBubble: gap <= 16,
        levelWithFirstLine: Math.abs(pillBox.y - bubbleBox.y) <= 16,
        withinRowWidth:
          pillBox.x >= rowBox.x - 1 && pillBox.x + pillBox.width <= rowBox.x + rowBox.width + 1,
      };
    })
    .toEqual({ besideBubble: true, levelWithFirstLine: true, withinRowWidth: true });
}

test("message hover shows a floating action pill; reply links to parent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("hover-actions"), "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const transcript = page.getByTestId("transcript");

  // Empty start: no Fresh-start greeting. Answer the focus card so a plain
  // bot text bubble exists for hover layout checks.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const botRow = transcript.locator(`[data-message-id]`).filter({ has: botText }).first();
  await expect(botRow).toBeVisible();
  await expectPillAtRest(page, botRow);
  await captureScreenshot(page, testInfo, "message-actions-rest-desktop");

  const botPill = await revealHoverPill(botRow);
  const botToolbar = botRow.getByTestId("message-hover-actions");
  // Mono thread: a bot message carries no name and no avatar (D2-a puts the
  // bot's identity in the header instead), and no permanent clock — its time
  // reveals on hover, exactly like the user bubble's.
  await expect(botRow.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(botRow.getByTestId("message-hover-time")).toHaveCount(1);

  // The pill carries Reply/Copy directly; it has no More button at all any more.
  await expect(botToolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "More" })).toHaveCount(0);
  // Voice is not configured in this test, so the pill carries no Speak button.
  await expect(botToolbar.getByRole("button", { name: "Speak this reply" })).toHaveCount(0);
  await expectPillNextToBubble(
    botPill,
    botRow.locator('[data-slot="message-row-bubble"]').first(),
    botRow,
  );
  await expect(botPill.getByTestId("message-hover-time")).toHaveText(/\d/);
  await captureScreenshot(page, testInfo, "message-bot-actions-desktop");
  await expectPillAtRest(page, botRow);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await sendComposerMessage(page, composer, parentText);

  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  // Your own message is a bare right-aligned bubble: it never wears the bot
  // avatar-and-name row header (a regression once labelled it "Bot").
  await expect(parentRow.locator('[data-slot="message-row-author"]')).toHaveCount(0);
  await expect(parentRow.locator('[data-slot="message-row-avatar"]')).toHaveCount(0);

  // A user message carries no floating pill at all: nothing to reply or react
  // to on what you said yourself, and no hover time riding along with it.
  await expect(parentRow.getByTestId("message-hover-rail")).toHaveCount(0);
  await expect(parentRow.getByTestId("message-hover-time")).toHaveCount(0);

  const userBubble = parentRow.getByTestId("message-user-bubble");
  const userActions = parentRow.getByTestId("message-user-actions");
  await expect(userActions).toHaveCSS("opacity", "0");
  // The reply lands right under the bubble, where the icons float: let it settle before pointing.
  await expect(transcript.getByText(`done. i handled: ${parentText}`)).toBeVisible({
    timeout: 20_000,
  });
  // The bot's reply can land and shift the row out from under the pointer, so hover again.
  await expect(async () => {
    await parentRow.hover();
    await expect(userActions).toHaveCSS("opacity", "1", { timeout: 2_000 });
  }).toPass();

  // Bare icons float below the bubble, end-aligned with it.
  await expect
    .poll(async () => {
      const actionsBox = await userActions.boundingBox();
      const bubbleBox = await userBubble.boundingBox();
      if (!actionsBox || !bubbleBox) return null;
      return {
        endAligned:
          Math.abs(actionsBox.x + actionsBox.width - (bubbleBox.x + bubbleBox.width)) <= 4,
        belowBubble: actionsBox.y >= bubbleBox.y + bubbleBox.height - 1,
      };
    })
    .toEqual({ endAligned: true, belowBubble: true });

  await expect(userActions.getByTestId("message-edit")).toBeVisible();
  await expect(userActions.getByRole("button", { name: "Edit and resend" })).toBeVisible();
  await expect(userActions.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(userActions.getByRole("button", { name: "Reply" })).toHaveCount(0);
  await expect(userActions.getByRole("button", { name: "React" })).toHaveCount(0);

  await userActions.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);

  // Rest requires both pointer and keyboard focus outside the action group.
  await composer.focus();
  // Moving the mouse away returns the bare icons to opacity 0.
  const parentRowBox = await parentRow.boundingBox();
  if (parentRowBox) {
    await page.mouse.move(
      Math.max(0, parentRowBox.x) + 8,
      parentRowBox.y + parentRowBox.height + 32,
    );
  }
  await expect(userActions).toHaveCSS("opacity", "0");
  await captureScreenshot(page, testInfo, "message-user-bubble-desktop");

  // The row's own invisible frame (the pill's touch/anchor area) still runs
  // the column's full width (inside the transcript's padding) — the visible
  // bot bubble inside it is narrower (fit-content, capped at 82%/88%) and
  // never widens to hug the pill.
  const botFrame = botRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const frameBox = await botFrame.boundingBox();
      const columnWidth = await transcript.evaluate((el) => {
        const style = getComputedStyle(el);
        return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      if (!frameBox) return null;
      return Math.abs(columnWidth - frameBox.width);
    })
    .toBeLessThan(4);

  // User bubble is the dark, filled `chatUser` surface (not the old cream
  // fill), and keeps its own 78% cap regardless of message length.
  const userSurface = parentRow.getByTestId("message-user-bubble");
  await expect(userSurface).toBeVisible();
  await expect
    .poll(async () => userSurface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/^rgb\(241,\s*241,\s*239\)$/); // not cream primary foreground

  // Long user bubble: the bubble itself still caps near 78% regardless of content.
  const longText = `hover-long-${stamp}-${"x".repeat(220)}`;
  await sendComposerMessage(page, composer, longText);
  const longRow = transcript
    .locator(`[data-message-id]`)
    .filter({ hasText: longText.slice(0, 40) })
    .first();
  await expect(longRow).toBeVisible({ timeout: 20_000 });
  const longBubble = longRow.getByTestId("message-user-bubble");
  await expect
    .poll(async () => {
      const bubbleBox = await longBubble.boundingBox();
      const transcriptBox = await transcript.boundingBox();
      if (!bubbleBox || !transcriptBox) return null;
      return bubbleBox.width / transcriptBox.width;
    })
    .toBeLessThan(0.8);

  // Reactions and Reply live only on the bot's row now: a user message has
  // neither. Exercise both on `botRow` (its "Got it." text).
  const botPillReacted = await revealHoverPill(botRow);
  const react = botToolbar.getByRole("button", { name: "React" });
  await expect(react).toBeVisible();
  // Default reaction matches Reply: muted control color, not yellow.
  await expect
    .poll(async () => {
      const mutedColor = await botToolbar
        .getByRole("button", { name: "Reply" })
        .evaluate((el) => getComputedStyle(el).color);
      const reactionColor = await react.evaluate((el) => getComputedStyle(el).color);
      return reactionColor === mutedColor;
    })
    .toBe(true);

  // Clip shot of the bot bubble + pill for gallery geometry.
  const botPillBox = await botPillReacted.boundingBox();
  const botFrameBox = await botFrame.boundingBox();
  if (!botPillBox || !botFrameBox) throw new Error("missing hover pill geometry");
  const pad = 16;
  const top = Math.min(botPillBox.y, botFrameBox.y);
  const clip = {
    x: Math.max(0, Math.min(botPillBox.x, botFrameBox.x) - pad),
    y: Math.max(0, top - pad),
    width:
      Math.max(botPillBox.x + botPillBox.width, botFrameBox.x + botFrameBox.width) -
      Math.min(botPillBox.x, botFrameBox.x) +
      pad * 2,
    height:
      Math.max(botPillBox.y + botPillBox.height, botFrameBox.y + botFrameBox.height) -
      top +
      pad * 2,
  };
  const hoverPath = testInfo.outputPath("message-hover-toolbar.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip,
    path: hoverPath,
  });
  await testInfo.attach("message-hover-toolbar", { contentType: "image/png", path: hoverPath });

  await react.click();
  for (const emoji of ["👍", "👎", "❤️", "😂", "🎉", "😮"]) {
    await expect(page.getByRole("button", { name: emoji, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "message-reaction-picker");
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(botRow.getByTestId("message-reactions")).toHaveText("❤️");
  await botRow.hover();
  await react.click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await expect(botRow.getByTestId("message-reactions")).toContainText("👍");
  await botRow.hover();
  await react.click();
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(botRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await captureScreenshot(page, testInfo, "message-multiple-reactions");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(botRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await expect(botRow.getByTestId("message-reactions")).toContainText("👍");

  await botRow.hover();
  await botToolbar.getByRole("button", { name: "Reply" }).click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(/Replying to/);

  await sendComposerMessage(page, composer, replyText);
  await expect(replyChip).toHaveCount(0);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(/Got it\./);
  await captureScreenshot(page, testInfo, "message-reply-thread");

  await parentPreview.click();
  await expect(botRow).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await botRow.scrollIntoViewIfNeeded();
  await revealHoverPill(botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-mobile");
  await parentRow.scrollIntoViewIfNeeded();
  await parentRow.hover();
  await expect(userActions).toHaveCSS("opacity", "1");
  await captureScreenshot(page, testInfo, "message-user-actions-mobile");
});

test("reply preview jumps to parent outside the loaded page", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("hover-page"), "password12", "Hover Page");
  await completeOnboarding(page);

  const replyText = `page-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();

  const transcript = page.getByTestId("transcript");
  // The parent replied to is the bot's own message — a user message no
  // longer carries a Reply action at all.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const parentRow = transcript.locator(`[data-message-id]`).filter({ has: botText }).first();
  await expect(parentRow).toBeVisible();
  const parentId = await parentRow.getAttribute("data-message-id");
  expect(parentId).toBeTruthy();

  await parentRow.hover();
  await parentRow.getByRole("button", { name: "Reply" }).click();
  await sendComposerMessage(page, composer, replyText);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  await expect(replyRow.getByTestId("reply-parent-preview")).toContainText(/Got it\./);

  const unroute = await reshapeThreadPages(page, (thread) => {
    const parent = thread.entries.find((entry) => entry.id === parentId);
    if (!parent) return;
    thread.entries = thread.entries.filter((entry) => entry.seq > parent.seq);
    thread.olderCursor = thread.entries[0]?.id ?? null;
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toHaveCount(0);
  const offlinePreview = page
    .locator(`[data-message-id]`)
    .filter({ hasText: replyText })
    .getByTestId("reply-parent-preview");
  await expect(offlinePreview).toBeVisible();
  await expect(offlinePreview).toHaveText("Earlier message");

  await unroute();
  await offlinePreview.click();
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toContainText(/Got it\./);
});

test("a send after a search jump lands on the latest messages", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("jump-send"), "password12", "Jump Send");
  await completeOnboarding(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  const botId = activeBotId(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  const transcript = page.getByTestId("transcript");
  const long = (word: string, lines: number) =>
    Array.from({ length: lines }, (_, line) => `${word}-${stamp} line ${line + 1}`).join("\n");

  const answered = async (marker: string) => {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const entries = await threadEntries(page, { botId });
          const sent = entries.find(
            (entry) =>
              entry.type === "user.message" && JSON.stringify(entry.payload).includes(marker),
          );
          id = sent?.id;
          return finishedRuns(entries).some((entry) => entry.seq > (sent?.seq ?? Infinity));
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    return id!;
  };

  await sendComposerMessage(page, composer, long("first", 30));
  const firstId = await answered(`first-${stamp} line 1`);
  await sendComposerMessage(page, composer, long("second", 80));
  await answered(`second-${stamp} line 1`);
  const entries = await threadEntries(page, { botId });
  const secondSeq = entries.find(
    (entry) =>
      entry.type === "user.message" && JSON.stringify(entry.payload).includes(`second-${stamp}`),
  )!.seq;

  // A long thread: the latest page starts at the second message, and the jump's window ends
  // before the entry the second message hangs from, so the two pages do not join.
  await reshapeThreadPages(
    page,
    (thread, request) => {
      const around = request.postDataJSON()?.json?.around !== undefined;
      thread.entries = thread.entries.filter((entry) =>
        around ? entry.seq < secondSeq - 1 : entry.seq >= secondSeq,
      );
      thread.olderCursor = thread.entries[0]?.id ?? null;
    },
    /\/rpc\/(bootstrap|threads\/get|threads\/messages)(?:\?|$)/,
  );

  await page.goto(`/app/${botId}?m=${firstId}`);
  const firstRow = transcript.locator(`[data-message-id="${firstId}"]`);
  await expect(firstRow).toBeVisible({ timeout: 20_000 });
  await expect(transcript.getByText(`second-${stamp} line 1`, { exact: false })).toHaveCount(0);

  await sendComposerMessage(
    page,
    page.getByRole("combobox", { name: /^Message/ }),
    `third-${stamp}`,
  );
  const thirdRow = transcript
    .getByTestId("message-user-bubble")
    .filter({ hasText: `third-${stamp}` });
  await expect(thirdRow).toBeInViewport({ timeout: 20_000 });
  await expect(firstRow).toHaveCount(0);
  await answered(`third-${stamp}`);
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
});

/** Simulates a touch hold: a real `pointerdown`/`pointerup` pair (pointerType
 * "touch"), `ms` apart — `Locator.tap()` has no way to control hold duration. */
async function longPress(page: Page, target: Locator, ms: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("longPress target has no bounding box");
  const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true, ...point });
  await page.waitForTimeout(ms);
  await target.dispatchEvent("pointerup", { pointerType: "touch", bubbles: true, ...point });
}

test.describe("touch message actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a tap does nothing; a 450ms hold opens the action sheet", async ({ page }, testInfo) => {
    await signup(page, uniqueEmail("touch-actions"), "password12", "Touch Actions");
    await completeOnboarding(page);
    expect(
      await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
    ).toBe(false);
    await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /Day-to-day work/ }).click();
    const botText = page.getByText(/Got it\./);
    await expect(botText).toBeVisible({ timeout: 20_000 });
    const row = page
      .getByTestId("transcript")
      .locator("[data-message-id]")
      .filter({ has: botText })
      .first();
    const bubble = row.locator('[data-slot="message-row-bubble"]').first();
    const sheet = page.getByRole("dialog", { name: "Message actions" });

    // B1/B2: a touch pointer has no hover to reveal the pill with — the pill
    // never appears on touch at all, and a plain tap opens nothing.
    await expect(row.getByTestId("message-hover-rail")).toHaveCSS("opacity", "0");
    await bubble.tap();
    await expect(sheet).toBeHidden();

    // Releasing before 450ms opens nothing either.
    await longPress(page, bubble, 200);
    await expect(sheet).toBeHidden();

    // A full 450ms hold opens the sheet.
    await longPress(page, bubble, 500);
    await expect(sheet).toBeVisible();
    await captureScreenshot(page, testInfo, "message-actions-sheet-touch");

    // Tapping a reaction reacts and closes the sheet (B2).
    await sheet.getByRole("button", { name: "🎉", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(row.getByTestId("message-reactions")).toHaveText("🎉");

    // Reply from the sheet puts the message in reply, same as the hover pill.
    await longPress(page, bubble, 500);
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Reply", exact: true }).tap();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  });
});
