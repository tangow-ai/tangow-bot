import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  inviteToSpace,
  openNewGroup,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("a group's creator adds a person, who writes in it and leaves", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signup(page, uniqueEmail("group-people-owner"), "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const guestEmail = uniqueEmail("group-people-guest");
  const inviteUrl = await inviteToSpace(page, spaceId, guestEmail);
  // Scout stays Ada's alone; Helper is shared with the Space.
  await createNamedBot(page, "Scout");
  const helperId = await createNamedBot(page, "Helper");
  await rpc(page, "bots/share", { botId: helperId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, guestEmail, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);

  await page.reload();
  await openNewGroup(page);
  const panel = page.getByTestId("side-panel");
  await panel.locator("label:has-text('Name') input").fill("Launch crew");
  await panel.getByRole("button", { name: "Grace Guest" }).click();
  await panel.getByRole("button", { name: "Helper" }).click();
  await panel.getByRole("button", { name: "Scout" }).click();
  await panel.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  // The lead answers a message naming no bot: Ada makes it her own Scout.
  await page.getByTestId("bot-settings-trigger").click();
  await expect(panel.getByRole("button", { name: "Grace Guest" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await panel.getByLabel("Lead bot").selectOption({ label: "Scout" });
  await captureScreenshot(page, testInfo, "group-settings-people");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "group-settings-people-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");

  const composer = page.getByRole("combobox", { name: "Message Launch crew" });
  await composer.fill("Kickoff is at noon.");
  await composer.press("Enter");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Kickoff is at noon.", { exact: true })).toBeVisible();
  // The sidebar's group avatar shows Grace beside the bots.
  await captureScreenshot(page, testInfo, "group-sidebar-people");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Back" }).click();
  const phoneList = page.getByTestId("bots-sidebar");
  await expect(phoneList).toBeVisible();
  await captureScreenshot(page, testInfo, "group-sidebar-people-phone");
  await phoneList.getByRole("button", { name: /^Launch crew/ }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  await page.setViewportSize({ width: 1280, height: 720 });

  // The group is in Grace's own sidebar, and Ada's message carries her name.
  await guest.reload();
  await guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Launch crew/ })
    .click();
  const guestTranscript = guest.getByTestId("transcript");
  await expect(guestTranscript.getByText("Kickoff is at noon.", { exact: true })).toBeVisible();
  await expect(guestTranscript.getByText("Ada Owner", { exact: true })).toBeVisible();

  // Only the bot Grace can wake is offered; Ada's own Scout is not.
  const guestComposer = guest.getByRole("combobox", { name: "Message Launch crew" });
  await guestComposer.fill("@");
  await expect(guest.getByRole("option", { name: "@Helper", exact: true })).toBeVisible();
  await expect(guest.getByRole("option", { name: "@Scout", exact: true })).toHaveCount(0);
  // Naming no bot wakes the lead, Scout, which Grace cannot use: the message stands alone.
  await guestComposer.fill("Works for me.");
  await guestComposer.press("Enter");
  await expect(guestTranscript.getByText("Works for me.", { exact: true })).toBeVisible();
  // A shared history: nobody edits it alone.
  await expect(guest.getByTestId("message-edit")).toHaveCount(0);
  // Helper asks Grace, whose run it is: only she answers.
  await guestComposer.fill("@Helper pick from these cities with tappable choices");
  await guestComposer.press("Enter");
  await expect(guest.getByRole("button", { name: "Berlin", exact: true })).toBeVisible({
    timeout: 60_000,
  });

  await page.reload();
  await expect(transcript.getByText("Works for me.", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Grace Guest", { exact: true })).toBeVisible();
  await expect(transcript.getByText("Which city should I use?", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Berlin", exact: true })).toHaveCount(0);
  await expect(transcript.getByText("Waiting for Grace Guest", { exact: true })).toBeVisible();
  // Ada can still reply to what Grace wrote.
  const graceRow = transcript.locator("[data-message-id]").filter({ hasText: "Works for me." });
  await graceRow.hover();
  await expect(graceRow.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-people-thread");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "group-people-thread-phone");
  await page.setViewportSize({ width: 1280, height: 720 });

  // Grace sees who is in it and changes nothing, then leaves from the sidebar once she confirms.
  await guest.getByTestId("bot-settings-trigger").click();
  const guestPanel = guest.getByTestId("side-panel");
  await expect(guestPanel.getByText("Ada Owner", { exact: true })).toBeVisible();
  await expect(guestPanel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await guest.keyboard.press("Escape");
  const guestRow = guest
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Launch crew/ });
  await guestRow.click({ button: "right" });
  await guest.getByRole("menuitem", { name: "Leave group" }).click();
  const confirm = guest.getByRole("alertdialog", { name: "Leave Launch crew?" });
  await expect(confirm).toBeVisible();
  await captureScreenshot(guest, testInfo, "group-leave-confirm");
  await confirm.getByRole("button", { name: "Leave", exact: true }).click();
  await guest.waitForURL(/\/app\/(?!g\/)[^/]+$/);
  await expect(guestRow).toHaveCount(0);
  await guestContext.close();
});
