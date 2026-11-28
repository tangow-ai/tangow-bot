import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const source = fileURLToPath(new URL("./tangow.mjs", import.meta.url));
function fixture(t, { e2b = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "tangow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "checkout ' with spaces");
  const bin = path.join(directory, "bin");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "infra/compose"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(source, path.join(root, "scripts/tangow.mjs"));
  copyFileSync(
    fileURLToPath(new URL("./tangow-options.mjs", import.meta.url)),
    path.join(root, "scripts/tangow-options.mjs"),
  );
  for (const name of [
    "tangow-builds.mjs",
    "tangow-deployment.mjs",
    "tangow-docker.mjs",
    "tangow-setup.mjs",
  ])
    copyFileSync(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      path.join(root, "scripts", name),
    );
  writeFileSync(path.join(root, "infra/compose/docker-compose.yml"), "services: {}\n");
  writeFileSync(
    path.join(root, "infra/compose/setup-e2b.mjs"),
    `import {writeFileSync} from 'node:fs';writeFileSync('data/setup-args.json',JSON.stringify(process.argv.slice(2)));`,
  );
  writeFileSync(path.join(root, ".gitignore"), ".env*\nbackups/\ndata/\n");
  mkdirSync(path.join(root, "data"));
  writeFileSync(
    path.join(root, ".env"),
    'SECRET=fake-test-secret\nAGENT_RUNTIME=pi\nGIT_SHA=old\nUNRELATED="$(touch must-not-exist)"\n',
  );
  if (e2b) {
    const environment = {
      SANDBOX_PROVIDER: "e2b",
      E2B_API_KEY: "fake-test-secret",
      E2B_DOMAIN: "e2b.example.com",
      WORKER_TEMPLATE: "custom-worker",
    };
    writeFileSync(
      path.join(root, ".env.e2b.compose.json"),
      JSON.stringify({ services: { api: { environment }, worker: { environment } } }),
    );
  }
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-m", "initial");
  const before = git("rev-parse", "HEAD");
  const remote = path.join(directory, "remote.git");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  writeFileSync(path.join(root, "version"), "updated");
  git("add", "version");
  git("commit", "-m", "new revision");
  const target = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  git("reset", "--hard", before);
  const calls = path.join(directory, "calls");
  const fake = `#!${process.execPath}
const fs=require('node:fs');
const name=require('node:path').basename(process.argv[1]);let args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify([name,...args])+'\\n');
if(name==='sudo'){
 if(args[1]==='cat'){const mode=fs.statSync(args[2]).mode;fs.chmodSync(args[2],0o600);try{process.stdout.write(fs.readFileSync(args[2]));}finally{fs.chmodSync(args[2],mode);}process.exit(0);}
 if(args[0]!=='-n'||args[1]!=='docker')process.exit(2);args=args.slice(2);
}
if(name==='tar'){fs.writeFileSync(args[args.indexOf('-czf')+1],'fixture-data-backup');process.exit(0);}
const provider=args.includes('.env.e2b.compose.json')||args.includes('.env.tangow.docker.source.json')?'e2b':'docker';
if(name==='pnpm'){if(args.includes('template:build')&&process.env.E2B_API_KEY!=='fake-test-secret')process.exit(1);process.exit(0);}
if(args[0]==='info'&&process.env.NO_DOCKER)process.exit(1);
if(args[0]==='volume'||args[0]==='ps'){if(process.env.EXISTING_SETUP)console.log('existing-state');process.exit(0);}
if(args.includes('build')&&process.env.FAIL_BUILD){console.error('fake-test-secret');process.exit(1);}
if(args.includes('config')){console.log(JSON.stringify({services:{api:{environment:{SANDBOX_PROVIDER:provider,SANDBOX_SUPERVISOR_TOKEN:process.env.NO_TOKEN?'':'fake-token',E2B_API_KEY:process.env.NO_KEY?'':'fake-test-secret',AGENT_RUNTIME:process.env.SCRIPTED?'scripted':undefined}},worker:{environment:{SANDBOX_PROVIDER:provider,SANDBOX_SUPERVISOR_TOKEN:process.env.NO_TOKEN?'':'fake-token',E2B_API_KEY:process.env.NO_KEY?'':'fake-test-secret'}}}}));process.exit(0);}
if(args.includes('pull')&&args.includes('postgres')&&args.includes('data-init'))fs.writeFileSync(process.env.RUNTIME_IMAGES,'cached');
if(args.includes('up')&&args.includes('migrate')&&process.env.FRESH_IMAGES&&!fs.existsSync(process.env.RUNTIME_IMAGES))process.exit(1);
if(args.includes('scripts/tangow-signup-policy.mjs')&&process.env.FAIL_POLICY)process.exit(1);
if(args.includes('wait')&&process.env.FAIL_MIGRATE)process.exit(1);
if(args.includes('scripts/migrate-e2b-to-docker.ts')){if(args.includes('--inspect')){console.log(JSON.stringify({blockers:{runs:process.env.DOCKER_MIGRATION_BUSY?1:0}}));process.exit(0);}if(process.env.FAIL_DOCKER_COPY){console.error('fake-test-secret');process.exit(1);}console.log(JSON.stringify({outcome:'migrated',volumes:3,computers:1}));process.exit(0);}
if(args.includes('up')&&args.includes('api')&&process.env.FAIL_DOCKER_START)process.exit(1);
if(args.includes('scripts/setup-e2b-homes.ts')){console.log(JSON.stringify({computers:process.env.E2B_SNAPSHOTS?[{id:'computer-old',kind:'e2b',homeStorage:'snapshot'}]:[]}));process.exit(0);}
if(args.includes('scripts/migrate-docker-homes.ts')){console.log(JSON.stringify({deferred:process.env.DEFERRED?[{id:'computer-busy',state:'running',bots:[{name:'Fixture bot'}],reason:'snapshot'}]:[]}));process.exit(0);}
if(args.includes('exec')&&args.includes('api'))console.log(JSON.stringify({ok:true,revision:process.env.TARGET,sandbox:provider}));
else if(args.includes('ps')&&args.includes('-q'))console.log(args.at(-1)+'-container');
else if(args.includes('ps'))console.log('api running\\nworker running\\nweb running');
else if(args.includes('{{json .RepoDigests}}'))console.log(JSON.stringify(process.env.NO_DIGEST?[]:['registry.example.com/computer@sha256:'+'c'.repeat(64)]));
else if(args[0]==='image'&&args.some(a=>a.includes('org.opencontainers.image.revision')))console.log(process.env.BAD_WORKER_REVISION?'old':process.env.TARGET);
else if(args[0]==='image'&&args.includes('inspect'))console.log(args.includes('{{.Id}}')?(args.at(-1).includes('supervisor')?'sha256:supervisor':args.at(-1).includes('/worker:')?'sha256:guest':'sha256:app'):'registry.example.com/computer@sha256:'+'c'.repeat(64));
else if(args[0]==='inspect'&&args.some(a=>a.includes('.State.ExitCode')))console.log('exited 0 '+(args.at(-1)==='worker-image-container'?'sha256:guest':process.env.BAD_MIGRATE_IMAGE?'sha256:old':'sha256:app'));
else if(args[0]==='inspect')console.log(args.includes('{{.Image}}')?'sha256:app':args.some(a=>a.includes('Config.Env'))?process.env.TARGET:args.at(-1)==='supervisor-container'?'sha256:supervisor true 0':'sha256:app true 0');
`;
  for (const name of ["docker", "sudo", "pnpm", "tar"])
    writeFileSync(path.join(bin, name), fake, { mode: 0o755 });
  const network = path.join(directory, "network.mjs");
  writeFileSync(
    network,
    `import {appendFileSync} from 'node:fs'; globalThis.fetch = async (url) => { appendFileSync(process.env.CALLS,JSON.stringify(['fetch',String(url)])+'\\n'); if(String(url)!=='https://app.example.com') throw new Error('Unexpected network request'); return {ok: !process.env.FAIL_PUBLIC}; };`,
  );
  const invoke = (args, env = {}, input) =>
    spawnSync(process.execPath, [source, "--path", root, ...args], {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        NODE_OPTIONS: `--import=${network}`,
        RUNTIME_IMAGES: path.join(directory, "runtime-images"),
        CALLS: calls,
        TARGET: target,
        PROVIDER: e2b ? "e2b" : "docker",
        ...env,
      },
    });
  return {
    bin,
    callPath: calls,
    root,
    before,
    target,
    git,
    invoke,
    calls: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("help, dry-run and invalid command options execute nothing and change nothing", (t) => {
  const f = fixture(t);
  const env = readFileSync(path.join(f.root, ".env"), "utf8");
  for (const args of [
    ["--help"],
    ["update", "--dry-run"],
    ["cleanup", "--dry-run"],
    ["setup", "--dry-run"],
  ])
    assert.equal(f.invoke(args).status, 0);
  for (const args of [
    ["update", "--yes"],
    ["logs", "postgres"],
    ["provider", "unknown"],
    ["update", "--computers"],
    ["--host=-oProxyCommand=bad", "update"],
    ["update", "--unknown=fake-test-secret"],
  ]) {
    const result = f.invoke(args);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /fake-test-secret/);
  }
  assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), env);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("update automatically builds E2B templates, preserves its override and verifies deployment", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("switch", "-c", "old-deployment");
  writeFileSync(path.join(f.root, ".env.tangow.compose.yml"), "services: {}\n");
  const override = readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8");
  const result = f.invoke(["update", "--sudo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Ready: ${f.target} \\(e2b\\)`));
  assert.match(result.stdout, /Updated application and E2B templates/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("rev-parse", "HEAD"), f.target);
  assert.equal(readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8"), override);
  assert.match(readFileSync(path.join(f.root, ".env"), "utf8"), new RegExp(`GIT_SHA=${f.target}`));
  assert.doesNotMatch(readFileSync(path.join(f.root, ".env"), "utf8"), /^AGENT_RUNTIME=/m);
  assert.equal(statSync(path.join(f.root, ".env")).mode & 0o777, 0o600);
  assert.equal(existsSync(path.join(f.root, "must-not-exist")), false);
  const calls = f.calls();
  assert.ok(calls.some((c) => c.includes(`GIT_SHA=${f.target}`)));
  assert.ok(calls.some((c) => c.includes("custom-worker")));
  assert.ok(
    calls.some((c) => c.includes(`registry.example.com/computer@sha256:${"c".repeat(64)}`)),
  );
  assert.ok(calls.some((c) => c.includes("{{.Image}} {{.State.Running}} {{.RestartCount}}")));
  assert.ok(calls.some((c) => c.includes("web") && c.includes("exec")));
  for (const call of calls.filter((c) => c.includes("compose"))) {
    const files = call.flatMap((value, index) => (call[index - 1] === "-f" ? [value] : []));
    assert.deepEqual(files.slice(-2), [".env.e2b.compose.json", ".env.tangow.compose.yml"]);
  }
  assert.ok(
    calls
      .filter((c) => c[0] !== "pnpm")
      .every((c) => c[0] === "sudo" && c[1] === "-n" && c[2] === "docker"),
  );
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(calls), /fake-test-secret/);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("dirty or divergent checkouts are refused without rebuilding or rewriting history", (t) => {
  for (const kind of ["dirty", "divergent"]) {
    const f = fixture(t);
    writeFileSync(path.join(f.root, "local-file"), "keep me");
    if (kind === "divergent") {
      f.git("add", "local-file");
      f.git("commit", "-m", "local change");
    }
    const original = f.git("rev-parse", "HEAD");
    const result = f.invoke(["update"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, kind === "dirty" ? /local changes/ : /outside origin\/main/);
    assert.equal(f.git("rev-parse", "HEAD"), original);
    assert.ok(
      f.calls().every((c) => !c.includes("build") && !c.includes("up") && !c.includes("restart")),
    );
    assert.equal(readFileSync(path.join(f.root, "local-file"), "utf8"), "keep me");
  }
});

test("build failures leave running services and environment untouched and hide tool secrets", (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.root, ".env"), "utf8");
  const result = f.invoke(["update"], { FAIL_BUILD: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /have not been restarted/);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), before);
  assert.ok(f.calls().every((c) => !c.includes("up") && !c.includes("restart")));
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("incomplete migration and concurrent operations block mutations", (t) => {
  for (const lock of [".env.e2b.upgrade.json", ".env.e2b.setup.lock", ".env.tangow.lock"]) {
    const f = fixture(t);
    writeFileSync(path.join(f.root, lock), "{}");
    for (const command of ["restart", "setup"]) {
      const env = readFileSync(path.join(f.root, ".env"), "utf8");
      const result = f.invoke([command], {}, "\n\n\n");
      assert.notEqual(result.status, 0);
      assert.deepEqual(f.calls(), []);
      assert.equal(readFileSync(path.join(f.root, lock), "utf8"), "{}");
      assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), env);
    }
  }
});

test("cleanup requires consent and only prunes unused cache and images", (t) => {
  const f = fixture(t);
  assert.notEqual(f.invoke(["cleanup"]).status, 0);
  assert.deepEqual(f.calls(), []);
  const result = f.invoke(["cleanup", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    ["docker", "builder", "prune", "--all", "--force"],
    ["docker", "image", "prune", "--all", "--force"],
  ]);
});

test("provider setup forwards sudo and requires consent before migrating E2B homes", (t) => {
  const f = fixture(t, { e2b: true });
  assert.notEqual(f.invoke(["provider", "docker"]).status, 0);
  writeFileSync(path.join(f.root, ".env.e2b.upgrade.json"), "{}");
  const result = f.invoke([
    "provider",
    "e2b",
    "--sudo",
    "--migrate-existing",
    "--computer-image",
    "registry.example.com/computer:local",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, "data/setup-args.json"), "utf8")), [
    "--computer-image",
    "registry.example.com/computer:local",
    "--sudo",
    "--migrate-existing",
  ]);
});

