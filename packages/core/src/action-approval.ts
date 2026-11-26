import type { ActionApprovalRule as StoredActionApprovalRule } from "@tangow/contracts";

const APPROVAL_EXEMPT_TOOLS = new Set([
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_run",
  "list_files",
  "read_file",
  "grep",
  "write_file",
  "edit_file",
  "shell",
  "computer_exec",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "request_secret",
  "run_subagent",
  "schedule_create",
  "schedule_list",
  "schedule_cancel",
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set([
  "destination.write",
  "delete_bot",
  "archive_bot",
  "secret_request",
  "forget_memory",
]);
const EXPLICIT_APPROVAL_BUILTIN_TOOLS = new Set(["create_space", "spawn_bot"]);

const UNATTENDED_SAFE_BUILTIN_TOOLS = new Set([
  "search_runs",
  "browser_snapshot",
  "computer_observe",
  "list_files",
  "list_secrets",
  "read_file",
  "grep",
  "recall_memory",
  "request_takeover",
  "run_subagent",
  "schedule_list",
  "scratchpad_list",
  "skill_read",
  "skill_search",
  "web_fetch",
  "web_search",
]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|_)(get|list|search|find|read|fetch|query)(_|$)/i;
const MUTATING_CONNECTOR_PATTERN =
  /(^|_)(accept|add|approve|archive|assign|buy|cancel|charge|checkout|close|commit|copy|create|delete|deploy|disable|enable|execute|forward|grant|invite|link|mark|merge|modify|move|patch|pay|post|publish|purchase|put|register|reject|remove|rename|replace|reply|reset|revoke|run|schedule|send|set|share|start|stop|submit|subscribe|trigger|unassign|unlink|unsubscribe|update|upload|upsert|write)(_|$)/i;
const COMPOUND_CONNECTOR_ACTION_PATTERN = /_(and|or|then)_/i;

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalRule = Pick<
  StoredActionApprovalRule,
  "effect" | "matchKind" | "matchValue"
>;

export function isEmailConnectorKind(connectorKind: string): boolean {
  return EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase());
}

export function connectorKindFromToolName(toolName: string, connectorKinds: string[] = []): string {
  const normalizedTool = toolName.toLowerCase();
  const matched = connectorKinds
    .map((kind) => kind.toLowerCase())
    .filter((kind) => normalizedTool === kind || normalizedTool.startsWith(`${kind}_`))
    .sort((left, right) => right.length - left.length)[0];
  if (matched) return matched;
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

/**
 * MCP tools reach us as `mcp__<slug>__<tool>`. A slug may contain `_` and `-`
 * (deriveMcpSlug), so strip lazily up to the first `__`: a slug that itself
 * contains `__` over-asks, never over-allows. Without this the slug stays in the
 * tested string, and a server named `search` or `my_get` silently allows every
 * tool it exposes. Dashes become `_` so `notion-search` hits the same word
 * boundaries as `notion_search`.
 */
function normalizeConnectorToolName(toolName: string): string {
  return toolName.replace(/^mcp__.+?__/, "").replace(/-/g, "_");
}

export function connectorToolRequiresApproval(toolName: string): boolean {
  const name = normalizeConnectorToolName(toolName);
  if (MUTATING_CONNECTOR_PATTERN.test(name)) return true;
  if (COMPOUND_CONNECTOR_ACTION_PATTERN.test(name)) return true;
  return !READ_ONLY_CONNECTOR_PATTERN.test(name);
}

export function toolRequiresApproval(toolName: string, viaConnector: boolean): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (toolRequiresExplicitApproval(toolName)) return true;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName);
  return false;
}

/** Security-boundary changes cannot be auto-reviewed or permanently allowed. */
export function toolRequiresExplicitApproval(toolName: string): boolean {
  return EXPLICIT_APPROVAL_BUILTIN_TOOLS.has(toolName);
}

/**
 * External webhook runs may inspect state unattended, but side effects need the owner unless
 * the woken routine opted out, in which case the normal approval rules apply.
 * `classifiedConsequential` adds a connector call classified from its definition; it never
 * removes what the name already requires.
 */
export function unattendedTriggerToolRequiresApproval(
  run: { trigger: string; requireToolApproval: boolean },
  toolName: string,
  viaConnector: boolean,
  localTool?: { readOnly?: boolean },
  classifiedConsequential = false,
): boolean {
  if (run.trigger !== "webhook" || !run.requireToolApproval) return false;
  return viaConnector
    ? classifiedConsequential || connectorToolRequiresApproval(toolName)
    : !(localTool?.readOnly ?? UNATTENDED_SAFE_BUILTIN_TOOLS.has(toolName));
}

