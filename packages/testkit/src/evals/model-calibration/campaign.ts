import type {
  CalibrationCandidate,
  CalibrationLimits,
  CalibrationScenario,
  CalibrationTrial,
} from "./types.js";

export type CalibrationJob = {
  scenario: CalibrationScenario;
  candidate: CalibrationCandidate;
  repeat: number;
  auto: boolean;
};

export type CalibrationDriver = {
  run: (job: CalibrationJob, remainingTokens: number) => Promise<CalibrationTrial>;
};

export function planCalibration(input: {
  scenarios: readonly CalibrationScenario[];
  candidates: readonly CalibrationCandidate[];
  repeats: number;
  auto?: boolean;
}): CalibrationJob[] {
  if (!Number.isSafeInteger(input.repeats) || input.repeats < 1 || input.repeats > 10)
    throw new Error("Repeats must be an integer between 1 and 10");
  const jobs: CalibrationJob[] = [];
  for (let repeat = 1; repeat <= input.repeats; repeat++) {
    for (const [index, scenario] of input.scenarios.entries()) {
      const offset = input.candidates.length ? index % input.candidates.length : 0;
      const rotated = [...input.candidates.slice(offset), ...input.candidates.slice(0, offset)];
      const order = repeat % 2 === 1 ? rotated : rotated.reverse();
      for (const candidate of order) {
        jobs.push({
          scenario,
          candidate,
          repeat,
          auto: Boolean(input.auto && candidate.id === "auto"),
        });
      }
    }
  }
  return jobs;
}

export function unattempted(job: CalibrationJob, reason: string): CalibrationTrial {
  return {
    caseId: job.scenario.id,
    category: job.scenario.category,
    configurationId: job.candidate.id,
    repeat: job.repeat,
    status: "not-run",
    grade: { contentPass: false, formatPass: false, criticalFailure: false, reasons: [reason] },
    latencyMs: null,
    turnLatenciesMs: [],
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
    actualModels: [],
    routing: [],
    response: "",
    failure: reason,
  };
}

export async function runCalibration(input: {
  jobs: readonly CalibrationJob[];
  limits: CalibrationLimits;
  driver: CalibrationDriver;
  signal?: AbortSignal;
  save: (trials: readonly CalibrationTrial[]) => Promise<void>;
}): Promise<CalibrationTrial[]> {
  const trials: CalibrationTrial[] = [];
  let tokens = 0;
  let attempted = 0;
  let stopped: string | null = null;
  for (const job of input.jobs) {
    const reason =
      stopped ??
      (input.signal?.aborted
        ? "interrupted"
        : attempted >= input.limits.maxTrials
          ? "trial-budget"
          : tokens >= input.limits.maxTokens
            ? "token-budget"
            : null);
    if (reason) {
      trials.push(unattempted(job, reason));
    } else {
      const result = await input.driver.run(job, input.limits.maxTokens - tokens);
      trials.push(result);
      attempted++;
      if (result.inputTokens === null || result.outputTokens === null)
        stopped = "usage-unavailable";
      else tokens += result.inputTokens + result.outputTokens;
      if (result.failure === "cleanup-failed") stopped = "cleanup-failed";
    }
    await input.save(trials);
  }
  return trials;
}
