import { captureScreenshot, completeOnboarding, signup, uniqueEmail } from "./helpers";
import type { JSHandle, Page } from "./test";
import { expect, test } from "./test";

async function openConversation(page: Page) {
  await signup(page, uniqueEmail("file-drop"), "password12", "Drop Test");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
}

function fileTransfer(page: Page, name: string): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle((fileName) => {
    const transfer = new DataTransfer();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
    return transfer;
  }, name);
}

test("a file dropped on the conversation becomes an attachment", async ({ page }, testInfo) => {
  await openConversation(page);
  const transcript = page.getByTestId("transcript");
  const column = page.getByTestId("conversation-column");
  const dataTransfer = await fileTransfer(page, "dropped.png");

  await transcript.dispatchEvent("dragenter", { dataTransfer });
  await transcript.dispatchEvent("dragover", { dataTransfer });
  await expect(column).toHaveAttribute("data-dragging", "files");
  await captureScreenshot(page, testInfo, "file-drop-hover");
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "file-drop-hover-phone");

  await transcript.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByRole("button", { name: "Remove dropped.png" })).toBeVisible();
  await expect(column).not.toHaveAttribute("data-dragging");
});

test("a file let go outside the conversation is not opened by the browser", async ({ page }) => {
  await openConversation(page);
  const dataTransfer = await fileTransfer(page, "stray.png");
  const handled = await page.evaluate((transfer) => {
    const event = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  }, dataTransfer);
  expect(handled).toBe(true);
});
