import { captureScreenshot, completeOnboarding, rpc, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

test("skills overlay: user and built-in skills, search, desktop and phone", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("skills-overlay"), "password12", "Skills Overlay");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Keep a user skill beside the built-in catalog.
  await rpc(page, "agentSkills/create", {
    name: "Daily standup",
    description: "Prepare a concise standup update from recent work.",
    body: "1. Summarize wins.\n2. List blockers.",
  });

  await page.getByTestId("open-customize").click();
  const overlay = page.getByRole("dialog");
  await expect(overlay.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  // Switching sections keeps the same dialog element: no close-and-reopen flash.
  await overlay.evaluate((dialog) => dialog.setAttribute("data-e2e-mark", "kept"));
  await page.getByTestId("customize-nav-skills").click();
  await expect(overlay).toHaveAttribute("data-e2e-mark", "kept");
  await expect(overlay.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(overlay.getByRole("tab")).toHaveCount(0);
  await expect(overlay.getByRole("button", { name: /Interrogate/ })).toBeVisible();
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("zzz-no-match");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toHaveCount(0);
  await expect(overlay.getByText("No skills match")).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("standup");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("");
  await captureScreenshot(page, testInfo, "90-skills-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "91-skills-phone");

  // Back to Integrations through the list: still the same dialog, already loaded.
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  await overlay.getByTestId("customize-list-integrations").click();
  await expect(overlay.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();
  await expect(overlay).toHaveAttribute("data-e2e-mark", "kept");
  await expect(overlay.getByText("Loading integrations…")).toHaveCount(0);
  await overlay.getByRole("button", { name: "Customize", exact: true }).click();
  await overlay.getByTestId("customize-list-skills").click();

  await overlay.getByLabel("Close skills").click();
  await expect(overlay).toHaveCount(0);
});
