import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { authorizeGitAction, type ExecutionPolicy } from "@repopilot/policy";
import type { ProviderRegistry } from "@repopilot/provider";
import type { OllamaConfig } from "@repopilot/provider/ollama";
import { independentReviewSchema } from "@repopilot/provider/review";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";
import { parsePlanningIntent, WorkflowEngine } from "./index.js";
import { assertDevelopmentCommit } from "./git-lifecycle.js";
import {
  applyChanges,
  appliedChangeSet,
  artifactOf,
  assertAppliedState,
  changeProposalSchema,
  proposeChanges,
  reviewAppliedChanges,
  validateAppliedChanges
} from "./development.js";

const requestSchema = z.strictObject({
  version: z.literal(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u)
});
export type TaskCompletionStatus =
  | "needs_input"
  | "awaiting_approval"
  | "awaiting_validation_authorization"
  | "needs_attention"
  | "validation_failed"
  | "needs_review"
  | "review_ready"
  | "committed";

export interface TaskCompletionReport {
  version: 1;
  runId: string;
  objective: string;
  status: TaskCompletionStatus;
  stage: string;
  summary: string;
  evidenceFreshness: "checked" | "not_rechecked";
  worktree: string | null;
  proposalArtifactId: string | null;
  acceptanceCriteria: {
    id: string;
    description: string;
    judgment: "supported" | "not_met" | "unverified";
    evidence: { file: string; line: number; description: string }[];
    executableVerification: "not_mapped";
  }[];
  validation: {
    status: "passed" | "failed" | "not_run";
    artifactId: string | null;
    checks: unknown[];
  };
  review: {
    status: "completed" | "not_run";
    artifactId: string | null;
    findings: z.infer<typeof independentReviewSchema>["findings"];
  };
  limitations: string[];
  nextCommand: string | null;
}

export interface TaskRunnerOptions {
  store: WorkflowStore;
  providers: ProviderRegistry;
  policy: ExecutionPolicy;
  ollama?: OllamaConfig;
  approve?: boolean;
  executeChecks?: boolean;
  onStage?: (stage: string) => void;
}

// Injectable operations keep orchestration tests offline while exercising real apply/validation.
export interface TaskRunnerOperations {
  propose: typeof proposeChanges;
  apply: typeof applyChanges;
  validate: typeof validateAppliedChanges;
  review: typeof reviewAppliedChanges;
}
const defaultOperations: TaskRunnerOperations = {
  propose: proposeChanges,
  apply: applyChanges,
  validate: validateAppliedChanges,
  review: reviewAppliedChanges
};
const activeRuns = new Set<string>();

function repositoryHead(root: string): string {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "rev-parse", "HEAD"],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1_024
    }
  );
  if (result.error || result.status !== 0)
    throw new Error("Development tasks require a Git repository with a commit.");
  return result.stdout.trim();
}

export async function initializeDevelopmentTask(
  store: WorkflowStore,
  runId: string
): Promise<void> {
  const run = await store.loadRun(runId);
  if (run.provider !== "codex" && run.provider !== "ollama")
    throw new Error("Development tasks require Codex or Ollama.");
  if (artifactOf(run, "task-runner-request")) return;
  await store.recordArtifact(runId, {
    kind: "report",
    summary: "Supervised development task requested.",
    metadata: {
      type: "task-runner-request",
      request: { version: 1, baseCommit: repositoryHead(run.repositoryRoot) }
    }
  });
}

export function getTaskCompletionReport(run: RunSnapshot): TaskCompletionReport | undefined {
  // This is the last recorded report. Freshness is rechecked by resume --develop.
  const report = artifactOf(run, "task-completion")?.metadata?.report as
    TaskCompletionReport | undefined;
  const commit = artifactOf(run, "development-commit");
  if (report && commit && report.status !== "needs_attention")
    return {
      ...report,
      status: "committed",
      stage: "committed",
      summary: commit.summary,
      nextCommand: null
    };
  return report;
}

