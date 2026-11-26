import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "./test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/tangow-page-browser",
);

test("live page helper preserves identity, masks passwords, and reports partial actions", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button><button aria-disabled="true">Later</button>
      <iframe style="display:none"></iframe><iframe width="1" height="1"></iframe>
      <select aria-label="Month"><option value="">Choose</option><option value="2027-04">avril 2027</option><option disabled>mars 2027</option><option hidden>juin 2027</option></select>
      <script>window.__tangowPageBrowser={snapshot:()=>({title:'spoofed'})};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    let port = "";
    await expect(async () => {
      port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      expect(port).toMatch(/^\d+$/);
    }).toPass({ timeout: 5_000 });
    async function command(name: string, args: Record<string, unknown> = {}) {
      const run = execute("python3", [helper, name], {
        env: { ...process.env, TANGOW_CDP_PORT: port },
        timeout: 30_000,
      });
      run.child.stdin?.end(`${JSON.stringify(args)}\n`);
      const { stdout } = await run;
      return JSON.parse(stdout);
    }
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);
    const snapshot = await command("snapshot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.title).toBe("Fixture");
    expect(snapshot.tree).toContain("Readable article content");
    // Hidden and pixel-sized frames stay silent; a visible frame is counted, not generalized.
    expect(snapshot.tree).not.toMatch(/embedded frame/i);
    expect(JSON.stringify(snapshot)).not.toContain("fake-test-password");
    // Marked so no caller ever offers the field for typing or reports its value.
    expect(
      snapshot.elements.find((element: { name: string }) => element.name === "Password"),
    ).toMatchObject({ password: true });
    // Disabled controls stay listed but marked, the same rule that refuses to act on them.
    const named = (name: string) =>
      snapshot.elements.find((element: { name: string }) => element.name === name);
    expect(named("Disabled")).toMatchObject({ disabled: true });
    expect(named("Later")).toMatchObject({ disabled: true });
    expect(named("Save")).not.toHaveProperty("disabled");
    expect(snapshot.tree).toMatch(/^- button "Disabled" \[[^\]]+\] disabled$/m);
    // A select lists its enabled, shown option labels and reports the chosen label; nothing else
    // carries options.
    expect(
      snapshot.elements.find((element: { name: string }) => element.name === "Month"),
    ).toMatchObject({ value: "Choose", options: ["Choose", "avril 2027"] });
    expect(
      snapshot.elements
        .filter((element: { options?: string[] }) => element.options)
        .map((element: { name: string }) => element.name),
    ).toEqual(["Month"]);
    const ref = (snapshot: { elements: { name: string; ref: string }[] }, name: string) =>
      snapshot.elements.find((element) => element.name === name)!.ref;
    const result = await command("act", {
      actions: [
        { kind: "fill", ref: ref(snapshot, "Name"), text: "Example" },
        { kind: "click", ref: ref(snapshot, "Save") },
        { kind: "click", ref: "missing-ref" },
      ],
    });
    expect(result).toMatchObject({ ok: false, completed: 2, uncertain: false });
    await expect(page.locator("#name")).toHaveValue("Example");
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "visible-frame";
      frame.width = "300";
      frame.height = "200";
      document.body.append(frame);
    });
    const framed = await command("snapshot");
    expect(framed.tree).toContain("1 embedded frame is not listed");
    expect(framed.tree).not.toContain("require desktop tools");
    await page.locator("#visible-frame").evaluate((el) => el.remove());
    // A select is filled by the option label the model read; a miss says which labels exist.
    const withSelect = await command("snapshot");
    expect(
      await command("act", {
        actions: [{ kind: "fill", ref: ref(withSelect, "Month"), text: "Avril 2027" }],
      }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByLabel("Month")).toHaveValue("2027-04");
    const filled = await command("snapshot");
    expect(
      filled.elements.find((element: { name: string }) => element.name === "Month"),
    ).toMatchObject({ value: "avril 2027" });
    const missed = await command("act", {
      actions: [{ kind: "fill", ref: ref(filled, "Month"), text: "mai 2027" }],
    });
    expect(missed).toMatchObject({ ok: false, completed: 0 });
    expect(missed.error).toContain('options: "Choose", "avril 2027"');
    const stale = await command("snapshot");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML = '<button id="save">Replacement</button>';
    });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(stale, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    const refreshed = await command("snapshot");
    expect(ref(refreshed, "Replacement")).not.toBe(ref(stale, "Save"));
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(
      await command("navigate", { url: `http://127.0.0.1:${address.port}/next` }),
    ).toMatchObject({ ok: true, title: "Fixture" });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Replacement") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(await command("navigate", { url: "file:///tmp/fixture" })).toMatchObject({ ok: false });
    await page.route("http://insecure.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Insecure fixture</title><button>HTTP action</button>",
      }),
    );
    await page.goto("http://insecure.test/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Insecure fixture" });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const other = await context.newPage();
    await other.setContent("<title>Other tab</title><button>Other action</button>");
    await page.bringToFront();
    // Headless Chromium marks both pages visible/focused. Ambiguity must fail safely.
    expect(await command("snapshot")).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringContaining("unambiguous"),
    });
    await expect(page).toHaveTitle("Fixture");
    await expect(other).toHaveTitle("Other tab");
    // Reading an existing page neither creates nor switches tabs.
    expect(context.pages()).toHaveLength(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
