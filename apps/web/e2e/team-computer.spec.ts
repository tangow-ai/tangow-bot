import type { ThreadEntry } from "@tangow/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openBotSettings,
  realSandboxTimeout,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Page, test } from "./test";
import { finishedRuns } from "./thread-log";

test("Team Computer gives bots a home folder plus shared space while Private stays isolated", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const personalMarker = `personal-${stamp}`;
  const sharedMarker = `shared-${stamp}`;
  const privateMarker = `private-${stamp}`;

  await signup(page, uniqueEmail("team-computer"), "password12", "Team Computer");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await openComputerPanel(page);
  await expect(page.getByText("Team Computer", { exact: true }).last()).toBeVisible();
  await captureScreenshot(page, testInfo, "41-team-computer");

  const writerId = await createBot(page, "Writer", "team");
  await sendAndWait(
    page,
    writerId,
    `write a file in your home called notes/result.txt that says ${personalMarker}`,
  );

  await expect(readFile(page, writerId, "notes/result.txt")).resolves.toContain(personalMarker);
  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
  await expect(readFile(page, chiefId, `bots/${writerId}/notes/result.txt`)).resolves.toContain(
    personalMarker,
  );
  await captureScreenshot(page, testInfo, "42-team-bot-home-folder");

  await sendAndWait(
    page,
    writerId,
    `write a file called shared/notes/result.txt that says ${sharedMarker}`,
  );
  await expect(readFile(page, chiefId, "shared/notes/result.txt")).resolves.toContain(sharedMarker);

  const privateId = await createBot(page, "Private Writer", "dedicated");
  await openComputerPanel(page);
  await expect(page.getByText(/Private Writer['’]s screen/).last()).toBeVisible();
  await captureScreenshot(page, testInfo, "43-private-computer");
  await expect(readFileResponse(page, privateId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });

  await sendAndWait(
    page,
    privateId,
    `write a file in your home called notes/result.txt that says ${privateMarker}`,
  );
  await expect(readFile(page, privateId, "notes/result.txt")).resolves.toContain(privateMarker);
  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });

  await setComputerMode(page, "Private Writer", privateId, "team");
  await expect(readFileResponse(page, privateId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
  await expect(readFile(page, privateId, "shared/notes/result.txt")).resolves.toContain(
    sharedMarker,
  );
  await captureScreenshot(page, testInfo, "44-private-bot-joined-team-computer");

  await setComputerMode(page, "Private Writer", privateId, "dedicated");
  await expect(readFile(page, privateId, "notes/result.txt")).resolves.toContain(privateMarker);
  await expect(readFile(page, writerId, "notes/result.txt")).resolves.toContain(personalMarker);
  await captureScreenshot(page, testInfo, "45-private-computer-restored");
});

test("user control leaves another Team bot's screen available", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const marker = `after-release-${stamp}`;

  await signup(page, uniqueEmail("team-control"), "password12", "Team Control");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  const workerId = await createBot(page, "Worker", "team");

  await openBot(page, "Chief");
  await page.getByTestId("open-computer-panel").click();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByTestId("computer-take-control").click();
  await expect(page.getByTestId("computer-chrome").getByText("You have control")).toBeVisible();
  await page.getByRole("button", { name: "Close computer" }).click();

  await openBot(page, "Worker");
  const workerRunId = await sendMessage(
    page,
    `write a file in your home called notes/result.txt that says ${marker}`,
  );

  await waitForRun(page, workerId, workerRunId);
  await expect(
    rpc<{ controlHolder: string; controlBotId: string | null }>(page, "computer/status", {
      botId: workerId,
    }),
  ).resolves.toMatchObject({ controlHolder: "user", controlBotId: chiefId });
  await expect(readFile(page, workerId, "notes/result.txt")).resolves.toContain(marker);
  await captureScreenshot(page, testInfo, "46-team-computer-user-control-allows-parallel-bot");

  await rpc(page, "computer/release", { botId: chiefId });
  await expect(
    rpc<{ controlHolder: string; controlBotId: string | null }>(page, "computer/status", {
      botId: chiefId,
    }),
  ).resolves.toMatchObject({ controlHolder: "bot", controlBotId: null });

  await expect(readFileResponse(page, chiefId, "notes/result.txt")).resolves.toMatchObject({
    ok: false,
  });
  await captureScreenshot(page, testInfo, "47-team-computer-control-released");
});

test("a failed control release keeps the computer open for retry", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("team-release"), "password12", "Team Release");
  await completeOnboarding(page);
  await page.getByTestId("open-computer-panel").click();
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  const chrome = page.getByTestId("computer-chrome");
  await page.getByTestId("computer-take-control").click();
  const release = chrome.getByRole("button", { name: "Release", exact: true });
  await expect(release).toBeVisible();
  await page.route("**/rpc/computer/release", (route) =>
    route.fulfill({ status: 500, body: "release unavailable" }),
  );
  await release.click();
  await expect(page.getByText("Could not continue", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await captureScreenshot(page, testInfo, "48-team-computer-release-retry");
  await page.unroute("**/rpc/computer/release");
  await release.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
});

test("an active Team bot must be stopped before user takeover", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("active-team-control"), "password12", "Active Team Control");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);

  await sendMessage(page, "keep working until I stop you");
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");
  await captureScreenshot(page, testInfo, "48-active-team-bot-blocks-takeover");
  await expect
    .poll(
      async () => (await rpc<{ state: string }>(page, "computer/status", { botId: chiefId })).state,
    )
    .toBe("running");
  await expect
    .poll(
      async () =>
        (
          await rpc<{ busyBotName: string | null }>(page, "computer/status", {
            botId: chiefId,
          })
        ).busyBotName,
    )
    .not.toBeNull();

  const takeover = await rpcResponse(page, "computer/takeover", { botId: chiefId });
  expect(takeover.ok).toBe(false);
  expect(takeover.status).toBe(409);
  await expect
    .poll(async () => (await threadSnapshot(page, chiefId)).run?.status ?? "idle")
    .toBe("running");

  await page.getByTestId("open-computer-panel").click();
  const sidePanel = page.getByTestId("side-panel");
  await expect(sidePanel.getByRole("button", { name: /Take control/i })).toHaveCount(0);
  await page.getByTestId("computer-preview").hover();
  const openBusy = sidePanel.getByTestId("computer-preview-open");
  await expect(openBusy).toBeVisible();
  await expect(openBusy.getByText("Open", { exact: true })).toBeVisible();
  await openBusy.click();
  const chrome = page.getByTestId("computer-chrome");
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  // Open while the bot is busy must not grant control (takeover stays blocked).
  await expect(chrome.getByText("You have control", { exact: true })).toHaveCount(0);
  await expect(chrome.getByRole("button", { name: /Take control/i })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "48b-open-while-busy-no-control");
  await page.getByRole("button", { name: "Close computer" }).click();

  // Stop through the shell so the client refreshes computer status (API stop alone
  // does not emit a terminal thread event).
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await waitForIdle(page, chiefId);
  await expect
    .poll(
      async () =>
        (
          await rpc<{ busyBotName: string | null }>(page, "computer/status", {
            botId: chiefId,
          })
        ).busyBotName,
    )
    .toBeNull();

  // After stop, Open only watches. Take control is the one way to get the mouse and keyboard.
  const takeovers: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/rpc/computer/takeover")) takeovers.push(request.url());
  });
  await page.getByTestId("computer-preview").hover();
  await page.getByTestId("computer-preview-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  const takeControl = chrome.getByRole("button", { name: "Take control", exact: true });
  await expect(takeControl).toBeVisible();
  await expect(chrome.getByText("You have control", { exact: true })).toHaveCount(0);
  await expect(chrome.getByRole("button", { name: "Release", exact: true })).toHaveCount(0);
  expect(takeovers).toHaveLength(0);
  await captureScreenshot(page, testInfo, "49-team-computer-open-view-only");
  await takeControl.click();
  await expect(chrome.getByText("You have control", { exact: true })).toBeVisible();
  await expect(takeControl).toHaveCount(0);
  expect(takeovers).toHaveLength(1);
  await expect(chrome.getByRole("button", { name: "Release", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "49b-team-computer-take-control");
  await chrome.getByRole("button", { name: "Release", exact: true }).click();
  // Release closes the overlay and clears control without a DB edit.
  await expect(page.getByRole("button", { name: "Close computer" })).toHaveCount(0);
});

test("opening the bot's screen responds at once while a fresh screen URL loads", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await signup(page, uniqueEmail("screen-open"), "password12", "Screen Open");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "computer/boot", { botId });
  await expect(rpc<{ state: string }>(page, "computer/status", { botId })).resolves.toMatchObject({
    state: "running",
  });

  const screenUrl = "https://screen.example/vnc.html";
  let delayMs = 0;
  await page.route("https://screen.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Test desktop</title><p>Desktop connected</p>",
    }),
  );
  // A slow read answers with a distinct URL, so the window can be shown to use the fresh one.
  const freshUrl = `${screenUrl}?fresh=1`;
  await page.route("**/rpc/computer/screenUrl", async (route) => {
    const slow = delayMs > 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { url: slow ? freshUrl : screenUrl } }),
    });
  });

  await page.getByTestId("open-computer-panel").click();
  const preview = page.getByTestId("computer-preview");
  await expect(preview.locator("iframe")).toHaveAttribute("src", screenUrl);

  // Past the renew age the held URL is stale, so Open must read a new one, slowly.
  await page.clock.fastForward(55 * 60_000);
  delayMs = 3_000;
  await preview.hover();
  const slowRead = page.waitForResponse("**/rpc/computer/screenUrl");
  await preview.getByTestId("computer-preview-open").click();
  const viewport = page.getByTestId("computer-viewport");
  const closeButton = page.getByRole("button", { name: "Close computer" });
  await expect(closeButton).toBeVisible({ timeout: 1_000 });
  await expect(viewport.getByRole("status")).toHaveText("Connecting…");
  await expect(viewport.locator("iframe")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "50-team-computer-open-connecting");

  // Closing while it loads keeps it closed once the slow read lands.
  await closeButton.click();
  await slowRead;
  await expect(closeButton).toHaveCount(0);

  // Reopened, the window shows the fresh URL, not the one the preview held before.
  await preview.hover();
  await preview.getByTestId("computer-preview-open").click();
  await expect(viewport.locator("iframe")).toHaveAttribute("src", freshUrl);
});

