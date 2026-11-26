import type { ModelCategory, ThinkingLevel } from "@rakazo/contracts";

export type CalibrationCandidate = {
  id: string;
  connection: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

export type CalibrationGrade = {
  contentPass: boolean;
  formatPass: boolean;
  criticalFailure: boolean;
  reasons: string[];
};

export type CalibrationEvidence = {
  text: string;
  tools: Array<{ name: string; success: boolean }>;
};

export type CalibrationScenario = {
  id: string;
  category: ModelCategory;
  turns: readonly string[];
  grade: (evidence: CalibrationEvidence) => CalibrationGrade;
};

export type CalibrationTrial = {
  caseId: string;
  category: ModelCategory;
  configurationId: string;
  repeat: number;
  status: "completed" | "failed" | "cancelled" | "not-run";
  grade: CalibrationGrade;
  latencyMs: number | null;
  turnLatenciesMs: number[];
  modelCalls: number;
  toolCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  actualModels: Array<{ provider: string; modelId: string; thinkingLevel: string | null }>;
  routing: Array<{
    mode: string;
    category: string | null;
    fallback: string | null;
  }>;
  response: string;
  failure: string | null;
};

export type CalibrationLimits = {
  maxTrials: number;
  maxTokens: number;
  maxToolCalls: number;
  timeoutMs: number;
};
