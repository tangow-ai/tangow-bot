import type { ModelCategory } from "@rakazo/contracts";
import type { CalibrationCandidate, CalibrationTrial } from "./types.js";

const CATEGORIES: readonly ModelCategory[] = ["fast", "everyday", "complex"];
const MIN_REPEATS = 5;

type Measurements = {
  observations: number;
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
};

type Recommendation =
  | {
      status: "uncalibrated";
      configurationId: null;
      finalists: string[];
      basis: null;
      reasons: string[];
    }
  | {
      status: "repeat-required";
      configurationId: null;
      finalists: string[];
      basis: "latency" | "cost-per-success";
      reasons: string[];
    }
  | {
      status: "provisional";
      configurationId: string;
      finalists: string[];
      basis: "latency" | "cost-per-success";
      reasons: string[];
    };

function measurements(values: readonly number[]): Measurements {
  const ordered = [...values].sort((a, b) => a - b);
  const first = ordered[0];
  const last = ordered.at(-1);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  const lower = ordered[middle - 1];
  return {
    observations: ordered.length,
    medianMs:
      upper === undefined
        ? null
        : ordered.length % 2 === 0 && lower !== undefined
          ? (lower + upper) / 2
          : upper,
    minMs: first ?? null,
    maxMs: last ?? null,
  };
}