export async function withTaskLock<T>(
  store: WorkflowStore,
  runId: string,
  operation: () => Promise<T>,
  lockKind: "task-locks" | "delivery-locks" = "task-locks"
): Promise<T> {
  await store.loadRun(runId); // validates the run ID before using it as a path
  const directory = path.join(store.runsRoot, runId, lockKind);
  if (activeRuns.has(directory)) throw new Error("This development task is already running.");
  activeRuns.add(directory);
  let owned = false;
  const lock = path.join(directory, String(process.pid));
  try {
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Task lock directory must not be a symlink.");
    await writeFile(lock, "active\n", { flag: "wx", mode: 0o600 });
    owned = true;
    // Each contender publishes its own lock before checking others. At least one
    // sees its competitor, so two processes cannot both proceed. Dead-owner files
    // are ignored, not unlinked: recovery cannot delete a newly acquired lock.
    for (const entry of await readdir(directory)) {
      if (entry === String(process.pid) || !/^\d+$/u.test(entry)) continue;
      try {
        process.kill(Number(entry), 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
        throw new Error("Cannot establish exclusive development task ownership.");
      }
      throw new Error("This development task is already running in another process.");
    }
    return await operation();
  } finally {
    if (owned) await unlink(lock);
    activeRuns.delete(directory);
  }
}

export class VerifiedTaskRunner {
  constructor(
    private readonly options: TaskRunnerOptions,
    private readonly operations: TaskRunnerOperations = defaultOperations
  ) {}

  async run(runId: string): Promise<TaskCompletionReport> {
    return withTaskLock(this.options.store, runId, async () => {
      let stage = "recovering";
      const checkpoint = async (next: string) => {
        stage = next;
        this.options.onStage?.(next);
        const run = await this.options.store.loadRun(runId);
        await this.options.store.recordArtifact(runId, {
          kind: "report",
          summary: `Development stage: ${next}.`,
          metadata: {
            type: "task-stage",
            stage: next,
            proposalArtifactId: artifactOf(run, "change-proposal")?.id ?? null
          }
        });
      };
      const finish = (status: TaskCompletionStatus, summary: string) =>
        this.report(runId, status, stage, summary);
      try {
        let run = await this.options.store.loadRun(runId);
        const committed = await assertDevelopmentCommit(run);
        if (committed) {
          stage = "committed";
          return finish(
            "committed",
            `Reviewed changes committed as ${committed.commit} on ${committed.branch}.`
          );
        }
        if (artifactOf(run, "development-commit-intent"))
          throw new Error(
            "Commit was interrupted. Inspect its durable intent and preserved worktree; automatic replay is disabled."
          );
        const request = requestSchema.parse(
          artifactOf(run, "task-runner-request")?.metadata?.request
        );
        if (run.provider !== "codex" && run.provider !== "ollama")
          throw new Error("Development tasks require Codex or Ollama.");
        if (repositoryHead(run.repositoryRoot) !== request.baseCommit)
          throw new Error(
            "Repository HEAD changed since task creation; start a new task after inspection."
          );
        if (run.status === "cancelled")
          return finish("needs_attention", "Planning run was cancelled.");
        if (run.status !== "completed") {
          await checkpoint("planning");
          const outcome = await new WorkflowEngine(this.options).run(runId);
          if (outcome.run.status !== "completed")
            return finish(
              "needs_attention",
              `Planning stopped: ${outcome.run.status}. Inspect the failure artifact and resume when resolved.`
            );
          run = outcome.run;
        }
        const plan = parsePlanningIntent(artifactOf(run, "planning-intent")?.metadata?.plan);
        if (plan.questions.length > 0)
          return finish(
            "needs_input",
            `Resolve planning questions before implementation: ${plan.questions.join(" ")}`
          );
        if (plan.tasks.length !== 1 || plan.tasks[0]!.writeSet.length === 0)
          return finish(
            "needs_input",
            "This increment supports exactly one scoped implementation task. Narrow the objective and start a new run; no planned tasks were silently skipped."
          );
        const task = plan.tasks[0]!;
        let proposalArtifact = artifactOf(run, "change-proposal");
        if (!proposalArtifact) {
          await checkpoint("proposing");
          await this.operations.propose({
            store: this.options.store,
            runId,
            taskId: task.id,
            policy: this.options.policy,
            ...(this.options.ollama ? { ollama: this.options.ollama } : {})
          });
        }
        while (true) {
          run = await this.options.store.loadRun(runId);
          proposalArtifact = artifactOf(run, "change-proposal");
          if (!proposalArtifact) throw new Error("Proposal generation did not record its result.");
          const proposal = changeProposalSchema.parse(proposalArtifact.metadata?.proposal);
          if (proposal.taskId !== task.id)
            throw new Error("Proposal no longer matches the scoped task.");
          stage = "applying";
          const applied = artifactOf(run, "change-applied");
          if (applied?.metadata?.proposalArtifactId !== proposalArtifact.id) {
            const previousStage = artifactOf(run, "task-stage");
            if (
              previousStage?.metadata?.stage === "applying" &&
              previousStage.metadata.proposalArtifactId === proposalArtifact.id
            )
              throw new Error(
                "An apply was interrupted before its result was recorded. Inspect the preserved worktree; automatic replay is unsafe."
              );
            if (artifactOf(run, "apply-failure"))
              throw new Error(
                "An earlier apply failed. Inspect the preserved worktree before starting a new task."
              );
            // When a repair proposal is pending, validate the prior worktree against
            // its last applied proposal rather than against the new proposal ID.
            if (applied)
              await assertAppliedState({
                ...run,
                artifacts: run.artifacts.filter(
                  (artifact) =>
                    artifact.metadata?.type !== "change-proposal" ||
                    artifact.id === applied.metadata?.proposalArtifactId
                )
              });
            const authorization = authorizeGitAction(this.options.policy, {
              action: "apply",
              ...(this.options.approve
                ? { approval: { approved: true, approver: "CLI user" } }
                : {})
            });
            if (!authorization.allowed)
              return finish("awaiting_approval", authorization.reasons.join(" "));
            if (this.options.approve)
              await this.recordApproval(runId, `apply:${proposalArtifact.id}`);
            await checkpoint("applying");
            await this.operations.apply({
              store: this.options.store,
              runId,
              policy: this.options.policy,
              approval: this.options.approve ?? false
            });
          }
          run = await this.options.store.loadRun(runId);
          await assertAppliedState(run);
          stage = "validating";
          let validation = artifactOf(run, "development-validation");
          if (validation?.metadata?.proposalArtifactId !== proposalArtifact.id) {
            if (!this.options.executeChecks)
              return finish(
                "awaiting_validation_authorization",
                "Target checks execute repository code. Resume with --execute-checks after inspecting the worktree and installing its dependencies if needed."
              );
            await this.recordApproval(runId, `execute-validation:${proposalArtifact.id}`);
            await checkpoint("validating");
            await this.operations.validate({
              store: this.options.store,
              runId,
              policy: this.options.policy,
              executeChecks: true
            });
            run = await this.options.store.loadRun(runId);
            await assertAppliedState(run);
            validation = artifactOf(run, "development-validation");
          }
          if (!validation || validation.metadata?.proposalArtifactId !== proposalArtifact.id)
            throw new Error("Validation did not record a result for this proposal.");
          // Current policy is re-evaluated on every invocation. A previous pass
          // cannot satisfy checks added since that invocation.
          const checks = z
            .array(z.object({ commandId: z.string(), status: z.string() }))
            .parse(validation.metadata?.checks);
          const required = ["diff-check", ...this.options.policy.validation.before_commit];
          if (
            validation.metadata?.passed === true &&
            required.some(
              (id) =>
                !checks.some((check) => check.commandId === id && check.status === "completed")
            )
          )
            throw new Error(
              "Validation policy changed; recorded checks do not satisfy current policy. Start a new task after inspection."
            );
          if (validation.metadata?.passed !== true) {
            const attempts =
              run.artifacts.filter((artifact) => artifact.metadata?.type === "change-proposal")
                .length - 1;
            if (
              !this.options.executeChecks ||
              attempts >= this.options.policy.failure_handling.retry_limit
            )
              return finish(
                "validation_failed",
                "Validation failed. Automatic repair is limited by the current retry policy and requires --execute-checks for this invocation."
              );
            await checkpoint("repairing");
            await this.operations.propose({
              store: this.options.store,
              runId,
              taskId: task.id,
              repair: true,
              policy: this.options.policy,
              ...(this.options.ollama ? { ollama: this.options.ollama } : {})
            });
            continue;
          }
          stage = "reviewing";
          let review = artifactOf(run, "independent-review");
          if (
            review?.metadata?.proposalArtifactId !== proposalArtifact.id ||
            review.metadata?.fingerprint !== validation.metadata?.fingerprint ||
            JSON.stringify(review.metadata?.changes) !==
              JSON.stringify(appliedChangeSet(await assertAppliedState(run)))
          ) {
            await checkpoint("reviewing");
            await this.operations.review({
              store: this.options.store,
              runId,
              criteria: task.completionCriteria.map((description, index) => ({
                id: `criterion-${index + 1}`,
                description
              })),
              ...(this.options.ollama ? { ollama: this.options.ollama } : {})
            });
            run = await this.options.store.loadRun(runId);
            await assertAppliedState(run);
            review = artifactOf(run, "independent-review");
          }
          if (!review || review.metadata?.proposalArtifactId !== proposalArtifact.id)
            throw new Error("Independent review did not record its result.");
          const result = independentReviewSchema.parse(review.metadata?.review);
          const expectedCriteria = task.completionCriteria.map(
            (_, index) => `criterion-${index + 1}`
          );
          if (
            result.criteria.length !== expectedCriteria.length ||
            new Set(result.criteria.map((criterion) => criterion.id)).size !==
              expectedCriteria.length ||
            result.criteria.some((criterion) => !expectedCriteria.includes(criterion.id))
          )
            throw new Error("Independent review does not match the recorded acceptance criteria.");
          if (
            result.findings.some((finding) => finding.severity !== "low") ||
            result.criteria.some((criterion) => criterion.status !== "supported")
          )
            return finish(
              "needs_review",
              "Independent review found defects or requirements without sufficient evidence. Findings remain unverified; no speculative repair was applied."
            );
          return finish(
            "review_ready",
            "Required checks passed and independent review supports the acceptance criteria. Ready for human review; production behavior has not been verified."
          );
        }
      } catch (error) {
        // Underlying failures may contain source or secrets. Detailed, bounded
        // validation evidence stays in its own artifact; do not echo raw errors.
        const message =
          error instanceof z.ZodError
            ? "Invalid or incomplete durable task state."
            : error instanceof Error
              ? error.message
                  .replace(
                    /((?:password|token|api[_-]?key|secret)\s*[:=]\s*)\S+/giu,
                    "$1[REDACTED]"
                  )
                  .slice(0, 2_000)
              : "Task runner failed.";
        return finish("needs_attention", message);
      }
    });
  }

  private async recordApproval(runId: string, action: string) {
    const approval = await this.options.store.requestApproval(runId, action);
    await this.options.store.decideApproval(
      runId,
      approval.id,
      true,
      "Explicit CLI authorization for this invocation and proposal."
    );
  }

  private async report(
    runId: string,
    status: TaskCompletionStatus,
    stage: string,
    summary: string
  ): Promise<TaskCompletionReport> {
    const run = await this.options.store.loadRun(runId);
    const planArtifact = artifactOf(run, "planning-intent");
    let plan;
    try {
      plan = planArtifact ? parsePlanningIntent(planArtifact.metadata?.plan) : undefined;
    } catch {
      /* Invalid planning evidence must not prevent recording a failure report. */
    }
    const proposal = artifactOf(run, "change-proposal");
    const applied = artifactOf(run, "change-applied");
    const validationArtifact = artifactOf(run, "development-validation");
    const validation =
      validationArtifact?.metadata?.proposalArtifactId === proposal?.id
        ? validationArtifact
        : undefined;
    const reviewArtifact = artifactOf(run, "independent-review");
    const review =
      reviewArtifact?.metadata?.proposalArtifactId === proposal?.id ? reviewArtifact : undefined;
    const parsedReview = independentReviewSchema.safeParse(review?.metadata?.review);
    const judgment = parsedReview.success ? parsedReview.data : undefined;
    const task = plan?.tasks.length === 1 ? plan.tasks[0] : undefined;
    const quotedRoot = `'${run.repositoryRoot.replaceAll("'", "'\\''")}'`;
    const resume = `repopilot resume ${runId} --develop --repo ${quotedRoot}`;
    const report: TaskCompletionReport = {
      version: 1,
      runId,
      objective: run.objective,
      status,
      stage,
      summary,
      evidenceFreshness: status === "needs_attention" ? "not_rechecked" : "checked",
      worktree: typeof applied?.metadata?.worktree === "string" ? applied.metadata.worktree : null,
      proposalArtifactId: proposal?.id ?? null,
      acceptanceCriteria: (task?.completionCriteria ?? []).map((description, index) => {
        const id = `criterion-${index + 1}`;
        const assessment = judgment?.criteria.find((criterion) => criterion.id === id);
        return {
          id,
          description,
          judgment: assessment?.status ?? "unverified",
          evidence: assessment?.evidence ?? [],
          executableVerification: "not_mapped"
        };
      }),
      validation: {
        status: validation
          ? validation.metadata?.passed === true
            ? "passed"
            : "failed"
          : "not_run",
        artifactId: validation?.id ?? null,
        checks: Array.isArray(validation?.metadata?.checks) ? validation.metadata.checks : []
      },
      review: {
        status: review ? "completed" : "not_run",
        artifactId: review?.id ?? null,
        findings: judgment?.findings ?? []
      },
      limitations: [
        "Acceptance-criterion judgments are source-based review, not individually mapped executable proof.",
        "Production behavior and live integrations have not been verified.",
        "Review findings are not executable reproductions; only failed checks trigger automatic repair.",
        ...(plan?.risks ?? []),
        ...(judgment?.findings
          .filter((finding) => finding.severity === "low")
          .map((finding) => `${finding.file}:${finding.line}: ${finding.description}`) ?? [])
      ],
      nextCommand:
        status === "committed" ||
        status === "review_ready" ||
        status === "needs_input" ||
        status === "needs_review"
          ? null
          : `${resume}${status === "awaiting_approval" ? " --approve" : ""}${status === "awaiting_validation_authorization" || status === "validation_failed" ? " --execute-checks" : ""}`
    };
    await this.options.store.recordArtifact(runId, {
      kind: "report",
      summary,
      metadata: { type: "task-completion", report }
    });
    return report;
  }
}
