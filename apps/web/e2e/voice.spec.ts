import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("Providers connect a voice key, space Voice speaks a reply, and opens a call", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Voice ${stamp}`;
  await signup(page, uniqueEmail("voice"), "password12", userName);
  await completeOnboarding(page);

  await expect(page.getByRole("button", { name: "Call", exact: true })).toHaveCount(0);
  // The call moved to the thread header; the composer's mic is dictation now.
  await expect(page.getByTestId("open-voice-call")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "voice-header");
  // With no voice key yet, the call opens the account Providers section.
  await page.getByTestId("open-voice-call").click();
  await expect(page.getByTestId("providers-settings")).toBeVisible();
  await page.getByRole("button", { name: "Close user settings" }).click();
  await expect(page.getByTestId("providers-settings")).toHaveCount(0);

  const preparedOff = await rpc<{ ready: boolean }>(page, "voice/prepare", {
    text: "Hello there.",
  });
  expect(preparedOff.ready).toBe(false);

  const settings = await openUserSettings(page, "providers");
  const providers = settings.getByTestId("providers-settings");
  const voiceProviders = providers.getByRole("region", { name: "Voice", exact: true });
  await voiceProviders.getByRole("button", { name: /Scripted/ }).click();
  const apiKeyInput = providers.getByPlaceholder(/Paste your API key/);
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-voice-key");
  await providers.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(voiceProviders.getByText("Connected", { exact: true })).toBeVisible();
  await expect(providers.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(providers.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "providers-voice-connected");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "providers-voice-connected-phone");

  await settings.getByRole("button", { name: "Providers", exact: true }).click();
  await settings.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByTestId("settings-list-voice").click();
  const voiceSettings = settings.getByTestId("voice-settings");
  await expect(voiceSettings.getByLabel("Voice", { exact: true })).toBeVisible();
  await expect(voiceSettings.getByLabel("API key", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "voice-settings-phone");
  await page.setViewportSize({ width: 1280, height: 720 });
  await captureScreenshot(page, testInfo, "voice-settings");

  const spoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await page.getByRole("button", { name: "Hear a sample" }).click();
  const clip = await spoken;
  expect(clip.headers()["content-type"]).toContain("audio/mpeg");

  const credentials = await rpc<Array<{ hasKey: boolean; provider: string }>>(
    page,
    "voice/credentials",
    {},
  );
  expect(credentials).toEqual([expect.objectContaining({ hasKey: true, provider: "scripted" })]);
  expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

  await page.getByRole("button", { name: "Close voice settings" }).click();

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("say hello");
  await page.keyboard.press("Enter");
  // Speak now lives in the row's hover pill, so the row needs a hover first.
  // A reply can render more than one text bubble; speak the latest one.
  const replyRow = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: page.getByRole("button", { name: "Speak this reply" }) })
    .last();
  await expect(replyRow).toBeVisible({ timeout: 30_000 });
  await replyRow.hover();
  const speakReply = replyRow.getByRole("button", { name: "Speak this reply" });
  await expect(speakReply).toBeVisible();

  const replySpoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await speakReply.click();
  await replySpoken;

  await openUserSettings(page, "voice");
  await expect(page.getByRole("button", { name: "Hear a sample" })).toBeEnabled();
  await page.getByRole("button", { name: "Close voice settings" }).click();

  // The screen panel sits above the call view; starting a call
  // must close it so it can never hide Mute/End call behind it.
  await page.getByTestId("open-computer-panel").click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "computer");

  await page.getByTestId("open-voice-call").click();
  await expect(page.getByTestId("call-view")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("button", { name: "End call" })).toBeVisible();
  await captureScreenshot(page, testInfo, "call-view");

  const appearanceSettings = await openUserSettings(page);
  await appearanceSettings.getByTestId("ui-appearance-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await appearanceSettings.getByRole("button", { name: "Close user settings" }).click();
  await expect(appearanceSettings).toBeHidden();
  await captureScreenshot(page, testInfo, "call-view-dark");

  await page.getByRole("button", { name: "End call" }).click();
  await expect(page.getByTestId("call-view")).toHaveCount(0);

  await openUserSettings(page, "providers");
  await voiceProviders.getByRole("button", { name: /Scripted/ }).click();
  await providers.getByPlaceholder(/Paste a replacement key/).fill("leftover-voice-key");
  await providers.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(providers.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(providers.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(providers.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(rpc<Array<{ provider: string }>>(page, "voice/credentials", {})).resolves.toEqual(
    [],
  );
});
