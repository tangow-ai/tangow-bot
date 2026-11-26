import type { Request, Route } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import type { Locator, Page, TestInfo } from "./test";
import { expect, test } from "./test";
import type { EntryDraft } from "./thread-log";
import { at, runStarted, showThread } from "./thread-log";

const RUN = "draft-run";
const EFFECT = "draft-effect";
const BODY =
  "Hi Bo,\n\nWednesday won't work for me after all. Could we do Thursday instead?\n\nAna";
const EDITED = `${BODY.replace("instead?", "instead? Tell me if 8pm is OK.")}`;
// An invented app logo, inline so the spec never fetches one.
const LOGO = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#3b6fd8"/><path d="M4 6h12v8H4z" fill="none" stroke="#fff" stroke-width="1.5"/><path d="m4 6 6 5 6-5" fill="none" stroke="#fff" stroke-width="1.5"/></svg>',
)}`;

function card(overrides: Record<string, unknown> = {}, draft: Record<string, unknown> = {}) {
  return {
    kind: "ask",
    approvalEffectId: EFFECT,
    text: "Send this email?",
    status: "pending",
    actions: [
      { id: "allow", label: "Send" },
      { id: "deny", label: "Discard" },
    ],
    draft: {
      app: { name: "Mail", logo: LOGO, account: "ana@example.com" },
      recipients: [
        { role: "to", address: "bo@example.com" },
        { role: "to", address: "cy@example.com" },
        { role: "cc", address: "dee.long-address@partners.example.com" },
        { role: "bcc", address: "ed@example.com" },
      ],
      subject: "Thursday instead of Wednesday",
      body: BODY,
      ...draft,
    },
    ...overrides,
  };
}

function requested(botId: string, id: string, minute: number, block = card()): EntryDraft {
  return {
    id,
    ts: at(minute),
    type: "effect.requested",
    botId,
    runId: RUN,
    payload: { effectId: EFFECT, effectKind: "connector", proposal: {}, card: block },
  };
}

function resolved(
  botId: string,
  id: string,
  minute: number,
  decision: "approved" | "denied",
  dismissed?: true,
): EntryDraft {
  return {
    id,
    ts: at(minute),
    type: "effect.resolved",
    botId,
    runId: RUN,
    payload: { effectId: EFFECT, decision, ...(dismissed ? { dismissed } : {}) },
  };
}

/** The bot asked to send a message and waits on its draft. */
function waitingDraft(
  botId: string,
  block = card(),
  ask = "Email Bo and Cy that Thursday works better.",
  ready = "Ready for Bo.",
): EntryDraft[] {
  return [
    {
      id: "draft-request",
      ts: at(10),
      type: "user.message",
      payload: { blocks: [{ kind: "text", text: ask }], source: "app" },
    },
    runStarted(botId, RUN, 10, "draft-request"),
    {
      id: "draft-reply",
      ts: at(11),
      type: "assistant.text",
      botId,
      runId: RUN,
      payload: { toPerson: true, midTurn: true, blocks: [{ kind: "text", text: ready }] },
    },
    requested(botId, "draft-card", 11, block),
  ];
}

/** What the server logs once a Send left: the edited card, the approval, the sent mail. */
function sentAfter(
  botId: string,
  target: string,
  body: string,
  draft: Record<string, unknown> = {},
): EntryDraft[] {
  return [
    {
      id: `${target}-edited`,
      ts: at(12),
      type: "effect.edited",
      botId,
      runId: RUN,
      payload: { effectId: EFFECT, proposal: {}, card: card({}, { body, ...draft }) },
    },
    resolved(botId, `${target}-approved`, 12, "approved"),
    {
      id: `${target}-sent`,
      ts: at(12),
      type: "effect.applied",
      botId,
      runId: RUN,
      payload: { target, sent: { at: "2026-09-17T10:44:00.000Z", edited: body !== BODY } },
    },
  ];
}

/** The sent card leads with a 28 px success disc to the left of its title, the only green. */
async function expectSuccessDiscFirst(draftCard: Locator) {
  const disc = draftCard.locator(".bg-success");
  const [box, title] = await Promise.all([
    disc.boundingBox(),
    draftCard.getByText("Sent", { exact: true }).boundingBox(),
  ]);
  expect(box!.width).toBe(28);
  expect(box!.x + box!.width).toBeLessThan(title!.x);
  await expect(disc).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
}

type Captured = { body: Record<string, unknown> | undefined };

/** A send the server refuses, as it does when no waiting card took the draft's text. */
const CONFLICT = { status: 409, code: "CONFLICT", message: "This draft is no longer waiting." };

/**
 * The served app has no mail connector to send through, so Send, Discard and a typed reply are
 * answered here: each records what the card asked for and logs what the server would have.
 */
async function answerRpc(
  page: Page,
  procedure: "answer" | "send",
  respond: (body: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const captured: Captured = { body: undefined };
  await page.route(new RegExp(`/rpc/threads/${procedure}(?:\\?|$)`), async (route: Route) => {
    const request: Request = route.request();
    const body = (request.postDataJSON() as { json: Record<string, unknown> }).json;
    captured.body = body;
    const output = await respond(body);
    const refused = output === CONFLICT;
    await route.fulfill({
      status: refused ? CONFLICT.status : 200,
      contentType: "application/json",
      body: JSON.stringify({ json: refused ? { defined: false, ...CONFLICT } : output, meta: [] }),
    });
  });
  return captured;
}

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const width = page.viewportSize()?.width;
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await captureScreenshot(page, testInfo, `outbound-draft-${name}-${theme}-${width}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

