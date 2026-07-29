import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { normalizeRelativePath } from "@repopilot/shared";

export const repoPilotConfigPath = ".repopilot/config.yaml";

export const autonomySchema = z.enum(["safe", "balanced", "autonomous", "custom"]);
export const parallelStrategySchema = z.enum([
  "disabled",
  "parallel_analysis",
  "isolated_worktrees",
  "isolated_sandboxes"
]);
export const commitStrategySchema = z.enum([
  "never",
  "after_task",
  "after_feature",
  "after_milestone"
]);
export const pushStrategySchema = z.enum([
  "never",
  "after_feature",
  "after_milestone",
  "on_completion"
]);
export const commitMessageFormatSchema = z.enum([
  "conventional",
  "imperative",
  "repository_inferred",
  "custom_template"
]);
export const validationCheckSchema = z.enum([
  "format",
  "lint",
  "typecheck",
  "relevant_tests",
  "unit_tests",
  "build",
  "full_check"
]);

export const executionPolicySchema = z.object({
  autonomy: autonomySchema,
  parallelism: z.object({
    enabled: z.boolean(),
    max_workers: z.number().int().min(1).max(16),
    strategy: parallelStrategySchema,
    allow_parallel_reads: z.boolean(),
    allow_parallel_writes: z.boolean(),
    require_independent_scopes: z.boolean()
  }),
  commits: z.object({
    enabled: z.boolean(),
    strategy: commitStrategySchema,
    require_clean_validation: z.boolean(),
    allow_checkpoint_commits: z.boolean(),
    message_format: commitMessageFormatSchema,
    sign_commits: z.boolean()
  }),
  pushes: z.object({
    enabled: z.boolean(),
    strategy: pushStrategySchema,
    remote: z.string().min(1),
    allowed_branch_patterns: z.array(z.string().min(1)).min(1),
    prohibited_branches: z.array(z.string().min(1)),
    allow_force_push: z.boolean().default(false)
  }),
  pull_requests: z.object({
    enabled: z.boolean(),
    create_as_draft: z.boolean(),
    require_validation: z.boolean(),
    require_human_approval: z.boolean()
  }),
  validation: z.object({
    before_commit: z.array(validationCheckSchema),
    before_push: z.array(validationCheckSchema),
    before_pull_request: z.array(validationCheckSchema),
    stop_on_failure: z.boolean()
  }),
  approvals: z.object({
    before_apply: z.boolean(),
    before_commit: z.boolean(),
    before_push: z.boolean(),
    before_pull_request: z.boolean(),
    before_destructive_action: z.boolean()
  }),
  failure_handling: z.object({
    preserve_worktree: z.boolean(),
    create_failure_report: z.boolean(),
    allow_partial_commit: z.boolean(),
    retry_limit: z.number().int().min(0).max(10)
  })
});

export const repoPilotConfigSchema = z.object({
  version: z.literal(1),
  execution: executionPolicySchema
});

export type Autonomy = z.infer<typeof autonomySchema>;
export type ParallelStrategy = z.infer<typeof parallelStrategySchema>;
export type CommitStrategy = z.infer<typeof commitStrategySchema>;
export type PushStrategy = z.infer<typeof pushStrategySchema>;
export type ValidationCheck = z.infer<typeof validationCheckSchema>;
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type RepoPilotConfig = z.infer<typeof repoPilotConfigSchema>;

export interface ResolvedPolicy {
  version: 1;
  execution: ExecutionPolicy;
  sources: string[];
  warnings: string[];
}

export type PolicyOverride = PartialDeep<ExecutionPolicy>;

export interface ValidationRecord {
  status: "passed" | "failed" | "missing";
  checks: ValidationCheck[];
  summary: string;
}

export interface ApprovalRecord {
  approved: boolean;
  approver?: string;
  reason?: string;
}

export type GitAction = "apply" | "commit" | "push" | "pull_request" | "destructive_action";

export interface GitActionContext {
  action: GitAction;
  branch?: string;
  remote?: string;
  force?: boolean;
  validation?: ValidationRecord;
  approval?: ApprovalRecord;
  stagedPaths?: string[];
  protectedBranches?: string[];
  defaultBranch?: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reasons: string[];
  requiredApprovals: GitAction[];
}

export interface PolicyTask {
  id: string;
  objective: string;
  expectedScopes: string[];
  dependencies: string[];
  readSet: string[];
  writeSet: string[];
  validationCommands: string[];
  completionCriteria: string[];
}

export interface ParallelizationDecision {
  canRunInParallel: boolean;
  reasons: string[];
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  action:
    | "policy_resolved"
    | "task_parallelized"
    | "worktree_created"
    | "commit_created"
    | "validation_performed"
    | "push_attempted"
    | "pull_request_opened"
    | "approval_decision"
    | "failure_recorded";
  summary: string;
  policy: ExecutionPolicy;
  metadata: Record<string, string | number | boolean | string[]>;
}

