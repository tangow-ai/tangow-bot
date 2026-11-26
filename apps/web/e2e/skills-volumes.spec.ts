import type { AgentSkill } from "@tangow/contracts";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotTab,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

test("volume skills have a read-only viewer and no per-bot access switch", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("volume-skills"), "password12", "Skills reviewer");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const skill: AgentSkill = {
    id: `volume:bot:${botId}:release-notes`,
    name: "release-notes",
    description: "Prepare release notes from checked changes.",
    content:
      "---\nname: release-notes\ndescription: Prepare release notes from checked changes.\n---\nRead the checked changes before writing release notes.\n",
    source: "bot",
    readOnly: true,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
  const shared: AgentSkill = {
    ...skill,
    id: "volume:shared:team-review",
    name: "team-review",
    source: "shared",
    description: "Review shared work before publishing.",
    content: "",
  };
  // The worker/database contract is covered offline; this fixture owns presentation of that contract.
  await page.route("**/rpc/agentSkills/list", (route) =>
    route.fulfill({
      json: {
        json: [
          { ...skill, availability: "selected", visibleBotIds: [botId] },
          {
            ...skill,
            id: "builtin:Interrogate",
            name: "Interrogate",
            source: "builtin",
            description: "Review changes before editing.",
            availability: "all",
            visibleBotIds: [botId],
          },
          {
            ...shared,
            availability: "all",
            visibleBotIds: [botId],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/agentSkills/get", (route) => route.fulfill({ json: { json: skill } }));
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const botPage = await openBotTab(page, "Knowledge");
  const skills = botPage.getByTestId("bot-skills");
  await expect(skills.getByRole("button", { name: /release-notes/ })).toBeVisible();
  await expect(skills.getByRole("button", { name: /team-review/ })).toBeVisible();
  await expect(skills.getByRole("switch")).toHaveCount(0);
  await skills.getByRole("button", { name: /release-notes/ }).click();
  const editor = page.getByTestId("bot-knowledge-skill-editor");
  await expect(editor.locator("textarea")).toHaveAttribute("readonly", "");
  await expect(editor.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await page.unroute("**/rpc/agentSkills/get");
  await page.route("**/rpc/agentSkills/get", (route) => route.fulfill({ json: { json: shared } }));
  await skills.getByRole("button", { name: /team-review/ }).click();
  await expect(editor.getByText(shared.description, { exact: true })).toBeVisible();
  await expect(
    editor.getByText("Content lives on the shared volume.", { exact: true }),
  ).toBeVisible();
  await expect(editor.locator("textarea")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "skills-volumes-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "skills-volumes-phone");
});
