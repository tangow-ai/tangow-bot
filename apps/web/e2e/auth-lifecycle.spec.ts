import type { Locator, Page, TestInfo } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";
import { expect, test } from "./test";

async function captureOnboardingStep(page: Page, testInfo: TestInfo, name: string) {
  await expect(page.locator('[data-slot="onboarding-frame"] img').last()).toHaveJSProperty(
    "complete",
    true,
  );
  const desktopViewport = page.viewportSize();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await captureScreenshot(page, testInfo, `${name}-${colorScheme}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await captureScreenshot(page, testInfo, `${name}-${colorScheme}-phone`);
    await page.setViewportSize(shortPhone);
    await captureScreenshot(page, testInfo, `${name}-${colorScheme}-short-phone`);
    if (desktopViewport) await page.setViewportSize(desktopViewport);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const shortPhone = { width: 393, height: 694 };

/** A box read once it stops moving: the button eases its margin when the viewport changes. */
async function settledBox(locator: Locator) {
  let last: Awaited<ReturnType<Locator["boundingBox"]>> = null;
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      const settled = JSON.stringify(box) === JSON.stringify(last);
      last = box;
      return settled;
    })
    .toBe(true);
  return last;
}

/** The main button's box on the desktop viewport, and with the scene card's on a short phone. */
async function stepLayout(page: Page, button: Locator) {
  const desktopViewport = page.viewportSize();
  const desktop = await settledBox(button);
  await page.setViewportSize(shortPhone);
  const phone = await settledBox(button);
  const card = await page.locator(".rk-onboarding-stage").boundingBox();
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  return { desktop, phone, card };
}

test("the clay plays forward into sign-up and stands still going back", async ({
  page,
}, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.setViewportSize({ width: 390, height: 844 });
  const preloaded = ["p02", "p03", "p04"].map((frame) =>
    page.waitForResponse((response) => response.url().includes(`/${frame}-800`)),
  );
  await page.goto("/");
  await Promise.all(preloaded);
  await page.clock.install();
  const plate = page.locator(".rk-onboarding-stage > img");
  const onTop = plate.locator("visible=true").last();
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.getByRole("link", { name: "Sign up" }).click();
    for (const frame of ["p02", "p03", "p04"]) {
      await expect(onTop).toHaveAttribute("src", new RegExp(`/${frame}-800`));
      await captureScreenshot(page, testInfo, `40-plate-${frame}-${colorScheme}-phone`);
      await page.clock.runFor(150);
    }
    await page.goBack();
    await expect(plate).toHaveCount(1);
  }
});

test("a busy step button keeps its label and its size", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-up/email", () => {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Busy User");
  await page.getByLabel("Email").fill("busy@example.test");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  const create = page.getByRole("button", { name: "Create account", exact: true });
  const idle = await create.boundingBox();
  await create.click();
  await expect(create).toHaveAttribute("aria-busy", "true");
  expect(await create.boundingBox()).toEqual(idle);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const path = testInfo.outputPath(`40-sign-up-busy-${colorScheme}-phone.png`);
    // The sweep is the state under test, so the capture keeps animations running and
    // lets the theme's colour transitions settle first.
    await page.waitForTimeout(600);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`40-sign-up-busy-${colorScheme}-phone`, {
      contentType: "image/png",
      path,
    });
  }
});

test("restricted signup waits for mailbox verification", async ({ page }, testInfo) => {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: { passwordReset: false, resetUrl: null },
    }),
  );
  let refuse = true;
  await page.route("**/api/auth/sign-up/email", (route) =>
    refuse
      ? route.fulfill({
          status: 400,
          json: { code: "REGISTRATION_CLOSED", message: "Registration is closed" },
        })
      : route.fulfill({
          json: { token: null, user: { id: "pending-user", emailVerified: false } },
        }),
  );
  const resent: unknown[] = [];
  await page.route("**/api/auth/send-verification-email", (route) => {
    resent.push(route.request().postDataJSON());
    return route.fulfill({ json: { status: true } });
  });
  await page.goto("/");
  await expect(page.locator('[data-tangow-surface="welcome"]')).toBeVisible();
  await captureOnboardingStep(page, testInfo, "40-welcome");
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Grab some clay." })).toBeVisible();
  await captureOnboardingStep(page, testInfo, "40-sign-up");
  await page.getByLabel("Name").fill("Pending User");
  await page.getByLabel("Email").fill("pending@example.test");
  await page.getByLabel("Password", { exact: true }).fill("password12");
  const create = page.getByRole("button", { name: "Create account", exact: true });
  const quiet = await stepLayout(page, create);
  expect(quiet.card?.width).toBe(shortPhone.width - 32);
  await create.click();
  const status = page.getByRole("alert");
  await expect(status).toHaveText("Sign-ups are closed on this server.");
  expect(await stepLayout(page, create)).toEqual(quiet);
  const [button, line] = [await create.boundingBox(), await status.boundingBox()];
  expect(line!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
  await captureOnboardingStep(page, testInfo, "40-sign-up-refused");

  refuse = false;
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email." })).toBeVisible();
  await expect(page).toHaveURL(/\/sign-up\?verify=email$/);
  await page.reload();
  await expect(page.getByText("Open the link sent to pending@example.test.")).toBeVisible();
  await captureOnboardingStep(page, testInfo, "40-check-email");
  await page.getByRole("button", { name: "Send again" }).click();
  await expect.poll(() => resent).toEqual([{ email: "pending@example.test" }]);
  await page.getByRole("link", { name: "Use another email" }).click();
  await expect(page.getByRole("heading", { name: "Grab some clay." })).toBeVisible();
});

test("logout protects bot deep links and sign-in restores the session", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const email = `auth-lifecycle-${stamp}@tangow.test`;
  const password = "password12";
  const userName = "Auth Lifecycle";

  await page.goto("/sign-up");
  await expect(page.getByLabel("Name")).toHaveAttribute("autocomplete", "name");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "new-password",
  );

  await signup(page, email, password, userName);
  await completeOnboarding(page);

  await page.waitForURL(/\/app\/[^/]+$/);
  const protectedBotPath = new URL(page.url()).pathname;
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(
    page
      .locator('[data-slot="popover-content"]')
      .getByRole("button", { name: "Models", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-slot="popover-content"]')
      .getByRole("button", { name: "Memory", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-slot="popover-content"]')
      .getByRole("button", { name: "Voice", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "36-account-menu");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Got the key?" })).toBeVisible();
  await page.goto("/");
  await expect(page.locator('[data-tangow-surface="welcome"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: /Mold a bot\./ })).toBeVisible();
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByRole("heading", { name: "Grab some clay." })).toBeVisible();
  await page.goto("/");
  await captureScreenshot(page, testInfo, "37-logged-out-welcome");

  await page.goto(protectedBotPath);
  await page.waitForURL((url) => url.pathname === "/sign-in");
  await expect(page.getByRole("heading", { name: "Got the key?" })).toBeVisible();
  await expect(page.getByText("Chief", { exact: true })).toHaveCount(0);
  await expect(page.getByText(userName, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", "username");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await expect(page.getByRole("img", { name: "Tangow" })).toBeVisible();
  await expect(page.locator('form input[type="email"]')).toBeVisible();
  await expect(page.locator('[data-slot="onboarding-frame"] img')).toHaveJSProperty(
    "complete",
    true,
  );
  await captureScreenshot(page, testInfo, "38-protected-deep-link-sign-in");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "38-sign-in-phone");
  if (desktopViewport) await page.setViewportSize(desktopViewport);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("wrong-password12");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(/wrong email or password/i);
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page).toHaveURL(/\/sign-in$/);
  await captureOnboardingStep(page, testInfo, "39-invalid-credentials");

  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname === protectedBotPath, {
    timeout: 20_000,
  });
  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await expect(composer).toHaveAttribute("name", "chat-message");
  await expect(composer).toHaveAttribute("autocomplete", "off");
  await expect(composer).toHaveAttribute("aria-label", "Message Chief");
  await expect(page.getByRole("button", { name: new RegExp(userName, "i") })).toBeVisible();

  await composer.fill("line one");
  const heightBeforeNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  await composer.press("Shift+Enter");
  await composer.type("line two");
  await expect(composer).toHaveValue("line one\nline two");
  const heightWithNewline = await composer.evaluate((el) => el.getBoundingClientRect().height);
  expect(heightWithNewline).toBeGreaterThan(heightBeforeNewline);

  await composer.press("Enter");
  const multilineMessage = page
    .getByTestId("transcript")
    .getByText("line one\nline two", { exact: true });
  await expect(multilineMessage).toBeVisible();
  await expect(multilineMessage).toHaveCSS("white-space", "pre-wrap");

  const message = "Fake composer regression check.";
  await composer.fill(message);
  await captureScreenshot(page, testInfo, "40-restored-auth-session");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  // Scope to the transcript: the sidebar activity row can echo the same text.
  await expect(page.getByTestId("transcript").getByText(message, { exact: true })).toBeVisible();
});

test("changes and recovers an email password", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const email = `password-recovery-${stamp}@tangow.test`;
  const originalPassword = "password12";
  const changedPassword = "changed-password12";
  const resetPassword = "reset-password12";
  const userName = "Password Recovery";

  await signup(page, email, originalPassword, userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);

  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toBeVisible();
  await expect(settings.locator('input[name="username"]')).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(settings.locator('input[name="username"]')).toHaveValue(email);
  await expect(settings.getByLabel("Current password")).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await expect(settings.getByLabel("New password")).toHaveAttribute("autocomplete", "new-password");
  await expect(settings.getByLabel("Confirm password")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await settings.getByLabel("Current password").fill(originalPassword);
  await settings.getByLabel("New password").fill(changedPassword);
  await settings.getByLabel("Confirm password").fill(changedPassword);
  await settings.getByRole("button", { name: "Change password" }).click();
  await expect(settings.getByText("Password updated")).toBeVisible();
  await captureScreenshot(page, testInfo, "41-password-changed");
  await settings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByRole("button", { name: new RegExp(userName, "i") }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Lost the key?" })).toBeVisible();
  await captureOnboardingStep(page, testInfo, "42-forgot-password");
  await page.getByLabel("Email").fill(email);
  await expect(page.getByLabel("Email")).toHaveValue(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "A new key is on its way." })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    `If ${email} has an account, the link is in its inbox.`,
  );
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await captureOnboardingStep(page, testInfo, "42-password-reset-requested");

  const emailApi = process.env.API_URL ?? "http://127.0.0.1:3110";
  await expect
    .poll(async () => {
      const response = await page.request.get(`${emailApi}/__e2e/emails`);
      return ((await response.json()) as unknown[]).length;
    })
    .toBeGreaterThan(0);
  const messagesResponse = await page.request.get(`${emailApi}/__e2e/emails`);
  expect(messagesResponse.headers()["cache-control"]).toBe("no-store");
  const messages = (await messagesResponse.json()) as Array<{
    text: string;
  }>;
  const resetUrl = messages.at(-1)?.text.match(/https?:\/\/\S+/)?.[0];
  expect(resetUrl).toBeTruthy();

  await page.goto(resetUrl!);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await captureOnboardingStep(page, testInfo, "43-new-password");
  await page.getByLabel("New password").fill(resetPassword);
  await page.getByLabel("Confirm password").fill(`${resetPassword}x`);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match");
  await expect(page.getByLabel("Confirm password")).toHaveAttribute("aria-invalid", "true");
  await captureOnboardingStep(page, testInfo, "43-new-password-mismatch");
  await page.getByLabel("Confirm password").fill(resetPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Got the key?" })).toBeVisible();

  await page.goto(resetUrl!);
  await expect(page.getByRole("alert")).toHaveText("This link has expired or was already used.");
  await captureOnboardingStep(page, testInfo, "44-reset-link-expired");
  await page.getByRole("link", { name: "Send a new link" }).click();
  await expect(page.getByRole("heading", { name: "Lost the key?" })).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(resetPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/app(?:\/|$)/);
});
