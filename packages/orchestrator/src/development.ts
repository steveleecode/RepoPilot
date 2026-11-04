import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  LocalCommandExecutor,
  type CommandDefinition,
  type CommandExecutionResult
} from "@repopilot/executor";
import { authorizeGitAction, type ExecutionPolicy, type ValidationCheck } from "@repopilot/policy";
import { type OllamaConfig } from "@repopilot/provider/ollama";
import { independentReviewSchema, type IndependentReview } from "@repopilot/provider/review";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";
import { parsePlanningIntent, type PlanningIntent } from "./index.js";

const relativePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((part) => part === ".." || part === "")
  );
const changeSchema = z.strictObject({
  action: z.enum(["create", "modify", "delete"]),
  path: relativePath,
  content: z.string().max(100_000).optional(),
  evidencePaths: z.array(relativePath).max(20),
  taskId: z.string().min(1),
  baseHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
});
export const changeProposalSchema = z.strictObject({
  summary: z.string().min(1).max(5_000),
  taskId: z.string().min(1),
  contextManifest: z
    .array(
      z.strictObject({
        path: relativePath,
        hash: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        reason: z.string().min(1),
        evidence: z.string().min(1)
      })
    )
    .max(12),
  changes: z.array(changeSchema).min(1).max(20),
  commandIntents: z
    .array(z.strictObject({ commandId: z.string(), arguments: z.array(z.string()) }))
    .max(10)
});
export type ChangeProposal = z.infer<typeof changeProposalSchema>;

function planned(run: RunSnapshot): PlanningIntent {
  const artifact = run.artifacts.find((item) => item.metadata?.type === "planning-intent");
  if (!artifact) throw new Error("Run has no validated planning artifact.");
  return parsePlanningIntent(artifact.metadata?.plan);
}

function scopeContains(file: string, scopes: string[]): boolean {
  return scopes.some((scope) => scope === "." || file === scope || file.startsWith(`${scope}/`));
}

export function validateChangeProposal(raw: unknown, plan: PlanningIntent): ChangeProposal {
  const proposal = changeProposalSchema.parse(raw);
  const task = plan.tasks.find((item) => item.id === proposal.taskId);
  if (!task) throw new Error("Proposal references an unknown planned task.");
  if (task.writeSet.length === 0) throw new Error("Planned task declares no write scope.");
  const seen = new Set<string>();
  const evidence = new Map(proposal.contextManifest.map((item) => [item.path, item.hash]));
  for (const change of proposal.changes) {
    if (change.taskId !== task.id || !scopeContains(change.path, task.writeSet))
      throw new Error("Proposal exceeds planned task scope.");
    if (
      change.path
        .split("/")
        .some((part) => [".git", ".repopilot", "node_modules"].includes(part)) ||
      /(^\.env($|\.)|\.pem$|\.key$|credentials|secret|token)/iu.test(change.path)
    )
      throw new Error("Proposal targets a protected path.");
    if (seen.has(change.path)) throw new Error("Proposal has duplicate paths.");
    seen.add(change.path);
    if (change.action === "create" && change.baseHash !== null)
      throw new Error("Create change has a base hash.");
    if (change.action !== "create" && change.baseHash === null)
      throw new Error("Existing-file change lacks a base hash.");
    if (change.action !== "create" && evidence.get(change.path) !== change.baseHash)
      throw new Error("Change base hash disagrees with context manifest.");
    if (change.action === "delete" ? change.content !== undefined : change.content === undefined)
      throw new Error("Change content does not match action.");
    if (change.evidencePaths.some((item) => !evidence.has(item)))
      throw new Error("Proposal cites unknown evidence.");
    if (change.action !== "create" && change.evidencePaths.length === 0)
      throw new Error("Existing-file changes require source evidence.");
  }
  if (proposal.commandIntents.length !== 0)
    throw new Error("Model command intents are not authorized in this milestone.");
  return proposal;
}

export function artifactOf(run: RunSnapshot, type: string) {
  return [...run.artifacts].reverse().find((item) => item.metadata?.type === type);
}