test("Docker migration backs up before copying and starts Docker only after adoption", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("merge", "--ff-only", "origin/main");
  const override = readFileSync(path.join(f.root, ".env.e2b.compose.json"), "utf8");
  const result = f.invoke(["provider", "docker", "--migrate-existing"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Docker migration complete/);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.docker.json")), false);
  const calls = f.calls();
  const build = calls.findIndex((c) => c.includes("build") && c.includes("worker-image"));
  const stop = calls.findIndex((c) => c.includes("stop") && c.includes("api"));
  const backup = calls.findIndex((c) => c.some((arg) => arg.includes("pg_dump")));
  const copy = calls.findIndex(
    (c) => c.includes("scripts/migrate-e2b-to-docker.ts") && !c.includes("--inspect"),
  );
  const start = calls.findIndex((c) => c.includes("up") && c.includes("api"));
  assert.ok(build >= 0 && stop > build && backup > stop && copy > backup && start > copy);
  const operation = calls[copy][calls[copy].indexOf("--operation") + 1];
  assert.equal(
    readFileSync(
      path.join(f.root, "backups", `docker-${operation}`, "original-e2b-compose.json"),
      "utf8",
    ),
    override,
  );
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(calls), /fake-test-secret/);
  assert.ok(calls.every((c) => !c.includes("down") && !c.includes("prune")));
});

