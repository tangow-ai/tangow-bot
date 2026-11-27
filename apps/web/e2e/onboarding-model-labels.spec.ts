import { captureScreenshot, signup } from "./helpers";
import { expect, test } from "./test";

test("onboarding uses compact model selects without misleading latest labels", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: "openai/gpt-5.6-luna",
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(page, `model-labels-${stamp}@tangow.test`, "password12", `Model labels ${stamp}`);
  await expect(page.getByRole("heading", { name: "Plug in a brain." })).toBeVisible({
    timeout: 20_000,
  });

  const provider = page.getByRole("combobox", { name: "Provider" });
  await expect(provider.locator("option:checked")).toHaveText("OpenRouter");
  await page.getByLabel("API key").fill("openrouter-only-key");
  await expect(provider.getByRole("option", { name: "ChatGPT" })).toBeAttached();
  await expect(provider.getByRole("option", { name: "Vercel AI Gateway" })).toBeAttached();
  await provider.selectOption({ label: "Anthropic" });
  await page.getByRole("button", { name: "Or paste an API key" }).click();
  await expect(page.getByLabel("API key")).toHaveValue("");

  const models = page.getByRole("combobox", { name: "Model", exact: true });
  const aliasOption = models.getByRole("option", { name: /\(auto-updates\)$/ }).first();
  await expect(aliasOption).toBeAttached();
  const labels = await models.getByRole("option").allTextContents();
  // "latest" is an upstream alias marker, so it lands on families like Claude Opus 4.5 while
  // newer models carry no marker. Rendered as-is it tells the user the opposite of the truth.
  expect(labels.filter((label) => /\blatest\b/i.test(label))).toEqual([]);

  // Select a non-default model and keep its user-facing alias visible in the compact trigger.
  const alias = await aliasOption.textContent();
  expect(labels).toContain(alias);
  await models.selectOption({ label: alias! });
  await expect(models.locator("option:checked")).toHaveText(alias!);

  await page.route("**/rpc/models/probeOpenAiCompatible", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { models: ["probed-model"] } }),
    });
  });
  await provider.selectOption({ label: "OpenAI-compatible" });
  await page.getByLabel("Server URL").fill("http://127.0.0.1:8090/v1");
  const manualModel = page.getByRole("textbox", { name: "Model", exact: true });
  const discovered = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(manualModel).toBeVisible();
  // Typing before the first probe must keep freeform even if the probe returns that id.
  await manualModel.fill("probed-model");
  const firstProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await firstProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(discovered).toHaveCount(0);
  await page.getByRole("button", { name: "Use a found model" }).click();
  await expect(discovered).toBeVisible();
  await expect(discovered.locator("option:checked")).toHaveText("probed-model");
  await discovered.selectOption({ label: "Other model…" });
  await expect(manualModel).toBeVisible();
  // Typing a discovered id (or its prefix) must keep the freeform field.
  await manualModel.fill("probed-model");
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  // Re-probe while the typed id matches a discovered model must stay freeform.
  const reProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await reProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(discovered).toHaveCount(0);
  // Editing the server URL must not drop Other model… mode either.
  await page.getByLabel("Server URL").fill("http://127.0.0.1:8091/v1");
  const editedUrlProbeResponse = page.waitForResponse("**/rpc/models/probeOpenAiCompatible");
  await page.getByRole("button", { name: "Find models" }).click();
  await editedUrlProbeResponse;
  await expect(manualModel).toBeVisible();
  await expect(manualModel).toHaveValue("probed-model");
  await expect(discovered).toHaveCount(0);
  await manualModel.fill("probed-model-custom");
  await expect(manualModel).toHaveValue("probed-model-custom");

  await captureScreenshot(page, testInfo, "onboarding-model-labels");
});
