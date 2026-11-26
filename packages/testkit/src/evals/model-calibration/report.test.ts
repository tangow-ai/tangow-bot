import type { ModelCategory } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { summarizeAutoValidation, summarizeCalibration } from "./report.js";
import type { CalibrationCandidate, CalibrationTrial } from "./types.js";

function candidate(id: string): CalibrationCandidate {
  return {
    id,
    connection: "test-connection",
    provider: "test-provider",
    modelId: `model-${id}`,
    thinkingLevel: "low",
  };
}

function trial(overrides: Partial<CalibrationTrial> = {}): CalibrationTrial {
  const configurationId = overrides.configurationId ?? "a";
  return {
    caseId: "case",
    category: "fast",
    configurationId,
    repeat: 1,
    status: "completed",
    grade: { contentPass: true, formatPass: true, criticalFailure: false, reasons: [] },
    latencyMs: 100,
    turnLatenciesMs: [100],
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: 2,
    actualModels: [
      { provider: "test-provider", modelId: `model-${configurationId}`, thinkingLevel: "low" },
    ],
    routing: [],
    response: "synthetic response",
    failure: null,
    ...overrides,
  };
}

function repeated(input: {
  configurationId: string;
  latencies?: readonly number[];
  category?: ModelCategory;
  costUsd?: number | null;
}) {
  return (input.latencies ?? [100, 100, 100, 100, 100]).map((latencyMs, index) =>
    trial({
      configurationId: input.configurationId,
      category: input.category ?? "fast",
      repeat: index + 1,
      latencyMs,
      turnLatenciesMs: [latencyMs],
      costUsd: input.costUsd === undefined ? 2 : input.costUsd,
    }),
  );
}

function categorySummary(
  report: ReturnType<typeof summarizeCalibration>,
  category: ModelCategory = "fast",
) {
  const summary = report.categories.find((item) => item.category === category);
  if (!summary) throw new Error("Test category is missing");
  return summary;
}

function configurationSummary(
  category: ReturnType<typeof categorySummary>,
  configurationId: string,
) {
  const summary = category.configurations.find((item) => item.configuration.id === configurationId);
  if (!summary) throw new Error("Test configuration is missing");
  return summary;
}

const fastCases = [
  { id: "case", category: "fast" } satisfies { id: string; category: ModelCategory },
];