export async function proposeChanges(input: {
  store: WorkflowStore;
  runId: string;
  ollama?: OllamaConfig;
  taskId?: string;
  files?: string[];
  policy?: ExecutionPolicy;
  repair?: boolean;
}): Promise<ChangeProposal> {
  const run = await input.store.loadRun(input.runId);
  if (run.status !== "completed")
    throw new Error("Planning run must complete before proposing changes.");
  if (run.provider !== "ollama" && run.provider !== "codex")
    throw new Error("Change generation requires Ollama or Codex.");
  if (run.provider === "ollama" && !input.ollama) throw new Error("Ollama is not configured.");
  const previousProposal = artifactOf(run, "change-proposal");
  let contextRoot = run.repositoryRoot;
  let objective = run.objective;
  if (input.repair) {
    if (!previousProposal) throw new Error("Repair requires a previous proposal.");
    const validation = artifactOf(run, "development-validation");
    if (!validation || validation.metadata?.passed !== false)
      throw new Error("Repair requires failed validation.");
    const attempts =
      run.artifacts.filter((item) => item.metadata?.type === "change-proposal").length - 1;
    if (attempts >= (input.policy?.failure_handling.retry_limit ?? 0))
      throw new Error("Policy repair retry limit reached.");
    const applied = artifactOf(run, "change-applied");
    if (!applied || typeof applied.metadata?.worktree !== "string")
      throw new Error("Repair requires an applied worktree.");
    if (validation.metadata?.proposalArtifactId !== applied.metadata?.proposalArtifactId)
      throw new Error("Repair state is stale.");
    contextRoot = await realpath(applied.metadata.worktree);
    const checks = Array.isArray(validation.metadata?.checks) ? validation.metadata.checks : [];
    const diagnostics = checks.map((item) => {
      const parsed = z
        .object({
          commandId: z.string(),
          status: z.string(),
          exitCode: z.number().nullable(),
          stderr: z.string().optional(),
          stdout: z.string().optional()
        })
        .parse(item);
      return {
        commandId: parsed.commandId,
        status: parsed.status,
        exitCode: parsed.exitCode,
        diagnostics: redactDiagnostics(`${parsed.stderr ?? ""}\n${parsed.stdout ?? ""}`).slice(
          0,
          2_000
        )
      };
    });
    objective = `${run.objective}\nRepair the failed validation without expanding task scope. Diagnostics: ${JSON.stringify(diagnostics).slice(0, 8_000)}`;
  } else if (previousProposal) {
    throw new Error(
      "Run already has a proposal; use repair after failed validation or start a new run."
    );
  }
  const plan = planned(run);
  const task = input.taskId
    ? plan.tasks.find((item) => item.id === input.taskId)
    : plan.tasks.find((item) => item.writeSet.length > 0);
  if (!task || task.writeSet.length === 0)
    throw new Error("Select a planned task with a write scope.");
  if (
    input.repair &&
    previousProposal?.metadata?.proposal &&
    changeProposalSchema.parse(previousProposal.metadata.proposal).taskId !== task.id
  ) {
    throw new Error("Repair cannot switch planned tasks.");
  }
  if (objective.length > 4_000) objective = objective.slice(0, 4_000);
  const payload = {
    repositoryRoot: contextRoot,
    objective,
    taskId: task.id,
    taskObjective: task.objective,
    completionCriteria: task.completionCriteria,
    readSet: task.readSet,
    writeSet: task.writeSet,
    files: input.files ?? [],
    ...(run.provider === "codex" ? { codex: true } : { ollama: input.ollama })
  };
  const bundledBroker = new URL("./change-broker.mjs", import.meta.url);
  const broker = existsSync(fileURLToPath(bundledBroker))
    ? bundledBroker
    : new URL("../../provider/dist/change-broker.js", import.meta.url);
  const raw = await runJsonProcess(
    process.execPath,
    [fileURLToPath(broker)],
    run.repositoryRoot,
    JSON.stringify(payload),
    (input.ollama?.timeoutMs ?? 180_000) + 5_000
  );
  const proposal = validateChangeProposal(raw, plan);
  await input.store.recordArtifact(run.id, {
    kind: "proposal",
    summary: proposal.summary,
    metadata: { type: "context-manifest", taskId: task.id, files: proposal.contextManifest }
  });
  await input.store.recordArtifact(run.id, {
    kind: "proposal",
    summary: proposal.summary,
    metadata: { type: "change-proposal", proposal }
  });
  return proposal;
}

export function redactDiagnostics(value: string): string {
  return value.replace(/((?:password|token|api[_-]?key|secret)\s*[:=]\s*)\S+/giu, "$1[REDACTED]");
}

function runJsonProcess(
  executable: string,
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number
): unknown {
  const result = spawnSync(executable, args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    shell: false,
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 250_000
  });
  if (result.error || result.status !== 0)
    throw new Error(result.stderr?.trim() || result.error?.message || "Context broker failed.");
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Context broker returned invalid JSON.");
  }
}

