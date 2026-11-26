import type { ComputerStatus, ComputerUpdate, ComputerUpdateAllResult } from "@tangow/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openUserSettings,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("global Computer settings updates idle computers without taking control and reports busy ones", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("computer-batch"), "password12", "Computer Batch");
  await completeOnboarding(page);
  await createNamedBot(page, "Planner");
  const busyBotId = await createNamedBot(page, "Scout", { computerMode: "dedicated" });
  await rpc(page, "computer/boot", { botId: busyBotId });
  await rpc(page, "computer/takeover", { botId: busyBotId });
  // The fake provider has no image registry. Supply a published release notice for this UI flow.
  await page.route("**/rpc/computer/list", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const item of body.json) item.status.updateAvailable = true;
    await route.fulfill({ response, json: body });
  });
  const controlRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/rpc\/computer\/(boot|takeover)$/.test(new URL(request.url()).pathname)) {
      controlRequests.push(request.url());
    }
  });
  const settings = await openUserSettings(page, "computer");
  await expect(settings.getByTestId("computer-settings-row")).toHaveCount(2);
  const team = settings.getByTestId("computer-settings-row").filter({ hasText: "Team Computer" });
  await expect(team).toContainText("Update available");
  await expect(
    settings.getByTestId("settings-nav-computer").getByRole("img", { name: "Update available" }),
  ).toBeVisible();
  await expect(team).toContainText("Chief");
  await expect(team).toContainText("Planner");
  const privateComputer = settings
    .getByTestId("computer-settings-row")
    .filter({ hasText: "Private Computer" });
  await expect(privateComputer).toContainText("Bots: Scout");
  for (const name of ["Update computer", "Recover computer", "Reset computer"]) {
    await expect(team.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(privateComputer.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await team.getByRole("button", { name: "Reset computer", exact: true }).click();
  const reset = page.getByRole("alertdialog");
  await expect(
    reset.getByText("Restore the last saved workspace. Unsaved work on the computer is lost."),
  ).toBeVisible();
  await reset.getByRole("button", { name: "Cancel", exact: true }).click();
  await captureScreenshot(page, testInfo, "computer-settings-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "computer-settings-phone");
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/rpc/computer/updateAll",
  );
  await settings.getByRole("button", { name: "Update all computers", exact: true }).click();
  const result: { json: ComputerUpdateAllResult } = await (await response).json();
  expect(result.json.queued).toHaveLength(1);
  expect(result.json.skipped).toEqual([{ botId: busyBotId, name: "Scout", reason: "busy" }]);
  await expect(settings.getByTestId("computer-update-result")).toContainText("Updates queued: 1");
  await expect(settings.getByTestId("computer-update-result")).toContainText(
    "Busy. Try again when idle.",
  );
  expect(controlRequests).toEqual([]);
  expect(await rpc<ComputerStatus>(page, "computer/status", { botId: busyBotId })).toMatchObject({
    controlHolder: "user",
    controlBotId: busyBotId,
  });
  await captureScreenshot(page, testInfo, "computer-settings-batch-result");
  await rpc(page, "computer/release", { botId: busyBotId });
});

test("computer maintenance shows durable background progress and failure recovery", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("tangow.uiAppearance", "dark"));
  await signup(page, uniqueEmail("computer-update"), "password12", "Computer Update");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  let updates: ComputerUpdate[] = [];
  const status = await rpc<ComputerStatus>(page, "computer/status", { botId });
  await page.route("**/rpc/computer/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            botId,
            name: "Chief",
            bots: [{ id: botId, name: "Chief" }],
            status: {
              ...status,
              updateAvailable: !updates.some((item) => item.status === "completed"),
              state: updates.some((item) => item.status !== "failed" && item.status !== "completed")
                ? "booting"
                : "stopped",
            },
          },
        ],
      },
    }),
  );
  const updating: ComputerUpdate = {
    id: "update-example",
    botId,
    name: "Chief",
    mode: "team",
    action: "update",
    status: "running",
    stage: "restoring",
  };
  await page.route("**/rpc/computer/updates", (route) => {
    const ids: string[] = route.request().postDataJSON()?.json?.ids ?? [];
    return route.fulfill({
      json: {
        json: updates.filter((item) => item.status !== "completed" || ids.includes(item.id)),
      },
    });
  });
  await page.route("**/rpc/computer/update", (route) => {
    updates = [updating];
    return route.fulfill({ json: { json: updating } });
  });
  await page.route("**/rpc/computer/recover", (route) => {
    updates = [{ ...updating, id: "recovery-example", action: "recover", stage: "preparing" }];
    return route.fulfill({ json: { json: updates[0] } });
  });
  let releases = 0;
  await page.route("**/rpc/computer/releaseInterrupted", (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      json: { id: updating.id, workersStopped: true },
    });
    releases++;
    updates = [{ ...updating, status: "failed" }];
    return route.fulfill({ json: { json: { ok: true } } });
  });
  const settings = await openUserSettings(page, "computer");
  await settings.getByRole("button", { name: "Update computer", exact: true }).click();
  const dialog = page.getByTestId("computer-update-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Updating Team Computer");
  await expect(dialog.locator('[aria-current="step"]')).toHaveText("Restoring your workspace");
  await captureScreenshot(page, testInfo, "computer-update-progress");
  await dialog.getByRole("button", { name: "Continue in Background" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Recover computer", exact: true }),
  ).toBeDisabled();
  await captureScreenshot(page, testInfo, "computer-update-background");
  updates = [{ ...updating, status: "completed", stage: "reconnecting" }];
  await expect(
    settings.getByRole("button", { name: "Recover computer", exact: true }),
  ).toBeEnabled();
  await expect(
    settings.getByRole("button", { name: "Update all computers", exact: true }),
  ).toHaveCount(0);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).not.toBeVisible();
  await page.getByRole("button", { name: /Computer updated/ }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Computer updated");
  await expect(dialog.getByRole("button", { name: "Continue in Background" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-success-desktop");
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "computer-update-success-phone");
  if (viewport) await page.setViewportSize(viewport);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  updates = [updating];
  await page.reload();
  await page.getByRole("button", { name: /Updating Team Computer/ }).click();
  await expect(dialog).toBeVisible();
  updates = [{ ...updating, status: "interrupted" }];
  await expect(
    dialog.getByText("Recovery is unavailable until the previous operation has stopped."),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recover computer" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "computer-update-interrupted");
  updates = [{ ...updating, status: "interrupted", canReleaseReservation: true }];
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await captureScreenshot(page, testInfo, "computer-update-release-confirmation");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(releases).toBe(0);
  await dialog.getByRole("button", { name: "Release computer", exact: true }).click();
  await confirmation.getByRole("button", { name: "Nothing is still running", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Recover computer", exact: true })).toBeVisible();
  expect(releases).toBe(1);
  await expect(dialog.getByRole("heading")).toHaveText("Update failed");
  await captureScreenshot(page, testInfo, "computer-update-failed");
  await dialog.getByRole("button", { name: "Recover computer" }).click();
  await expect(dialog.getByRole("heading")).toHaveText("Recovering Team Computer");
  await captureScreenshot(page, testInfo, "computer-recovery-progress");
  updates = updates.map((item) => ({ ...item, status: "completed", stage: "reconnecting" }));
  await expect(dialog.getByRole("heading")).toHaveText("Computer recovered");
  await captureScreenshot(page, testInfo, "computer-recovery-success");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Recovering Team Computer/ })).toHaveCount(0);
});