describe("model calibration summaries", () => {
  it("keeps missing and budget-skipped trials in the success denominator", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a")],
        plannedCases: fastCases,
        repeats: 5,
        trials: [
          trial({ repeat: 1, latencyMs: 100, costUsd: 1 }),
          trial({
            repeat: 2,
            status: "failed",
            grade: {
              contentPass: false,
              formatPass: false,
              criticalFailure: false,
              reasons: ["provider"],
            },
            latencyMs: 20,
            costUsd: 2,
          }),
          trial({ repeat: 3, latencyMs: 200, costUsd: 3 }),
          trial({
            repeat: 4,
            status: "not-run",
            grade: {
              contentPass: false,
              formatPass: false,
              criticalFailure: false,
              reasons: ["budget"],
            },
            latencyMs: null,
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            failure: "budget",
          }),
        ],
      }),
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      planned: 5,
      recorded: 4,
      attempted: 3,
      missing: 1,
      notRun: 2,
      failed: 1,
      contentPassed: 2,
      contentSuccessRate: 0.4,
      executionComplete: false,
      eligible: false,
      latency: { observations: 3, medianMs: 100, minMs: 20, maxMs: 200 },
      successfulLatency: { observations: 2, medianMs: 150, minMs: 100, maxMs: 200 },
      unsuccessfulLatency: { observations: 1, medianMs: 20, minMs: 20, maxMs: 20 },
      observedCostUsd: 6,
      totalCostUsd: null,
      costPerSuccessUsd: null,
      inputTokens: null,
    });
    expect(summary.recommendation).toMatchObject({ status: "uncalibrated", configurationId: null });
  });

  it("charges failed attempts to the cost of obtaining a successful task", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a")],
        plannedCases: fastCases,
        repeats: 2,
        trials: [
          trial({ repeat: 1, costUsd: 1 }),
          trial({
            repeat: 2,
            status: "cancelled",
            grade: {
              contentPass: false,
              formatPass: false,
              criticalFailure: false,
              reasons: ["timeout"],
            },
            latencyMs: 180_000,
            costUsd: 2,
          }),
        ],
      }),
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      attempted: 2,
      cancelled: 1,
      successful: 1,
      successRate: 0.5,
      totalCostUsd: 3,
      costPerSuccessUsd: 3,
    });
    expect(summary.recommendation.status).toBe("uncalibrated");
  });

  it("keeps unknown costs unknown and labels an Everyday latency choice accordingly", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: [{ id: "case", category: "everyday" }],
        repeats: 5,
        trials: [
          ...repeated({ configurationId: "a", category: "everyday", costUsd: null }),
          ...repeated({
            configurationId: "b",
            category: "everyday",
            latencies: [1000, 1000, 1000, 1000, 1000],
            costUsd: 1,
          }),
        ],
      }),
      "everyday",
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      totalCostUsd: null,
      costPerSuccessUsd: null,
      observedCostUsd: null,
      knownCostTrials: 0,
    });
    expect(summary.recommendation).toMatchObject({
      status: "provisional",
      configurationId: "a",
      basis: "latency",
      reasons: expect.arrayContaining(["cost_unavailable_not_spend_optimized"]),
    });
  });

  it("uses complete measured cost per success for Everyday without a model-size preference", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: [{ id: "case", category: "everyday" }],
        repeats: 5,
        trials: [
          ...repeated({ configurationId: "a", category: "everyday", costUsd: 10 }),
          ...repeated({
            configurationId: "b",
            category: "everyday",
            latencies: [1000, 1000, 1000, 1000, 1000],
            costUsd: 2,
          }),
        ],
      }),
      "everyday",
    );
    expect(configurationSummary(summary, "b").costPerSuccessUsd).toBe(2);
    expect(summary.recommendation).toMatchObject({
      status: "provisional",
      configurationId: "b",
      basis: "cost-per-success",
    });
  });

  it("does not let a fast but incomplete configuration beat a fully measured one", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: fastCases,
        repeats: 5,
        trials: [
          ...repeated({ configurationId: "a", latencies: [10, 10, 10, 10] }),
          ...repeated({ configurationId: "b", latencies: [1000, 1000, 1000, 1000, 1000] }),
        ],
      }),
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      missing: 1,
      contentSuccessRate: 0.8,
      totalCostUsd: null,
      eligible: false,
    });
    expect(summary.recommendation).toMatchObject({
      status: "provisional",
      configurationId: "b",
      reasons: expect.arrayContaining(["other_configurations_incomplete"]),
    });
  });

  it("reports harmless formatting separately while rejecting a critical failure", () => {
    const fast = repeated({ configurationId: "a" });
    const first = fast[0];
    if (!first) throw new Error("Test trial is missing");
    first.grade = {
      contentPass: true,
      formatPass: false,
      criticalFailure: false,
      reasons: ["casing"],
    };
    const slow = repeated({ configurationId: "b", latencies: [1000, 1000, 1000, 1000, 1000] });
    const input = {
      candidates: [candidate("a"), candidate("b")],
      plannedCases: fastCases,
      repeats: 5,
    };
    const formatSummary = categorySummary(
      summarizeCalibration({ ...input, trials: [...fast, ...slow] }),
    );
    expect(configurationSummary(formatSummary, "a")).toMatchObject({
      contentPassed: 5,
      formatPassed: 4,
      criticalFailures: 0,
      eligible: true,
    });
    expect(formatSummary.recommendation).toMatchObject({
      status: "provisional",
      configurationId: "a",
    });

    const critical = trial({
      repeat: 1,
      grade: {
        contentPass: true,
        formatPass: true,
        criticalFailure: true,
        reasons: ["unsafe-effect"],
      },
    });
    const criticalSummary = categorySummary(
      summarizeCalibration({ ...input, trials: [critical, ...fast.slice(1), ...slow] }),
    );
    expect(configurationSummary(criticalSummary, "a")).toMatchObject({
      contentPassed: 5,
      successful: 4,
      criticalFailures: 1,
      eligible: false,
    });
    expect(criticalSummary.recommendation).toMatchObject({
      status: "provisional",
      configurationId: "b",
    });
  });

  it("requires repetition for a single pass and for gaps within observed variability", () => {
    const exploratory = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a")],
        plannedCases: fastCases,
        repeats: 1,
        trials: [trial()],
      }),
    );
    expect(exploratory.recommendation).toMatchObject({
      status: "repeat-required",
      configurationId: null,
      finalists: ["a"],
    });
    const repeatedSummary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: fastCases,
        repeats: 5,
        trials: [
          ...repeated({ configurationId: "a", latencies: [90, 100, 110, 100, 100] }),
          ...repeated({ configurationId: "b", latencies: [95, 105, 115, 105, 105] }),
        ],
      }),
    );
    expect(repeatedSummary.recommendation).toMatchObject({
      status: "repeat-required",
      configurationId: null,
      finalists: ["a", "b"],
      reasons: expect.arrayContaining(["gap_within_run_to_run_variation"]),
    });
  });

  it("compares repeat variability within each scenario rather than mixing task sizes", () => {
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: [
          { id: "short", category: "fast" },
          { id: "long", category: "fast" },
        ],
        repeats: 5,
        trials: [
          ...repeated({ configurationId: "a", latencies: [10, 10, 10, 10, 10] }).map((row) => ({
            ...row,
            caseId: "short",
          })),
          ...repeated({ configurationId: "a", latencies: [1000, 1000, 1000, 1000, 1000] }).map(
            (row) => ({ ...row, caseId: "long" }),
          ),
          ...repeated({ configurationId: "b", latencies: [20, 20, 20, 20, 20] }).map((row) => ({
            ...row,
            caseId: "short",
          })),
          ...repeated({ configurationId: "b", latencies: [1100, 1100, 1100, 1100, 1100] }).map(
            (row) => ({ ...row, caseId: "long" }),
          ),
        ],
      }),
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      distinctCasesPlanned: 2,
      planned: 10,
      latency: { medianMs: 505, minMs: 10, maxMs: 1000 },
      repeatVariationMs: 0,
    });
    expect(summary.recommendation).toMatchObject({ status: "provisional", configurationId: "a" });
  });

  it("does not treat a small cost gap within repeat variability as a spending advantage", () => {
    const a = repeated({ configurationId: "a", category: "everyday" });
    const b = repeated({ configurationId: "b", category: "everyday" });
    const costsA = [1, 2, 3, 2, 2];
    const costsB = [1.2, 2.2, 3.2, 2.2, 2.2];
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a"), candidate("b")],
        plannedCases: [{ id: "case", category: "everyday" }],
        repeats: 5,
        trials: [
          ...a.map((row, index) => ({ ...row, costUsd: costsA[index] ?? null })),
          ...b.map((row, index) => ({ ...row, costUsd: costsB[index] ?? null })),
        ],
      }),
      "everyday",
    );
    expect(summary.recommendation).toMatchObject({
      status: "repeat-required",
      configurationId: null,
      finalists: ["a", "b"],
      basis: "cost-per-success",
      reasons: expect.arrayContaining(["cost_gap_within_run_to_run_variation"]),
    });
  });

  it("allows one configuration in multiple categories and leaves uncovered categories uncalibrated", () => {
    const report = summarizeCalibration({
      candidates: [candidate("a")],
      plannedCases: [
        { id: "case", category: "fast" },
        { id: "case", category: "complex" },
      ],
      repeats: 5,
      trials: [
        ...repeated({ configurationId: "a" }),
        ...repeated({ configurationId: "a", category: "complex" }),
      ],
    });
    expect(categorySummary(report, "fast").recommendation).toMatchObject({
      status: "provisional",
      configurationId: "a",
    });
    expect(categorySummary(report, "complex").recommendation).toMatchObject({
      status: "provisional",
      configurationId: "a",
    });
    expect(categorySummary(report, "everyday").recommendation).toMatchObject({
      status: "uncalibrated",
      configurationId: null,
    });
  });

  it("refuses a nominally successful configuration if the observed model differs", () => {
    const rows = repeated({ configurationId: "a" });
    const first = rows[0];
    if (!first) throw new Error("Test trial is missing");
    first.actualModels = [
      { provider: "test-provider", modelId: "another-model", thinkingLevel: "low" },
    ];
    const summary = categorySummary(
      summarizeCalibration({
        candidates: [candidate("a")],
        plannedCases: fastCases,
        repeats: 5,
        trials: rows,
      }),
    );
    expect(configurationSummary(summary, "a")).toMatchObject({
      settingMismatches: 1,
      eligible: false,
    });
    expect(summary.recommendation.status).toBe("uncalibrated");
  });
});

