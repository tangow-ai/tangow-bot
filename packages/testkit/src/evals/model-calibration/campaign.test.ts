import { describe, expect, it } from "vitest";
import { planCalibration, runCalibration } from "./campaign.js";
import type { CalibrationTrial } from "./types.js";

const candidate = {
  id: "luna",
  connection: "test",
  provider: "test",
  modelId: "luna",
  thinkingLevel: "low",
} as const;
const scenario = {
  id: "sum",
  category: "fast",
  turns: ["Compute 2+3"],
  grade: () => ({ contentPass: true, formatPass: true, criticalFailure: false, reasons: [] }),
} as const;
const limits = { maxTrials: 5, maxTokens: 100, timeoutMs: 1_000, maxToolCalls: 3 };
function observed(): CalibrationTrial {
  return {
    caseId: "sum",
    category: "fast",
    configurationId: "luna",
    repeat: 1,
    status: "completed",
    grade: { contentPass: true, formatPass: true, criticalFailure: false, reasons: [] },
    latencyMs: 12,
    turnLatenciesMs: [12],
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 40,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    actualModels: [{ provider: "test", modelId: "luna", thinkingLevel: "low" }],
    routing: [],
    response: "5",
    failure: null,
  };
}
const jobs = () => planCalibration({ scenarios: [scenario], candidates: [candidate], repeats: 3 });

describe("calibration execution budgets", () => {
  it("keeps unattempted trials visible after the observed token budget", async () => {
    let executions = 0;
    const saved: number[] = [];
    const trials = await runCalibration({
      jobs: jobs(),
      limits,
      driver: {
        async run(job) {
          executions++;
          return { ...observed(), repeat: job.repeat };
        },
      },
      save: async (trials) => {
        saved.push(trials.length);
      },
    });
    expect(executions).toBe(2);
    expect(trials.map((trial) => [trial.status, trial.failure])).toEqual([
      ["completed", null],
      ["completed", null],
      ["not-run", "token-budget"],
    ]);
    expect(saved).toEqual([1, 2, 3]);
  });

  it("stops after the task count ceiling without removing later slots", async () => {
    const trials = await runCalibration({
      jobs: jobs(),
      limits: { ...limits, maxTrials: 1 },
      driver: { run: async () => observed() },
      save: async () => {},
    });
    expect(trials.map((trial) => trial.failure)).toEqual([null, "trial-budget", "trial-budget"]);
  });

  it.each(["missing-usage", "cleanup-failed"])("does not continue after %s", async (fault) => {
    let executions = 0;
    const trials = await runCalibration({
      jobs: jobs(),
      limits,
      driver: {
        async run() {
          executions++;
          return {
            ...observed(),
            inputTokens: fault === "missing-usage" ? null : 40,
            failure: fault === "cleanup-failed" ? "cleanup-failed" : null,
          };
        },
      },
      save: async () => {},
    });
    expect(executions).toBe(1);
    expect(trials.slice(1).map((trial) => trial.failure)).toEqual(
      fault === "missing-usage"
        ? ["usage-unavailable", "usage-unavailable"]
        : ["cleanup-failed", "cleanup-failed"],
    );
  });

  it("does not dispatch additional trials after an operator interruption", async () => {
    const controller = new AbortController();
    const trials = await runCalibration({
      jobs: jobs(),
      limits,
      signal: controller.signal,
      driver: {
        async run() {
          controller.abort();
          return observed();
        },
      },
      save: async () => {},
    });
    expect(trials.map((trial) => trial.failure)).toEqual([null, "interrupted", "interrupted"]);
  });

  it("rotates configurations across cases and reverses each paired repeat", () => {
    const plan = planCalibration({
      scenarios: [scenario, { ...scenario, id: "other" }],
      candidates: [candidate, { ...candidate, id: "terra" }],
      repeats: 2,
    });
    expect(plan.map((job) => [job.scenario.id, job.repeat, job.candidate.id])).toEqual([
      ["sum", 1, "luna"],
      ["sum", 1, "terra"],
      ["other", 1, "terra"],
      ["other", 1, "luna"],
      ["sum", 2, "terra"],
      ["sum", 2, "luna"],
      ["other", 2, "luna"],
      ["other", 2, "terra"],
    ]);
  });
});
