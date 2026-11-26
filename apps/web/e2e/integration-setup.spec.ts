import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

test("setup exposes all integration choices and saves only the selected provider", async ({
  page,
}, testInfo) => {
  const saved: unknown[] = [];
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: true,
          webUrl: "https://example.test/integrations/setup",
          providers: [{ id: "composio", configured: false }],
        },
      },
    }),
  );
  await page.route("**/rpc/integrationSetup/save", (route) => {
    saved.push(route.request().postDataJSON());
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await signup(page, uniqueEmail("integration-setup"), "password12", "Setup Test");
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeVisible();
  for (const name of ["Direct MCP", "Composio", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("API key", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "integration-setup-options");
  await page.getByRole("button", { name: "Composio", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("fake-composio-key");
  await captureScreenshot(page, testInfo, "integration-setup-composio");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect
    .poll(() => saved)
    .toEqual([{ json: { provider: "composio", apiKey: "fake-composio-key" } }]);
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
});

test("direct MCP connects a URL and assigns it to the first bot", async ({ page }, testInfo) => {
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: true,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
  let serverId = "";
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    serverId = route.request().postDataJSON().json.serverId;
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  await signup(page, uniqueEmail("direct-mcp-setup"), "password12", "Direct MCP");
  await page.getByText("Add server URL", { exact: true }).click();
  await page.getByRole("textbox", { name: "Server URL" }).fill("https://mcp.example.test/mcp");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => serverId).not.toBe("");
  await captureScreenshot(page, testInfo, "integration-setup-direct-connected");
  let createCalls = 0;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route("**/rpc/bots/create", async (route) => {
    createCalls += 1;
    await createGate;
    await route.continue();
  });

  const assigned = page.waitForResponse(
    (response) => response.url().includes("/rpc/mcp/assignments/approve") && response.ok(),
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Opening chat…")).toBeVisible();
  await expect.poll(() => createCalls).toBe(1);
  releaseCreate();
  const response = await assigned;
  expect(response.request().postDataJSON().json.serverId).toBe(serverId);
  await page.waitForURL(/\/app\//);
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();
});

test("Executor reconnect saves a replacement token before authorization", async ({ page }) => {
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: true,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
  await signup(page, uniqueEmail("executor-reconnect"), "password12", "Executor Test");
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeVisible();
  const server = await page.evaluate(async () => {
    const response = await fetch("/rpc/mcp/servers/create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tangow-space-id": localStorage.getItem("tangow:space-id") ?? "",
      },
      body: JSON.stringify({
        json: {
          slug: "existing-executor",
          name: "Executor",
          transport: "streamable_http",
          endpoint: "http://localhost:8765/mcp",
          secret: "fake-old-token",
          headers: { "X-Test": "fake-header" },
        },
      }),
    });
    if (!response.ok) throw new Error(`Server creation failed: ${response.status}`);
    return (await response.json()).json;
  });
  let saved = false;
  await page.route("**/rpc/mcp/servers/update", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      json: { id: server.id, secret: "fake-new-token" },
    });
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const updated = (await response.json()).json;
    expect(updated.headerKeys).toEqual(["X-Test"]);
    expect(updated.revision).toBe(server.revision + 1);
    saved = true;
    await route.fulfill({ response });
  });
  await page.route("**/rpc/mcp/oauth/begin", (route) => {
    expect(saved).toBe(true);
    return route.fulfill({ json: { json: { status: "already_connected" } } });
  });
  await page.getByRole("button", { name: "Executor", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Server URL", exact: true })
    .fill("http://localhost:8765/mcp");
  await page.getByLabel("Access token", { exact: true }).fill("fake-new-token");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page.getByRole("alert")).toBeHidden();
});

test("remote members skip server setup and keep direct MCP connections", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          providers: [],
          webUrl: "https://example.test/integrations/setup",
        },
      },
    }),
  );
  await signup(page, uniqueEmail("remote-member"), "password12", "Remote Member");
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "remote-member-onboarding");
  await completeOnboarding(page);
  await page.goto("/integrations/setup?mode=mcp");
  await expect(page.getByRole("heading", { name: "Custom apps" })).toBeVisible();
  for (const name of ["Composio", "Executor"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
  }
  await expect(page.getByRole("textbox", { name: "App URL", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "remote-member-mcp");
  await page.goto("/integrations/setup");
  await page.waitForURL(/\/app/);
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
});

test("configured server owners manage providers from settings", async ({ page }, testInfo) => {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: true,
          needsSetup: false,
          providers: [{ id: "composio", configured: true }],
          webUrl: "https://example.test/integrations/setup",
        },
      },
    }),
  );
  await signup(page, uniqueEmail("configured-owner"), "password12", "Server Owner");
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeHidden();
  await completeOnboarding(page);
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  const link = settings.getByRole("link", { name: "Server integrations", exact: true });
  await expect(link).toBeVisible();
  await captureScreenshot(page, testInfo, "server-integrations-settings");
  await link.click();
  await expect(page.getByRole("heading", { name: "Server integrations" })).toBeVisible();
  await page.getByRole("button", { name: "Composio", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "server-integrations-configured");
});