test("Docker migration refuses busy work before stopping the running deployment", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("merge", "--ff-only", "origin/main");
  const result = f.invoke(["provider", "docker", "--migrate-existing"], {
    DOCKER_MIGRATION_BUSY: "1",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /services were not stopped/);
  assert.ok(f.calls().every((c) => !c.includes("stop") && !c.includes("up")));
  assert.equal(existsSync(path.join(f.root, ".env.tangow.docker.json")), false);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), true);
});

test("failed Docker copy keeps source settings and blocks mutations until the same operation resumes", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("merge", "--ff-only", "origin/main");
  const failure = f.invoke(["provider", "docker", "--migrate-existing"], { FAIL_DOCKER_COPY: "1" });
  assert.notEqual(failure.status, 0);
  assert.doesNotMatch(failure.stdout + failure.stderr, /fake-test-secret/);
  const journal = path.join(f.root, ".env.tangow.docker.json");
  const state = JSON.parse(readFileSync(journal, "utf8"));
  assert.equal(state.phase, "copying");
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), true);
  const before = f.calls().length;
  for (const args of [
    ["update"],
    ["restart"],
    ["cleanup", "--yes"],
    ["computers", "build"],
    ["provider", "e2b"],
  ]) {
    assert.notEqual(f.invoke(args).status, 0);
  }
  assert.equal(f.calls().length, before);
  const resumed = f.invoke(["provider", "docker"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const copies = f
    .calls()
    .filter((c) => c.includes("scripts/migrate-e2b-to-docker.ts") && !c.includes("--inspect"));
  assert.equal(copies.length, 2);
  for (const copy of copies) assert.equal(copy[copy.indexOf("--operation") + 1], state.operationId);
  assert.equal(existsSync(journal), false);
});