describe("Auto calibration validation", () => {
  it("accepts mixed Auto models and excludes an absent baseline pair without improving its denominator", () => {
    const fixed = (caseId: string, category: ModelCategory, repeat: number, latencyMs: number) =>
      trial({
        configurationId: "baseline",
        caseId,
        category,
        repeat,
        latencyMs,
        routing: [{ mode: "fixed", category: null, fallback: null }],
      });
    const auto = (
      caseId: string,
      category: ModelCategory,
      repeat: number,
      latencyMs: number,
      modelId: string,
    ) =>
      trial({
        configurationId: "auto",
        caseId,
        category,
        repeat,
        latencyMs,
        actualModels: [{ provider: "test-provider", modelId, thinkingLevel: "low" }],
        routing: [{ mode: "auto", category, fallback: repeat === 2 ? "decision_failed" : null }],
      });
    const report = summarizeAutoValidation({
      baselineId: "baseline",
      repeats: 2,
      plannedCases: [
        { id: "short", category: "fast" },
        { id: "planning", category: "complex" },
      ],
      trials: [
        fixed("short", "fast", 1, 200),
        fixed("short", "fast", 2, 200),
        auto("short", "fast", 1, 100, "small-model"),
        auto("short", "fast", 2, 150, "small-model"),
        fixed("planning", "complex", 1, 500),
        auto("planning", "complex", 1, 300, "reasoning-model"),
        auto("planning", "complex", 2, 350, "reasoning-model"),
      ],
    });
    const fast = report.categories.find((row) => row.category === "fast");
    expect(fast).toMatchObject({
      plannedPairs: 2,
      validPairs: 2,
      comparisonComplete: true,
      pairedLatencyDelta: { observations: 2, medianMs: -75, minMs: -100, maxMs: -50 },
      auto: {
        planned: 2,
        successful: 2,
        actualModels: [{ modelId: "small-model", selections: 2 }],
        routeCategories: { fast: 2 },
        fallbacks: { decision_failed: 1 },
      },
    });
    const complex = report.categories.find((row) => row.category === "complex");
    expect(complex).toMatchObject({
      plannedPairs: 2,
      validPairs: 1,
      comparisonComplete: false,
      baseline: {
        planned: 2,
        attempted: 1,
        missing: 1,
        notRun: 1,
        successRate: 0.5,
        totalCostUsd: null,
      },
      auto: { successful: 2, actualModels: [{ modelId: "reasoning-model", selections: 2 }] },
      pairedLatencyDelta: { observations: 1, medianMs: -200, minMs: -200, maxMs: -200 },
      pairedDifferences: [
        { caseId: "planning", category: "complex", repeat: 1, autoMinusBaselineMs: -200 },
      ],
    });
    expect(report.cases.find((row) => row.caseId === "planning")).toMatchObject({
      validPairs: 1,
      comparisonComplete: false,
    });
  });
});
