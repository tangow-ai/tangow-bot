import { readFile } from "node:fs/promises";
import type { MemoryDocument } from "@tangow/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotTab,
  openUserSettings,
  realSandboxTimeout,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, uniqueEmail("knowledge"), "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Ask the agent for a working file up front so the Files tab has something
  // real to show by the time memory and skills are done.
  const chiefId = activeBotId(page);
  const fileMarker = `file-${stamp}`;
  await page
    .getByPlaceholder(/Message/)
    .fill(`write a file in your home called notes/result.csv that says ${fileMarker}`);
  await page.keyboard.press("Enter");

  // Space-wide documents live in Settings → Memory. Open that before bot
  // settings so the Knowledge Memory tab cannot steal this click.
  await openUserSettings(page, "memory");
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Shared documents")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/rpc/memory/update",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(docEditor).toBeDisabled();
    await expect(memoryRow).toBeDisabled();
    await expect(spaceDocs.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    releaseSave();
  }
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  const sharedDocuments = await rpc<MemoryDocument[]>(page, "memory/list", { scope: "user" });
  expect(sharedDocuments).toContainEqual(
    expect.objectContaining({ content: `# Memory\n\n${marker}\n`, revision: 2 }),
  );
  // Export must fetch fresh content and exclude the bot's private document.
  const sharedDocument = sharedDocuments.find((doc) => doc.path === "MEMORY.md")!;
  const latestMarker = `Latest shared memory ${stamp}`;
  await rpc(page, "memory/update", { documentId: sharedDocument.id, content: latestMarker });
  const downloadPromise = page.waitForEvent("download");
  await spaceDocs.getByRole("button", { name: "Download as markdown" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("space-memory.md");
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain(latestMarker);
  expect(exported).not.toContain(marker);
  expect(exported).not.toContain("# Chief");
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  // The bot's memory, files and skills live on the Knowledge tab of its page.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const botPage = await openBotTab(page, "Knowledge");
  /** Remount the bot page so its sections refetch after an out-of-band RPC. */
  const reopenKnowledge = async () => {
    await page.reload();
    await openBotTab(page, "Knowledge");
  };
  const knowledge = botPage.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`). It opens in the wide panel with its
  // own Save and Cancel: leaving the field saves nothing.
  const panel = page.getByTestId("side-panel");
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  await expect(panel).toHaveAttribute("data-detail", "memory");
  await expect(panel).toHaveAttribute("data-size", "wide");
  const botDocEditor = panel.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await botDocEditor.blur();
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", { botId: chiefId, scope: "bot" }),
  ).toContainEqual(expect.objectContaining({ revision: 1 }));
  // Back on Knowledge, the row stays on screen while the list reads again.
  let releaseMemoryRefresh!: () => void;
  const memoryRefreshGate = new Promise<void>((resolve) => {
    releaseMemoryRefresh = resolve;
  });
  await page.route(
    "**/rpc/memory/list",
    async (route) => {
      await memoryRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(panel).toHaveAttribute("data-size", "default");
    await expect(botMemoryRow).toBeFocused();
    await expect(botMemory).not.toContainText("Nothing remembered yet");
  } finally {
    releaseMemoryRefresh();
  }
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  expect(
    await rpc<MemoryDocument[]>(page, "memory/list", { botId: chiefId, scope: "bot" }),
  ).toContainEqual(expect.objectContaining({ content: `# Chief\n\n${botMarker}\n`, revision: 2 }));
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");

  // Skills: its own section on the Knowledge tab; the editor opens in the wide
  // panel. Create one, reopen it, edit, then delete it. Builtin catalog is
  // currently empty; user skills still cover create/edit/delete.
  const skillsSection = botPage.getByTestId("bot-skills");
  await expect(skillsSection.getByText("Skills", { exact: true })).toBeVisible();
  await skillsSection.getByRole("button", { name: "New skill", exact: true }).click();
  await expect(panel).toHaveAttribute("data-detail", "skill");
  await expect(panel).toHaveAttribute("data-size", "wide");
  const editor = panel.getByTestId("bot-knowledge-skill-editor").locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  const skillRow = skillsSection.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(skillsSection.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(
    page.getByRole("button", { name: "Skill greet-politely", exact: true }),
  ).toBeVisible();
  await composer.fill("");

  // Import: a plain-text .skill lands in the list like a hand-made skill.
  await skillsSection.getByTestId("bot-knowledge-skill-import").setInputFiles({
    name: "imported.skill",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      ["---", "name: imported-skill", "description: Came from a file.", "---", "", "Body."].join(
        "\n",
      ),
    ),
  });
  await expect(skillsSection.getByRole("button", { name: /imported-skill/ })).toBeVisible();

  // Scoping: a hand-made skill is visible to every agent; the agent's own switch
  // writes a per-bot override that hides it from Chief's catalog only.
  type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const before = (await listFor()).find((entry) => entry.name === "greet-politely");
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);

  const skillCard = skillsSection
    .getByTestId("bot-knowledge-skill")
    .filter({ hasText: "greet-politely" });
  const chiefSwitch = skillCard.getByRole("switch", { name: "greet-politely" });
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "true");
  await chiefSwitch.click();
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "false");
  await captureScreenshot(page, testInfo, "82b-knowledge-skill-scoped");
  await expect
    .poll(async () => (await listFor(chiefId)).some((entry) => entry.name === "greet-politely"))
    .toBe(false);
  expect((await listFor()).some((entry) => entry.name === "greet-politely")).toBe(true);
  await chiefSwitch.click();
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await listFor(chiefId)).some((entry) => entry.name === "greet-politely"))
    .toBe(true);

  // A skill disabled for every agent is not installable, so it leaves this list.
  // The section reads the catalog on mount, hence the reopen.
  await rpc(page, "agentSkills/setAccess", {
    skillId: before?.id,
    availability: "disabled",
  });
  await reopenKnowledge();
  await expect(skillCard).toHaveCount(0);
  await rpc(page, "agentSkills/setAccess", { skillId: before?.id, availability: "all" });
  await reopenKnowledge();
  await expect(skillCard).toHaveCount(1);

  // A built-in skill uses the same viewer without mutation controls. The
  // editor reads the skill as it mounts, so every read answers read-only until unrouted.
  await page.route("**/rpc/agentSkills/get", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, json: { ...body.json, readOnly: true, source: "builtin" } },
    });
  });
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  await page.unroute("**/rpc/agentSkills/get");
  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  let releaseSkillRefresh!: () => void;
  const skillRefreshGate = new Promise<void>((resolve) => {
    releaseSkillRefresh = resolve;
  });
  await page.route(
    "**/rpc/agentSkills/list",
    async (route) => {
      await skillRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  // Saved, the panel goes back to Knowledge, which reads the catalog again.
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(editor).toBeHidden();
    await expect(panel).toHaveAttribute("data-size", "default");
    await expect(skillRow).toBeFocused();
    await captureScreenshot(page, testInfo, "85-skill-refresh-pending");
  } finally {
    releaseSkillRefresh();
  }
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  // Edited twice, the skill keeps no history to browse or undo.
  await expect(panel.getByText("Versions", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "85b-knowledge-skill-edited");
  await panel.getByRole("button", { name: "Delete", exact: true }).click();
  await panel.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(skillRow).toBeHidden();
  await composer.fill("/");
  await expect(page.getByRole("button", { name: "Skill greet-politely", exact: true })).toHaveCount(
    0,
  );
  await composer.fill("");
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );

  // Files: the agent's working folder, browsable down to a readable file.
  await expect
    .poll(
      async () => {
        const entries = await rpc<Array<{ path: string }>>(page, "computer/files", {
          botId: chiefId,
          path: "",
        });
        return entries.some((entry) => entry.path === "notes");
      },
      {
        timeout: realSandboxTimeout(90_000, 20_000),
        message: "the agent must finish writing notes/result.csv",
      },
    )
    .toBe(true);

  // Files are read when the tab opens, so open it again now that the file exists.
  await reopenKnowledge();
  const files = knowledge.getByTestId("bot-knowledge-files");
  const notesRow = files.getByRole("button", { name: "notes/", exact: true });
  await expect(notesRow).toBeVisible();
  await notesRow.click();
  const csvRow = files.getByRole("button", { name: /result\.csv/ });
  await expect(csvRow).toBeVisible();
  await captureScreenshot(page, testInfo, "85-knowledge-files-list");
  await csvRow.click();
  await expect(files.locator("textarea")).toHaveValue(new RegExp(fileMarker));
  await expect(files.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "86-knowledge-files-preview");
});
