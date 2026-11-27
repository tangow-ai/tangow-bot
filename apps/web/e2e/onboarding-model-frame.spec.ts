import type { Page } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const viewports = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "phone", width: 390, height: 844 },
  { name: "short-phone", width: 393, height: 694 },
];

async function needModel(page: Page) {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: "openai/gpt-5.6-luna",
        },
      },
    });
  });
  await page.route("**/rpc/integrationSetup/get", (route) =>
    route.fulfill({
      json: {
        json: {
          canConfigure: false,
          needsSetup: false,
          webUrl: "https://example.test/integrations/setup",
          providers: [],
        },
      },
    }),
  );
}

/** Signs up from the sign-up page, recording each plate frame shown on top as it changes. */
async function signUpWatchingThePlate(page: Page, email: string) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Grab some clay." })).toBeVisible();
  await page.evaluate(() => {
    const seen: (number | null)[] = [];
    (window as unknown as { plateFrames: typeof seen }).plateFrames = seen;
    const tick = () => {
      const shown = [...document.querySelectorAll<HTMLImageElement>(".rk-onboarding-stage img")]
        .filter((image) => !image.hidden)
        .at(-1);
      const frame = /p(\d\d)-(?:800|1600)/.exec(shown?.currentSrc || shown?.src || "")?.[1];
      const value = frame ? Number(frame) : null;
      if (seen.at(-1) !== value) seen.push(value);
      requestAnimationFrame(tick);
    };
    tick();
  });
  await page.getByLabel("Name").fill("Plate Watcher");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
}

const plateFrames = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { plateFrames: (number | null)[] }).plateFrames.filter(
      (frame) => frame !== null,
    ),
  );

test("signing up plays the clay toward the model step, and a connected model opens its eyes", async ({
  page,
}, testInfo) => {
  await needModel(page);
  await page.route("**/rpc/models/connect", (route) => route.fulfill({ json: { json: {} } }));
  await signUpWatchingThePlate(page, `model-plate-${Date.now()}@tangow.test`);
  await expect(page.getByRole("heading", { name: "Plug in a brain." })).toBeVisible({
    timeout: 20_000,
  });
  for (const shot of ["a", "b", "c"]) {
    await captureScreenshot(page, testInfo, `signup-to-model-${shot}`);
    await page.waitForTimeout(250);
  }
  await expect.poll(() => plateFrames(page)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);

  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Opening chat…")).toBeVisible();
  expect(await plateFrames(page)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

for (const viewport of viewports) {
  test(`the model step keeps its main button in place through every state (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await needModel(page);
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await page.route("**/rpc/models/beginOAuth", (route) =>
      route.fulfill({
        json: {
          json: {
            loginId: "fake-login",
            provider: "anthropic",
            mode: "auth-url",
            verificationUri: "https://claude.example.test/oauth/authorize?state=fake",
            expiresInSeconds: 900,
          },
        },
      }),
    );
    await page.route("**/rpc/models/completeOAuth", (route) =>
      route.fulfill({ json: { json: { status: "pending" } } }),
    );
    let releaseConnect!: () => void;
    const connectHeld = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    await page.route("**/rpc/models/connect", async (route) => {
      await connectHeld;
      await route.fulfill({
        status: 400,
        json: {
          json: {
            defined: false,
            code: "BAD_REQUEST",
            status: 400,
            message: "OpenRouter rejected this key.",
          },
          meta: [],
        },
      });
    });
    await signUpWatchingThePlate(page, `model-states-${viewport.name}-${Date.now()}@tangow.test`);
    await expect(page.getByRole("heading", { name: "Plug in a brain." })).toBeVisible({
      timeout: 20_000,
    });

    const main = page.locator(".rk-onboarding-actions > :first-child");
    const tops: Record<string, number> = {};
    const record = async (state: string) => {
      tops[state] = (await main.boundingBox())!.y;
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await captureScreenshot(page, testInfo, `model-${viewport.name}-${state}-${colorScheme}`);
      }
      await page.emulateMedia({ colorScheme: "light" });
    };
    const apiKey = page.getByLabel("API key", { exact: true });

    await expect.poll(() => plateFrames(page)).toContain(11);
    await record("empty");
    await apiKey.fill("fake-test-key");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Connecting…")).toBeVisible();
    await record("connecting");
    releaseConnect();
    await expect(page.getByRole("alert")).toHaveText("OpenRouter rejected this key.");
    await expect(apiKey).toHaveAttribute("aria-invalid", "true");
    await record("error");

    const provider = page.getByRole("combobox", { name: "Provider" });
    await provider.selectOption({ label: "Anthropic" });
    const signIn = page.getByRole("button", { name: "Sign in with Claude Pro/Max" });
    await expect(apiKey).toBeHidden();
    await record("subscription");
    await signIn.click();
    await expect(page.getByText("Waiting for sign-in…")).toBeVisible();
    await expect(page.getByLabel("Code or URL")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Model" })).toBeHidden();
    await record("waiting");
    await page.getByRole("button", { name: "Or paste an API key" }).click();
    await expect(apiKey).toBeVisible();
    await expect(signIn).toBeVisible();
    await record("subscription-key");

    await provider.selectOption({ label: "OpenAI-compatible" });
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await page.getByRole("button", { name: "Add API key" }).click();
    await expect(apiKey).toBeFocused();
    await expect(apiKey).toBeInViewport();
    await record("server-with-key");

    expect(new Set(Object.values(tops)), JSON.stringify(tops)).toEqual(new Set([tops.empty]));
  });
}