test("failed Docker startup resumes after configuration cutover without reimporting volumes", (t) => {
  const f = fixture(t, { e2b: true });
  f.git("merge", "--ff-only", "origin/main");
  const failure = f.invoke(["provider", "docker", "--migrate-existing"], {
    FAIL_DOCKER_START: "1",
  });
  assert.notEqual(failure.status, 0);
  assert.equal(existsSync(path.join(f.root, ".env.e2b.compose.json")), false);
  assert.equal(
    JSON.parse(readFileSync(path.join(f.root, ".env.tangow.docker.json"), "utf8")).phase,
    "configured",
  );
  assert.deepEqual(f.calls().at(-1).slice(-3), ["stop", "api", "worker"]);
  const resumed = f.invoke(["provider", "docker"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(
    f
      .calls()
      .filter((c) => c.includes("scripts/migrate-e2b-to-docker.ts") && !c.includes("--inspect"))
      .length,
    1,
  );
});

test("sudo reads a root-private override without exposing credentials", (t) => {
  const f = fixture(t, { e2b: true });
  const filename = path.join(f.root, ".env.e2b.compose.json");
  chmodSync(filename, 0);
  try {
    readFileSync(filename);
    t.skip("This process bypasses file permissions; exercise this case without that privilege.");
    return;
  } catch (error) {
    assert.equal(error.code, "EACCES");
  }
  assert.notEqual(f.invoke(["status"]).status, 0);
  const result = f.invoke(["status", "--sudo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured provider: e2b/);
  assert.doesNotMatch(
    result.stdout + result.stderr + JSON.stringify(f.calls()),
    /fake-test-secret/,
  );
});

test("standalone template builds require a clean revision matching API and worker", (t) => {
  const f = fixture(t, { e2b: true });
  const args = ["computers", "build", "--computer-image", "registry.example.com/computer:local"];
  const mismatch = f.invoke(args);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /must match the running API and worker/);
  assert.ok(f.calls().every((c) => !c.includes("push") && !c.includes("build")));
  f.git("merge", "--ff-only", "origin/main");
  const result = f.invoke(args);
  assert.equal(result.status, 0, result.stderr);
});

test("Docker updates deploy the supervisor too and restart preserves running images", (t) => {
  const f = fixture(t);
  const update = f.invoke(["update"]);
  assert.equal(update.status, 0, update.stderr);
  assert.ok(f.calls().some((c) => c.includes("build") && c.includes("supervisor")));
  assert.ok(f.calls().some((c) => c.includes("up") && c.includes("supervisor")));
  assert.ok(f.calls().some((c) => c.includes("supervisor-container")));
  const restart = f.invoke(["restart"]);
  assert.equal(restart.status, 0, restart.stderr);
});

test("private deployment defaults choose sudo and registry while explicit flags override the image", (t) => {
  for (const explicit of [false, true]) {
    const f = fixture(t, { e2b: true });
    writeFileSync(
      path.join(f.root, ".env.tangow.json"),
      JSON.stringify({ sudo: true, computerImage: "saved.example.com/computer:release" }),
    );
    const result = f.invoke([
      "update",
      ...(explicit ? ["--computer-image", "override.example.com/computer:release"] : []),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const expected = explicit
      ? "override.example.com/computer:release"
      : "saved.example.com/computer:release";
    assert.ok(f.calls().some((c) => c[0] === "sudo" && c.includes("push") && c.includes(expected)));
  }
});

test("missing registry configuration and invalid private config fail before updating Git or services", (t) => {
  const f = fixture(t, { e2b: true });
  const result = f.invoke(["update"], { NO_DIGEST: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Set computerImage in .env.tangow.json/);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.ok(f.calls().every((c) => !c.includes("build") && !c.includes("up")));
  writeFileSync(
    path.join(f.root, ".env.tangow.json"),
    JSON.stringify({ sudo: "fake-test-secret" }),
  );
  const invalid = f.invoke(["update"]);
  assert.notEqual(invalid.status, 0);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /fake-test-secret/);
});

test("Docker update builds worker guest at the application revision and verifies migration before service start", (t) => {
  const f = fixture(t);
  const result = f.invoke(["update"]);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const build = calls.find((c) => c.includes("build") && c.includes("api"));
  assert.ok(build.includes("worker-image"));
  assert.ok(build.includes(`GIT_SHA=${f.target}`));
  const wait = calls.findIndex((c) => c.includes("wait") && c.includes("migrate"));
  const start = calls.findIndex((c) => c.includes("up") && c.includes("api"));
  assert.ok(wait >= 0 && start > wait);
});

test("failed migration or mismatched guest image prevents restarting application services", (t) => {
  for (const env of [
    { FAIL_MIGRATE: "1" },
    { BAD_MIGRATE_IMAGE: "1" },
    { BAD_WORKER_REVISION: "1" },
  ]) {
    const f = fixture(t);
    const result = f.invoke(["update"], env);
    assert.notEqual(result.status, 0);
    assert.ok(
      f.calls().every((c) => !c.includes("restart") && !(c.includes("up") && c.includes("api"))),
    );
  }
});

test("E2B snapshot homes refuse update and restart before any application start", (t) => {
  for (const command of ["update", "restart"]) {
    const f = fixture(t, { e2b: true });
    const result = f.invoke([command], { E2B_SNAPSHOTS: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /provider e2b/);
    assert.ok(
      f.calls().every((c) => !c.includes("restart") && !(c.includes("up") && c.includes("api"))),
    );
  }
});

test("successful startup reports deferred Docker homes with bot context", (t) => {
  const f = fixture(t);
  const result = f.invoke(["update"], { DEFERRED: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deferred.*Fixture bot/);
});

test("invalid production provider credentials and scripted runtime refuse updates before builds", (t) => {
  for (const [e2b, env] of [
    [false, { NO_TOKEN: "1" }],
    [true, { NO_KEY: "1" }],
    [false, { SCRIPTED: "1" }],
  ]) {
    const f = fixture(t, { e2b });
    const result = f.invoke(["update"], env);
    assert.notEqual(result.status, 0);
    assert.ok(f.calls().every((c) => !c.includes("build") && !c.includes("up")));
    assert.doesNotMatch(result.stdout + result.stderr, /fake-test-secret/);
  }
});

test("setup creates private configuration, deploys HEAD and preserves secrets on retry", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, ".env"));
  f.git("switch", "-c", "pinned-release");
  const result = f.invoke(["setup"], { TARGET: f.before, FRESH_IMAGES: "1" }, "\n\n\n");
  assert.equal(result.status, 0, result.stderr);
  const filename = path.join(f.root, ".env");
  const first = parseEnv(readFileSync(filename, "utf8"));
  assert.equal(first.WEB_ORIGIN, "http://127.0.0.1:5173");
  assert.equal(first.TANGOW_HOST, "127.0.0.1");
  assert.equal(first.GIT_SHA, f.before);
  assert.match(first.ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  const secretNames = [
    "POSTGRES_PASSWORD",
    "BETTER_AUTH_SECRET",
    "ENCRYPTION_KEY",
    "SANDBOX_SUPERVISOR_TOKEN",
    "SCREEN_PROXY_SECRET",
  ];
  assert.equal(new Set(secretNames.map((name) => first[name])).size, secretNames.length);
  for (const name of secretNames) {
    assert.ok(first[name].length >= 32);
    assert.ok(!result.stdout.includes(first[name]));
    assert.ok(!result.stderr.includes(first[name]));
  }
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(f.git("rev-parse", "HEAD"), f.before);
  assert.equal(f.git("branch", "--show-current"), "pinned-release");
  assert.match(result.stdout, /Ready:.*docker/);
  assert.match(result.stdout, /Create.*account/i);
  writeFileSync(
    filename,
    `${readFileSync(filename, "utf8")}# keep this comment\nCUSTOM_OPTION=keep-me\n`,
  );
  const retry = f.invoke(["setup"], { TARGET: f.before, EXISTING_SETUP: "1" }, "\n\n\n");
  assert.equal(retry.status, 0, retry.stderr);
  const secondText = readFileSync(filename, "utf8");
  const second = parseEnv(secondText);
  for (const name of secretNames) assert.equal(second[name], first[name]);
  assert.equal(second.CUSTOM_OPTION, "keep-me");
  assert.match(secondText, /# keep this comment/);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("setup refuses missing credentials with deployed state, cancellation and unavailable Docker without writing", (t) => {
  for (const [env, input, message] of [
    [{ EXISTING_SETUP: "1" }, "\n", /credentials|secret/i],
    [{}, "", /cancel|input|terminal/i],
    [{}, "\n\nno\n", /cancel/i],
    [{}, "http://app.example.com\n", /HTTPS/i],
    [{}, "https://app.example.com\n\n", /SMTP/i],
    [
      {},
      "https://app.example.com\nsmtps://user:fake-password@smtp.example.com:465\nmail@example.com\nexample.com\n",
      /allowlist/i,
    ],
    [{ NO_DOCKER: "1" }, "\n", /Docker/i],
  ]) {
    const f = fixture(t);
    const before = readFileSync(path.join(f.root, ".env"), "utf8");
    const result = f.invoke(["setup"], { TARGET: f.before, ...env }, input);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), before);
    assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
    assert.ok(!f.calls().some((call) => call.includes("build") || call.includes("up")));
  }
});

test("setup configures public hostname and email policy before building without exposing credentials", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, ".env"));
  const smtp = "smtps://user:fake-$pass'\"%23@example.com:465";
  const result = f.invoke(
    ["setup"],
    { TARGET: f.before },
    `https://app.example.com\n${smtp}\nTangow <mail@example.com>\nowner@example.com\n\n\n`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ready:/);
  assert.deepEqual(
    f.calls().filter((call) => call[0] === "fetch"),
    [["fetch", "https://app.example.com"]],
  );
  const saved = parseEnv(readFileSync(path.join(f.root, ".env"), "utf8"));
  assert.equal(saved.WEB_ORIGIN, "https://app.example.com");
  assert.equal(saved.BETTER_AUTH_URL, "https://app.example.com");
  assert.equal(saved.API_URL, "https://app.example.com");
  assert.equal(saved.TANGOW_HOST, "app.example.com");
  assert.equal(saved.SIGNUP_ALLOWLIST, "owner@example.com");
  const compose = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      path.join(f.root, ".env"),
      "-f",
      path.join(f.root, "infra/compose/docker-compose.yml"),
      "config",
      "--environment",
    ],
    { encoding: "utf8" },
  );
  assert.equal(compose.status, 0, compose.stderr);
  assert.ok(
    compose.stdout.split("\n").includes(`SMTP_URL=${smtp}`),
    "Compose must preserve the literal SMTP credential",
  );
  assert.ok(!result.stdout.includes("fake-$pass"));
  assert.ok(!result.stderr.includes("fake-$pass"));
  assert.ok(!f.calls().some((call) => call.some((arg) => arg.includes("fake-$pass"))));
  assert.ok(f.calls().some((call) => call.includes("scripts/tangow-signup-policy.mjs")));
  const retry = f.invoke(
    ["setup"],
    { TARGET: f.before, EXISTING_SETUP: "1", FAIL_PUBLIC: "1" },
    "\n\n\n\n\n\n",
  );
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /Public web reachability/);
  assert.doesNotMatch(retry.stdout, /Open https/);
  const retried = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      path.join(f.root, ".env"),
      "-f",
      path.join(f.root, "infra/compose/docker-compose.yml"),
      "config",
      "--environment",
    ],
    { encoding: "utf8" },
  );
  assert.equal(retried.status, 0, retried.stderr);
  assert.ok(retried.stdout.split("\n").includes(`SMTP_URL=${smtp}`));
});