async function createBot(page: Page, name: string, mode: "team" | "dedicated") {
  return createNamedBot(page, name, { computerMode: mode });
}

async function setComputerMode(
  page: Page,
  botName: string,
  botId: string,
  mode: "team" | "dedicated",
) {
  await page.getByRole("button", { name: botName, exact: true }).last().click();
  const settings = await openBotSettings(page);
  await expect(page.getByTestId("bot-page").getByLabel("Name", { exact: true })).toHaveValue(
    botName,
  );
  // The computer applies on its own call the moment it is picked.
  await settings
    .getByRole("button", { name: mode === "team" ? "Team" : "Private", exact: true })
    .click();
  await expect
    .poll(async () => {
      const bots = await rpc<Array<{ id: string; computerMode: string }>>(page, "bots/list", {});
      return bots.find((bot) => bot.id === botId)?.computerMode;
    })
    .toBe(mode);
}

async function openBot(page: Page, name: string) {
  await page
    .getByRole("complementary")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

async function openComputerPanel(page: Page) {
  await page.getByTestId("open-computer-panel").click();
  await expect(page.getByTestId("computer-preview")).toBeVisible();
  await expect(page.getByTestId("computer-preview-open")).toHaveCount(1);
}

async function sendAndWait(page: Page, botId: string, text: string) {
  const runId = await sendMessage(page, text);
  await waitForRun(page, botId, runId);
}

async function sendMessage(page: Page, text: string) {
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill(text);
  const sent = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/send") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  const response = await sent;
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as { json?: { runId?: string } };
  if (!result.json?.runId) throw new Error("threads/send did not return a run id");
  return result.json.runId;
}

async function waitForRun(page: Page, botId: string, runId: string) {
  await expect
    .poll(
      async () => {
        const snapshot = await threadSnapshot(page, botId);
        if (snapshot.run?.id === runId) return false;
        return finishedRuns(snapshot.entries).some((entry) => entry.runId === runId);
      },
      {
        timeout: realSandboxTimeout(90_000, 20_000),
        message: `run ${runId} must finish before its result is inspected`,
      },
    )
    .toBe(true);
}

async function waitForIdle(page: Page, botId: string) {
  await expect
    .poll(async () => (await threadSnapshot(page, botId)).run?.status ?? "idle", {
      timeout: realSandboxTimeout(90_000, 20_000),
    })
    .toBe("idle");
}

function threadSnapshot(page: Page, botId: string) {
  return rpc<{
    run: { id: string; status: string } | null;
    entries: ThreadEntry[];
  }>(page, "threads/get", { botId });
}

async function readFile(page: Page, botId: string, path: string) {
  const result = await rpc<{ content: string }>(page, "computer/readFile", { botId, path });
  return result.content;
}

async function readFileResponse(page: Page, botId: string, path: string) {
  return rpcResponse(page, "computer/readFile", { botId, path });
}

async function rpcResponse(page: Page, procedure: string, body: unknown) {
  const response = await page.request.post(`/rpc/${procedure}`, { data: { json: body } });
  return { ok: response.ok(), status: response.status() };
}
