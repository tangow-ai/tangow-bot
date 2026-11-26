import type { MemoryDocument } from "@tangow/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  inviteToSpace,
  openBotTab,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("a member's run saves for a shared bot's team, and its owner reads and edits it", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signup(page, uniqueEmail("team-memory-owner"), "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const guestEmail = uniqueEmail("team-memory-guest");
  const inviteUrl = await inviteToSpace(page, spaceId, guestEmail);
  const botId = await createNamedBot(page, "Release notes");
  await rpc(page, "bots/share", { botId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, guestEmail, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  await guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ })
    .click();
  await guest
    .getByPlaceholder("Message Release notes")
    .fill("Remember for the team that release notes go out on Thursdays");
  await guest.keyboard.press("Enter");
  // The reply in the thread, not its preview in the sidebar row.
  await expect(
    guest.getByTestId("message-bot-bubble").getByText("noted for the team."),
  ).toBeVisible();
  await expect(guest.getByText("Saved for the team", { exact: true })).toBeVisible();
  await guest.mouse.move(1, 1);
  await captureScreenshot(guest, testInfo, "team-memory-thread-line");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "team-memory-thread-line-phone");
  await guestContext.close();

  // The owner finds the save under Team memory, beside their own memory of the bot, and edits it.
  await page.reload();
  const knowledge = (await openBotTab(page, "Knowledge")).getByTestId("bot-knowledge");
  const team = knowledge.getByTestId("bot-knowledge-team-memory");
  const teamRow = team.getByRole("button", { name: /MEMORY\.md/ });
  await expect(teamRow).toBeVisible();
  await expect(knowledge.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
  await captureScreenshot(page, testInfo, "team-memory-section");
  await teamRow.click();
  const panel = page.getByTestId("side-panel");
  const editor = panel.locator("textarea");
  await expect(editor).toHaveValue("- release notes go out on Thursdays");
  await editor.fill("- Release notes go out on Thursdays at 10:00");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(team.getByText("rev 2")).toBeVisible();
  expect(await rpc<MemoryDocument[]>(page, "memory/list", { botId, scope: "team" })).toEqual([
    expect.objectContaining({ content: "- Release notes go out on Thursdays at 10:00" }),
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await openBotTab(page, "Knowledge");
  await expect(teamRow).toBeVisible();
  await captureScreenshot(page, testInfo, "team-memory-section-phone");

  // Unsharing keeps what the team saved, on screen as in the prompt.
  await rpc(page, "bots/share", { botId, visibility: "private", userIds: [] });
  await page.reload();
  await openBotTab(page, "Knowledge");
  await expect(teamRow).toBeVisible();

  // A private bot that never had team memory shows no section for it.
  await createNamedBot(page, "Drafts");
  const teamRead = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/memory/list") &&
      Boolean(response.request().postData()?.includes('"team"')),
  );
  await openBotTab(page, "Knowledge");
  await teamRead;
  await expect(knowledge.getByTestId("bot-knowledge-memory")).toBeVisible();
  await expect(team).toHaveCount(0);
});