for (const width of [1440, 390]) {
  test(`a mail draft is edited in place, sent, retried, discarded and replaced (${width})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signup(page, uniqueEmail(`outbound-draft-${width}`), "password12", "Ana Lima");
    await completeOnboarding(page);
    const botId = activeBotId(page);
    const drafts = waitingDraft(botId);
    const reset = async (entries: EntryDraft[]) => {
      drafts.splice(0, drafts.length, ...entries);
      await page.reload({ waitUntil: "domcontentloaded" });
    };
    let onAnswer: (body: Record<string, unknown>) => void = () => undefined;
    const answered = await answerRpc(page, "answer", (body) => {
      onAnswer(body);
      return { ok: true };
    });
    let refuseSend = false;
    const sent = await answerRpc(page, "send", (body) => {
      if (refuseSend) {
        refuseSend = false;
        return CONFLICT;
      }
      drafts.push(resolved(botId, "draft-replaced", 13, "denied", true), {
        id: "draft-typed",
        ts: at(13),
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: body.text }], source: "app" },
      });
      return { taskId: "draft-task", runId: RUN, seq: 99 };
    });
    // The Undo window is timed: the spec moves the page's clock past it instead of waiting.
    await page.clock.install();
    await showThread(page, drafts, { run: null });
    // A send the server took, whose thread then fails to load: the reply is in, nothing to retry.
    let failNextRefresh = false;
    await page.route(/\/rpc\/threads\/get(?:\?|$)/, async (route) => {
      if (!failNextRefresh) return route.fallback();
      failNextRefresh = false;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          json: { defined: false, code: "INTERNAL_SERVER_ERROR", status: 500, message: "Offline" },
          meta: [],
        }),
      });
    });

    const draftCard = page.getByTestId("draft-card");
    const text = draftCard.getByRole("textbox", { name: "Edit message", exact: true });
    const header = draftCard.locator('[data-slot="framed-block-header"]');
    const button = (name: string) => draftCard.getByRole("button", { name, exact: true });

    // At rest: the app and account, every recipient by role, the subject, the text, nothing else.
    await expect(header).toHaveText("Mail");
    await expect(draftCard.getByText("Ana Lima", { exact: true })).toBeVisible();
    await expect(draftCard.getByText("ana@example.com", { exact: true })).toBeVisible();
    await expect(
      draftCard.getByText("bo@example.com, cy@example.com", { exact: true }),
    ).toBeVisible();
    await expect(
      draftCard.getByText("dee.long-address@partners.example.com", { exact: true }),
    ).toBeVisible();
    await expect(draftCard.getByText("ed@example.com", { exact: true })).toBeVisible();
    await expect(
      draftCard.getByText("Thursday instead of Wednesday", { exact: true }),
    ).toBeVisible();
    // Labels share one column and the values start together.
    const [toLabel, toValue, subjectValue] = await Promise.all([
      draftCard.getByText("To", { exact: true }).boundingBox(),
      draftCard.getByText("bo@example.com, cy@example.com", { exact: true }).boundingBox(),
      draftCard.getByText("Thursday instead of Wednesday", { exact: true }).boundingBox(),
    ]);
    expect(toLabel!.x).toBeLessThan(toValue!.x);
    expect(toValue!.x).toBeCloseTo(subjectValue!.x, 0);
    await expect(text).toHaveValue(BODY);
    await expect(draftCard.locator('[data-slot="framed-block-status"]')).toHaveCount(0);
    const [trash, copy, send] = await Promise.all(
      ["Discard", "Copy", "Send"].map((name) => button(name).boundingBox()),
    );
    expect(trash!.x).toBeLessThan(copy!.x);
    expect(copy!.x).toBeLessThan(send!.x);
    await expect(button("Send")).toHaveAttribute("data-consequential", "true");
    await shoot(page, testInfo, "rest");

    // Editing in place: the state reads Editing while typing, Edited once the field is left.
    await text.click();
    await expect(header).toContainText("Editing");
    await expect(text).toHaveCSS("box-shadow", /0px 0px 0px 1\.5px/);
    await text.fill(EDITED);
    // The row's hover pill straddles the card's top edge: it never covers the Editing status.
    await draftCard.hover();
    const pill = page.locator('[data-message-id="draft-card"] [data-slot="hover-pill"]');
    await expect(pill).toHaveCSS("opacity", "1");
    const [pillBox, statusBox, cardBox] = await Promise.all([
      pill.boundingBox(),
      draftCard.locator('[data-slot="framed-block-status"]').boundingBox(),
      draftCard.boundingBox(),
    ]);
    expect(pillBox!.y + pillBox!.height).toBeLessThanOrEqual(statusBox!.y);
    expect(pillBox!.y).toBeLessThan(cardBox!.y);
    await captureScreenshot(page, testInfo, `outbound-draft-editing-pill-${width}`);
    await shoot(page, testInfo, "editing");
    await draftCard.getByText("Subject").click();
    await expect(header).toContainText("Edited");

    // Send carries the edited text, then the card settles on the bot's paper.
    onAnswer = () => drafts.push(...sentAfter(botId, "draft-card", EDITED));
    await button("Send").click();
    await expect(draftCard).toHaveAttribute("data-answered", "true");
    expect(answered.body).toMatchObject({
      runId: RUN,
      messageId: "draft-card",
      answer: "allow",
      edits: { text: EDITED },
    });
    // The settled card: the success disc leads, then Sent and its time, who it went to, and the
    // subject behind the app's mark. The text itself is gone.
    await expect(draftCard.getByText("Sent", { exact: true })).toBeVisible();
    await expect(draftCard.getByText(/^\d{1,2}:\d{2}/)).toBeVisible();
    await expect(
      draftCard.getByText("to bo@example.com, cy@example.com", { exact: true }),
    ).toBeVisible();
    await expect(draftCard).toContainText("Thursday instead of Wednesday");
    await expect(draftCard).not.toContainText("Tell me if 8pm is OK.");
    await expectSuccessDiscFirst(draftCard);
    await shoot(page, testInfo, "sent");

    // A send that did not leave opens again, Not sent with its reason, answered under its new entry.
    const failure = { reason: "Mail is disconnected.", disconnected: true };
    await reset([
      ...waitingDraft(botId),
      resolved(botId, "draft-approved", 12, "approved"),
      requested(botId, "draft-card-again", 13, card({}, { body: EDITED, failure })),
    ]);
    await expect(header).toContainText("Not sent");
    await expect(draftCard.getByText("Mail is disconnected.", { exact: true })).toBeVisible();
    await expect(text).toHaveValue(EDITED);
    await expect(button("Try again")).toHaveCount(0);
    await shoot(page, testInfo, "not-sent");
    await button("Reconnect Mail").click();
    const integrations = page.getByRole("dialog");
    await expect(integrations.getByRole("button", { name: "Close integrations" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(integrations).toHaveCount(0);
    // Still disconnected: the card asks to reconnect again rather than offering a retry that fails.
    onAnswer = () =>
      drafts.push(
        resolved(botId, "draft-approved-again", 14, "approved"),
        requested(botId, "draft-card-third", 15, card({}, { body: EDITED, failure })),
      );
    await button("Try again").click();
    expect(answered.body).toMatchObject({ messageId: "draft-card-again", answer: "allow" });
    await expect(button("Reconnect Mail")).toBeVisible();
    await expect(button("Try again")).toHaveCount(0);
    await button("Reconnect Mail").click();
    await page.keyboard.press("Escape");
    await expect(integrations).toHaveCount(0);
    onAnswer = () => drafts.push(...sentAfter(botId, "draft-card-third", EDITED));
    await button("Try again").click();
    await expect(draftCard.getByText("Sent", { exact: true })).toBeVisible();
    expect(answered.body).toMatchObject({ messageId: "draft-card-third", answer: "allow" });

    // Discard waits five seconds with Undo, then tells the server.
    await reset(waitingDraft(botId));
    answered.body = undefined;
    await button("Discard").click();
    await expect(draftCard).toHaveText("Discarded · Undo");
    await shoot(page, testInfo, "discarded");
    await draftCard.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(button("Send")).toBeVisible();
    await page.clock.fastForward(6_000);
    await expect(button("Send")).toBeVisible();
    expect(answered.body).toBeUndefined();
    onAnswer = () => drafts.push(resolved(botId, "draft-denied", 12, "denied"));
    await button("Discard").click();
    await expect(draftCard).toHaveText("Discarded · Undo");
    await page.clock.fastForward(5_000);
    await expect(draftCard).toHaveText("Discarded");
    expect(answered.body).toMatchObject({ messageId: "draft-card", answer: "deny" });

    // Typing to the bot while the draft waits replaces it and carries the edited text.
    await reset(waitingDraft(botId));
    await text.fill(EDITED);
    const composer = page.locator('textarea[name="chat-message"]');
    // A refused send hands the typed text back instead of losing it.
    refuseSend = true;
    await composer.fill("Make it Friday instead.");
    await composer.press("Enter");
    await expect(page.getByText("This draft is no longer waiting.")).toBeVisible();
    await expect(composer).toHaveValue("Make it Friday instead.");
    failNextRefresh = true;
    await composer.press("Enter");
    await expect.poll(() => failNextRefresh).toBe(false);
    await expect(page.getByText("Offline", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue("");
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(draftCard).toHaveText("Replaced");
    expect(sent.body).toMatchObject({
      text: "Make it Friday instead.",
      draft: { messageId: "draft-card", text: EDITED },
    });
    await shoot(page, testInfo, "replaced");

    // Another member of the thread sees the owner's draft, read-only and with no actions.
    const owner = { userId: "another-member", name: "Bo Chen" };
    await reset([
      ...waitingDraft(botId).slice(0, -1),
      requested(botId, "draft-card", 11, card({}, { owner })),
    ]);
    await expect(draftCard.getByText("BC", { exact: true })).toBeVisible();
    await expect(draftCard.getByRole("textbox")).toHaveCount(0);
    await expect(draftCard.getByRole("button")).toHaveCount(0);
    await expect(
      draftCard.getByText("Could we do Thursday instead?", { exact: false }),
    ).toBeVisible();
  });
}

const CHAT_BODY =
  "Hey Marie, Wednesday won't work for me after all, sorry! Thursday instead? Same place, same time.";
const CHAT_EDITED = `${CHAT_BODY} Tell me if 8pm is OK.`;
const CHAT = {
  app: {
    name: "Acme Chat",
    logo: null,
  },
  recipients: [{ role: "to", address: "#launch" }],
  chat: true,
  subject: undefined,
};

for (const width of [1440, 390]) {
  test(`a chat draft shows its conversation, and only its text changes (${width})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signup(page, uniqueEmail(`outbound-chat-${width}`), "password12", "Ana Lima");
    await completeOnboarding(page);
    const botId = activeBotId(page);
    const waiting = (draft: Record<string, unknown> = {}) =>
      waitingDraft(
        botId,
        card({}, { ...CHAT, body: CHAT_BODY, ...draft }),
        "Tell the team in the chat I can't make Wednesday, Thursday instead?",
        "Ready for the team.",
      );
    const drafts = waiting();
    let onAnswer: () => void = () => undefined;
    const answered = await answerRpc(page, "answer", () => {
      onAnswer();
      return { ok: true };
    });
    await showThread(page, drafts, { run: null });

    const draftCard = page.getByTestId("draft-card");
    const text = draftCard.getByRole("textbox", { name: "Edit message", exact: true });
    const header = draftCard.locator('[data-slot="framed-block-header"]');

    await expect(header).toHaveText("Acme Chat");
    await expect(draftCard.getByText("#launch", { exact: true })).toBeVisible();
    await expect(draftCard).not.toContainText("Subject");
    await expect(draftCard.getByRole("textbox")).toHaveCount(1);
    await expect(text).toHaveValue(CHAT_BODY);
    await shoot(page, testInfo, "chat-rest");

    await text.click();
    await expect(header).toContainText("Editing");
    await text.fill(CHAT_EDITED);
    await shoot(page, testInfo, "chat-editing");
    await draftCard.getByText("#launch", { exact: true }).click();
    await expect(header).toContainText("Edited");

    onAnswer = () => drafts.push(...sentAfter(botId, "draft-card", CHAT_EDITED, CHAT));
    await draftCard.getByRole("button", { name: "Send", exact: true }).click();
    await expect(draftCard).toHaveAttribute("data-answered", "true");
    expect(answered.body).toMatchObject({ messageId: "draft-card", answer: "allow" });
    expect(answered.body?.edits).toEqual({ text: CHAT_EDITED });
    await expect(draftCard.getByText("to #launch", { exact: true })).toBeVisible();
    // The text's first line stands for the message: a chat message has no subject.
    await expect(draftCard).toContainText("Tell me if 8pm is OK.");
    await expectSuccessDiscFirst(draftCard);
    await shoot(page, testInfo, "chat-sent");
  });
}

