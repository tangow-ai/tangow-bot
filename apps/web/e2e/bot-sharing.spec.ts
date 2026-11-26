import type { BotSharing } from "@tangow/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  inviteToSpace,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("a bot shared with one person gives them their own thread until it is unshared", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  await signup(page, uniqueEmail("share-owner"), "password12", "Ada Owner");
  await completeOnboarding(page);
  const { spaceId } = await rpc<{ spaceId: string }>(page, "me", undefined);
  await rpc(page, "spaces/rename", { spaceId, name: "Studio" });
  const guestEmail = uniqueEmail("share-guest");
  const inviteUrl = await inviteToSpace(page, spaceId, guestEmail);
  const botId = await createNamedBot(page, "Release notes");
  await rpc(page, "agentSkills/create", {
    name: "Changelog",
    description: "Write the changelog",
    body: "Steps",
  });
  const ownerGmail = await rpc<{ connectionId: string }>(page, "connections/begin", {
    connectorId: "composio",
    provider: "GMAIL",
    displayName: "Gmail",
  });
  const linear = await rpc<{ id: string }>(page, "mcp/servers/create", {
    slug: "linear",
    name: "Linear",
    transport: "streamable_http",
    endpoint: "https://mcp.linear.example/mcp",
    headers: { "X-Api-Key": "owner-key" },
    enabled: true,
  });
  await rpc(page, "mcp/assignments/replace", { botId, assignments: [{ serverId: linear.id }] });

  const guestContext = await browser.newContext({ baseURL });
  const guest = await guestContext.newPage();
  await signup(guest, guestEmail, "password12", "Grace Guest");
  await completeOnboarding(guest);
  await guest.goto(inviteUrl);
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await guest.waitForURL(/\/app/);
  const guestSidebar = guest.locator("aside").first();
  await expect(guestSidebar.getByRole("button", { name: /^Release notes/ })).toHaveCount(0);

  const ownerRow = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Release notes/ });
  await ownerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const sheet = page.getByTestId("share-bot-dialog");
  await expect(sheet.getByRole("heading", { name: "Share Release notes" })).toBeVisible();
  const grace = sheet.getByRole("checkbox", { name: "Grace Guest" });
  const filesNote = sheet.getByText(
    "Everyone who uses this bot can see its files and browser sign-ins.",
  );
  const skillsHeading = sheet.getByRole("heading", { name: "Skills this bot can use" });
  const changelog = sheet.getByRole("checkbox", { name: "Changelog" });
  const appsHeading = sheet.getByRole("heading", { name: "Apps this bot can use" });
  const gmail = sheet.getByRole("checkbox", { name: "Gmail" });
  const linearBox = sheet.getByRole("checkbox", { name: "Linear" });
  await expect(filesNote).toHaveCount(0);
  await expect(skillsHeading).toHaveCount(0);
  await expect(appsHeading).toHaveCount(0);
  await grace.click();
  await expect(grace).toBeChecked();
  await expect(filesNote).toBeVisible();
  await expect(sheet.getByRole("switch", { name: "Everyone in Studio" })).not.toBeChecked();
  await expect(skillsHeading).toBeVisible();
  await expect(changelog).not.toBeChecked();
  await changelog.click();
  await expect(changelog).toBeChecked();
  await expect(appsHeading).toBeVisible();
  await expect(gmail).not.toBeChecked();
  await gmail.click();
  await expect(gmail).toBeChecked();
  await linearBox.click();
  await expect(linearBox).toBeChecked();
  await captureScreenshot(page, testInfo, "share-sheet");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "share-sheet-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await guest.reload();
  await guestSidebar.getByRole("button", { name: /^Release notes/ }).click();
  await expect(guest.getByTestId("open-settings-panel")).toHaveCount(0);
  await guest.getByPlaceholder("Message Release notes").fill("Hello from Grace");
  await guest.keyboard.press("Enter");
  await expect(guest.getByText("Hello from Grace")).toBeVisible();
  const gmailCard = guest.getByRole("group", { name: "Gmail connection" });
  await expect(gmailCard.getByRole("button", { name: "Authorize" })).toBeVisible();
  await guest.mouse.move(1, 1);
  await captureScreenshot(guest, testInfo, "shared-bot-member-thread");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "shared-bot-member-thread-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });

  // The member adds the declared MCP server with their own key, in the form filled in for them.
  const linearCard = guest.getByRole("group", { name: "Linear connection" });
  await linearCard.getByRole("button", { name: "Add" }).click();
  const serverUrl = guest.getByLabel("App URL");
  await expect(serverUrl).toHaveValue("https://mcp.linear.example/mcp");
  await expect(serverUrl).toHaveAttribute("readonly", "");
  await expect(guest.getByLabel("Server name")).toHaveValue("Linear");
  const memberKey = guest.getByLabel("X-Api-Key");
  await expect(memberKey).toHaveValue("");
  await captureScreenshot(guest, testInfo, "declared-mcp-form");
  await guest.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(guest, testInfo, "declared-mcp-form-phone");
  await guest.setViewportSize({ width: 1280, height: 720 });
  await memberKey.fill("grace-key");
  const added = guest.waitForResponse(
    (response) => response.url().endsWith("/rpc/bots/addDeclaredMcp") && response.ok(),
  );
  await guest.getByRole("button", { name: "Add", exact: true }).click();
  await expect(guest.getByLabel("Server name")).toBeHidden();
  // Their own copy, with the key they typed.
  await expect(guest.getByRole("button", { name: "Actions for Linear" })).toBeVisible();
  expect((await (await added).json()).json).toMatchObject({ name: "Linear", hasSecret: true });
  await guest.keyboard.press("Escape");
  await expect(linearCard.getByText("Connected")).toBeVisible();

  await page.reload();
  await expect(page.getByPlaceholder("Message Release notes")).toBeVisible();
  await expect(page.getByText("Hello from Grace")).toHaveCount(0);

  // A declared app the owner has since disconnected, or a server they deleted, stays listed, so
  // it can still be unticked.
  await rpc(page, "connections/revoke", { connectionId: ownerGmail.connectionId });
  await rpc(page, "mcp/servers/remove", { id: linear.id });
  await ownerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const deleted = sheet.getByRole("checkbox", { name: "Deleted" });
  await expect(gmail).toBeChecked();
  await expect(deleted).toBeChecked();
  await gmail.click();
  await expect(gmail).not.toBeChecked();
  await deleted.click();
  await expect(deleted).not.toBeChecked();
  await expect
    .poll(async () => (await rpc<BotSharing>(page, "bots/sharing", { botId })).connectors)
    .toEqual([]);
  await grace.click();
  await expect(grace).not.toBeChecked();
  await expect(filesNote).toHaveCount(0);
  await page.keyboard.press("Escape");

  await guest.reload();
  await expect(guestSidebar.getByRole("button", { name: /^Release notes/ })).toHaveCount(0);
  await guestContext.close();
});