export const safePolicy: ExecutionPolicy = {
  autonomy: "safe",
  parallelism: {
    enabled: false,
    max_workers: 1,
    strategy: "disabled",
    allow_parallel_reads: false,
    allow_parallel_writes: false,
    require_independent_scopes: true
  },
  commits: {
    enabled: false,
    strategy: "never",
    require_clean_validation: true,
    allow_checkpoint_commits: false,
    message_format: "conventional",
    sign_commits: false
  },
  pushes: {
    enabled: false,
    strategy: "never",
    remote: "origin",
    allowed_branch_patterns: ["repopilot/**", "agent/**", "codex/**"],
    prohibited_branches: ["main", "master", "production", "release/**"],
    allow_force_push: false
  },
  pull_requests: {
    enabled: false,
    create_as_draft: true,
    require_validation: true,
    require_human_approval: true
  },
  validation: {
    before_commit: ["format", "lint", "typecheck", "relevant_tests"],
    before_push: ["unit_tests", "build"],
    before_pull_request: ["full_check"],
    stop_on_failure: true
  },
  approvals: {
    before_apply: true,
    before_commit: true,
    before_push: true,
    before_pull_request: true,
    before_destructive_action: true
  },
  failure_handling: {
    preserve_worktree: true,
    create_failure_report: true,
    allow_partial_commit: false,
    retry_limit: 0
  }
};

export const balancedPolicy: ExecutionPolicy = mergePolicy(safePolicy, {
  autonomy: "balanced",
  parallelism: {
    enabled: true,
    max_workers: 3,
    strategy: "isolated_worktrees",
    allow_parallel_reads: true,
    allow_parallel_writes: true,
    require_independent_scopes: true
  },
  commits: {
    enabled: true,
    strategy: "after_feature",
    require_clean_validation: true,
    allow_checkpoint_commits: false,
    message_format: "conventional",
    sign_commits: false
  },
  approvals: {
    before_apply: false,
    before_commit: false,
    before_push: true,
    before_pull_request: true,
    before_destructive_action: true
  },
  failure_handling: {
    retry_limit: 2
  }
});

export const autonomousPolicy: ExecutionPolicy = mergePolicy(balancedPolicy, {
  autonomy: "autonomous",
  pushes: {
    enabled: true,
    strategy: "after_feature",
    remote: "origin",
    allowed_branch_patterns: ["repopilot/**", "agent/**", "codex/**"],
    prohibited_branches: ["main", "master", "production", "release/**"],
    allow_force_push: false
  },
  pull_requests: {
    enabled: true,
    create_as_draft: true,
    require_validation: true,
    require_human_approval: false
  },
  approvals: {
    before_apply: false,
    before_commit: false,
    before_push: false,
    before_pull_request: false,
    before_destructive_action: true
  }
});

export function presetPolicy(autonomy: Autonomy): ExecutionPolicy {
  if (autonomy === "safe") return structuredClone(safePolicy);
  if (autonomy === "balanced") return structuredClone(balancedPolicy);
  if (autonomy === "autonomous") return structuredClone(autonomousPolicy);
  return mergePolicy(safePolicy, { autonomy: "custom" });
}

export function defaultConfig(autonomy: Autonomy = "safe"): RepoPilotConfig {
  return { version: 1, execution: presetPolicy(autonomy) };
}

export function parsePolicyConfig(content: string): RepoPilotConfig {
  const raw: unknown = parseYaml(content);
  return repoPilotConfigSchema.parse(raw);
}

