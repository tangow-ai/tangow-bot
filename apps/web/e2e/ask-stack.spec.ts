import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  uniqueEmail,
} from "./helpers";
import type { Page, TestInfo } from "./test";
import { expect, test } from "./test";

/** Opens the scripted three-question card. */
async function openStack(page: Page, name: string) {
  await signup(page, uniqueEmail(`${name}`), "password12", "Ask Stack");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill("ask me three questions");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status,
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const first = page.getByRole("button", { name: "Built-in, 54–56 cm", exact: true });
  if ((await first.count()) === 0) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(first).toBeVisible({ timeout: 15_000 });
  return page.locator('[data-slot="question-card"]');
}

async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const width = page.viewportSize()?.width;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await captureScreenshot(page, testInfo, `ask-stack-${name}-${theme}-${width}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

for (const width of [1440, 390]) {
  test(`steps through three questions, reopens a line and sends from the recap (CA6, CA7, CA10, CA18, ${width})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const card = await openStack(page, `ask-stack-${width}`);
    const head = card.locator('[data-slot="stack-head"]');
    const lines = card.locator('[data-slot="stack-line"]');
    const button = (name: string) => card.getByRole("button", { name, exact: true });

    await expect(head).toHaveText("Format·2 more");
    await expect(card.getByRole("group", { name: "Which fridge do you have now?" })).toBeVisible();
    await expect(lines).toHaveCount(0);
    await expect(card).not.toContainText("1/3");
    await expect(button("Freestanding, 60 cm")).toHaveAccessibleDescription(
      "Recommended · Fits most kitchens",
    );
    await expect(button("Freestanding, 60 cm")).toHaveAttribute("aria-pressed", "false");
    await expect(button("Built-in, 54–56 cm")).toHaveAccessibleDescription(
      "Hides behind a cabinet door",
    );
    await shoot(page, testInfo, "open");

    await button("Built-in, 54–56 cm").click();
    await expect(button("Built-in, 54–56 cm")).toHaveAttribute("aria-pressed", "true");
    await expect(head).toHaveText("Extras·1 more");
    await expect(lines).toHaveText(["FormatBuilt-in, 54–56 cm"]);

    await expect(button("Next")).toHaveCount(0);
    await button("Ice maker").click();
    await button("No frost").click();
    await expect(button("No frost")).toHaveAttribute("aria-pressed", "true");
    await shoot(page, testInfo, "mid");
    await button("Next").click();

    await expect(head).toHaveText("Last one");
    await button("Skip").click();
    await expect(lines).toHaveText([
      "FormatBuilt-in, 54–56 cm",
      "ExtrasIce maker, No frost",
      "Do you already have a separate freezer?Skipped",
    ]);
    await expect(head).toHaveCount(0);
    await shoot(page, testInfo, "recap");

    await lines.first().click();
    await expect(head).toHaveText("Format");
    await expect(button("Built-in, 54–56 cm")).toHaveAttribute("aria-pressed", "true");
    await button("Freestanding, 60 cm").click();
    await expect(lines.first()).toHaveText("FormatFreestanding, 60 cm");
    await expect(head).toHaveCount(0);

    const answered = page.waitForRequest((request) =>
      request.url().includes("/rpc/threads/answer"),
    );
    await button("Send").click();
    expect(JSON.parse((await answered).postDataJSON().json.answer)).toEqual({
      answers: {
        q1: { selected: ["q1o1"] },
        q2: { selected: ["q2o1", "q2o2"] },
        q3: { skipped: true },
      },
    });
    const bubble = page.getByRole("group", {
      name: "Your answer: Format — Freestanding, 60 cm; Extras — Ice maker, No frost; Do you already have a separate freezer? — Skipped",
    });
    await expect(bubble).toBeVisible();
    await expect(card.getByTestId("ask-settled")).toContainText(
      "Format · Extras · Do you already have a separate freezer?",
    );
    await expect(card.locator("[data-ask-flight]")).toHaveCount(0);
    await shoot(page, testInfo, "settled");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(bubble).toBeVisible({ timeout: 15_000 });
  });
}