function spread(values: readonly number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function summarizeConfiguration(input: {
  candidate: CalibrationCandidate;
  category: ModelCategory;
  trials: readonly CalibrationTrial[];
  plannedCases: readonly { id: string; category: ModelCategory }[];
  repeats: number;
}) {
  const cases = input.plannedCases.filter((scenario) => scenario.category === input.category);
  const caseIds = new Set(cases.map((scenario) => scenario.id));
  const records = input.trials.filter(
    (trial) =>
      trial.configurationId === input.candidate.id &&
      trial.category === input.category &&
      caseIds.has(trial.caseId) &&
      trial.repeat >= 1 &&
      trial.repeat <= input.repeats,
  );
  const slots = new Map<string, CalibrationTrial>();
  for (const trial of records) {
    const key = JSON.stringify([trial.caseId, trial.repeat]);
    if (!slots.has(key)) slots.set(key, trial);
  }
  const unique = [...slots.values()];
  const attempted = unique.filter((trial) => trial.status !== "not-run");
  const contentPassed = attempted.filter(
    (trial) => trial.status === "completed" && trial.grade.contentPass,
  );
  const successes = contentPassed.filter((trial) => !trial.grade.criticalFailure);
  const unsuccessful = attempted.filter(
    (trial) =>
      trial.status !== "completed" || !trial.grade.contentPass || trial.grade.criticalFailure,
  );
  const planned = cases.length * input.repeats;
  const duplicates = records.length - unique.length;
  const criticalFailures = attempted.filter((trial) => trial.grade.criticalFailure).length;
  const settingMismatches = attempted.filter(
    (trial) =>
      trial.status === "completed" &&
      (trial.actualModels.length === 0 ||
        trial.actualModels.some(
          (actual) =>
            actual.provider !== input.candidate.provider ||
            actual.modelId !== input.candidate.modelId ||
            actual.thinkingLevel !== input.candidate.thinkingLevel,
        )),
  ).length;
  const executionComplete = planned > 0 && attempted.length === planned && duplicates === 0;
  const latencyComplete = executionComplete && attempted.every((trial) => trial.latencyMs !== null);
  const qualityPassed = executionComplete && successes.length === planned && criticalFailures === 0;
  const costComplete = executionComplete && attempted.every((trial) => trial.costUsd !== null);
  const totalCostUsd = costComplete
    ? attempted.reduce((sum, trial) => sum + (trial.costUsd ?? 0), 0)
    : null;
  const sumTokens = (
    key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
  ) =>
    executionComplete && attempted.every((trial) => trial[key] !== null)
      ? attempted.reduce((sum, trial) => sum + (trial[key] ?? 0), 0)
      : null;
  const observedTotal = (key: "costUsd" | "inputTokens" | "outputTokens") => {
    const known = records.flatMap((trial) => {
      const value = trial[key];
      return trial.status === "not-run" || value === null ? [] : [value];
    });
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  const durations = (trials: readonly CalibrationTrial[]) =>
    trials.flatMap((trial) => (trial.latencyMs === null ? [] : [trial.latencyMs]));
  const repeatVariationMs = Math.max(
    0,
    ...cases.map((scenario) => {
      return spread(durations(attempted.filter((trial) => trial.caseId === scenario.id)));
    }),
  );
  const repeatCostVariationUsd = costComplete
    ? Math.max(
        0,
        ...cases.map((scenario) => {
          const costs = attempted.flatMap((trial) =>
            trial.caseId === scenario.id && trial.costUsd !== null ? [trial.costUsd] : [],
          );
          return spread(costs);
        }),
      )
    : null;
  return {
    configuration: { ...input.candidate },
    planned,
    recorded: unique.length,
    attempted: attempted.length,
    missing: planned - unique.length,
    notRun: planned - attempted.length,
    completed: attempted.filter((trial) => trial.status === "completed").length,
    failed: attempted.filter((trial) => trial.status === "failed").length,
    cancelled: attempted.filter((trial) => trial.status === "cancelled").length,
    contentPassed: contentPassed.length,
    successful: successes.length,
    formatPassed: attempted.filter(
      (trial) => trial.status === "completed" && trial.grade.formatPass,
    ).length,
    criticalFailures,
    distinctCasesPlanned: cases.length,
    distinctCasesAttempted: new Set(attempted.map((trial) => trial.caseId)).size,
    contentSuccessRate: planned > 0 ? contentPassed.length / planned : null,
    successRate: planned > 0 ? successes.length / planned : null,
    duplicates,
    settingMismatches,
    executionComplete,
    latencyComplete,
    qualityPassed,
    eligible: qualityPassed && latencyComplete && settingMismatches === 0,
    latency: measurements(durations(attempted)),
    repeatVariationMs,
    successfulLatency: measurements(durations(successes)),
    unsuccessfulLatency: measurements(durations(unsuccessful)),
    modelCalls: attempted.reduce((sum, trial) => sum + trial.modelCalls, 0),
    toolCalls: attempted.reduce((sum, trial) => sum + trial.toolCalls, 0),
    inputTokens: sumTokens("inputTokens"),
    outputTokens: sumTokens("outputTokens"),
    cacheReadTokens: sumTokens("cacheReadTokens"),
    cacheWriteTokens: sumTokens("cacheWriteTokens"),
    totalCostUsd,
    repeatCostVariationUsd,
    costPerSuccessUsd:
      totalCostUsd !== null && successes.length > 0 ? totalCostUsd / successes.length : null,
    knownCostTrials: records.filter((trial) => trial.status !== "not-run" && trial.costUsd !== null)
      .length,
    observedCostUsd: observedTotal("costUsd"),
    observedInputTokens: observedTotal("inputTokens"),
    observedOutputTokens: observedTotal("outputTokens"),
  };
}

type ConfigurationSummary = ReturnType<typeof summarizeConfiguration>;

function recommend(input: {
  category: ModelCategory;
  configurations: readonly ConfigurationSummary[];
  repeats: number;
}): Recommendation {
  const eligible = input.configurations.filter((configuration) => configuration.eligible);
  if (!eligible.length) {
    return {
      status: "uncalibrated",
      configurationId: null,
      finalists: [],
      basis: null,
      reasons: [
        "no_configuration_meets_complete_quality_and_measurement_gate",
        "retain_current_setting",
      ],
    };
  }
  const costKnown = eligible.every((configuration) => configuration.costPerSuccessUsd !== null);
  const useCost = input.category === "everyday" && costKnown;
  const basis = useCost ? "cost-per-success" : "latency";
  const ranked = eligible
    .flatMap((configuration) => {
      const value = useCost ? configuration.costPerSuccessUsd : configuration.latency.medianMs;
      return value === null ? [] : [{ configuration, value }];
    })
    .sort(
      (a, b) =>
        a.value - b.value ||
        a.configuration.configuration.id.localeCompare(b.configuration.configuration.id),
    );
  const first = ranked[0];
  if (!first) {
    return {
      status: "uncalibrated",
      configurationId: null,
      finalists: [],
      basis: null,
      reasons: ["no_complete_measurement", "retain_current_setting"],
    };
  }
  const reasons = ["small_corpus_indicative_only", "reserved_validation_required"];
  if (input.configurations.some((configuration) => !configuration.executionComplete)) {
    reasons.push("other_configurations_incomplete");
  }
  if (input.category === "everyday" && !costKnown)
    reasons.push("cost_unavailable_not_spend_optimized");
  if (input.category === "complex")
    reasons.push("no_observed_content_quality_difference_among_eligible");
  if (input.repeats < MIN_REPEATS) {
    return {
      status: "repeat-required",
      configurationId: null,
      finalists: ranked.map((item) => item.configuration.configuration.id),
      basis,
      reasons: [...reasons, "at_least_five_repeats_for_variability_comparison"],
    };
  }
  const contenders = ranked.filter((item) => {
    if (item === first) return true;
    if (useCost) {
      return (
        item.value - first.value <=
        Math.max(
          first.configuration.repeatCostVariationUsd ?? 0,
          item.configuration.repeatCostVariationUsd ?? 0,
        )
      );
    }
    return (
      item.value - first.value <=
      Math.max(first.configuration.repeatVariationMs, item.configuration.repeatVariationMs)
    );
  });
  if (contenders.length > 1) {
    return {
      status: "repeat-required",
      configurationId: null,
      finalists: contenders.map((item) => item.configuration.configuration.id),
      basis,
      reasons: [
        ...reasons,
        useCost ? "cost_gap_within_run_to_run_variation" : "gap_within_run_to_run_variation",
      ],
    };
  }
  return {
    status: "provisional",
    configurationId: first.configuration.configuration.id,
    finalists: [first.configuration.configuration.id],
    basis,
    reasons,
  };
}

export function summarizeCalibration(input: {
  candidates: readonly CalibrationCandidate[];
  trials: readonly CalibrationTrial[];
  plannedCases: readonly { id: string; category: ModelCategory }[];
  repeats: number;
}) {
  return {
    qualityGate: "all_planned_content_checks_passed_without_critical_failure",
    categories: CATEGORIES.map((category) => {
      const configurations = input.candidates.map((candidate) =>
        summarizeConfiguration({ ...input, candidate, category }),
      );
      return {
        category,
        configurations,
        recommendation: recommend({ category, configurations, repeats: input.repeats }),
      };
    }),
    limitations: [
      "Recommendations are provisional and require reserved validation scenarios.",
      "Repeated trials measure variability, not independent task coverage or general quality.",
      "Format compliance is reported separately from content correctness and critical failures.",
      "Missing costs and subscription quota units remain unknown; tokens are not monetary prices.",
      "Input token counters already include cache reads when the provider reports them that way.",
      "Latency includes observed failed attempts; only complete quality-eligible configurations can be recommended.",
      "A missing or duplicate planned trial prevents a configuration from passing the gate.",
    ],
  };
}

type AutoValidationInput = {
  trials: readonly CalibrationTrial[];
  plannedCases: readonly { id: string; category: ModelCategory }[];
  repeats: number;
  baselineId: string;
};

function validationArm(input: AutoValidationInput, configurationId: string) {
  const plannedCases = new Set(
    input.plannedCases.map((scenario) => JSON.stringify([scenario.category, scenario.id])),
  );
  const records = input.trials.filter(
    (trial) =>
      trial.configurationId === configurationId &&
      plannedCases.has(JSON.stringify([trial.category, trial.caseId])) &&
      trial.repeat >= 1 &&
      trial.repeat <= input.repeats,
  );
  const slots = new Map<string, CalibrationTrial[]>();
  for (const trial of records) {
    const key = JSON.stringify([trial.category, trial.caseId, trial.repeat]);
    const existing = slots.get(key);
    if (existing) existing.push(trial);
    else slots.set(key, [trial]);
  }
  const unique = [...slots.values()].flatMap((rows) => (rows.length === 1 ? rows : []));
  const attempted = unique.filter((trial) => trial.status !== "not-run");
  const planned = input.plannedCases.length * input.repeats;
  const duplicates = records.length - slots.size;
  const complete = planned > 0 && attempted.length === planned && duplicates === 0;
  const successful = attempted.filter(
    (trial) =>
      trial.status === "completed" && trial.grade.contentPass && !trial.grade.criticalFailure,
  );
  const counts = (values: readonly string[]) => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return Object.fromEntries(result);
  };
  const models = new Map<
    string,
    {
      provider: string;
      modelId: string;
      thinkingLevel: string | null;
      selections: number;
    }
  >();
  for (const trial of attempted)
    for (const actual of trial.actualModels) {
      const key = JSON.stringify([actual.provider, actual.modelId, actual.thinkingLevel]);
      const existing = models.get(key);
      if (existing) existing.selections += 1;
      else models.set(key, { ...actual, selections: 1 });
    }
  const costKnown = complete && attempted.every((trial) => trial.costUsd !== null);
  const totalCostUsd = costKnown
    ? attempted.reduce((sum, trial) => sum + (trial.costUsd ?? 0), 0)
    : null;
  return {
    slots,
    summary: {
      configurationId,
      planned,
      recorded: slots.size,
      attempted: attempted.length,
      missing: planned - slots.size,
      notRun: planned - attempted.length,
      duplicates,
      complete,
      completed: attempted.filter((trial) => trial.status === "completed").length,
      failed: attempted.filter((trial) => trial.status === "failed").length,
      cancelled: attempted.filter((trial) => trial.status === "cancelled").length,
      contentPassed: attempted.filter(
        (trial) => trial.status === "completed" && trial.grade.contentPass,
      ).length,
      formatPassed: attempted.filter(
        (trial) => trial.status === "completed" && trial.grade.formatPass,
      ).length,
      criticalFailures: attempted.filter((trial) => trial.grade.criticalFailure).length,
      successful: successful.length,
      successRate: planned > 0 ? successful.length / planned : null,
      latency: measurements(
        attempted.flatMap((trial) => (trial.latencyMs === null ? [] : [trial.latencyMs])),
      ),
      successfulLatency: measurements(
        successful.flatMap((trial) => (trial.latencyMs === null ? [] : [trial.latencyMs])),
      ),
      totalCostUsd,
      costPerSuccessUsd:
        totalCostUsd !== null && successful.length > 0 ? totalCostUsd / successful.length : null,
      modelCalls: attempted.reduce((sum, trial) => sum + trial.modelCalls, 0),
      toolCalls: attempted.reduce((sum, trial) => sum + trial.toolCalls, 0),
      actualModels: [...models.values()],
      routeModes: counts(attempted.flatMap((trial) => trial.routing.map((route) => route.mode))),
      routeCategories: counts(
        attempted.flatMap((trial) =>
          trial.routing.flatMap((route) => (route.category === null ? [] : [route.category])),
        ),
      ),
      fallbacks: counts(
        attempted.flatMap((trial) =>
          trial.routing.flatMap((route) => (route.fallback === null ? [] : [route.fallback])),
        ),
      ),
    },
  };
}

function autoValidationGroup(input: AutoValidationInput) {
  const auto = validationArm(input, "auto");
  const baseline = validationArm(input, input.baselineId);
  const differences: Array<{
    caseId: string;
    category: ModelCategory;
    repeat: number;
    autoMinusBaselineMs: number;
  }> = [];
  for (const scenario of input.plannedCases)
    for (let repeat = 1; repeat <= input.repeats; repeat += 1) {
      const key = JSON.stringify([scenario.category, scenario.id, repeat]);
      const a = auto.slots.get(key);
      const b = baseline.slots.get(key);
      if (a?.length !== 1 || b?.length !== 1) continue;
      const first = a[0];
      const second = b[0];
      if (
        !first ||
        !second ||
        first.status !== "completed" ||
        second.status !== "completed" ||
        !first.grade.contentPass ||
        !second.grade.contentPass ||
        first.grade.criticalFailure ||
        second.grade.criticalFailure ||
        first.latencyMs === null ||
        second.latencyMs === null ||
        first.actualModels.length === 0 ||
        second.actualModels.length === 0 ||
        first.routing.length === 0 ||
        second.routing.length === 0 ||
        first.routing.some((route) => route.mode !== "auto") ||
        second.routing.some((route) => route.mode !== "fixed")
      )
        continue;
      differences.push({
        caseId: scenario.id,
        category: scenario.category,
        repeat,
        autoMinusBaselineMs: first.latencyMs - second.latencyMs,
      });
    }
  const plannedPairs = input.plannedCases.length * input.repeats;
  return {
    plannedPairs,
    validPairs: differences.length,
    comparisonComplete:
      plannedPairs > 0 &&
      differences.length === plannedPairs &&
      auto.summary.complete &&
      baseline.summary.complete,
    auto: auto.summary,
    baseline: baseline.summary,
    pairedLatencyDelta: measurements(differences.map((pair) => pair.autoMinusBaselineMs)),
    pairedDifferences: differences,
  };
}

export function summarizeAutoValidation(input: AutoValidationInput) {
  return {
    baselineId: input.baselineId,
    cases: input.plannedCases.map((scenario) => ({
      caseId: scenario.id,
      category: scenario.category,
      ...autoValidationGroup({ ...input, plannedCases: [scenario] }),
    })),
    categories: CATEGORIES.map((category) => ({
      category,
      ...autoValidationGroup({
        ...input,
        plannedCases: input.plannedCases.filter((scenario) => scenario.category === category),
      }),
    })),
    limitations: [
      "Reserved validation is descriptive and never selects or recalibrates a model configuration.",
      "Success rates include missing, skipped, failed and cancelled planned trials in their denominator.",
      "Latency differences include only unique completed pairs with correct content, no critical failure, observed models, known latency and the expected Auto/fixed modes.",
      "Negative paired latency differences mean Auto completed sooner on that pair; incomplete pairs cannot establish a complete comparison.",
      "Repeated cases do not establish general quality or a reliable p95.",
      "Auto may legitimately use multiple models. Route and fallback counts are reported without a single-model mismatch gate.",
      "Missing monetary costs remain unknown and cannot establish spending or subscription-quota savings.",
    ],
  };
}
