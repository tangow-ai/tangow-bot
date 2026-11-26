import { createHash } from "node:crypto";
import { ModelCategorySchema, ThinkingLevelSchema } from "@rakazo/contracts";
import * as z from "zod";

const alias = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const CandidateSchema = z.object({
  id: alias.refine((value) => value !== "auto", "auto is reserved for the validation arm"),
  connection: alias,
  provider: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: ThinkingLevelSchema,
});
export const CalibrationConfigSchema = z
  .object({
    candidates: z.array(CandidateSchema).min(1).max(12),
    limits: z.object({
      maxTrials: z.number().int().min(1).max(500),
      maxTokens: z.number().int().min(1).max(10_000_000),
      maxToolCalls: z.number().int().min(1).max(100).default(15),
      timeoutMs: z.number().int().min(1_000).max(300_000).default(180_000),
    }),
  })
  .superRefine(({ candidates }, context) => {
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
      context.addIssue({ code: "custom", message: "Candidate ids must be unique" });
  });
export type CalibrationConfig = z.infer<typeof CalibrationConfigSchema>;

export const CalibrationSessionSchema = z.object({
  userId: z.string().min(1),
  spaceId: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.url().default("http://127.0.0.1:3100"),
  origin: z.url(),
  connections: z.record(alias, z.string().min(1)),
});
export type CalibrationSession = z.infer<typeof CalibrationSessionSchema>;

export const FrozenProfileSchema = z.object({
  developmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  baselineId: alias,
  categories: z.object({ fast: alias, everyday: alias, complex: alias }),
});
export type FrozenProfile = z.infer<typeof FrozenProfileSchema>;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateProfile(input: {
  profile: FrozenProfile;
  developmentReport: string;
  candidates: CalibrationConfig["candidates"];
}): void {
  if (digest(input.developmentReport) !== input.profile.developmentSha256)
    throw new Error("Frozen profile does not match its development report");
  const development = z
    .object({
      kind: z.literal("rakazo-model-calibration"),
      phase: z.literal("development"),
      candidates: z.array(CandidateSchema),
    })
    .parse(JSON.parse(input.developmentReport));
  const selectedIds = new Set([
    input.profile.baselineId,
    ...Object.values(input.profile.categories),
  ]);
  for (const id of selectedIds) {
    const before = development.candidates.find((candidate) => candidate.id === id);
    const after = input.candidates.find((candidate) => candidate.id === id);
    if (!before || !after || JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Frozen candidate model, connection or thinking level changed");
  }
  const ids = new Set(input.candidates.map((candidate) => candidate.id));
  if (
    !ids.has(input.profile.baselineId) ||
    ModelCategorySchema.options.some((category) => !ids.has(input.profile.categories[category]))
  )
    throw new Error("Frozen profile references an unknown candidate");
}
