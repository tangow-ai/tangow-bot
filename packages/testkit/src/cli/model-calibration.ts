import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { ModelCategory } from "@rakazo/contracts";
import {
  planCalibration,
  runCalibration,
  unattempted,
} from "../evals/model-calibration/campaign.js";
import type { FrozenProfile } from "../evals/model-calibration/config.js";
import {
  CalibrationConfigSchema,
  CalibrationSessionSchema,
  FrozenProfileSchema,
  validateProfile,
} from "../evals/model-calibration/config.js";
import { DEVELOPMENT_CASES } from "../evals/model-calibration/development.js";
import {
  summarizeAutoValidation,
  summarizeCalibration,
} from "../evals/model-calibration/report.js";
import type {
  CalibrationCandidate,
  CalibrationLimits,
  CalibrationTrial,
} from "../evals/model-calibration/types.js";

type CalibrationReport = {
  kind: string;
  version: number;
  phase: "development" | "validation";
  revision: string | null;
  startedAt: string;
  finishedAt: string | null;
  candidates: CalibrationCandidate[];
  profile: FrozenProfile | null;
  controls: CalibrationLimits & { repeats: number };
  plannedCases: Array<{ id: string; category: ModelCategory; turns: number; promptSha256: string }>;
  trials: CalibrationTrial[];
  summary: unknown;
  limitations: string[];
};

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      session: { type: "string" },
      live: { type: "boolean", default: false },
      phase: { type: "string", default: "development" },
      repeats: { type: "string" },
      profile: { type: "string" },
      "development-report": { type: "string" },
      list: { type: "boolean", default: false },
      output: { type: "string", default: "test-report/model-calibration/report.json" },
    },
  });
  const phase = values.phase;
  if (phase !== "development" && phase !== "validation")
    throw new Error("Unknown calibration phase");
  if (values.list && phase === "development") {
    process.stdout.write(
      `${JSON.stringify(
        DEVELOPMENT_CASES.map(({ id, category, turns }) => ({ id, category, turns: turns.length })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!values.config) throw new Error("A calibration config file is required");
  const config = CalibrationConfigSchema.parse(readJson(values.config));
  const repeats = Number(values.repeats ?? (phase === "development" ? "1" : "5"));
  let candidates: CalibrationCandidate[] = config.candidates;
  let scenarios = DEVELOPMENT_CASES;
  let profile: FrozenProfile | undefined;
  if (phase === "validation") {
    if (!values.profile || !values["development-report"])
      throw new Error("Validation requires a frozen profile and its development report");
    const frozen = FrozenProfileSchema.parse(readJson(values.profile));
    profile = frozen;
    validateProfile({
      profile,
      developmentReport: readFileSync(values["development-report"], "utf8"),
      candidates,
    });
    const baseline = candidates.find((candidate) => candidate.id === frozen.baselineId);
    if (!baseline) throw new Error("Unknown baseline configuration");
    candidates = [baseline, { ...baseline, id: "auto" }];
    const { HOLDOUT_CASES } = await import("../evals/model-calibration/holdout.js");
    scenarios = HOLDOUT_CASES;
  }
  const jobs = planCalibration({ scenarios, candidates, repeats, auto: phase === "validation" });
  const output = path.resolve(values.output!);
  const plannedCases = scenarios.map(({ id, category, turns }) => ({
    id,
    category,
    turns: turns.length,
    promptSha256: createHash("sha256").update(JSON.stringify(turns)).digest("hex"),
  }));
  let revision: string | null = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  const report: CalibrationReport = {
    kind: "rakazo-model-calibration",
    version: 1,
    phase,
    revision,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    candidates: config.candidates,
    profile: profile ?? null,
    controls: { ...config.limits, repeats },
    plannedCases,
    trials: jobs.map((job) => unattempted(job, "not-started")),
    summary: {},
    limitations: [
      "Exploratory corpus; repetitions do not add independent scenarios or prove general quality.",
      "Run latency includes queue, routing, worker setup and model/tool work; excludes account/bot setup and cleanup.",
      "Persisted usage has no monetary price, cache counters, per-call duration or time-to-first-token; unavailable values remain null.",
      "Input tokens already include cached prompt tokens. Tokens are not subscription quota or money.",
      "Token and tool ceilings use observed usage; an in-flight call may overshoot before cancellation reaches the server.",
      "Synthetic isolated conversations; no real external integrations. Context preparation turns count in time, tokens and budgets.",
    ],
  };
  const save = async (trials: readonly CalibrationTrial[]) => {
    report.trials = [
      ...trials,
      ...jobs.slice(trials.length).map((job) => unattempted(job, "not-started")),
    ];
    report.summary =
      phase === "validation" && profile
        ? summarizeAutoValidation({
            trials: report.trials,
            plannedCases,
            repeats,
            baselineId: profile.baselineId,
          })
        : summarizeCalibration({ candidates, trials: report.trials, plannedCases, repeats });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${output}.tmp`, output);
  };
  await save([]);
  if (!values.live) {
    process.stdout.write(
      `${JSON.stringify({ live: false, phase, plannedTasks: jobs.length, limits: config.limits })}\n`,
    );
    return;
  }
  if (!values.session || !process.env.DATABASE_URL)
    throw new Error("Live calibration requires a private session and server DATABASE_URL");
  const session = CalibrationSessionSchema.parse(readJson(values.session));
  const { createDb } = await import("@rakazo/db");
  const { prepareLiveCalibration, liveCalibrationDriver } = await import(
    "../evals/model-calibration/live.js"
  );
  const { prisma, pool } = createDb(process.env.DATABASE_URL, {
    poolMax: 1,
    applicationName: "model-calibration",
  });
  let restore: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    restore = await prepareLiveCalibration({ prisma, session, config, profile });
    const driver = liveCalibrationDriver({
      prisma,
      session,
      limits: config.limits,
      signal: controller.signal,
    });
    await runCalibration({
      jobs,
      limits: config.limits,
      signal: controller.signal,
      driver: {
        async run(job, remainingTokens) {
          const trial = await driver.run(job, remainingTokens);
          process.stdout.write(
            `${JSON.stringify({ caseId: trial.caseId, configurationId: trial.configurationId, repeat: trial.repeat, status: trial.status, contentPass: trial.grade.contentPass, formatPass: trial.grade.formatPass, latencyMs: trial.latencyMs, failure: trial.failure })}\n`,
          );
          return trial;
        },
      },
      save,
    });
    report.finishedAt = new Date().toISOString();
    await save(report.trials);
    if (report.trials.some((trial) => trial.status !== "completed")) process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      await restore?.();
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  }
}

main().catch(() => {
  process.stderr.write(
    "Model calibration could not complete. Results remain incomplete; private configuration and provider errors were not printed.\n",
  );
  process.exitCode = 1;
});
