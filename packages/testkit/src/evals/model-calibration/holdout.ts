import { gradeJson } from "./grading.js";
import type { CalibrationScenario } from "./types.js";

export const HOLDOUT_CASES: readonly CalibrationScenario[] = [
  {
    id: "holdout/refund-extraction",
    category: "fast",
    turns: [
      'Read this invented statement: original charge EUR 81.00, transaction TX-440; refund EUR 18.35, reference RF-909; remaining charge EUR 62.65. Extract the refund reference and refund amount in cents, represented as a negative integer. Return only JSON with exactly "reference" and "cents".',
    ],
    grade: gradeJson({ expected: [{ reference: "RF-909", cents: -1835 }] }),
  },
  {
    id: "holdout/long-table-lookup",
    category: "fast",
    turns: [
      'In this invented table, extract the zone for the exact active SKU SKU-077. Ignore all inactive rows even if their SKU matches. Return only JSON with exactly the key "zone".\n' +
        Array.from(
          { length: 150 },
          (_, index) => `SKU-${1000 + index} | active | zone-${index % 9}`,
        ).join("\n") +
        "\nSKU-077 | inactive | zone-2\nSKU-077 | active | zone-8\nSKU-0770 | active | zone-5",
    ],
    grade: gradeJson({ expected: [{ zone: "zone-8" }] }),
  },
  {
    id: "holdout/explicit-string-transform",
    category: "fast",
    turns: [
      'Normalize these invented labels: "  Blue  ", "RED", "blue", "Green", " red ". Trim surrounding spaces, lowercase, remove duplicates and sort alphabetically. Return only JSON with exactly the key "labels", containing the resulting string array.',
    ],
    grade: gradeJson({ expected: [{ labels: ["blue", "green", "red"] }] }),
  },
  {
    id: "holdout/dispatch-context",
    category: "everyday",
    turns: [
      "Use these invented dispatch records only in this conversation. Do not save memories or skills. Initial state: batch B-17 has 12 crates, destination Harbor, carrier Cedar, departure Tuesday, open checks K1 and K2. Background archived batches follow:\n" +
        Array.from(
          { length: 70 },
          (_, index) => `Closed dispatch OLD-${200 + index}: ${index + 3} crates; no open checks.`,
        ).join("\n") +
        "\nCorrection: B-17 has 10 crates, carrier Birch, departure Wednesday; K1 completed; K2 remains open. Reply exactly READY.",
      'Final correction for B-17: add three crates, change destination to Ridge, move departure to Friday, keep Birch as carrier. Complete K2 and add checks K3 and K4. Return only JSON with exactly "batch", "crates", "destination", "carrier", "departure", "checks". Include only open checks, sorted alphabetically. Use lowercase for the departure day and preserve names as written.',
    ],
    grade: gradeJson({
      expected: [
        {
          batch: "B-17",
          crates: 13,
          destination: "Ridge",
          carrier: "Birch",
          departure: "friday",
          checks: ["K3", "K4"],
        },
      ],
      lowercaseFields: ["departure"],
    }),
  },
  {
    id: "holdout/verified-batch-calculation",
    category: "everyday",
    turns: [
      'Verify this synthetic batch with a local calculation tool. For every integer i from 1 through 500 inclusive, set v = (i*i + 11*i + 7) modulo 113, using a nonnegative remainder. Return the sum of the values and the count whose value is strictly greater than 90. A successful local calculation tool call is required. Do not access the network or save persistent memories or skills. Return only JSON with exactly "sum" and "above90".',
    ],
    grade: gradeJson({
      expected: [{ sum: 27453, above90: 104 }],
      requireCalculation: true,
    }),
  },
  {
    id: "holdout/record-scope-workflow",
    category: "everyday",
    turns: [
      "Process these invented records for tenant blue. The explicit policy is: include a record only when tenant=blue AND consent=true AND status=open. Never disclose IDs of records that fail that policy. Deduplicate eligible records by ID, keeping the highest version. Sort the final IDs alphabetically.\n" +
        "ID | tenant | consent | status | version\n" +
        "PUBLIC-14 | blue | true | open | 1\n" +
        "DENIED-71 | red | true | open | 9\n" +
        "PUBLIC-09 | blue | true | open | 2\n" +
        "DENIED-83 | blue | false | open | 4\n" +
        "PUBLIC-14 | blue | true | open | 3\n" +
        "DENIED-96 | blue | true | closed | 8\n" +
        'Return only JSON with exactly "recordIds" and "versions", with aligned arrays of the selected IDs and their versions. Do not list rejected records or explain their IDs.',
    ],
    grade: gradeJson({
      expected: [{ recordIds: ["PUBLIC-09", "PUBLIC-14"], versions: [2, 3] }],
      forbiddenStrings: ["DENIED-71", "DENIED-83", "DENIED-96"],
    }),
  },
  {
    id: "holdout/failover-diagnosis",
    category: "complex",
    turns: [
      'Investigate an invented database incident using only this evidence. Acknowledged writes disappear after immediate leader failover. Hypotheses are ack-before-durability, duplicate-retries and stale-follower-reads. Experiment 1: disable every client retry; loss still occurs. Experiment 2: force every read to the new leader; loss still occurs. Experiment 3: make acknowledgments wait for durable log flush; loss stops under the same immediate-failover experiment. The old leader log inspection shows the missing acknowledged tail was not durable before failover. Choose the supported hypothesis and the two ruled-out hypotheses. Choose the next direct reproducer from crash-after-ack-before-flush, enable-retries-only, and read-same-follower-again. Return only JSON with exactly "hypothesis", "ruledOut", "nextExperiment". Sort ruledOut alphabetically. Use the exact lowercase hyphenated IDs supplied here. Do not claim that a new experiment has already run.',
    ],
    grade: gradeJson({
      expected: [
        {
          hypothesis: "ack-before-durability",
          ruledOut: ["duplicate-retries", "stale-follower-reads"],
          nextExperiment: "crash-after-ack-before-flush",
        },
      ],
    }),
  },
  {
    id: "holdout/critical-path-scheduling",
    category: "complex",
    turns: [
      'Find the minimum makespan for these invented nonpreemptive jobs on two identical workers. All start times are nonnegative integers and a worker executes only one job at a time. Durations: A=4, B=3, C=2, D=5, E=2, F=3, G=1. Dependencies: C after A; D after B; E after both C and D; F after A; G after both E and F. There are no other constraints. Return only JSON with exactly "minimum" and "criticalPath". criticalPath must be the ordered list of job IDs on the unique longest dependency path, and minimum must be the achievable optimal makespan, not merely the total-work lower bound.',
    ],
    grade: gradeJson({
      expected: [{ minimum: 11, criticalPath: ["B", "D", "E", "G"] }],
    }),
  },
  {
    id: "holdout/diagnostic-experiment-selection",
    category: "complex",
    turns: [
      'Choose the cheapest set of deterministic experiments that distinguishes every pair of hypotheses H1,H2,H3,H4. An experiment may be selected at most once. The table gives ID:cost:outcomes in H1,H2,H3,H4 order: P:2:0011, Q:3:0101, R:2:0110, S:1:0001, T:2:0100, U:4:1000. A selected set distinguishes all hypotheses only if each hypothesis has a different vector of outcomes across that set. Minimize total cost, not the number of experiments or a greedy split score. Return only JSON with exactly "experiments", "cost", "distinctVectors". Sort experiment IDs alphabetically and report the number of distinct hypothesis outcome vectors for your selection.',
    ],
    grade: gradeJson({
      expected: [{ experiments: ["P", "R"], cost: 4, distinctVectors: 4 }],
    }),
  },
];
