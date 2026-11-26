import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";
import { showThread } from "./thread-log";

test("labels a Sendblue group message with its actual transport", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("messaging-transport"), "password12", "Transport E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await showThread(page, [
    {
      id: `transport-message-${stamp}`,
      ts: new Date().toISOString(),
      type: "user.message",
      payload: {
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "SMS",
            channelId: `transport-channel-${stamp}`,
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "Dinner is at seven.",
          },
        ],
        source: "channel",
      },
    },
  ]);
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  const transportMessage = page.getByText("SMS · Alice: Dinner is at seven.");
  await expect(transportMessage).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, testInfo, "sendblue-sms-transport");
});
