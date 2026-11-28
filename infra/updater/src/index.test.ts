import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerUpdateRun } from "@tangow/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandEnvironment,
  createUpdaterApp,
  restoreCheckoutArgv,
  type UpdaterCommandRunner,
} from "./index.js";
import { resolveUpdaterConfig } from "./updater-logic.js";

const token = "fake-review-updater-token-000000000000";
const app = createUpdaterApp(
  resolveUpdaterConfig({
    TANGOW_DEPLOY_DIR: "/tangow-updater-tests-no-such-directory",
    TANGOW_UPDATER_TOKEN: token,
  }),
);
const authorized = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const currentCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function deployment(env = "TANGOW_IMAGE_TAG=v1.0.0\nTANGOW_IMAGE_TAG_PREVIOUS=v0.9.0\n") {
  const deployDir = await mkdtemp(path.join(os.tmpdir(), "tangow-updater-test-"));
  temporaryDirectories.push(deployDir);
  await writeFile(path.join(deployDir, ".env"), env);
  return {
    deployDir,
    config: resolveUpdaterConfig({ TANGOW_DEPLOY_DIR: deployDir, TANGOW_UPDATER_TOKEN: token }),
  };
}

async function checkoutDeployment(env?: string) {
  const fixture = await deployment(env);
  await mkdir(path.join(fixture.deployDir, ".git"));
  return fixture;
}

/**
 * A clean checkout on `currentCommit` whose remote branch is at `targetCommit`. Docker calls go to
 * `docker`, so each test only describes the part it is about.
 */
function checkoutRunner(
  docker: (args: string[]) => ReturnType<typeof ok> | Promise<ReturnType<typeof ok>> = () => ok(),
  remote = "https://github.com/tangow-ai/tangow-bot",
): UpdaterCommandRunner {
  let merged = false;
  return async (command, args) => {
    if (command !== "git") return docker(args);
    const joined = args.join(" ");
    if (args[0] === "merge") merged = true;
    if (joined === "rev-parse HEAD") return ok(merged ? targetCommit : currentCommit);
    if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
    if (joined === "remote get-url origin") return ok(remote);
    if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
    return ok();
  };
}

function ok(output = "") {
  return { ok: true, exitCode: 0, output };
}

function waitTimeout(args: readonly string[] | undefined) {
  return args?.[args.indexOf("--wait-timeout") + 1];
}

function failed(output: string) {
  return { ok: false, exitCode: 1, output };
}

function request(app: ReturnType<typeof createUpdaterApp>, pathname: string, body?: unknown) {
  return app.request(pathname, {
    method: "POST",
    headers: authorized,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("updater HTTP surface", () => {
  it("answers health without credentials, for the compose healthcheck", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, service: "updater" });
  });

  it("rejects every privileged route without the shared token", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/state"],
      ["POST", "/plan"],
      ["POST", "/apply"],
      ["POST", "/rollback"],
    ];
    for (const [method, pathname] of routes) {
      const response = await app.request(pathname, { method });
      expect(response.status, `${method} ${pathname}`).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    }
  });

  it("rejects a wrong or malformed token", async () => {
    for (const authorization of [`Bearer ${"x".repeat(token.length)}`, token, "Basic abc"]) {
      const response = await app.request("/state", { headers: { authorization } });
      expect(response.status).toBe(401);
    }
  });

  it("re-validates the repository URL at its own boundary", async () => {
    const cases = [
      "http://github.com/a/b",
      "file:///etc/passwd",
      "https://user:pw@github.com/a/b",
      "--upload-pack=id",
      "https://github.com/a/b?x=1",
    ];
    for (const repoUrl of cases) {
      const response = await app.request("/apply", {
        method: "POST",
        headers: authorized,
        body: JSON.stringify({ repoUrl, branch: "main" }),
      });
      expect(response.status, repoUrl).toBe(400);
      const payload = (await response.json()) as { error: string };
      expect(payload.error, repoUrl).toBeTruthy();
    }
  });

  it("re-validates the branch at its own boundary", async () => {
    const response = await app.request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        repoUrl: "https://github.com/tangow-ai/tangow-bot",
        branch: "--exec=id",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("refuses an update when the deployment has no checkout to build from", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/apply", {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ repoUrl: "https://github.com/someone/tangow", branch: "main" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/no \.git directory/);
  });

  it("refuses a rollback when no previous tag was recorded", async () => {
    const fixture = await deployment("TANGOW_IMAGE_TAG=v1.0.0\n");
    const response = await createUpdaterApp(fixture.config).request("/rollback", {
      method: "POST",
      headers: authorized,
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toMatch(/nothing to roll back/);
  });

  it("reports the deployment it manages without touching Docker", async () => {
    const fixture = await deployment();
    const response = await createUpdaterApp(fixture.config).request("/state", {
      headers: authorized,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployDir: fixture.deployDir,
      currentTag: "v1.0.0",
      previousTag: "v0.9.0",
      checkout: { present: false },
    });
  });

  it("fails closed when the deployment environment cannot be read", async () => {
    const response = await app.request("/state", { headers: authorized });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/\.env/) });
  });
});