export async function loadRepositoryConfig(
  repositoryRoot: string
): Promise<RepoPilotConfig | undefined> {
  try {
    return parsePolicyConfig(
      await readFile(path.join(repositoryRoot, repoPilotConfigPath), "utf8")
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeRepositoryConfig(
  repositoryRoot: string,
  config: RepoPilotConfig = defaultConfig("balanced")
): Promise<string> {
  const parsed = repoPilotConfigSchema.parse(config);
  const targetPath = path.join(repositoryRoot, repoPilotConfigPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(parsed), "utf8");
  return targetPath;
}

export function resolvePolicy(input: {
  selectedPreset?: Autonomy | undefined;
  globalConfig?: RepoPilotConfig | undefined;
  repositoryConfig?: RepoPilotConfig | undefined;
  cliOverrides?: PolicyOverride | undefined;
  temporaryApprovals?: Partial<Record<GitAction, ApprovalRecord>> | undefined;
}): ResolvedPolicy {
  const sources = ["built-in safe defaults"];
  let execution = structuredClone(safePolicy);

  if (input.selectedPreset) {
    execution = mergePolicy(execution, presetPolicy(input.selectedPreset));
    sources.push(`${input.selectedPreset} preset`);
  }

  if (input.globalConfig) {
    execution = mergePolicy(execution, input.globalConfig.execution);
    sources.push("global user configuration");
  }

  if (input.repositoryConfig) {
    execution = mergePolicy(execution, presetPolicy(input.repositoryConfig.execution.autonomy));
    execution = mergePolicy(execution, input.repositoryConfig.execution);
    sources.push(repoPilotConfigPath);
  }

  if (input.cliOverrides) {
    execution = mergePolicy(execution, input.cliOverrides);
    sources.push("explicit command-line flags");
  }

  const warnings = policyWarnings(execution);
  return { version: 1, execution: executionPolicySchema.parse(execution), sources, warnings };
}

export function mergePolicy(base: ExecutionPolicy, override: PolicyOverride): ExecutionPolicy {
  return executionPolicySchema.parse(deepMerge(base, override));
}

export function authorizeGitAction(
  policy: ExecutionPolicy,
  context: GitActionContext
): AuthorizationResult {
  const reasons: string[] = [];
  const requiredApprovals: GitAction[] = [];

  if (requiresApproval(policy, context.action) && !context.approval?.approved) {
    requiredApprovals.push(context.action);
    reasons.push(`${context.action} requires human approval.`);
  }

  if (context.action === "commit") {
    if (!policy.commits.enabled) reasons.push("Automatic commits are disabled by policy.");
    if (policy.commits.require_clean_validation) {
      requireValidation(policy.validation.before_commit, context.validation, reasons, "commit");
    }
  }

  if (context.action === "push") {
    if (!policy.pushes.enabled) reasons.push("Automatic pushes are disabled by policy.");
    if (context.force) reasons.push("Force pushes are disabled by policy.");
    const branch = context.branch ?? "";
    if (!branch) reasons.push("Push destination branch is required.");
    if (branch && !isBranchAllowed(policy, branch, context)) {
      reasons.push(`Branch ${branch} is not permitted for automatic pushes.`);
    }
    if (context.remote && context.remote !== policy.pushes.remote) {
      reasons.push(
        `Remote ${context.remote} does not match configured remote ${policy.pushes.remote}.`
      );
    }
    requireValidation(policy.validation.before_push, context.validation, reasons, "push");
  }

  if (context.action === "pull_request") {
    if (!policy.pull_requests.enabled)
      reasons.push("Automatic pull-request creation is disabled by policy.");
    if (policy.pull_requests.require_validation) {
      requireValidation(
        policy.validation.before_pull_request,
        context.validation,
        reasons,
        "pull request"
      );
    }
  }

  if (context.action === "apply" && policy.approvals.before_apply && !context.approval?.approved) {
    reasons.push("Applying generated files requires human approval.");
  }

  if (
    context.action === "destructive_action" &&
    policy.approvals.before_destructive_action &&
    !context.approval?.approved
  ) {
    reasons.push("Destructive actions always require human approval.");
  }

  return { allowed: reasons.length === 0, reasons, requiredApprovals };
}

export function canParallelizeTasks(
  policy: ExecutionPolicy,
  first: PolicyTask,
  second: PolicyTask
): ParallelizationDecision {
  const reasons: string[] = [];
  if (!policy.parallelism.enabled || policy.parallelism.strategy === "disabled") {
    reasons.push("Parallel execution is disabled by policy.");
  }
  if (first.dependencies.includes(second.id) || second.dependencies.includes(first.id)) {
    reasons.push("One task depends on the other.");
  }
  if (overlaps(first.writeSet, second.writeSet)) {
    reasons.push("Expected write scopes overlap.");
  }
  if (touchesSequentialScope(first) || touchesSequentialScope(second)) {
    reasons.push("At least one task touches a sequential-only scope.");
  }
  const bothReadOnly = first.writeSet.length === 0 && second.writeSet.length === 0;
  if (!bothReadOnly && policy.parallelism.strategy !== "isolated_worktrees") {
    reasons.push("Parallel writes require isolated worktrees.");
  }
  if (!bothReadOnly && !policy.parallelism.allow_parallel_writes) {
    reasons.push("Parallel writes are disabled by policy.");
  }
  if (bothReadOnly && !policy.parallelism.allow_parallel_reads) {
    reasons.push("Parallel reads are disabled by policy.");
  }
  if (
    policy.parallelism.require_independent_scopes &&
    overlaps(first.expectedScopes, second.expectedScopes)
  ) {
    reasons.push("Task scopes are not independent.");
  }
  if (first.validationCommands.length === 0 || second.validationCommands.length === 0) {
    reasons.push("Both tasks must declare independent validation commands.");
  }
  return { canRunInParallel: reasons.length === 0, reasons };
}

export function createAuditRecord(input: {
  action: AuditRecord["action"];
  summary: string;
  policy: ExecutionPolicy;
  metadata?: AuditRecord["metadata"];
  now?: Date;
}): AuditRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: (input.now ?? new Date()).toISOString(),
    action: input.action,
    summary: redactSecrets(input.summary),
    policy: input.policy,
    metadata: redactMetadata(input.metadata ?? {})
  };
}

export function setPolicyValue(
  config: RepoPilotConfig,
  dottedPath: string,
  rawValue: string
): RepoPilotConfig {
  const segments = dottedPath.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("Policy path is required.");
  const next = structuredClone(config) as unknown as Record<string, unknown>;
  const fullPath = segments[0] === "execution" ? segments : ["execution", ...segments];
  let cursor = next;
  for (const segment of fullPath.slice(0, -1)) {
    const value = cursor[segment];
    if (!isRecord(value)) throw new Error(`Unknown policy path: ${dottedPath}`);
    cursor = value;
  }
  cursor[fullPath.at(-1) ?? ""] = parseScalar(rawValue);
  return repoPilotConfigSchema.parse(next);
}

export function formatResolvedPolicy(policy: ResolvedPolicy): string {
  return stringifyYaml({
    version: policy.version,
    sources: policy.sources,
    warnings: policy.warnings,
    execution: policy.execution
  });
}

function requireValidation(
  requiredChecks: ValidationCheck[],
  validation: ValidationRecord | undefined,
  reasons: string[],
  action: string
): void {
  if (!validation) {
    reasons.push(`Validation is required before ${action}.`);
    return;
  }
  if (validation.status !== "passed") {
    reasons.push(`Validation must pass before ${action}.`);
  }
  const missingChecks = requiredChecks.filter((check) => !validation.checks.includes(check));
  if (missingChecks.length > 0) {
    reasons.push(`Validation before ${action} is missing: ${missingChecks.join(", ")}.`);
  }
}

function requiresApproval(policy: ExecutionPolicy, action: GitAction): boolean {
  if (action === "apply") return policy.approvals.before_apply;
  if (action === "commit") return policy.approvals.before_commit;
  if (action === "push") return policy.approvals.before_push;
  if (action === "pull_request") return policy.approvals.before_pull_request;
  return policy.approvals.before_destructive_action;
}

function isBranchAllowed(
  policy: ExecutionPolicy,
  branch: string,
  context: GitActionContext
): boolean {
  const prohibited = new Set([
    ...policy.pushes.prohibited_branches,
    ...(context.protectedBranches ?? []),
    context.defaultBranch ?? ""
  ]);
  if ([...prohibited].filter(Boolean).some((pattern) => branchMatches(pattern, branch)))
    return false;
  return policy.pushes.allowed_branch_patterns.some((pattern) => branchMatches(pattern, branch));
}

function branchMatches(pattern: string, branch: string): boolean {
  let regex = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (character === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(character ?? "");
    }
  }
  return new RegExp(`^${regex}$`, "u").test(branch);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
}

