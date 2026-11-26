import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("screen connection failures stay visible and can be retried", async ({ page }, testInfo) => {
  await signup(page, `screen-error-${Date.now()}@tangow.test`, "password12", "Screen Error");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  let failScreen = true;
  const screenUrl = "https://screen.example/vnc.html";
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  await page.route("**/rpc/computer/screenUrl", (route) =>
    route.fulfill({
      status: failScreen ? 409 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        failScreen
          ? {
              json: {
                defined: false,
                code: "CONFLICT",
                status: 409,
                message:
                  "The computer screen is temporarily busy. Retry in a moment. File and shell tools still work.",
              },
            }
          : { json: { url: screenUrl } },
      ),
    }),
  );

  await page.getByTestId("open-computer-panel").click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.getByRole("alert")).toContainText("temporarily busy");
  await expect(preview.getByTestId("computer-preview-open")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-screen-connection-error");

  failScreen = false;
  await preview.getByRole("button", { name: "Retry screen" }).click();
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);
  await expect(preview.getByRole("alert")).toHaveCount(0);

  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  failScreen = true;
  await page.getByTestId("computer-take-control").click();
  await expect(page.getByRole("alert")).toContainText("temporarily busy");
  await captureScreenshot(page, testInfo, "computer-full-screen-connection-error");

  failScreen = false;
  await page.getByRole("button", { name: "Retry screen" }).click();
  await expect(page.locator('iframe[title="Bot screen"]')).toHaveAttribute("src", screenUrl);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the computer panel shows retry guidance when capacity is full", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `computer-capacity-${Date.now()}@tangow.test`,
    "password12",
    "Computer Capacity",
  );
  await completeOnboarding(page);

  const message = "No room right now. Try again in a moment.";
  await page.route("**/rpc/computer/boot", (route) =>
    route.fulfill({
      status: 429,
      json: { json: { defined: false, code: "TOO_MANY_REQUESTS", status: 429, message } },
    }),
  );
  await page.getByTestId("open-computer-panel").click();
  await page.getByTestId("computer-preview-open").click();
  const alert = page.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-capacity-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(alert).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-capacity-phone");
});