test("an app without a catalog logo shows its bundled mark, or a neutral glyph, never a letter", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, uniqueEmail("outbound-marks"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const drafts = waitingDraft(botId, card({}, { app: { name: "Gmail", logo: null } }));
  await showThread(page, drafts, { run: null });
  const icon = page
    .getByTestId("draft-card")
    .locator('[data-slot="framed-block-header"]')
    .locator("svg, img");
  const shown = async (app: string, chat?: true) => {
    drafts.splice(
      0,
      drafts.length,
      ...waitingDraft(botId, card({}, { app: { name: app, logo: null }, chat })),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(icon).toHaveCount(1);
    await shoot(page, testInfo, `mark-${app.toLowerCase().replace(/\W+/g, "-")}`);
  };
  await expect(icon).toHaveAttribute("viewBox", "52 42 88 66");
  await shoot(page, testInfo, "mark-gmail");
  await shown("Microsoft Outlook");
  await expect(icon).toHaveAttribute("viewBox", "0 0 32 32");
  await shown("Slack", true);
  await expect(icon).toHaveAttribute("viewBox", "0 0 127 127");
  await shown("Fastmail");
  await expect(icon).toHaveClass(/lucide-mail/);
  await shown("Mattermost", true);
  await expect(icon).toHaveClass(/lucide-message-square/);
  await expect(page.getByTestId("draft-card")).not.toContainText(/^M\b/);
});

test("a discard still reaches its own thread when the person moves to another one within Undo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, uniqueEmail("outbound-draft-move"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const other = await rpc<{ id: string }>(page, "bots/create", {
    name: "Scout",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const answered = await answerRpc(page, "answer", () => ({ ok: true }));
  await showThread(page, waitingDraft(botId), { run: null });
  const draftCard = page.getByTestId("draft-card");
  await draftCard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(draftCard).toContainText("Discarded · Undo");

  await page.getByText("Scout", { exact: true }).filter({ visible: true }).first().click();
  await page.waitForURL(new RegExp(`/app/${other.id}$`));
  await expect
    .poll(() => answered.body)
    .toMatchObject({
      botId,
      runId: RUN,
      messageId: "draft-card",
      answer: "deny",
    });
});