function overlaps(first: string[], second: string[]): boolean {
  const normalizedFirst = first.map(normalizeRelativePath);
  const normalizedSecond = second.map(normalizeRelativePath);
  return normalizedFirst.some((a) =>
    normalizedSecond.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
  );
}

function touchesSequentialScope(task: PolicyTask): boolean {
  const sequentialPatterns = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    ".repopilot/config.yaml",
    "tsconfig.base.json",
    "turbo.json"
  ];
  return task.writeSet.some((filePath) => {
    const normalized = normalizeRelativePath(filePath);
    return sequentialPatterns.some(
      (pattern) => normalized === pattern || normalized.endsWith(".sql")
    );
  });
}

function policyWarnings(policy: ExecutionPolicy): string[] {
  const warnings: string[] = [];
  if (policy.pushes.enabled)
    warnings.push("External Git pushes are enabled for permitted branches.");
  if (policy.pull_requests.enabled) warnings.push("Pull-request automation is enabled.");
  if (policy.commits.enabled && !policy.commits.require_clean_validation) {
    warnings.push("Automatic commits do not require clean validation.");
  }
  return warnings;
}

function deepMerge<T>(base: T, override: PartialDeep<T>): T {
  if (!isRecord(base) || !isRecord(override))
    return override === undefined ? base : (override as T);
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value.includes(",")) return value.split(",").map((item) => item.trim());
  return value;
}

function redactSecrets(value: string): string {
  return value.replace(/(token|secret|password|key)=\S+/giu, "$1=[REDACTED]");
}

function redactMetadata(metadata: AuditRecord["metadata"]): AuditRecord["metadata"] {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      /(token|secret|password|key)/iu.test(key) ? "[REDACTED]" : value
    ])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
    : T[K] extends Record<string, unknown>
      ? PartialDeep<T[K]>
      : T[K];
};