describe("updater orchestration", () => {
  it.each([
    { endpoint: "/apply", production: true, script: true, prepares: true },
    { endpoint: "/apply", production: true, script: false, prepares: false },
    { endpoint: "/apply", production: false, script: true, prepares: false },
    { endpoint: "/rollback", production: true, script: true, prepares: false },
  ])(
    "prepares the vault for $endpoint with production=$production and script=$script",
    async ({ endpoint, production, script, prepares }) => {
      const { config, deployDir } = await checkoutDeployment();
      const helper = path.join(deployDir, "scripts/tangow-vault.mjs");
      if (script) {
        await mkdir(path.dirname(helper));
        await writeFile(helper, "");
      }
      const overlay = path.join(deployDir, "overlay.yml");
      const composeFiles = production ? [...config.composeFiles, overlay] : [overlay];
      const calls: Array<{ command: string; args: string[] }> = [];
      const checkout = checkoutRunner();
      const subject = createUpdaterApp(
        { ...config, composeFiles },
        {
          run: async (command, args, options) => {
            calls.push({ command, args });
            return checkout(command, args, options);
          },
        },
      );
      const response = await request(
        subject,
        endpoint,
        endpoint === "/apply"
          ? {
              repoUrl: "https://github.com/tangow-ai/tangow-bot",
              branch: "main",
            }
          : undefined,
      );
      const record = (await response.json()) as ServerUpdateRun;
      expect(record.ok).toBe(true);
      expect(record.steps.map(({ id }) => id).slice(endpoint === "/apply" ? 3 : 0)).toEqual(
        prepares ? ["prepare-vault", "pull-vault", "recreate"] : ["recreate"],
      );
      const prepare = calls.findIndex(
        ({ command, args }) => command === "node" && args[0] === helper,
      );
      const pull = calls.findIndex(
        ({ args }) => args.slice(-4).join(" ") === "pull --policy missing openbao",
      );
      if (prepares) {
        expect(prepare).toBeGreaterThan(-1);
        expect(pull).toBeGreaterThan(prepare);
        expect(calls.findIndex(({ args }) => args.includes("--build"))).toBeGreaterThan(pull);
      } else {
        expect(prepare).toBe(-1);
        expect(calls.some(({ args }) => args.includes("pull"))).toBe(false);
      }
    },
  );

  it("serializes updates before their asynchronous preflight can race", async () => {
    const fixture = await checkoutDeployment();
    let releaseGate: ((result: ReturnType<typeof ok>) => void) | undefined;
    const pendingRelease = new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseGate = resolve;
    });
    let reachedRemote!: () => void;
    const atRemote = new Promise<void>((resolve) => {
      reachedRemote = resolve;
    });
    const checkout = checkoutRunner();
    const run: UpdaterCommandRunner = async (command, args, options) => {
      if (command === "git" && args.includes("ls-remote")) {
        reachedRemote();
        return pendingRelease;
      }
      return checkout(command, args, options);
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const input = { repoUrl: "https://github.com/tangow-ai/tangow-bot", branch: "main" };
    const first = request(subject, "/apply", input);
    await atRemote;
    const second = await request(subject, "/apply", input);
    expect(second.status).toBe(400);
    await expect(second.json()).resolves.toEqual({ error: "An update is already running." });
    releaseGate?.(ok(`${targetCommit}\trefs/heads/main\n`));
    expect((await first).status).toBe(200);
  });

  it("restores the previous remote when an update fails after repointing it", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const previousRemote = "https://github.com/example/previous-fork";
    const nextRemote = "https://github.com/example/next-fork";
    const run: UpdaterCommandRunner = async (command, args) => {
      calls.push({ command, args });
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok(previousRemote);
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "fetch") return failed("registry unavailable");
      return ok();
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", { repoUrl: nextRemote, branch: "main" });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual(["remote", "fetch", "restore-remote"]);
    expect(
      calls.filter(({ args }) => args.slice(0, 3).join(" ") === "remote set-url origin"),
    ).toEqual([
      { command: "git", args: ["remote", "set-url", "origin", nextRemote] },
      { command: "git", args: ["remote", "set-url", "origin", previousRemote] },
    ]);
  });

  it("restores the prior checkout and image after a recreate fails health checks", async () => {
    const fixture = await checkoutDeployment();
    const calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
    let upCalls = 0;
    const checkout = checkoutRunner((args) => {
      if (!args.includes("up")) return ok();
      upCalls += 1;
      return upCalls === 1 ? failed("api did not become healthy") : ok("restored");
    });
    const run: UpdaterCommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return checkout(command, args, options);
    };
    const subject = createUpdaterApp(fixture.config, { run });
    const response = await request(subject, "/apply", {
      repoUrl: "https://github.com/tangow-ai/tangow-bot",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record).toMatchObject({ ok: false, restart: "not-required" });
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "recreate",
      "stop-migrate",
      "restore-checkout",
      "recover",
    ]);
    expect(calls.map(({ args }) => args)).toContainEqual(["checkout", "-B", "main", currentCommit]);
    expect(record.restartAdvice).toMatch(/restored the previously running v1\.0\.0 image/);
    const composeUp = calls.filter(({ args }) => args.includes("up"));
    expect(composeUp).toHaveLength(2);
    expect(composeUp[0]?.args).toEqual(expect.arrayContaining(["--wait", "--pull", "never"]));
    expect(composeUp[0]?.args).toContain("--build");
    expect(composeUp[1]?.args).toContain("--no-build");
    expect(waitTimeout(composeUp[0]?.args)).toBe("3600");
    expect(composeUp[0]?.args).not.toContain("--no-deps");
    expect(composeUp[1]?.args).toContain("--no-deps");
    expect(composeUp[0]?.env?.TANGOW_IMAGE_TAG).toBe(`local-${targetCommit}`);
    expect(composeUp[1]?.env?.TANGOW_IMAGE_TAG).toBe("v1.0.0");
    expect(await readFile(path.join(fixture.deployDir, ".env"), "utf8")).toContain(
      "TANGOW_IMAGE_TAG=v1.0.0",
    );

    const state = await subject.request("/state", { method: "GET", headers: authorized });
    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toMatchObject({
      running: false,
      lastRun: { ok: false, fromTag: "v1.0.0", toTag: `local-${targetCommit}` },
    });
  });

  it("leaves the services down rather than restore an image older than the moved conversations", async () => {
    const fixture = await checkoutDeployment();
    const ups: string[][] = [];
    const run = checkoutRunner((args) => {
      if (args.includes("--entrypoint")) return failed("the image has no session log");
      if (args.includes("exec")) return ok("t\n");
      if (!args.includes("up")) return ok();
      ups.push(args);
      return failed("api did not become healthy");
    });
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/tangow-ai/tangow-bot",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record).toMatchObject({ ok: false, restart: "manual" });
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "recreate",
      "stop-migrate",
      "restore-checkout",
    ]);
    expect(record.restartAdvice).toMatch(/v1\.0\.0 cannot read this database/);
    expect(ups).toHaveLength(1);
  });

  it("restores the prior branch when merge fails after checkout switches", async () => {
    const fixture = await deployment("TANGOW_IMAGE_TAG=local\n");
    await mkdir(path.join(fixture.deployDir, ".git"));
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("deploy");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status") || joined === "ls-files --others --exclude-standard") return ok();
      if (args.includes("ls-remote")) return ok(`${targetCommit}\trefs/heads/main\n`);
      if (args[0] === "merge") return failed("not a fast-forward");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(false);
    expect(record.steps.map((step) => step.id)).toEqual([
      "fetch",
      "checkout",
      "merge",
      "restore-checkout",
    ]);
    expect(calls).toContainEqual(["checkout", "-B", "deploy", currentCommit]);
  });

  it("rolls back from the cached image without rebuilding", async () => {
    const fixture = await deployment();
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/rollback");
    const record = (await response.json()) as ServerUpdateRun;
    expect(record.ok).toBe(true);
    expect(calls.some((args) => args.includes("pull"))).toBe(false);
    expect(calls.find((args) => args.includes("up"))).toEqual(
      expect.arrayContaining(["--pull", "never", "--no-deps"]),
    );
    const stopsMigrate = calls.findIndex((args) => args.includes("rm") && args.includes("migrate"));
    expect(stopsMigrate).toBeGreaterThan(-1);
    expect(stopsMigrate).toBeLessThan(calls.findIndex((args) => args.includes("up")));
  });

  it("refuses a rollback to an image older than the moved conversations", async () => {
    const fixture = await deployment();
    const calls: string[][] = [];
    const run: UpdaterCommandRunner = async (_command, args) => {
      calls.push(args);
      if (args.includes("--entrypoint")) return failed("the image has no session log");
      return args.includes("exec") ? ok("t\n") : ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/rollback");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/v0\.9\.0 cannot read this database/),
    });
    expect(calls.some((args) => args.includes("up"))).toBe(false);
  });

  it("preserves the environment owner and surrounding values with mode 0600", async () => {
    const fixture = await checkoutDeployment("FAKE_SETTING=kept\nTANGOW_IMAGE_TAG=v1.0.0\n");
    const envFile = path.join(fixture.deployDir, ".env");
    await chmod(envFile, 0o644);
    const before = await lstat(envFile);
    const run = checkoutRunner();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/tangow-ai/tangow-bot",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    const after = await lstat(envFile);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode & 0o777 }).toEqual({
      uid: before.uid,
      gid: before.gid,
      mode: 0o600,
    });
    expect(await readFile(envFile, "utf8")).toMatch(/FAKE_SETTING=kept/);
  });

  it("refuses to replace a symlinked deployment environment", async () => {
    const fixture = await checkoutDeployment();
    const envFile = path.join(fixture.deployDir, ".env");
    const target = path.join(fixture.deployDir, "fake-target");
    await writeFile(target, "TANGOW_IMAGE_TAG=v1.0.0\n");
    await rm(envFile);
    await symlink(target, envFile);
    const run = checkoutRunner();
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/tangow-ai/tangow-bot",
      branch: "main",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/persist/),
    });
    expect(await readFile(target, "utf8")).toBe("TANGOW_IMAGE_TAG=v1.0.0\n");
  });

  it("fails closed when it cannot verify checkout cleanliness", async () => {
    const fixture = await deployment();
    await mkdir(path.join(fixture.deployDir, ".git"));
    const run: UpdaterCommandRunner = async (_command, args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok(currentCommit);
      if (joined === "rev-parse --abbrev-ref HEAD") return ok("main");
      if (joined === "remote get-url origin") return ok("https://github.com/example/fork");
      if (args.includes("status")) return failed("cannot read index");
      return ok();
    };
    const response = await request(createUpdaterApp(fixture.config, { run }), "/apply", {
      repoUrl: "https://github.com/example/fork",
      branch: "main",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/verified/),
    });
  });
});