function git(root: string, args: string[]): string {
  const result = runTextProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    root
  );
  if (result.code !== 0)
    throw new Error(`Git operation failed: ${result.stderr.trim() || result.code}`);
  return result.stdout.trim();
}

function runTextProcess(
  executable: string,
  args: string[],
  cwd: string
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(executable, args, {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
    shell: false,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 50_000
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function safeTarget(root: string, relative: string): Promise<string> {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Change target leaves worktree.");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error("Change target traverses a symlink.");
  }
  return resolved;
}

export async function applyChanges(input: {
  store: WorkflowStore;
  runId: string;
  policy: ExecutionPolicy;
  approval?: boolean;
}): Promise<string> {
  const run = await input.store.loadRun(input.runId);
  const raw = artifactOf(run, "change-proposal")?.metadata?.proposal;
  if (!raw) throw new Error("Run has no change proposal.");
  const proposal = validateChangeProposal(raw, planned(run));
  const proposalArtifact = artifactOf(run, "change-proposal");
  if (!proposalArtifact) throw new Error("Proposal artifact disappeared.");
  const priorApply = artifactOf(run, "change-applied");
  if (priorApply?.metadata?.proposalArtifactId === proposalArtifact.id)
    throw new Error("Proposal was already applied.");
  const authorization = authorizeGitAction(input.policy, {
    action: "apply",
    ...(input.approval ? { approval: { approved: true, approver: "CLI user" } } : {})
  });
  if (!authorization.allowed) throw new Error(authorization.reasons.join(" "));
  const root = await realpath(run.repositoryRoot);
  if (git(root, ["rev-parse", "--show-toplevel"]) !== root)
    throw new Error("Repository root must be the Git top level.");
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  if (priorApply && priorApply.metadata?.baseCommit !== baseCommit)
    throw new Error("Repository base changed since apply; inspect the preserved worktree.");
  const worktree =
    typeof priorApply?.metadata?.worktree === "string"
      ? priorApply.metadata.worktree
      : path.join(
          tmpdir(),
          "repopilot-worktrees",
          createHash("sha256").update(root).digest("hex").slice(0, 16),
          run.id
        );
  if (!priorApply) {
    await mkdir(path.dirname(worktree), { recursive: true });
    git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  }
  const resolvedWorktree = await realpath(worktree);
  try {
    for (const change of proposal.changes) {
      const target = await safeTarget(resolvedWorktree, change.path);
      const stat = await lstat(target).catch(() => undefined);
      if (change.action === "create" && stat)
        throw new Error(`Create target already exists: ${change.path}`);
      if (
        change.action !== "create" &&
        (!stat?.isFile() || (await hashFile(target)) !== change.baseHash)
      )
        throw new Error(`Stale or missing base file: ${change.path}`);
    }
    for (const change of proposal.changes) {
      const target = await safeTarget(resolvedWorktree, change.path);
      if (change.action === "delete") await unlink(target);
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, change.content ?? "", {
          flag: change.action === "create" ? "wx" : "w"
        });
      }
    }
    const diff = git(resolvedWorktree, ["diff", "--no-ext-diff", "--no-textconv", "--stat"]);
    await input.store.recordArtifact(run.id, {
      kind: "diff",
      summary: diff || `${proposal.changes.length} file changes applied.`,
      metadata: {
        type: "change-applied",
        proposalArtifactId: proposalArtifact.id,
        worktree: resolvedWorktree,
        baseCommit,
        fingerprint: await developmentFingerprint(resolvedWorktree),
        changes: proposal.changes.map((item) => ({ action: item.action, path: item.path }))
      }
    });
    return resolvedWorktree;
  } catch (error) {
    await input.store.recordArtifact(run.id, {
      kind: "report",
      summary: error instanceof Error ? error.message : "Apply failed.",
      metadata: { type: "apply-failure", worktree }
    });
    throw error;
  }
}

