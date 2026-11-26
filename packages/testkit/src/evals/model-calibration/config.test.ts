import { describe, expect, it } from "vitest";
import { CalibrationConfigSchema, CandidateSchema, digest, validateProfile } from "./config.js";

const candidate = CandidateSchema.parse({
  id: "luna",
  connection: "codex",
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  thinkingLevel: "low",
});
const development = JSON.stringify({
  kind: "rakazo-model-calibration",
  phase: "development",
  candidates: [candidate],
});
const profile = {
  developmentSha256: digest(development),
  baselineId: "luna",
  categories: { fast: "luna", everyday: "luna", complex: "luna" },
};

describe("frozen calibration profile", () => {
  it("accepts one unchanged configuration for multiple categories", () => {
    expect(() =>
      validateProfile({ profile, developmentReport: development, candidates: [candidate] }),
    ).not.toThrow();
  });
  it.each([
    { modelId: "other-model" },
    { thinkingLevel: "medium" },
    { connection: "other-connection" },
  ])("rejects a changed configuration behind an unchanged alias: %j", (change) => {
    const changed = CandidateSchema.parse({ ...candidate, ...change });
    expect(() =>
      validateProfile({ profile, developmentReport: development, candidates: [changed] }),
    ).toThrow("Frozen candidate");
  });
  it("rejects a development report changed after freezing", () => {
    expect(() =>
      validateProfile({ profile, developmentReport: `${development}\n`, candidates: [candidate] }),
    ).toThrow("does not match");
  });
  it("reserves auto for the comparison arm", () => {
    expect(
      CalibrationConfigSchema.safeParse({
        candidates: [{ ...candidate, id: "auto" }],
        limits: { maxTrials: 1, maxTokens: 100 },
      }).success,
    ).toBe(false);
  });
});
