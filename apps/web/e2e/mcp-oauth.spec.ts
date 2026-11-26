import type { McpServer } from "@tangow/contracts";
import { MCP_OAUTH_CHANNEL } from "../src/lib/mcp-connect";
import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, type Route, test } from "./test";

test("connects an MCP server through the OAuth popup callback", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("mcp-oauth"), "password12", "MCP OAuth");
  await completeOnboarding(page);

  let oauthStatus: McpServer["oauthStatus"] = "none";
  let hasSecret = false;
  let created = false;
  const server: McpServer = {
    id: "mcp-oauth-server",
    spaceId: "mcp-oauth-workspace",
    slug: "linear",
    name: "Linear MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://mcp.linear.test/mcp",
    command: null,
    args: [],
    envKeys: [],
    headerKeys: [],
    hasSecret,
    oauthStatus,
    enabled: true,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  const browserOrigin = new URL(page.url()).origin;
  let releaseCompletion = () => {};
  let markCompletionStarted = () => {};
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const completionStarted = new Promise<void>((resolve) => {
    markCompletionStarted = resolve;
  });

  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: created ? [{ ...server, hasSecret, oauthStatus }] : [] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });
  await page.context().route("**/rpc/mcp/oauth/begin", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        serverId: server.id,
        redirectUri: `${browserOrigin}/mcp/oauth/callback`,
      },
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          status: "authorization_required",
          sessionId: "mcp-oauth-session",
          authorizationUrl: `${browserOrigin}/mcp/oauth/callback?code=fake-code&state=mcp-oauth-session`,
        },
      }),
    });
  });
  await page.context().route("**/rpc/mcp/oauth/complete", async (route: Route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: {
        sessionId: "mcp-oauth-session",
        code: "fake-code",
        state: "mcp-oauth-session",
      },
    });
    markCompletionStarted();
    await completionGate;
    oauthStatus = "connected";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    });
  });

  await page.context().route("**/rpc/mcp/servers/create", async (route) => {
    expect(route.request().postDataJSON().json).toMatchObject({
      name: "Linear",
      slug: "linear",
      transport: "streamable_http",
      botIds: [expect.any(String)],
    });
    created = true;
    await route.fulfill({ json: { json: server } });
  });
  await page.getByTestId("open-customize").click();
  await page.getByTestId("customize-nav-custom-apps").click();
  await expect(page.getByRole("heading", { name: "Custom apps" })).toBeVisible();
  await expect(page.getByLabel("Access token", { exact: true })).toBeHidden();
  await page.getByLabel("App URL", { exact: true }).fill(server.endpoint!);

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const popup = await popupPromise;
  await completionStarted;
  await expect(popup.getByText("Finishing MCP connection…", { exact: true })).toBeVisible();
  await captureScreenshot(popup, testInfo, "mcp-oauth-callback");

  releaseCompletion();
  await expect(page.getByLabel("App URL", { exact: true })).toHaveValue("");
  await expect(page.getByText("Linear MCP", { exact: true })).toBeVisible();
  await expect.poll(() => popup.isClosed()).toBe(true);
  await captureScreenshot(page, testInfo, "mcp-oauth-connected");

  oauthStatus = "reconnect";
  hasSecret = true;
  await page.evaluate((channelName) => {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "mcp-oauth-complete" });
    channel.close();
  }, MCP_OAUTH_CHANNEL);
  await expect(page.getByText("Reconnect needed", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "custom-apps-reconnect-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "custom-apps-reconnect-phone");
});

test("reveals a token only after connection failure, retries and reuses the saved app", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("mcp-token"), "password12", "Custom Apps");
  await completeOnboarding(page);
  let tokenSaved = false;
  let creates = 0;
  await page.route("**/rpc/mcp/servers/create", async (route) => {
    creates++;
    await route.continue();
  });
  await page.route("**/rpc/mcp/oauth/begin", async (route) => {
    if (tokenSaved)
      await route.fulfill({ json: { json: { status: "authorization_not_requested" } } });
    else await route.fulfill({ json: { json: { status: "token_required" } } });
  });
  await page.goto("/integrations/setup?mode=mcp");
  await expect(page.getByRole("heading", { name: "Custom apps" })).toBeVisible();
  await page.getByLabel("App URL", { exact: true }).fill("https://mcp.linear.app/mcp");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
  await expect(page.getByText("This app needs an access token.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Actions for Linear", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "custom-apps-token-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "custom-apps-token-phone");
  await page.route("**/rpc/mcp/servers/update", async (route) => {
    expect(route.request().postDataJSON().json.secret).toBe("fake-access-token");
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    tokenSaved = true;
    await route.fulfill({ response });
  });
  await page.getByLabel("Access token", { exact: true }).fill("fake-access-token");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Access token", { exact: true })).toBeHidden();
  await expect(page.getByText("Linear", { exact: true })).toBeVisible();
  await page.getByLabel("App URL", { exact: true }).fill("https://mcp.linear.app/mcp");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("App URL", { exact: true })).toHaveValue("");
  expect(creates).toBe(1);

  tokenSaved = false;
  await page.getByLabel("App URL", { exact: true }).fill("https://mcp.notion.so/mcp");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Access token", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Access token", { exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Actions for Notion", exact: true })).toBeHidden();
  await page.unroute("**/rpc/mcp/servers/update");
  await page.getByRole("button", { name: "Actions for Linear", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await page.getByLabel("Server name", { exact: true }).fill("Linear notes");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for Linear notes", exact: true }),
  ).toBeVisible();
  const agent = page.getByRole("button", { name: "Chief", exact: true });
  await expect(agent).toHaveAttribute("aria-pressed", "true");
  await agent.click();
  await expect(agent).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Actions for Linear notes", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Confirm delete", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for Linear notes", exact: true }),
  ).toBeHidden();
});