test("setup continues to E2B only after Docker is ready and keeps provider settings on retry", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, ".env"));
  const first = f.invoke(
    ["setup", "--sudo"],
    { TARGET: f.before },
    "\ne2b\nregistry.example.com/computer:local\nyes\n",
  );
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Ready:.*docker[\s\S]*Ready:.*e2b/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, "data/setup-args.json"), "utf8")), [
    "--computer-image",
    "registry.example.com/computer:local",
    "--sudo",
  ]);
  const config = JSON.parse(readFileSync(path.join(f.root, ".env.tangow.json"), "utf8"));
  assert.deepEqual(config, { sudo: true, computerImage: "registry.example.com/computer:local" });
  const environment = {
    SANDBOX_PROVIDER: "e2b",
    E2B_API_KEY: "fake-test-secret",
    E2B_DOMAIN: "e2b.example.com",
  };
  writeFileSync(
    path.join(f.root, ".env.e2b.compose.json"),
    JSON.stringify({ services: { api: { environment }, worker: { environment } } }),
  );
  const retry = f.invoke(["setup"], { TARGET: f.before, EXISTING_SETUP: "1" }, "\n\n");
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Ready:.*e2b/);
  assert.ok(!retry.stdout.includes("Computer provider"));
});

test("public setup refuses startup when the database signup policy cannot be applied", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.root, ".env"));
  const result = f.invoke(
    ["setup"],
    { TARGET: f.before, FAIL_POLICY: "1" },
    "https://app.example.com\nsmtps://user:fake-password@smtp.example.com:465\nmail@example.com\nowner@example.com\n\n\n",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signup policy/i);
  assert.ok(!f.calls().some((call) => call.includes("up") && call.includes("api")));
});

