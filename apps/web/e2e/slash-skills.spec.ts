import { captureScreenshot, completeOnboarding, rpc, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

test("composer / picker lists skills above actions", async ({ page }, testInfo) => {
  await signup(page, uniqueEmail("slash-skills"), "password12", "Slash Skills");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  await rpc(page, "agentSkills/create", {
    name: "Daily standup",
    description:
      "Prepare a concise standup update from recent work. Use when the user asks for standup notes.",
    body: "1. Summarize wins.\n2. List blockers.",
  });

  // aria-label stays available when skill/mention chips hide the placeholder.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("/");

  const picker = page.getByTestId("slash-picker");
  await expect(picker).toBeVisible();
  const skillButton = picker.getByRole("button", { name: "Skill Daily standup" });
  const chatSettings = picker.getByRole("button", { name: "Bot settings" });
  await expect(skillButton).toBeVisible();
  await expect(chatSettings).toBeVisible();
  await expect(picker.getByRole("button", { name: "Settings: General" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Settings: Usage" })).toBeVisible();

  const skillBox = await skillButton.boundingBox();
  const actionBox = await chatSettings.boundingBox();
  expect(skillBox).toBeTruthy();
  expect(actionBox).toBeTruthy();
  expect(skillBox!.y).toBeLessThan(actionBox!.y);

  await expect(skillButton).toContainText("Prepare a concise standup");
  const interrogate = picker.getByRole("button", { name: "Skill Interrogate", exact: true });
  await expect(interrogate).toBeVisible();
  await expect(interrogate).toContainText("Review only; never applies fixes.");
  await captureScreenshot(page, testInfo, "slash-skills-picker");

  await skillButton.click();
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
  // The skill leads the draft in place, drawn as a token over its own text.
  const skillToken = page
    .getByTestId("composer-bar")
    .locator('[data-slot="entity-mention-field"][data-kind="skill"]');
  await expect(skillToken).toHaveText("/Daily standup");
  await expect(composer).toHaveValue("/Daily standup ");
  await page.keyboard.insertText("focus on blockers");
  await captureScreenshot(page, testInfo, "slash-skills-inserted");

  // Editing the token's text away drops the skill.
  await composer.fill("hello /");
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
  await expect(skillToken).toHaveCount(0);

  await composer.fill("/Inter");
  await expect(interrogate).toBeVisible();
  await captureScreenshot(page, testInfo, "interrogate-skill-picker");
  await interrogate.click();
  await expect(skillToken).toHaveText("/Interrogate");
  await composer.fill("");

  await composer.fill("@");
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
});
