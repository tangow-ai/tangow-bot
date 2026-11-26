import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  captureScreenshot,
  completeOnboarding,
  openBotSettings,
  openUserSettings,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

const LOCAL_MODEL_ID = "tangow-e2e-local";

test("custom connections persist reasoning support and bot thinking", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Reasoning ${stamp}`;
  await signup(page, uniqueEmail("reasoning-model"), "password12", userName);
  await completeOnboarding(page);
  await openUserSettings(page, "providers");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await page.getByLabel("Model id").fill("arbitrary-model");
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Supports thinking" }).check();
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("low");
  await page.getByLabel("Maximum output tokens").fill("8192");
  await page.getByLabel("Context limit").fill("65536");
  await page.getByRole("checkbox", { name: "Supports images" }).check();
  await page.getByLabel("Maximum images per request").fill("1");
  await captureScreenshot(page, testInfo, "openai-compatible-thinking-connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const credentials = await rpc<
    Array<{
      modelId?: string;
      reasoning?: boolean;
      thinkingLevel?: string | null;
      maxTokens?: number;
      contextWindow?: number;
      supportsImages?: boolean;
      maxImagesPerPrompt?: number;
    }>
  >(page, "models/credentials", {});
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.reasoning).toBe(true);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.thinkingLevel).toBe(
    "low",
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxTokens).toBe(8192);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.contextWindow).toBe(
    65536,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.supportsImages).toBe(
    true,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt).toBe(
    1,
  );
  await page.reload();
  await openUserSettings(page, "providers");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toHaveValue(
    "low",
  );
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("8192");
  await expect(page.getByLabel("Context limit")).toHaveValue("65536");
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeChecked();
  await expect(page.getByLabel("Maximum images per request")).toHaveValue("1");
  await page.getByLabel("Maximum images per request").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const clearedCredentials = await rpc<Array<{ modelId?: string; maxImagesPerPrompt?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(
    clearedCredentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt,
  ).toBeUndefined();
  await page.getByRole("button", { name: "Close user settings" }).click();
  const settings = await openBotSettings(page);
  await settings.getByRole("button", { name: /^Model/ }).click();
  const botPage = page.getByTestId("bot-page");
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-detail", "model");
  const model = botPage.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  await expect(model).toContainText("arbitrary-model");
  // Each choice saves on its own the moment it changes; there is no Save button.
  const modelSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  // Value key — not a /arbitrary-model/ label match, which also hits "Space default (arbitrary-model)".
  await model.selectOption("openai-compatible::arbitrary-model");
  await modelSaved;
  const thinking = botPage.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  const thinkingSaved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await thinking.selectOption("low");
  await thinkingSaved;
  await expect(botPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "openai-compatible-thinking");
  await page.reload();
  const reloaded = await openBotSettings(page);
  await reloaded.getByRole("button", { name: /^Model/ }).click();
  await expect(thinking).toHaveValue("low");
});

test("connects to and lists an OpenAI-compatible endpoint", async ({ page }, testInfo) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID }] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const stamp = Date.now();
    const userName = `Local model ${stamp}`;
    await signup(page, uniqueEmail("local-model"), "password12", userName);
    await completeOnboarding(page);

    await openUserSettings(page, "providers");
    const providerSearch = page.getByPlaceholder("Search providers");
    await providerSearch.fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeVisible();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id").fill("manual-model-not-listed");
    await page.getByRole("button", { name: "Find models" }).click();

    await expect(page.getByLabel("Model id")).toHaveValue("manual-model-not-listed");
    await page.getByRole("button", { name: "Use a found model" }).click();
    const discoveredModels = page.getByRole("combobox", { name: "Models from server" });
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await discoveredModels.selectOption("");
    await expect(page.getByLabel("Model id")).toBeVisible();
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await expect(page.getByText("Found 1 model.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenAI-compatible/ })).toContainText(
      "Connected",
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");

    await page.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("model settings connect, replace, and cancel provider authentication", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, uniqueEmail("models"), "password12", userName);
  await completeOnboarding(page);

  await openUserSettings(page, "providers");
  await expect(page.getByRole("button", { name: "Close user settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  const modelProviders = page.getByRole("region", { name: "Models", exact: true });
  await providerSearch.fill("scripted");
  await modelProviders.getByRole("button", { name: /Scripted/ }).click();
  await expect(page.getByRole("combobox", { name: "Model", exact: true })).toHaveText(
    /Scripted runtime/,
  );
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await captureScreenshot(page, testInfo, "desktop-provider-detail");
  await apiKeyInput.fill("fake-scripted-key-one");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          provider: "openai-codex",
          mode: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("Waiting for sign-in…")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await modelProviders.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("Waiting for sign-in…")).toBeHidden();
});

test("Auto category models persist and a fixed default disables Auto", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("auto-model"), "password12", "Model routing");
  await completeOnboarding(page);
  await rpc(page, "models/connect", {
    provider: "scripted",
    apiKey: "fake-scripted-key",
    modelId: "scripted",
    label: "Scripted",
  });
  await rpc(page, "models/connect", {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8090/v1",
    modelId: "local-model",
    label: "Local",
  });
  await openUserSettings(page, "models");
  const active = page.getByRole("combobox", { name: "Active model", exact: true });
  await active.selectOption("auto");
  for (const { category, model } of [
    { category: "Fast", model: "Scripted" },
    { category: "Everyday", model: "local-model" },
    { category: "Complex", model: "Scripted" },
  ]) {
    await page.getByRole("combobox", { name: category, exact: true }).click();
    await page
      .getByRole("region", { name: category, exact: true })
      .getByRole("option", { name: new RegExp(model) })
      .click();
    await expect(page.getByRole("combobox", { name: category, exact: true })).toContainText(model);
  }
  await page.reload();
  await openUserSettings(page, "models");
  await expect(active).toHaveValue("auto");
  await expect(page.getByRole("combobox", { name: "Fast", exact: true })).toContainText("Scripted");
  await expect(page.getByRole("combobox", { name: "Everyday", exact: true })).toContainText(
    "local-model",
  );
  await expect(page.getByRole("combobox", { name: "Complex", exact: true })).toContainText(
    "Scripted",
  );
  await captureScreenshot(page, testInfo, "auto-models-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneRow = await page.getByRole("region", { name: "Complex", exact: true }).boundingBox();
  expect(phoneRow && phoneRow.x + phoneRow.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "auto-models-phone");
  await page.getByRole("combobox", { name: "Complex", exact: true }).click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Complex", exact: true })).toHaveText("Default");
  await active.selectOption("openai-compatible::local-model");
  await expect(page.getByRole("combobox", { name: "Fast", exact: true })).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await openUserSettings(page, "models");
  await expect(active).toHaveValue("openai-compatible::local-model");
});