test("terminal secret entry hides input and Ctrl+C restores echo and releases the lock", (t) => {
  const f = fixture(t);
  const original = readFileSync(path.join(f.root, ".env"), "utf8");
  const program = String.raw`
import os, pty, select, signal, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.environ['PATH'] = sys.argv[4] + os.pathsep + os.environ['PATH']
    os.environ['CALLS'] = sys.argv[5]
    os.execv(sys.argv[1], [sys.argv[1], sys.argv[2], '--path', sys.argv[3], 'setup'])
output = b''
deadline = time.monotonic() + 5
sent = False
try:
    while b'SMTP URL' not in output and time.monotonic() < deadline:
        if select.select([fd], [], [], 0.1)[0]:
            output += os.read(fd, 4096)
            if not sent and b'Web origin' in output:
                os.write(fd, b'https://app.example.com\n'); sent = True
    if b'SMTP URL' not in output: raise RuntimeError('No secret prompt')
    if termios.tcgetattr(fd)[3] & termios.ECHO: raise RuntimeError('Secret echo enabled')
    os.write(fd, b'fake-hidden-secret')
    os.kill(pid, signal.SIGINT)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        ended, code = os.waitpid(pid, os.WNOHANG)
        if ended:
            if os.waitstatus_to_exitcode(code) != 130: raise RuntimeError('Unexpected cancel exit')
            if not termios.tcgetattr(fd)[3] & termios.ECHO: raise RuntimeError('Echo not restored')
            sys.exit(0)
        time.sleep(0.05)
    raise RuntimeError('Ctrl+C did not cancel')
finally:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(fd)
`;
  const result = spawnSync(
    "python3",
    ["-c", program, process.execPath, source, f.root, f.bin, f.callPath],
    { encoding: "utf8", timeout: 12000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(f.root, ".env"), "utf8"), original);
  assert.equal(existsSync(path.join(f.root, ".env.tangow.lock")), false);
});