describe("child process environment", () => {
  it("declares the deployment directory safe so git works on a non-root checkout", () => {
    // The child environment is rebuilt from an allowlist, so GIT_CONFIG_* set on the Compose
    // service never reaches git. Without these three, every git call exits 128 with "detected
    // dubious ownership" on the layout docs/self-host.md recommends.
    const env = commandEnvironment({ TANGOW_DEPLOY_DIR: "/srv/tangow" });
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("/srv/tangow");
  });

  it("keeps the exemption scoped to the deployment directory, whoever calls it", () => {
    const env = commandEnvironment(
      { TANGOW_DEPLOY_DIR: "/opt/tangow" },
      { GIT_CONFIG_VALUE_0: "*", GIT_CONFIG_COUNT: "9" },
    );
    expect(env.GIT_CONFIG_VALUE_0).toBe("/opt/tangow");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
  });

  it("sets no git ownership exemption when no deployment directory is known", () => {
    const env = commandEnvironment({ PATH: "/usr/bin" });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("passes operational settings and explicit overrides without leaking application secrets", () => {
    const env = commandEnvironment(
      {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.invalid",
        BETTER_AUTH_SECRET: "fake-secret-that-must-not-leak",
        DATABASE_URL: "postgres://fake.invalid/db",
        AXIOM_TOKEN: "fake-axiom-token",
        LOG_LEVEL: "debug",
      },
      { TANGOW_IMAGE_TAG: "sha-123" },
    );
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy.invalid",
      TANGOW_IMAGE_TAG: "sha-123",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AXIOM_TOKEN).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
  });

  it("restores detached checkouts without attaching to a branch tip", () => {
    expect(restoreCheckoutArgv("HEAD", currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv(null, currentCommit)).toEqual([
      "checkout",
      "--detach",
      currentCommit,
    ]);
    expect(restoreCheckoutArgv("deploy", currentCommit)).toEqual([
      "checkout",
      "-B",
      "deploy",
      currentCommit,
    ]);
  });
});