// Hash streams without interpreting or retaining target source in this process.
export async function developmentFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256").update(git(root, ["rev-parse", "HEAD"]));
  const tracked = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    "HEAD"
  ]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = [...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean))].sort();
  if (files.length > 2_000) throw new Error("Worktree fingerprint exceeds the file limit.");
  let bytes = 0;
  for (const file of files) {
    const target = await safeTarget(root, file);
    const stat = await lstat(target).catch(() => undefined);
    if (stat && !stat.isFile())
      throw new Error("Worktree fingerprint encountered a non-file change.");
    bytes += stat?.size ?? 0;
    if (bytes > 50_000_000) throw new Error("Worktree fingerprint exceeds the byte limit.");
    hash.update(JSON.stringify([file, stat?.mode ?? null, stat ? await hashFile(target) : null]));
  }
  // Include staged/index metadata as well as working-tree content.
  hash.update(git(root, ["diff", "--no-ext-diff", "--no-textconv", "--raw", "HEAD"]));
  hash.update(git(root, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--raw"]));
  return hash.digest("hex");
}

export async function assertAppliedState(run: RunSnapshot): Promise<string> {
  const applied = artifactOf(run, "change-applied");
  const proposal = artifactOf(run, "change-proposal");
  if (!applied || !proposal || applied.metadata?.proposalArtifactId !== proposal.id)
    throw new Error("Applied proposal is stale or missing.");
  const metadata = z
    .object({ worktree: z.string(), baseCommit: z.string(), fingerprint: z.string() })
    .parse(applied.metadata);
  const worktree = await realpath(metadata.worktree);
  const root = await realpath(run.repositoryRoot);
  if (
    git(root, ["rev-parse", "HEAD"]) !== metadata.baseCommit ||
    git(worktree, ["rev-parse", "HEAD"]) !== metadata.baseCommit ||
    git(worktree, ["rev-parse", "--show-toplevel"]) !== worktree ||
    (await realpath(path.resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"])))) !==
      (await realpath(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]))))
  ) {
    throw new Error("Repository or worktree base changed; inspect before resuming.");
  }
  if ((await developmentFingerprint(worktree)) !== metadata.fingerprint)
    throw new Error("Worktree contents changed since apply; previous checks and review are stale.");
  return worktree;
}

