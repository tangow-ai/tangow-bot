import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  openUserSettings,
  signup,
  uniqueEmail,
} from "./helpers";
import { expect, type Locator, type Page, test } from "./test";

async function setupGroupComposer(page: Page) {
  await signup(page, uniqueEmail("quiet-composer"), "password12", "Quiet Composer");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const helperId = await createNamedBot(page, "Helper");
  expect(helperId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Quiet composer team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Helper" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Quiet composer team" });
  await expect(composer).toBeVisible();
  return composer;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  const settings = await openUserSettings(page);
  await settings.getByTestId(`ui-appearance-${theme}`).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await settings.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).toBeHidden();
}

/**
 * Stubs `window.SpeechRecognition` before the app loads, so the composer's
 * dictation (`apps/web/src/lib/dictation.ts`) drives a fake engine instead of
 * a real one. The test reaches the running instance through
 * `window.__fakeRecognition` to fire `onresult` the way a browser would.
 */
async function stubSpeechRecognition(page: Page) {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        Object.assign(window, { __fakeRecognition: this });
      }
      stop() {}
      abort() {}
    }
    Object.assign(window, { SpeechRecognition: FakeSpeechRecognition });
  });
}

function speak(page: Page, transcript: string) {
  return page.evaluate((text) => {
    const rec = (
      window as unknown as {
        __fakeRecognition?: { onresult?: (event: unknown) => void };
      }
    ).__fakeRecognition;
    rec?.onresult?.({ results: [{ isFinal: true, 0: { transcript: text } }] });
  }, transcript);
}

/** Mentions Helper mid-sentence and returns its inline token. */
async function addMention(page: Page, composer: Locator) {
  await composer.fill("Ask @Help");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: "@Helper" }).click();
  await page.keyboard.insertText("about the launch");
  const token = page.getByTestId("composer-bar").locator('[data-slot="entity-mention-field"]');
  await expect(token).toHaveText("@Helper");
  await expect(composer).toHaveValue("Ask @Helper about the launch");
  return token;
}

/** The token sits on the text's line, no taller than it. */
async function expectInline(token: Locator, composer: Locator) {
  const tokenBox = await token.boundingBox();
  const fieldBox = await composer.boundingBox();
  expect(tokenBox).toBeTruthy();
  expect(fieldBox).toBeTruthy();
  expect(tokenBox!.y).toBeGreaterThanOrEqual(fieldBox!.y);
  expect(tokenBox!.height).toBeLessThanOrEqual(fieldBox!.height);
}