test("production vault setup creates private files silently and preserves existing values", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "tangow-vault-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  const script = path.join(root, "scripts/tangow-vault.mjs");
  copyFileSync(new URL("./tangow-vault.mjs", import.meta.url), script);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'process.umask(0o077); import(require("node:url").pathToFileURL(process.argv[1]));',
        script,
      ],
      { encoding: "utf8" },
    );
    return result;
  };
  const runSuccessfully = () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, "");
  };
  const vault = path.join(root, "infra/compose/openbao-private");
  const key = path.join(vault, "unseal.key");
  const role = path.join(vault, "role-id");
  const secret = path.join(vault, "secret-id");
  runSuccessfully();
  assert.equal(statSync(vault).mode & 0o777, 0o700);
  for (const file of [key, role, secret]) assert.equal(statSync(file).mode & 0o777, 0o444);
  const originalKey = readFileSync(key);
  const originalRole = readFileSync(role, "utf8");
  assert.equal(originalKey.length, 32);
  assert.match(originalRole, /^[a-f0-9]{64}$/);
  const originalSecret = readFileSync(secret, "utf8");
  runSuccessfully();
  assert.equal(readFileSync(secret, "utf8"), originalSecret);
  rmSync(secret);
  const partial = run();
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /Restore all three original vault files/);
  assert.equal(existsSync(secret), false);
  assert.deepEqual(readFileSync(key), originalKey);
  assert.equal(readFileSync(role, "utf8"), originalRole);
  assert.match(originalSecret, /^[a-f0-9]{64}$/);
});
