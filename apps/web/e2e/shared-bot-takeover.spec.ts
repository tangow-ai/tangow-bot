import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  inviteToSpace,
  realSandboxTimeout,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("a member takes over their own screen when their run on a shared bot asks", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signup(page, uniqueEmail("takeover-owner"), "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const guestEmail = uniqueEmail("takeover-guest");
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
  await guest.getByPlaceholder("Message Release notes").fill("install the gsc cli and sign in");
  await guest.keyboard.press("Enter");

  const openFromCard = guest.getByTestId("takeover-open-computer");
  await expect(openFromCard).toHaveCount(1, { timeout: realSandboxTimeout(90_000, 30_000) });
  await openFromCard.click();
  const done = guest.getByRole("button", { name: "I’m done", exact: true }).last();
  await expect(done).toBeVisible();
  await expect(guest.locator('iframe[title="Bot screen"]')).toBeVisible();
  // Teaching and the computer's upkeep stay with the owner.
  await expect(guest.getByTestId("teach-start-button")).toHaveCount(0);
  await captureScreenshot(guest, testInfo, "shared-bot-member-takeover");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "shared-bot-member-takeover-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  await done.click();
  await expect(guest.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(guest.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await guestContext.close();
});

test("in a group, the person whose run asks takes over its bot's screen", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signup(page, uniqueEmail("group-takeover-owner"), "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  const guestEmail = uniqueEmail("group-takeover-guest");
  const inviteUrl = await inviteToSpace(page, spaceId, guestEmail);
  const botId = await createNamedBot(page, "Releaser");
  await rpc(page, "bots/share", { botId, visibility: "space", userIds: [] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, guestEmail, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  const { userId: guestId } = await rpc<{ userId: string }>(guest, "me", undefined);
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Launch crew",
    botIds: [botId],
    userIds: [guestId],
  });

  await guest.goto(`/app/g/${group.id}`);
  const composer = guest.getByRole("combobox", { name: "Message Launch crew" });
  await composer.fill("@Releaser install the gsc cli and sign in");
  await composer.press("Enter");

  const openFromCard = guest.getByTestId("takeover-open-computer");
  await expect(openFromCard).toHaveCount(1, { timeout: realSandboxTimeout(90_000, 30_000) });
  await openFromCard.click();
  const done = guest.getByRole("button", { name: "I’m done", exact: true }).last();
  await expect(done).toBeVisible();
  await expect(guest.locator('iframe[title="Bot screen"]')).toBeVisible();
  await captureScreenshot(guest, testInfo, "group-takeover");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "group-takeover-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  // The run is Grace's: Ada sees its card wait on her, without a way to open it.
  await page.goto(`/app/g/${group.id}`);
  await expect(
    page.getByTestId("transcript").getByText("Waiting for Grace Guest", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("takeover-open-computer")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "group-takeover-others");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "group-takeover-others-phone");
  await page.setViewportSize({ width: 1280, height: 720 });

  await done.click();
  await expect(guest.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(
    guest
      .getByTestId("transcript")
      .getByText(/signed in|session stays/i)
      .first(),
  ).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await guestContext.close();
});