function categoryMatches(
  category: string,
  toolName: string,
  connectorKind: string,
  classifiedConsequential: boolean,
): boolean {
  const normalized = category.toLowerCase();
  const consequential = classifiedConsequential || connectorToolRequiresApproval(toolName);
  if (normalized === "email") {
    if (isEmailConnectorKind(connectorKind)) return consequential;
    return consequential && /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return consequential;
    return consequential && /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

function ruleMatches(
  rule: ActionApprovalRule,
  toolName: string,
  connectorKind: string,
  classifiedConsequential: boolean,
): boolean {
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind, classifiedConsequential);
    default:
      return false;
  }
}

function ruleSpecificity(rule: ActionApprovalRule): number {
  switch (rule.matchKind) {
    case "tool":
      return 3;
    case "connector":
      return 2;
    case "category":
      return 1;
    default:
      return 0;
  }
}

export type ActionApprovalSource = "require_approval" | "always_allow" | "default";

export type ActionApprovalResolved = {
  decision: "ask" | "allow";
  source: ActionApprovalSource;
  matchingRules: ActionApprovalRule[];
};

/**
 * Deterministic rule resolution. Always-allow and require-approval both beat the default.
 * `classifiedConsequential` lets a category also match a call classified as consequential from
 * its definition; a name that already matches keeps matching.
 */
export function resolveActionApprovalDetail(input: {
  toolName: string;
  connectorKind?: string;
  rules: ActionApprovalRule[];
  classifiedConsequential?: boolean;
}): ActionApprovalResolved {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  const matchingRules = input.rules.filter((rule) =>
    ruleMatches(rule, input.toolName, connectorKind, input.classifiedConsequential === true),
  );
  if (matchingRules.length === 0) {
    return { decision: "allow", source: "default", matchingRules };
  }

  const highestSpecificity = Math.max(...matchingRules.map(ruleSpecificity));
  const winners = matchingRules.filter((rule) => ruleSpecificity(rule) === highestSpecificity);
  if (winners.some((rule) => rule.effect === "require_approval")) {
    return { decision: "ask", source: "require_approval", matchingRules };
  }
  return { decision: "allow", source: "always_allow", matchingRules };
}

export function resolveActionApproval(input: {
  toolName: string;
  connectorKind?: string;
  rules: ActionApprovalRule[];
}): "ask" | "allow" {
  return resolveActionApprovalDetail(input).decision;
}

export type AutoReviewJudgeDecision = "pass" | "ask" | "error";

/**
 * Pure combiner for Auto Review after rule resolution.
 * Rules win: require_approval asks, always_allow runs. Only the default path may call a judge.
 * The judge only escalates to ask; it never silent-denies.
 */
export function planActionGate(input: {
  resolved: ActionApprovalResolved;
  consequential: boolean;
  autoReviewEnabled: boolean;
  checkerConfigured: boolean;
}): "ask" | "allow" | "judge" {
  if (input.resolved.decision === "ask") return "ask";
  if (input.resolved.source === "always_allow") return "allow";
  if (
    input.consequential &&
    input.autoReviewEnabled &&
    input.checkerConfigured &&
    input.resolved.source === "default"
  ) {
    return "judge";
  }
  return "allow";
}

/** Map a judge outcome onto ask/allow. Errors fail closed on consequential tools. */
export function applyJudgeDecision(input: {
  decision: AutoReviewJudgeDecision;
  consequential: boolean;
}): "ask" | "allow" {
  if (input.decision === "pass") return "allow";
  if (input.decision === "ask") return "ask";
  return input.consequential ? "ask" : "allow";
}

export function isSecretAskBlock(block: {
  kind: string;
  input?: string;
  approvalEffectId?: string;
}): boolean {
  return block.kind === "ask" && block.input === "secret" && !block.approvalEffectId;
}

export function isApprovalAskBlock(block: {
  kind: string;
  approvalEffectId?: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  if (block.kind !== "ask" || !block.approvalEffectId || !block.actions?.length) return false;
  const actionIds = new Set(block.actions.map((action) => action.id));
  return (
    actionIds.has("allow") &&
    actionIds.has("deny") &&
    [...actionIds].every((id) => id === "allow" || id === "always" || id === "deny")
  );
}
