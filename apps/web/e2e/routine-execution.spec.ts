import { createHmac } from "node:crypto";
import type { Routine, RunsListOutput } from "@tangow/contracts";
import {
  activeBotId,
  addRoutineTrigger,
  captureScreenshot,
  completeOnboarding,
  createRoutine,
  openRoutineCreate,
  openRoutines,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("Slack message trigger uses the mounted messaging provider and persists", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/messaging/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: { enabled: true, providers: ["slack"], openSignup: false, identities: [] },
      }),
    }),
  );
  await signup(page, uniqueEmail("routine-slack"), "password12", "Slack Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openRoutineCreate(page);
  await page.getByPlaceholder("Name this routine").fill("Triage Slack updates");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Review the verified message event");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Slack message", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(
    editor.getByText("Runs when this bot receives a verified message from this provider."),
  ).toBeVisible();
  await editor.getByRole("button", { name: "Done", exact: true }).click();

  const panel = page.getByTestId("side-panel");
  await expect(panel.getByText("Slack message", { exact: true })).toBeVisible();
  await createRoutine(page);
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Triage Slack updates",
    crons: [],
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: "slack",
  });
  await captureScreenshot(page, testInfo, "routine-slack-message");
});

test("GitHub event trigger exposes signed delivery settings and persists", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("routine-github"), "password12", "GitHub Routine");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await openRoutineCreate(page);
  await page.getByPlaceholder("Name this routine").fill("Review repository events");
  await page
    .getByPlaceholder("What should this routine do each time it runs?")
    .fill("Inspect the signed GitHub event");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Git event", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText(new RegExp(`/api/v1/bots/${botId}/github$`))).toBeVisible();
  await expect(editor.getByText("X-Hub-Signature-256: sha256=…", { exact: true })).toBeVisible();
  await expect(editor.getByText("••••••••••••••••", { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByTestId("side-panel").getByText("Git event", { exact: true }),
  ).toBeVisible();
  const toolApproval = page.getByRole("switch", { name: "Ask before every action" });
  await expect(toolApproval).toBeChecked();
  await toolApproval.click();
  await expect(toolApproval).not.toBeChecked();

  await createRoutine(page);
  const [routine] = await rpc<Routine[]>(page, "routines/list", { botId });
  expect(routine).toMatchObject({
    name: "Review repository events",
    crons: [],
    webhookEnabled: false,
    githubEnabled: true,
    requireToolApproval: false,
  });
  await captureScreenshot(page, testInfo, "routine-github-event");
});

test("picking Webhook shows the key the bot already has, and that key signs a delivery", async ({
  page,
}) => {
  await signup(page, uniqueEmail("routine-live-key"), "password12", "Live Key");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openRoutineCreate(page);
  const { secret } = await rpc<{ secret: string }>(page, "bots/rotateWebhookSecret", { botId });

  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Webhook", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText("Authorization: Bearer ••••••••••••••••")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Rotate key" })).toHaveCount(0);
  await editor.getByRole("button", { name: "Show key" }).click();
  await expect(editor.getByText(`Authorization: Bearer ${secret}`, { exact: true })).toBeVisible();
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();

  const body = JSON.stringify({ zen: "Design for failure." });
  const delivery = await page.request.post(`/api/v1/bots/${botId}/github`, {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    data: body,
  });
  expect(delivery.status()).toBe(200);
});

test("Korean webhook routine keeps technical field labels in English", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Korean Routine ${stamp}`;
  await signup(page, uniqueEmail("routine-ko"), "password12", userName);
  await completeOnboarding(page);

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("ui-locale-select").click();
  await settings.getByRole("option", { name: "한국어", exact: true }).click();
  await page.getByRole("button", { name: "계정 설정 닫기" }).click();

  await openRoutineCreate(page);
  await page.getByPlaceholder("이 루틴의 이름을 정하세요").fill("한국어 웹훅 확인");
  await page
    .getByPlaceholder("이 루틴이 실행될 때마다 무엇을 해야 하나요?")
    .fill("웹훅을 확인합니다.");
  await page.getByRole("button", { name: "트리거 추가" }).click();
  await page.getByRole("menuitem", { name: "웹훅", exact: true }).click();

  const editor = page.getByRole("dialog");
  await expect(editor.getByText("웹훅이 실행될 때", { exact: true })).toBeVisible();
  await expect(editor.getByText("POST 대상")).toBeVisible();
  await expect(editor.getByText("key", { exact: true })).toBeVisible();
  await expect(editor.getByText("header")).toBeVisible();
  await captureScreenshot(page, testInfo, "routine-webhook-ko");
});

test("routine test-run completes and survives reload", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("routine"), "password12", "Routine");
  await completeOnboarding(page);

  await openRoutineCreate(page);
  const panel = page.getByTestId("side-panel");
  await panel.getByLabel("Name", { exact: true }).fill("Daily verification");
  await panel
    .getByLabel("Instruction")
    .fill("write routine-run-now-ok into the durable task result");
  await addRoutineTrigger(page, { schedule: "Weekdays" });
  await expect(panel.getByText(/^Weekdays at 9:00 AM/)).toBeVisible();
  await captureScreenshot(page, testInfo, "32-routine-configured");

  await createRoutine(page);
  await panel.getByRole("button", { name: "Routines", exact: true }).click();
  const routine = page.getByRole("button", { name: /Daily verification/ });
  await expect(routine).toContainText("Weekdays at 9:00 AM");
  await captureScreenshot(page, testInfo, "33-routine-scheduled");

  await routine.click();
  const started = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/testRun") && response.ok(),
  );
  await page.getByRole("button", { name: "Test run" }).click();
  const {
    json: { runId },
  } = await (await started).json();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible({ timeout: 30_000 });
  // The composer stays enabled during a run; reload only after its result is durable.
  await expect
    .poll(
      async () => {
        const { runs } = await rpc<RunsListOutput>(page, "runs/list", { filter: "recent" });
        return runs.find((run) => run.runId === runId)?.status;
      },
      { timeout: 30_000 },
    )
    .toBe("completed");
  await captureScreenshot(page, testInfo, "34-routine-run-completed");

  await page.reload();
  await expect(page.getByText(/routine-run-now-ok/i).first()).toBeVisible();
  await openRoutines(page);
  await expect(panel.getByRole("button", { name: /Daily verification/ })).toContainText(
    "Weekdays at 9:00 AM",
  );
  await captureScreenshot(page, testInfo, "35-routine-run-persisted");
});
