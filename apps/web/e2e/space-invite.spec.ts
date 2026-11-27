import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("an invite for an email survives sign up and joins only that account to the space", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const stamp = Date.now();
  const guestEmail = `invite-guest-${stamp}@tangow.test`;
  const laterEmail = `invite-later-${stamp}@tangow.test`;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signup(page, `invite-owner-${stamp}@tangow.test`, "password12", "Ada Owner");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "space");
  const name = settings.getByTestId("space-name-input");
  await name.fill("Family");
  await name.press("Enter");
  await expect(settings.getByTestId("settings-space-label")).toContainText("Family");
  const members = settings.getByTestId("space-members");
  await expect(members.getByText("Ada Owner", { exact: true })).toBeVisible();
  await members
    .getByRole("textbox", { name: "Emails to invite" })
    .fill(`${guestEmail}, ${laterEmail}`);
  await members.getByRole("button", { name: "Invite", exact: true }).click();
  const invites = members.getByTestId("space-invite-row");
  await expect(invites).toHaveCount(2);
  const guestInvite = invites.filter({ hasText: guestEmail });
  await expect(guestInvite).toContainText("Expires in 7 days");
  await expect(invites.filter({ hasText: laterEmail })).toHaveCount(1);
  await captureScreenshot(page, testInfo, "space-members-invites");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "space-members-invites-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await guestInvite.getByRole("button", { name: "Copy link" }).click();
  await expect(guestInvite.getByRole("button", { name: "Copied" })).toBeVisible();
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(inviteUrl).pathname).toMatch(/^\/invite\/.+/);

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  const signUpOnSignIn = async (email: string, fullName: string) => {
    await guest.waitForURL(/\/sign-in$/);
    await guest.getByRole("link", { name: "Sign up" }).click();
    await guest.getByLabel("Name").fill(fullName);
    await guest.getByLabel("Email").fill(email);
    await guest.getByLabel("Password", { exact: true }).fill("password12");
    await guest.getByRole("button", { name: "Create account" }).click();
  };

  await guest.goto(inviteUrl);
  await signUpOnSignIn(`invite-other-${stamp}@tangow.test`, "Sam Other");
  await expect(guest.getByText(`This invite is for ${guestEmail}.`)).toBeVisible();
  await expect(guest.getByRole("button", { name: "Join", exact: true })).toHaveCount(0);
  await captureScreenshot(guest, testInfo, "invite-another-account");
  await guest.getByRole("button", { name: "Use another account" }).click();

  await signUpOnSignIn(guestEmail, "Grace Guest");
  await expect(guest.getByRole("heading", { name: "Join Family" })).toBeVisible();
  await expect(guest.getByText("Invited by Ada Owner")).toBeVisible();
  await captureScreenshot(guest, testInfo, "invite-accept");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "invite-accept-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/(app|onboarding)/);
  const { spaceId: ownerSpaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  await expect
    .poll(() => guest.evaluate(() => window.localStorage.getItem("tangow:space-id")))
    .toBe(ownerSpaceId);
  await expect(guest.getByText("Family", { exact: true }).first()).toBeVisible();

  await guest.goto(inviteUrl);
  await expect(guest.getByText("This invite link has expired or was already used.")).toBeVisible();
  await guestContext.close();

  await page.reload();
  const reopened = await openUserSettings(page, "space");
  const roster = reopened.getByTestId("space-members");
  await expect(roster.getByText("Grace Guest", { exact: true })).toBeVisible();
  await expect(roster.getByTestId("space-invite-row")).toHaveText([new RegExp(laterEmail)]);
  await roster.getByRole("button", { name: "Revoke" }).click();
  await expect(roster.getByTestId("space-invite-row")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "space-members");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "space-members-phone");
});
