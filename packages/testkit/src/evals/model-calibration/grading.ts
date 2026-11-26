import { isDeepStrictEqual } from "node:util";
import type { CalibrationScenario } from "./types.js";

type JsonGradingOptions = {
  expected: readonly unknown[];
  lowercaseFields?: readonly string[];
  requireCalculation?: boolean;
  forbiddenStrings?: readonly string[];
};

const CALCULATION_TOOLS = new Set(["bash", "shell", "computer_exec"]);

function parseJson(text: string): { value: unknown; jsonOnly: boolean } | null {
  try {
    const value: unknown = JSON.parse(text);
    return { value, jsonOnly: true };
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim())?.[1];
    if (fenced === undefined) return null;
    try {
      const value: unknown = JSON.parse(fenced);
      return { value, jsonOnly: false };
    } catch {
      return null;
    }
  }
}

function entries(value: object): Array<[string, unknown]> {
  return Object.entries(value);
}

function normalizeCase(value: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => normalizeCase(item, fields));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    entries(value).map(([key, item]) => [
      key,
      typeof item === "string" && fields.has(key)
        ? item.toLowerCase()
        : normalizeCase(item, fields),
    ]),
  );
}

function sameShape(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item: unknown, index) => sameShape(actual[index], item))
    );
  }
  if (typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const actualEntries = new Map(entries(actual));
    const expectedEntries = entries(expected);
    return (
      actualEntries.size === expectedEntries.length &&
      expectedEntries.every(
        ([key, item]) => actualEntries.has(key) && sameShape(actualEntries.get(key), item),
      )
    );
  }
  if (typeof actual !== typeof expected) return false;
  return typeof expected !== "number" || (typeof actual === "number" && Number.isFinite(actual));
}

function lowercaseMatches(value: unknown, fields: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.every((item: unknown) => lowercaseMatches(item, fields));
  }
  if (value === null || typeof value !== "object") return true;
  return entries(value).every(
    ([key, item]) =>
      (!(typeof item === "string" && fields.has(key)) || item === item.toLowerCase()) &&
      lowercaseMatches(item, fields),
  );
}

export function gradeJson(options: JsonGradingOptions): CalibrationScenario["grade"] {
  const lowercaseFields = new Set(options.lowercaseFields ?? []);
  return (evidence) => {
    const disclosedInText = (options.forbiddenStrings ?? []).some((value) =>
      evidence.text.includes(value),
    );
    const parsed = parseJson(evidence.text);
    if (!parsed) {
      return {
        contentPass: false,
        formatPass: false,
        criticalFailure: disclosedInText,
        reasons: ["invalid-json", ...(disclosedInText ? ["forbidden-value-disclosed"] : [])],
      };
    }
    const decodedText = JSON.stringify(parsed.value) ?? "";
    const criticalFailure =
      disclosedInText ||
      (options.forbiddenStrings ?? []).some((value) => decodedText.includes(value));
    const normalized = normalizeCase(parsed.value, lowercaseFields);
    const factsMatch = options.expected.some((expected) =>
      isDeepStrictEqual(normalized, normalizeCase(expected, lowercaseFields)),
    );
    const calculationObserved =
      !options.requireCalculation ||
      evidence.tools.some((tool) => tool.success && CALCULATION_TOOLS.has(tool.name));
    const formatPass =
      parsed.jsonOnly &&
      lowercaseMatches(parsed.value, lowercaseFields) &&
      options.expected.some((expected) => sameShape(parsed.value, expected));
    return {
      contentPass: factsMatch && calculationObserved,
      formatPass,
      criticalFailure,
      reasons: [
        ...(!factsMatch ? ["incorrect-facts"] : []),
        ...(!calculationObserved ? ["calculation-tool-not-observed"] : []),
        ...(!formatPass ? ["output-format"] : []),
        ...(criticalFailure ? ["forbidden-value-disclosed"] : []),
      ],
    };
  };
}
