import { activeBotId, completeOnboarding, rpc, signup, uniqueEmail } from "./helpers";
import { expect, test } from "./test";

type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };

test("per-bot skill access via agentSkills.setAccess", async ({ page }) => {
  await signup(page, uniqueEmail("skill-access"), "password12", "Skill Access");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  const created = await rpc<{ id: string }>(page, "agentSkills/create", {
    name: "Daily standup",
    description: "Prepare a concise standup update from recent work.",
    body: "1. Summarize wins.\n2. List blockers.",
  });
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const has = (entries: CatalogEntry[], id = created.id) =>
    entries.some((entry) => entry.id === id);

  // Default: visible to every bot.
  const before = (await listFor()).find((entry) => entry.id === created.id);
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(true);

  // Exclude Chief: hidden from Chief's catalog, still in the full list.
  const excluded = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    bots: [{ botId: chiefId, enabled: false }],
  });
  expect(excluded.availability).toBe("all");
  expect(excluded.visibleBotIds).not.toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(false);
  expect(has(await listFor())).toBe(true);

  // Rename keeps the exclusion: access rows follow the skill key (the id *is* the key, so it changes).
  const renamed = await rpc<{ id: string }>(page, "agentSkills/update", {
    skillId: created.id,
    name: "Weekly standup",
  });
  expect(renamed.id).not.toBe(created.id);
  expect((await listFor()).find((entry) => entry.id === renamed.id)?.name).toBe("Weekly standup");
  expect(has(await listFor(chiefId), renamed.id)).toBe(false);
  expect(has(await listFor(), renamed.id)).toBe(true);
  await rpc(page, "agentSkills/update", { skillId: renamed.id, name: "Daily standup" });
  expect(has(await listFor(chiefId))).toBe(false);
  expect(has(await listFor())).toBe(true);

  // Duplicating a bot copies its skill overrides: the clone is excluded too.
  const clone = await rpc<{ id: string }>(page, "bots/duplicate", { botId: chiefId });
  expect(has(await listFor(clone.id))).toBe(false);
  expect((await listFor()).find((entry) => entry.id === created.id)?.visibleBotIds).not.toContain(
    clone.id,
  );

  // Slash picker follows the active bot's catalog.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("/");
  const picker = page.getByTestId("slash-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "Bot settings" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Skill Daily standup" })).toHaveCount(0);
  await composer.fill("");

  // Selected + explicit include: visible to Chief again.
  const selected = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    availability: "selected",
  });
  expect(selected.availability).toBe("selected");
  expect(selected.visibleBotIds).not.toContain(chiefId);
  const included = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    bots: [{ botId: chiefId, enabled: true }],
  });
  expect(included.availability).toBe("selected");
  expect(included.visibleBotIds).toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(true);

  await composer.fill("/");
  await expect(picker.getByRole("button", { name: "Skill Daily standup" })).toBeVisible();
  await composer.fill("");

  // Disabled beats the explicit include: gone from every catalog and from the picker.
  const disabled = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    availability: "disabled",
    bots: [{ botId: chiefId, enabled: true }],
  });
  expect(disabled.availability).toBe("disabled");
  expect(disabled.visibleBotIds).toEqual([]);
  expect(has(await listFor(chiefId))).toBe(false);
  expect(has(await listFor(clone.id))).toBe(false);
  expect(has(await listFor())).toBe(true);
  await composer.fill("/");
  await expect(picker.getByRole("button", { name: "Bot settings" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Skill Daily standup" })).toHaveCount(0);
  await composer.fill("");

  // Back to Global: the include row for Chief and the exclusion copied onto the clone
  // are in force again, and a third bot with no row of its own sees the skill.
  const scout = await rpc<{ id: string }>(page, "bots/create", { name: "Scout" });
  const restored = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    availability: "all",
  });
  expect(restored.availability).toBe("all");
  expect(restored.visibleBotIds).toEqual(expect.arrayContaining([chiefId, scout.id]));
  expect(restored.visibleBotIds).not.toContain(clone.id);
  expect(has(await listFor(chiefId))).toBe(true);

  // Global -> Specific in the Skills panel keeps exactly that audience: Scout has no
  // override row, so without seeding the switch would silently drop it.
  await page.getByTestId("open-customize").click();
  await page.getByTestId("customize-nav-skills").click();
  const overlay = page.getByRole("dialog");
  const card = overlay.getByTestId("bot-knowledge-skill").filter({ hasText: "Daily standup" });
  await expect(card.getByRole("button", { name: "Global", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await card.getByRole("button", { name: "Specific agents", exact: true }).click();
  await expect(card.getByRole("button", { name: "Scout", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(card.getByRole("button", { name: "Chief copy", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const specific = (await listFor()).find((entry) => entry.id === created.id);
  expect(specific?.availability).toBe("selected");
  expect([...(specific?.visibleBotIds ?? [])].sort()).toEqual([chiefId, scout.id].sort());
  expect(has(await listFor(scout.id))).toBe(true);
  expect(has(await listFor(clone.id))).toBe(false);

  // Disabled from the panel hides the picker and the whole audience.
  await card.getByRole("button", { name: "Disabled", exact: true }).click();
  await expect(card.getByRole("button", { name: "Scout", exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await listFor()).find((entry) => entry.id === created.id)?.visibleBotIds)
    .toEqual([]);
  await overlay.getByLabel("Close skills").click();
});