export function appliedChangeSet(
  worktree: string
): { path: string; action: "create" | "modify" | "delete" }[] {
  const entries = git(worktree, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-status",
    "-z",
    "HEAD"
  ]).split("\0");
  const changes: { path: string; action: "create" | "modify" | "delete" }[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const status = entries[index];
    changes.push({
      path: entries[index + 1]!,
      action: status === "D" ? "delete" : status === "A" ? "create" : "modify"
    });
  }
  for (const file of git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)) {
    changes.push({ path: file, action: "create" });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export async function reviewAppliedChanges(input: {
  store: WorkflowStore;
  runId: string;
  criteria: { id: string; description: string }[];
  ollama?: OllamaConfig;
}): Promise<IndependentReview> {
  const run = await input.store.loadRun(input.runId);
  const worktree = await assertAppliedState(run);
  const applied = artifactOf(run, "change-applied")!;
  const validation = artifactOf(run, "development-validation");
  if (
    validation?.metadata?.proposalArtifactId !== applied.metadata?.proposalArtifactId ||
    validation?.metadata?.passed !== true ||
    validation.metadata.fingerprint !== applied.metadata?.fingerprint
  )
    throw new Error("Independent review requires fresh passing validation.");
  const proposal = changeProposalSchema.parse(
    artifactOf(run, "change-proposal")?.metadata?.proposal
  );
  const task = planned(run).tasks.find((item) => item.id === proposal.taskId)!;
  const changes = appliedChangeSet(worktree);
  if (!changes.length || changes.some((change) => !scopeContains(change.path, task.writeSet)))
    throw new Error("Independent review requires scoped final worktree changes.");
  if (run.provider !== "codex" && (run.provider !== "ollama" || !input.ollama))
    throw new Error("Independent review requires Codex or configured Ollama.");
  const bundled = new URL("./review-broker.mjs", import.meta.url);
  const broker = existsSync(fileURLToPath(bundled))
    ? bundled
    : new URL("../../provider/dist/review-broker.js", import.meta.url);
  const review = independentReviewSchema.parse(
    runJsonProcess(
      process.execPath,
      [fileURLToPath(broker)],
      run.repositoryRoot,
      JSON.stringify({
        repositoryRoot: worktree,
        baseCommit: applied.metadata?.baseCommit,
        objective: run.objective.slice(0, 4_000),
        scopes: [...task.readSet, ...task.writeSet],
        changes,
        criteria: input.criteria,
        ...(run.provider === "codex" ? { codex: true } : { ollama: input.ollama })
      }),
      (input.ollama?.timeoutMs ?? 180_000) + 5_000
    )
  );
  await assertAppliedState(await input.store.loadRun(run.id));
  await input.store.recordArtifact(run.id, {
    kind: "report",
    summary: review.summary,
    metadata: {
      type: "independent-review",
      proposalArtifactId: applied.metadata?.proposalArtifactId,
      fingerprint: applied.metadata?.fingerprint,
      changes,
      review
    }
  });
  return review;
}

export const validationCommands: Partial<Record<ValidationCheck, CommandDefinition>> = {
  format: {
    id: "format",
    executable: "pnpm",
    fixedArguments: ["exec", "prettier", "--check", "."]
  },
  lint: { id: "lint", executable: "pnpm", fixedArguments: ["exec", "eslint", "."] },
  typecheck: { id: "typecheck", executable: "pnpm", fixedArguments: ["exec", "tsc", "--noEmit"] },
  relevant_tests: {
    id: "relevant_tests",
    executable: "pnpm",
    fixedArguments: ["exec", "vitest", "run"]
  },
  unit_tests: { id: "unit_tests", executable: "pnpm", fixedArguments: ["exec", "vitest", "run"] },
  build: { id: "build", executable: "pnpm", fixedArguments: ["run", "build"] },
  full_check: { id: "full_check", executable: "pnpm", fixedArguments: ["run", "check"] }
};

export async function validateAppliedChanges(input: {
  store: WorkflowStore;
  runId: string;
  policy: ExecutionPolicy;
  executeChecks: boolean;
}): Promise<{ passed: boolean; results: CommandExecutionResult[] }> {
  const run = await input.store.loadRun(input.runId);
  const applied = artifactOf(run, "change-applied");
  if (!applied || typeof applied.metadata?.worktree !== "string")
    throw new Error("Run has no applied worktree.");
  if (!input.executeChecks)
    throw new Error("Validation runs target tooling; pass --execute-checks to approve it.");
  const latestValidation = artifactOf(run, "development-validation");
  if (latestValidation?.metadata?.proposalArtifactId === applied.metadata?.proposalArtifactId)
    throw new Error("Validation already recorded for this proposal.");
  const worktree = await realpath(applied.metadata.worktree);
  const fingerprint = await developmentFingerprint(worktree);
  const checks = [...new Set(input.policy.validation.before_commit)];
  if (
    checks.length > 0 &&
    !(await lstat(path.join(worktree, "node_modules")).catch(() => undefined))
  ) {
    throw new Error(
      "Validation worktree has no node_modules. Install dependencies there manually before verify."
    );
  }
  const executor = new LocalCommandExecutor({
    repositoryRoot: worktree,
    commands: [
      { id: "diff-check", executable: "git", fixedArguments: ["diff", "--check"] },
      ...checks
        .map((check) => validationCommands[check])
        .filter((item): item is CommandDefinition => !!item)
    ],
    environment: { PATH: process.env.PATH ?? "", CI: "true" },
    allowedEnvironmentVariables: ["PATH", "CI"],
    defaultTimeoutMs: 180_000,
    defaultMaxOutputBytes: 16_384
  });
  const results: CommandExecutionResult[] = [];
  for (const id of ["diff-check", ...checks]) {
    const result = await executor.execute({ commandId: id });
    results.push(result);
    if (result.status !== "completed" && input.policy.validation.stop_on_failure) break;
  }
  const unchanged = (await developmentFingerprint(worktree)) === fingerprint;
  const passed =
    unchanged &&
    results.length === checks.length + 1 &&
    results.every((item) => item.status === "completed");
  await input.store.recordArtifact(run.id, {
    kind: "report",
    summary: passed ? "Development validation passed." : "Development validation failed.",
    metadata: {
      type: "development-validation",
      proposalArtifactId: applied.metadata?.proposalArtifactId,
      worktree,
      passed,
      fingerprint,
      worktreeUnchanged: unchanged,
      checks: results.map(({ commandId, status, exitCode, durationMs, stdout, stderr }) => ({
        commandId,
        status,
        exitCode,
        durationMs,
        stdout: redactDiagnostics(stdout),
        stderr: redactDiagnostics(stderr)
      }))
    }
  });
  return { passed, results };
}

export function getDevelopmentArtifacts(run: RunSnapshot) {
  return {
    deliveryRequest: artifactOf(run, "delivery-request"),
    deliveryMessage: artifactOf(run, "delivery-message"),
    deliveryReport: artifactOf(run, "delivery-report"),
    plan: artifactOf(run, "planning-intent"),
    proposal: artifactOf(run, "change-proposal"),
    applied: artifactOf(run, "change-applied"),
    validation: artifactOf(run, "development-validation"),
    review: artifactOf(run, "independent-review"),
    completion: artifactOf(run, "task-completion"),
    commit: artifactOf(run, "development-commit"),
    push: artifactOf(run, "development-push"),
    pushIntent: artifactOf(run, "development-push-intent"),
    pushValidation: artifactOf(run, "push-validation")
  };
}