test("composer capsule: empty, typing, and inline mention in light and dark", async ({
  page,
}, testInfo) => {
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  // Empty — the round-icon buttons show, but Send only mounts once there's a draft.
  await expect(bar.getByRole("button", { name: "Attach file" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  const emptyMicBox = await bar.getByRole("button", { name: "Dictate" }).boundingBox();
  expect(emptyMicBox).toBeTruthy();
  await captureScreenshot(page, testInfo, "quiet-composer-empty-light");

  // Typing — Send appears where the mic sat flush right, as on iOS.
  await composer.fill("Ping the team about the launch");
  const send = bar.getByRole("button", { name: "Send" });
  await send.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const sendBox = await send.boundingBox();
  expect(sendBox).toBeTruthy();
  expect(
    Math.abs(sendBox!.x + sendBox!.width - (emptyMicBox!.x + emptyMicBox!.width)),
  ).toBeLessThanOrEqual(1);
  await captureScreenshot(page, testInfo, "quiet-composer-typing-light");
  await composer.fill("");
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);

  // Mention — inline where it was typed, its glyph over the `@`.
  const lightToken = await addMention(page, composer);
  await expectInline(lightToken, composer);
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-mention-light");
  await composer.fill("");

  await setTheme(page, "dark");

  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-composer-empty-dark");

  await composer.fill("Ping the team about the launch");
  await expect(bar.getByRole("button", { name: "Send" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-typing-dark");
  await composer.fill("");

  const darkToken = await addMention(page, composer);
  await expectInline(darkToken, composer);
  await captureScreenshot(page, testInfo, "quiet-composer-mention-dark");
});

test("composer while a bot works: Send replaces Stop when drafting, light and dark", async ({
  page,
}, testInfo) => {
  await signup(page, uniqueEmail("quiet-composer-run"), "password12", "Run");
  await completeOnboarding(page);
  await page
    .locator("[data-sidebar-group]")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");

  const bar = page.getByTestId("composer-bar");
  const stop = bar.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  const micBox = await bar.getByRole("button", { name: "Dictate" }).boundingBox();
  const stopBox = await stop.boundingBox();
  expect(micBox).toBeTruthy();
  expect(stopBox).toBeTruthy();
  expect(stopBox!.x - (micBox!.x + micBox!.width)).toBeLessThanOrEqual(9);
  await captureScreenshot(page, testInfo, "quiet-composer-working-light");

  await setTheme(page, "dark");
  await expect(stop).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-working-dark");

  await composer.fill("Try another approach");
  const send = bar.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeVisible();
  await expect(stop).toHaveCount(0);
  await send.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const sendBox = await send.boundingBox();
  expect(sendBox).toBeTruthy();
  expect(Math.abs(sendBox!.x + sendBox!.width - (stopBox!.x + stopBox!.width))).toBeLessThanOrEqual(
    1,
  );
  await captureScreenshot(page, testInfo, "quiet-composer-steering-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "quiet-composer-steering-phone");

  await composer.fill("");
  await expect(stop).toBeVisible();
  await expect(send).toHaveCount(0);
});

/** Pastes a tiny fake PNG into the composer, the same way `composer-paste.spec.ts` does. */
async function pasteImageAttachment(page: Page, name: string) {
  await page.evaluate((fileName) => {
    const target = document.querySelector("textarea[name='chat-message']");
    if (!target) throw new Error("composer textarea not found");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const file = new File([bytes], fileName, { type: "image/png" });
    const clipboardData = {
      files: [file],
      types: ["Files"],
      items: [{ kind: "file" }],
      getData: () => "",
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    target.dispatchEvent(event);
  }, name);
}

// The composer at rest, and with multi-line text plus one pending
// attachment, in both themes — the capture the PR links as proof of render.
test("composer capsule: rest, then multiline text with an attachment, light and dark", async ({
  page,
}, testInfo) => {
  const composer = await setupGroupComposer(page);

  await captureScreenshot(page, testInfo, "quiet-composer-rest-light");

  await composer.fill(
    "Deux semaines en août, quatre personnes.\nOn garde la réserve de 2 000 € intacte, ça change quoi sur le budget ?\nEt si on décale d'une semaine ?",
  );
  await composer.click();
  await pasteImageAttachment(page, "receipt.png");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-multiline-attachment-light");

  await setTheme(page, "dark");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toBeVisible();
  await captureScreenshot(page, testInfo, "quiet-composer-multiline-attachment-dark");

  await page.getByRole("button", { name: "Remove receipt.png" }).click();
  await composer.fill("");
  await expect(page.getByRole("button", { name: "Remove receipt.png" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "quiet-composer-rest-dark");
});

test("dictation: mic opens dictation mode, transcribes, and only inserts on ✓", async ({
  page,
}, testInfo) => {
  await stubSpeechRecognition(page);
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  await composer.fill("Notes:");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await expect(bar).toHaveAttribute("data-state", "dictating");
  // The mic, Send and Attach are inactive/gone; ✓ and × take over.
  await expect(bar.getByRole("button", { name: "Dictate" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Attach file" })).toBeDisabled();
  const preview = bar.getByRole("textbox", { name: "Message Quiet composer team" });
  await expect(preview).toContainText("Notes:");
  await captureScreenshot(page, testInfo, "quiet-composer-dictating-light");

  await speak(page, "call the vendor");
  await expect(preview).toContainText("call the vendor");

  // Nothing is sent by dictation itself.
  await expect(page.getByTestId("transcript")).not.toContainText("call the vendor");

  await bar.getByRole("button", { name: "Insert dictation" }).click();
  await expect(bar).toHaveAttribute("data-state", "typing");
  await expect(composer).toHaveValue("Notes: call the vendor");
  await expect(bar.getByRole("button", { name: "Dictate" })).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText("call the vendor");

  await setTheme(page, "dark");
  await composer.fill("Notes:");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await expect(bar).toHaveAttribute("data-state", "dictating");
  await speak(page, "call the vendor");
  await expect(preview).toContainText("call the vendor");
  await captureScreenshot(page, testInfo, "quiet-composer-dictating-dark");
  await bar.getByRole("button", { name: "Cancel dictation" }).click();
});

test("dictation: × restores the draft exactly as it was", async ({ page }) => {
  await stubSpeechRecognition(page);
  const composer = await setupGroupComposer(page);
  const bar = page.getByTestId("composer-bar");

  await composer.fill("keep me");
  await bar.getByRole("button", { name: "Dictate" }).click();
  await speak(page, "discard me");
  await expect(bar.getByRole("textbox", { name: "Message Quiet composer team" })).toContainText(
    "discard me",
  );

  await bar.getByRole("button", { name: "Cancel dictation" }).click();
  await expect(bar).toHaveAttribute("data-state", "typing");
  await expect(composer).toHaveValue("keep me");
});