/** A draft that records where its recipients and subject sit: every line is offered for editing. */
const fielded = card(
  {},
  {
    recipients: [
      { role: "to", address: "bo@example.com" },
      { role: "to", address: "cy@example.com" },
    ],
    fields: { to: null, cc: null, bcc: null, subject: true },
  },
);

for (const width of [1440, 390]) {
  test(`a mail draft's recipients and subject are edited in place and leave as shown (${width})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signup(page, uniqueEmail(`outbound-fields-${width}`), "password12", "Ana Lima");
    await completeOnboarding(page);
    const botId = activeBotId(page);
    const waiting = (block = fielded) => [
      ...waitingDraft(botId).slice(0, -1),
      requested(botId, "draft-card", 11, block),
    ];
    const drafts = waiting();
    const reset = async (entries: EntryDraft[]) => {
      drafts.splice(0, drafts.length, ...entries);
      await page.reload({ waitUntil: "domcontentloaded" });
    };
    let onAnswer: () => void = () => undefined;
    const answered = await answerRpc(page, "answer", () => {
      onAnswer();
      return { ok: true };
    });
    const sent = await answerRpc(page, "send", (body) => {
      drafts.push(resolved(botId, "draft-replaced", 13, "denied", true), {
        id: "draft-typed",
        ts: at(13),
        type: "user.message",
        payload: { blocks: [{ kind: "text", text: body.text }], source: "app" },
      });
      return { taskId: "draft-task", runId: RUN, seq: 99 };
    });
    await showThread(page, drafts, { run: null });

    const draftCard = page.getByTestId("draft-card");
    const header = draftCard.locator('[data-slot="framed-block-header"]');
    const button = (name: string) => draftCard.getByRole("button", { name, exact: true });
    const field = (name: string) => draftCard.getByRole("textbox", { name, exact: true });
    const [to, cc, bcc, subject] = ["To", "Cc", "Bcc", "Subject"].map(field);
    const send = button("Send");

    // At rest: the addresses as text, the subject, no empty Cc or Bcc line and no state.
    await expect(draftCard.getByText("bo@example.com,", { exact: true })).toBeVisible();
    await expect(cc).toHaveCount(0);
    await expect(bcc).toHaveCount(0);
    await expect(subject).toHaveValue("Thursday instead of Wednesday");
    await expect(draftCard.locator('[data-slot="framed-block-status"]')).toHaveCount(0);
    const remove = button("Remove cy@example.com");
    await expect(remove).toHaveCount(0);
    await expect(button("Cc")).toHaveCount(0);
    await shoot(page, testInfo, "fields-rest");

    // Editing starts: each line becomes a 44 px field and its text stays where it was read.
    const readAt = (await draftCard.getByText("bo@example.com,", { exact: true }).boundingBox())!;
    const subjectCell = subject.locator("xpath=..");
    expect((await subjectCell.boundingBox())!.height).toBeLessThan(44);
    // The focused To line offers the Cc and Bcc the send accepts; pressing one opens its field.
    await to.focus();
    const editAt = (await draftCard.getByText("bo@example.com", { exact: true }).boundingBox())!;
    expect(editAt.x).toBeCloseTo(readAt.x, 0);
    expect((await to.locator("xpath=..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await subjectCell.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(button("Cc")).toBeVisible();
    await expect(button("Bcc")).toBeVisible();
    const [removeBox, ccBox] = await Promise.all([
      remove.boundingBox(),
      button("Cc").boundingBox(),
    ]);
    expect(removeBox!.width).toBeGreaterThanOrEqual(24);
    expect(ccBox!.height).toBeGreaterThanOrEqual(24);
    await shoot(page, testInfo, "fields-cc-reveal");
    // Typing folds them away: the field runs to the line's end for a long address.
    await to.pressSequentially("lou@exa");
    await expect(button("Cc")).toHaveCount(0);
    const [toBox, toLine] = await Promise.all([
      to.boundingBox(),
      to.locator("xpath=..").boundingBox(),
    ]);
    // The field's inner padding is 8 px.
    expect(toBox!.x + toBox!.width).toBeCloseTo(toLine!.x + toLine!.width - 8, 0);
    await to.fill("");
    await button("Cc").click();
    await expect(cc).toBeFocused();
    await expect(button("Cc")).toHaveCount(0);

    // An edited line offers each address's remove button; a typed address joins the line.
    await remove.click();
    await expect(header).toContainText("Editing");
    await to.fill("lou@example.com");
    await to.press("Enter");
    await expect(draftCard.getByText("lou@example.com", { exact: true })).toBeVisible();
    // Backspace in an empty field takes the line's last address back off.
    await to.press("Backspace");
    await expect(draftCard.getByText("lou@example.com", { exact: true })).toHaveCount(0);
    await to.fill("lou@example.com,");
    await expect(draftCard.getByText("lou@example.com", { exact: true })).toBeVisible();
    // The same address in another case is already on the line.
    await to.fill("Bo@Example.com,");
    await expect(to).toHaveValue("");
    await expect(draftCard.getByText("Bo@Example.com", { exact: true })).toHaveCount(0);

    // A finished word that is not an address stays in the field, marked, and Send waits for it.
    // An unfinished one marks nothing and holds nothing back.
    await cc.fill("dee@partners.exa");
    await expect(cc).not.toHaveAttribute("aria-invalid");
    await expect(send).toBeEnabled();
    await cc.fill("dee at partners");
    await expect(cc).toHaveAttribute("aria-invalid", "true");
    await expect(cc).toHaveCSS("text-decoration-style", "wavy");
    await expect(send).toBeDisabled();
    // Discard then Undo brings the card back as it was left, half-typed text included.
    await button("Discard").click();
    await expect(draftCard).toHaveText("Discarded · Undo");
    await draftCard.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(cc).toHaveValue("dee at partners ");
    await expect(cc).toHaveAttribute("aria-invalid", "true");
    await expect(send).toBeDisabled();
    await cc.fill("dee@partners.example.com,");
    await expect(cc).toHaveValue("");
    await expect(send).toBeEnabled();

    // The subject stays on one line the server takes, and wraps when it is long.
    await subject.fill("Friday\ninstead of Wednesday");
    await expect(subject).toHaveValue("Friday instead of Wednesday");
    await subject.press("Enter");
    await expect(subject).toHaveValue("Friday instead of Wednesday");
    // A pasted line break becomes a space, and the caret stays after the pasted text.
    await subject.evaluate((field: HTMLTextAreaElement) => {
      field.focus();
      field.setSelectionRange(6, 6);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", " the\n13th");
      field.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    await expect(subject).toHaveValue("Friday the 13th instead of Wednesday");
    await page.keyboard.type("!");
    await expect(subject).toHaveValue("Friday the 13th! instead of Wednesday");
    const oneLine = (await subject.boundingBox())!.height;
    await subject.fill(
      `Friday instead of Wednesday, ${"and the week after if Friday is full, ".repeat(4)}`,
    );
    await expect.poll(async () => (await subject.boundingBox())!.height).toBeGreaterThan(oneLine);
    await subject.fill("Friday instead of Wednesday");
    await shoot(page, testInfo, "fields-editing");
    await subject.blur();
    await expect(header).toContainText("Edited");
    await shoot(page, testInfo, "fields-edited");

    // An address still typed when Send is pressed joins the line and leaves with it.
    await to.focus();
    await button("Bcc").click();
    await bcc.pressSequentially("ed@example.com");
    const recipients = [
      { role: "to", address: "bo@example.com" },
      { role: "to", address: "lou@example.com" },
      { role: "cc", address: "dee@partners.example.com" },
      { role: "bcc", address: "ed@example.com" },
    ];
    onAnswer = () =>
      drafts.push(
        ...sentAfter(botId, "draft-card", BODY, {
          recipients,
          subject: "Friday instead of Wednesday",
        }),
      );
    await send.click();
    await expect(draftCard).toHaveAttribute("data-answered", "true");
    expect(answered.body).toMatchObject({
      messageId: "draft-card",
      answer: "allow",
      edits: { recipients, subject: "Friday instead of Wednesday" },
    });
    expect(Object.keys(answered.body?.edits ?? {})).toEqual(["recipients", "subject"]);
    await expect(
      draftCard.getByText("to bo@example.com, lou@example.com", { exact: true }),
    ).toBeVisible();

    // Typing to the bot while the draft waits hands over its lines as they were left.
    await reset(waiting());
    await to.focus();
    await remove.click();
    await subject.fill("Friday instead of Wednesday");
    const composer = page.locator('textarea[name="chat-message"]');
    await composer.fill("Make it Friday instead.");
    await composer.press("Enter");
    await expect(draftCard).toHaveText("Replaced");
    expect(sent.body).toMatchObject({
      text: "Make it Friday instead.",
      draft: {
        messageId: "draft-card",
        text: BODY,
        recipients: [{ role: "to", address: "bo@example.com" }],
        subject: "Friday instead of Wednesday",
      },
    });

    // Another member sees the owner's draft read-only: its lines as text, no field, no action.
    await reset(
      waiting(card({}, { ...fielded.draft, owner: { userId: "another", name: "Bo Chen" } })),
    );
    await expect(
      draftCard.getByText("bo@example.com, cy@example.com", { exact: true }),
    ).toBeVisible();
    await expect(
      draftCard.getByText("Thursday instead of Wednesday", { exact: true }),
    ).toBeVisible();
    await expect(draftCard.getByRole("textbox")).toHaveCount(0);
    await expect(draftCard.getByRole("button")).toHaveCount(0);
  });
}

test("the card keeps its shape while a send is on its way", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, uniqueEmail("outbound-sending"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const hold = () => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  await answerRpc(page, "answer", async () => {
    await gate;
    return { ok: true };
  });
  await showThread(
    page,
    [...waitingDraft(botId).slice(0, -1), requested(botId, "draft-card", 11, fielded)],
    { run: null },
  );
  const draftCard = page.getByTestId("draft-card");
  const height = async () => (await draftCard.boundingBox())!.height;

  // Pressing Send, at rest and then with the lines turned into fields, changes nothing in the
  // card's height: Send stays under the pointer, and the fields only stop taking typing.
  for (const touched of [false, true]) {
    if (touched) await draftCard.getByRole("textbox", { name: "Subject", exact: true }).focus();
    const before = await height();
    hold();
    await draftCard.getByRole("button", { name: "Send", exact: true }).click();
    await expect(draftCard.getByRole("button", { name: "Sending…", exact: true })).toBeVisible();
    expect(await height()).toBe(before);
    await expect(draftCard.getByRole("textbox", { name: "Subject", exact: true })).toHaveJSProperty(
      "readOnly",
      true,
    );
    if (touched) await shoot(page, testInfo, "sending");
    release();
    await expect(draftCard.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    expect(await height()).toBe(before);
  }
});

test("a sent card fits a 320 px screen without scrolling the thread sideways", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await signup(page, uniqueEmail("outbound-narrow"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await showThread(page, [...waitingDraft(botId), ...sentAfter(botId, "draft-card", BODY)], {
    run: null,
  });
  const draftCard = page.getByTestId("draft-card");
  await expect(draftCard).toHaveAttribute("data-answered", "true");
  const overflow = await page
    .getByTestId("transcript")
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = (await draftCard.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await shoot(page, testInfo, "sent-narrow");
});

test("a full recipient line is a keyboard stop that starts editing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, uniqueEmail("outbound-keys"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const oneTo = card(
    {},
    { recipients: [{ role: "to", address: "bo@example.com" }], fields: { to: 1, subject: true } },
  );
  await showThread(
    page,
    [...waitingDraft(botId).slice(0, -1), requested(botId, "draft-card", 11, oneTo)],
    { run: null },
  );
  const draftCard = page.getByTestId("draft-card");
  const line = draftCard.getByRole("group", { name: "To", exact: true });

  // Tab from the From line lands on the To line, which has no field: it names itself and, once
  // focused, starts editing.
  await draftCard.getByText("Ana Lima", { exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(line).toBeFocused();
  await expect(draftCard.locator('[data-slot="framed-block-header"]')).toContainText("Editing");
  await expect(draftCard.locator("label[for]").filter({ hasText: /^To$/ })).toHaveCount(0);
  // Tab reaches the address's remove button; pressing it takes the address off and opens the field.
  await page.keyboard.press("Tab");
  const remove = draftCard.getByRole("button", { name: "Remove bo@example.com", exact: true });
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(draftCard.getByRole("textbox", { name: "To", exact: true })).toBeFocused();
});

test("a one-address line keeps what does not fit in its field, marked", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signup(page, uniqueEmail("outbound-one"), "password12", "Ana Lima");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const oneTo = card(
    {},
    { recipients: [{ role: "to", address: "bo@example.com" }], fields: { to: 1, subject: true } },
  );
  await showThread(
    page,
    [...waitingDraft(botId).slice(0, -1), requested(botId, "draft-card", 11, oneTo)],
    {
      run: null,
    },
  );
  const draftCard = page.getByTestId("draft-card");
  const to = draftCard.getByRole("textbox", { name: "To", exact: true });
  const send = draftCard.getByRole("button", { name: "Send", exact: true });

  // A full line has no field; pressing it starts editing, and removing its address opens the
  // field, focused.
  await expect(to).toHaveCount(0);
  await draftCard.getByText("bo@example.com", { exact: true }).click();
  await draftCard.getByRole("button", { name: "Remove bo@example.com", exact: true }).click();
  await expect(to).toBeFocused();

  // The first address fills the line; the field stays with the rest, marked, and Send waits.
  await to.pressSequentially("foo cy@example.com dee@example.com,");
  await expect(draftCard.getByText("cy@example.com", { exact: true })).toBeVisible();
  await expect(to).toHaveValue("foo dee@example.com ");
  await expect(to).toHaveAttribute("aria-invalid", "true");
  await expect(send).toBeDisabled();
  // A full line keeps its field while it has focus, and folds it once left.
  await to.fill("");
  await expect(to).toBeFocused();
  await expect(send).toBeEnabled();
  await to.blur();
  await expect(to).toHaveCount(0);
});

test.describe("the open card's shadow", () => {
  // Twice the pixels: a shadow cut by an ancestor shows as a hard edge in the capture.
  test.use({ deviceScaleFactor: 2 });

  test("has room inside every ancestor that clips it", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signup(page, uniqueEmail("outbound-shadow"), "password12", "Ana Lima");
    await completeOnboarding(page);
    await showThread(page, waitingDraft(activeBotId(page)), { run: null });
    const draftCard = page.getByTestId("draft-card");
    await expect(draftCard).toBeVisible();

    // shadow-card reaches 20 px sideways in light and 28 in dark by its blur radius, where the
    // visible part ends well short of it; below, 44 px at the widest.
    const room = await draftCard.evaluate((card) => {
      const box = card.getBoundingClientRect();
      const rooms: { sides: number; below: number }[] = [];
      for (let el = card.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const edge = el.getBoundingClientRect();
        rooms.push({
          sides: Math.min(box.left - edge.left, edge.left + el.clientWidth - box.right),
          below: parseFloat(style.paddingBottom),
        });
      }
      return rooms;
    });
    expect(room.length).toBeGreaterThan(0);
    // The shell's own overflow sits a column and a sidebar away: only the nearest clip is tight.
    expect(room[0]!.sides).toBeGreaterThanOrEqual(26);
    expect(room[0]!.below).toBeGreaterThanOrEqual(44);
    // The scroller reaches no further than the column it sits in.
    const sticksOut = await page.getByTestId("transcript").evaluate((scroller) => {
      const column = scroller.parentElement!.parentElement!.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      return Math.max(column.left - box.left, box.right - column.right);
    });
    expect(sticksOut).toBeLessThanOrEqual(0);

    const box = (await draftCard.boundingBox())!;
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const path = testInfo.outputPath(`outbound-draft-shadow-room-${theme}-1440.png`);
      await page.screenshot({
        path,
        clip: { x: box.x - 60, y: box.y - 20, width: box.width + 120, height: box.height + 90 },
      });
      await testInfo.attach(`shadow-room-${theme}`, { contentType: "image/png", path });
    }
  });
});
