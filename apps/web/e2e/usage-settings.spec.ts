import type { UsageCell } from "@tangow/contracts";
import {
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, test } from "./test";

const atlas = { id: "bot_atlas", name: "Atlas", color: "#5B5BD6", shapeSeed: 2, deleted: false };
const nova = { id: "bot_nova", name: "Nova", color: "#F76B15", shapeSeed: 5, deleted: false };
const juno = { id: "bot_juno", name: "Juno", color: null, shapeSeed: null, deleted: true };

function cell(
  fields: Partial<UsageCell> & Pick<UsageCell, "bot" | "inputTokens" | "outputTokens">,
) {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    category: "complex",
    hasRun: true,
    runs: 1,
    compactions: 0,
    ...fields,
  } satisfies UsageCell;
}

const CELLS: UsageCell[] = [
  cell({ bot: atlas, runs: 38, inputTokens: 3_900_000, outputTokens: 600_000 }),
  cell({
    bot: atlas,
    model: "claude-haiku-5-5",
    category: "fast",
    runs: 48,
    inputTokens: 1_000_000,
    outputTokens: 200_000,
  }),
  cell({
    bot: atlas,
    model: "claude-haiku-5-5",
    category: "compaction",
    hasRun: false,
    runs: 0,
    compactions: 14,
    inputTokens: 1_600_000,
    outputTokens: 90_000,
  }),
  cell({
    bot: nova,
    model: "claude-haiku-5-5",
    category: "everyday",
    runs: 112,
    inputTokens: 3_700_000,
    outputTokens: 700_000,
  }),
  cell({
    bot: juno,
    model: "gemma-4",
    category: "fixed",
    hasRun: false,
    runs: 0,
    inputTokens: 400_000,
    outputTokens: 60_000,
  }),
];

test("usage settings break spend down by bot, model and category, input and output apart", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, uniqueEmail("usage-settings"), "password12", `Usage ${stamp}`);
  await completeOnboarding(page);
  const periods: string[] = [];
  await page.route("**/rpc/usage/breakdown", async (route) => {
    periods.push(route.request().postData() ?? "");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: CELLS }) });
  });

  const settings = await openUserSettings(page, "usage");
  const usage = settings.getByTestId("usage-settings");
  const rows = usage.getByTestId("usage-rows");
  await expect(usage.getByTestId("usage-totals")).toContainText("10.6M in");
  await expect(usage.getByTestId("usage-totals")).toContainText("1.65M out");
  await expect(usage.getByTestId("usage-totals")).toContainText("14 compactions");
  await expect(rows.getByRole("button")).toHaveCount(3);
  await expect(rows.getByRole("button").first()).toContainText("Atlas");
  // Atlas averages over its 86 runs; its compaction counts in its totals only.
  await expect(rows.getByRole("button").first()).toContainText("86 runs · 57K in · 9.3K out / run");
  await expect(rows.getByRole("button", { name: /Juno/ })).toContainText("Deleted");
  await captureScreenshot(page, testInfo, "usage-settings-bots");

  await usage.getByRole("button", { name: /^Atlas/ }).click();
  await expect(usage.getByRole("button", { name: "Back to all usage" })).toContainText("Atlas");
  await expect(usage.getByRole("button", { name: "Bots", exact: true })).toHaveCount(0);
  await expect(rows.getByRole("button").first()).toContainText("claude-sonnet-5-5");
  await captureScreenshot(page, testInfo, "usage-settings-bot-models");
  await usage.getByRole("button", { name: "Categories", exact: true }).click();
  const compaction = rows.getByRole("button", { name: /Compaction/ });
  await expect(compaction).toContainText("14 compactions · 114K in · 6.43K out / compaction");
  await captureScreenshot(page, testInfo, "usage-settings-bot-categories");

  await usage.getByRole("button", { name: "Back to all usage" }).click();
  await usage.getByRole("button", { name: "7d", exact: true }).click();
  await expect.poll(() => periods.at(-1)).toContain("7d");

  await page.setViewportSize({ width: 390, height: 844 });
  await usage.getByRole("button", { name: "Models", exact: true }).click();
  await expect(rows.getByRole("button").first()).toContainText("claude-haiku-5-5");
  await captureScreenshot(page, testInfo, "usage-settings-models-phone");
});
