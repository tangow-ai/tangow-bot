import type { RunModelDecision } from "@tangow/contracts";
import { SessionEntrySchema } from "@tangow/contracts";
import { captureScreenshot, completeOnboarding, openBotPage, signup, uniqueEmail } from "./helpers";
import type { Page } from "./test";
import { expect, test } from "./test";

const phone = { width: 390, height: 844 };

async function turnOnDebugMode(page: Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("debug-mode").click();
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

test("a helper stays out of the thread, and debug mode opens its session", async ({
  page,
}, testInfo) => {
  const desktop = page.viewportSize()!;
  await signup(page, uniqueEmail("helper-session"), "password12", "Helper Session");
  await completeOnboarding(page);

  await page.getByPlaceholder(/Message/).fill("delegate to a helper to summarize the notes");
  await page.keyboard.press("Enter");

  const transcript = page.getByTestId("transcript");
  const result = "it found: delegate to a helper to summarize the notes";
  await expect(transcript.getByText(`the helper is done. ${result}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(transcript.getByText(result)).toHaveCount(1);
  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "helper-reply");
  await page.setViewportSize(phone);
  await captureScreenshot(page, testInfo, "helper-reply-phone");
  await page.setViewportSize(desktop);

  const decisions = {
    parent: {
      mode: "auto",
      category: "everyday",
      provider: "example",
      modelId: "parent-v1",
      fallback: "no_decision_provider",
    },
    child: {
      mode: "category",
      requestedCategory: "complex",
      category: "everyday",
      provider: "example",
      modelId: "helper-v2",
      fallback: "category_unassigned",
    },
  } satisfies Record<string, RunModelDecision>;
  let includeRouting = true;
  // Recorded decisions and legacy logs need fixtures independent of the router.
  // Disabling HTTP caching is acceptable here: this test exercises debug rendering.
  await page.route(/\/rpc\/(runs|sessions)\/entries/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const entries = SessionEntrySchema.array().parse(body.json.entries);
    await route.fulfill({
      response,
      json: {
        ...body,
        json: {
          ...body.json,
          entries: entries.map((entry) =>
            entry.type === "run.started"
              ? {
                  ...entry,
                  payload: {
                    ...entry.payload,
                    routing: includeRouting
                      ? entry.payload.trigger.kind === "subagent"
                        ? decisions.child
                        : decisions.parent
                      : undefined,
                  },
                }
              : entry,
          ),
        },
      },
    });
  });

  await turnOnDebugMode(page);
  const botPage = await openBotPage(page);
  await botPage.getByRole("tab", { name: "Activity" }).click();
  await botPage.getByTestId("activity-run").first().click();

  const session = page.getByTestId("session-view");
  const details = session.getByTestId("run-details");
  await expect(details).toContainText("example/parent-v1");
  await details.getByTestId("run-details-toggle").click();
  await expect(details).toContainText("Fallbackno_decision_provider");
  await session.getByTestId("agent-steps-toggle").first().click();
  await captureScreenshot(page, testInfo, "helper-run-debug");
  await session.getByRole("button", { name: "helper", exact: true }).click();
  await expect(session.getByRole("heading")).toHaveText("helper");
  await expect(details).toContainText("example/helper-v2");
  await details.getByTestId("run-details-toggle").click();
  await expect(details).toContainText("Triggersubagent");
  await expect(details).toContainText("Routingcategory");
  await expect(details).toContainText("Requestedcomplex");
  await expect(details).toContainText("Categoryeveryday");
  await expect(details).toContainText("Fallbackcategory_unassigned");
  await expect(details).not.toContainText("parent-v1");
  await expect(session.getByText(result)).toBeVisible();
  await captureScreenshot(page, testInfo, "helper-session-debug");
  await page.setViewportSize(phone);
  await expect(session.getByText(result)).toBeVisible();
  await captureScreenshot(page, testInfo, "helper-session-debug-phone");

  await session.getByRole("button", { name: "Close", exact: true }).click();
  includeRouting = false;
  await botPage.getByTestId("activity-run").first().click();
  await expect(details).toContainText("scripted/scripted");
  await details.getByTestId("run-details-toggle").click();
  await expect(details).toContainText("Effort");
  await expect(details).not.toContainText("Routing");
});
