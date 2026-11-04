import { z } from "zod";
import { type RunSnapshot } from "@repopilot/workflow";
import { artifactOf, appliedChangeSet, assertAppliedState } from "./development.js";
import { commitDevelopmentTask } from "./git-lifecycle.js";
import { pushDevelopmentTask } from "./push-lifecycle.js";
import {
  VerifiedTaskRunner,
  getTaskCompletionReport,
  withTaskLock,
  type TaskCompletionReport,
  type TaskRunnerOptions
} from "./task-runner.js";

export const deliveryRequestSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("review") }),
  z
    .strictObject({
      mode: z.enum(["commit", "push"]),
      message: z.string().min(1).max(500).optional(),
      messageProvider: z.enum(["codex", "gemini", "groq"]).optional()
    })
    .refine(
      (value) => Boolean(value.message) !== Boolean(value.messageProvider),
      "Select one commit message source."
    )
]);
export type DeliveryRequest = z.infer<typeof deliveryRequestSchema>;
export interface DeliveryReport {
  mode: DeliveryRequest["mode"];
  status: "waiting" | "blocked" | "completed";
  stage: string;
  summary: string;
  reason?: string;
  nextCommand?: string;
}
export interface CommitMessageContext {
  objective: string;
  summary: string;
  changes: { path: string; action: string }[];
  checks: { commandId: string; status: string }[];
}
export function validateCommitMessage(value: unknown): string {
  const message = z.string().max(500).parse(value);
  if (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(message) ||
    !/^[a-z]+(?:\([^()\r\n]+\))?!?: \S[^\r\n]*$/u.test(message)
  )
    throw new Error(
      "Commit message must be a single-line conventional commit of at most 500 characters."
    );
  return message;
}
export function getDeliveryRequest(run: RunSnapshot): DeliveryRequest | undefined {
  const artifact = artifactOf(run, "delivery-request");
  return artifact ? deliveryRequestSchema.parse(artifact.metadata?.request) : undefined;
}
export function getDeliveryReport(run: RunSnapshot): DeliveryReport | undefined {
  return artifactOf(run, "delivery-report")?.metadata?.report as DeliveryReport | undefined;
}
export function isDevelopmentUnfinished(run: RunSnapshot): boolean {
  if (run.status === "cancelled" || !artifactOf(run, "task-runner-request")) return false;
  const request = getDeliveryRequest(run);
  if (request && request.mode !== "review") return getDeliveryReport(run)?.status !== "completed";
  return (
    (!artifactOf(run, "development-commit") &&
      artifactOf(run, "task-completion")?.metadata?.report !== undefined &&
      (artifactOf(run, "task-completion")?.metadata?.report as TaskCompletionReport).status !==
        "review_ready") ||
    (!artifactOf(run, "task-completion") && !artifactOf(run, "development-commit"))
  );
}

export async function runDevelopmentWithDelivery(
  options: TaskRunnerOptions & {
    request?: DeliveryRequest;
    generateMessage: (
      provider: "codex" | "gemini" | "groq",
      context: CommitMessageContext
    ) => Promise<string>;
  },
  runId: string
): Promise<{ report: TaskCompletionReport; delivery: DeliveryReport }> {
  return withTaskLock(
    options.store,
    runId,
    async () => {
      let run = await options.store.loadRun(runId);
      let request = getDeliveryRequest(run);
      if (
        request &&
        options.request &&
        JSON.stringify(request) !== JSON.stringify(deliveryRequestSchema.parse(options.request))
      )
        throw new Error(
          "Delivery settings are immutable for this run. Start a new run to change delivery mode or message source."
        );
      if (!request) {
        request = deliveryRequestSchema.parse(options.request ?? { mode: "review" });
        if (request.mode !== "review" && request.message) validateCommitMessage(request.message);
        await options.store.recordArtifact(runId, {
          kind: "report",
          summary: "Run delivery intent recorded; permissions remain invocation-scoped.",
          metadata: { type: "delivery-request", request }
        });
      }
      const report = await new VerifiedTaskRunner(options).run(runId);
      let stage = "development";
      const finish = async (status: DeliveryReport["status"], summary: string) => {
        const delivery: DeliveryReport = { mode: request.mode, status, stage, summary };
        await options.store.recordArtifact(runId, {
          kind: "report",
          summary,
          metadata: { type: "delivery-report", report: delivery }
        });
        return {
          report: getTaskCompletionReport(await options.store.loadRun(runId)) ?? report,
          delivery
        };
      };
      if (run.status === "cancelled")
        return finish("waiting", "Run was cancelled; automatic Git delivery is disabled.");
      if (report.status !== "review_ready" && report.status !== "committed")
        return finish(
          "waiting",
          "Development has not reached the validated, independently reviewed delivery gate."
        );
      if (request.mode === "review")
        return finish(
          "completed",
          "Review-only run complete; automatic Git delivery was not requested."
        );
      const previousDelivery = getDeliveryReport(run);
      if (previousDelivery?.status === "completed" && report.status === "committed") {
        stage = previousDelivery.stage;
        return finish(
          "completed",
          "Local committed state rechecked; delivery completion is last recorded and the remote was not rechecked."
        );
      }
      try {
        run = await options.store.loadRun(runId);
        let message = artifactOf(run, "delivery-message")?.metadata?.message;
        if (!message) {
          stage = "message";
          const proposal = artifactOf(run, "change-proposal");
          message =
            request.message ??
            (await options.generateMessage(
              request.messageProvider!,
              await getReviewedCommitMessageContext(run)
            ));
          message = validateCommitMessage(message);
          await options.store.recordArtifact(runId, {
            kind: "report",
            summary: "Validated commit message recorded.",
            metadata: {
              type: "delivery-message",
              message,
              provider: request.messageProvider ?? "explicit",
              proposalArtifactId: proposal?.id,
              fingerprint: artifactOf(run, "change-applied")?.metadata?.fingerprint
            }
          });
        }
        run = await options.store.loadRun(runId);
        if (run.status === "cancelled") throw new Error("Run cancelled; inspect before delivery.");
        const messageArtifact = artifactOf(run, "delivery-message");
        if (
          messageArtifact?.metadata?.proposalArtifactId !==
            artifactOf(run, "change-proposal")?.id ||
          messageArtifact?.metadata?.fingerprint !==
            artifactOf(run, "change-applied")?.metadata?.fingerprint
        )
          throw new Error("Recorded message is stale; inspect delivery evidence.");
        stage = "committing";
        options.onStage?.(stage);
        await commitDevelopmentTask({
          store: options.store,
          runId,
          message: validateCommitMessage(message),
          approval: options.approve ?? false
        });
        if (request.mode === "push") {
          if ((await options.store.loadRun(runId)).status === "cancelled")
            throw new Error("Run cancelled; inspect before publishing.");
          stage = "pushing";
          options.onStage?.(stage);
          await pushDevelopmentTask({
            store: options.store,
            runId,
            approval: options.approve ?? false,
            executeChecks: options.executeChecks ?? false
          });
        }
        stage = request.mode === "push" ? "pushed" : "committed";
        const finalReport = await new VerifiedTaskRunner(options).run(runId);
        if (finalReport.status !== "committed")
          throw new Error("Final committed state requires inspection.");
        const delivery: DeliveryReport = {
          mode: request.mode,
          status: "completed",
          stage,
          summary:
            request.mode === "push"
              ? "Recorded reviewed commit published to its authorized branch."
              : "Reviewed changes committed locally; no push requested."
        };
        await options.store.recordArtifact(runId, {
          kind: "report",
          summary: delivery.summary,
          metadata: { type: "delivery-report", report: delivery }
        });
        return { report: finalReport, delivery };
      } catch (error) {
        // Transport/provider diagnostics can contain credentials or source. Detailed safe evidence lives in the existing operation artifacts.
        const message = error instanceof Error ? error.message : "";
        const reason = message.includes("requires human approval")
          ? "approval_required"
          : message.includes("node_modules")
            ? "dependencies_missing"
            : message.includes("--execute-checks")
              ? "check_authorization_required"
              : message.startsWith("Groq key missing")
                ? "groq_key_missing"
                : message.startsWith("Gemini key missing")
                  ? "gemini_key_missing"
                  : message.includes("disabled by policy") || message.includes("strategy")
                    ? "policy_denied"
                    : stage === "message"
                      ? "message_generation_failed"
                      : "inspection_required";
        const guidance: Record<string, string> = {
          approval_required: "Resume with --approve if you authorize the requested Git action.",
          check_authorization_required:
            "Inspect the worktree, then resume with --execute-checks to authorize required checks.",
          dependencies_missing:
            "Install dependencies manually in the recorded worktree before resuming with --execute-checks.",
          groq_key_missing: "Configure Groq with repopilot config groq, then resume.",
          gemini_key_missing: "Configure Gemini with repopilot config gemini, then resume.",
          policy_denied:
            "Inspect repository policy: the selected delivery mode does not enable permissions or change supported strategies.",
          message_generation_failed:
            "Check the selected provider configuration and message output, then resume; no commit was made by this delivery attempt.",
          inspection_required:
            "Inspect current policy, validation and Git operation artifacts before retrying. Interrupted commit/push intents may require manual inspection."
        };
        const delivery: DeliveryReport = {
          mode: request.mode,
          status: "blocked",
          stage,
          reason,
          summary: `Automatic delivery stopped. ${guidance[reason]} The worktree and completed local commits are preserved.`,
          nextCommand: `repopilot resume ${runId} --develop --repo '${run.repositoryRoot.replaceAll("'", "'\\''")}'${reason === "approval_required" ? " --approve" : reason === "check_authorization_required" || reason === "dependencies_missing" ? " --execute-checks" : ""}`
        };
        await options.store.recordArtifact(runId, {
          kind: "report",
          summary: delivery.summary,
          metadata: { type: "delivery-report", report: delivery }
        });
        return {
          report: getTaskCompletionReport(await options.store.loadRun(runId)) ?? report,
          delivery
        };
      }
    },
    "delivery-locks"
  );
}

/** Metadata for every final path; never silently omit repairs or large change sets. */
export async function getReviewedCommitMessageContext(
  run: RunSnapshot
): Promise<CommitMessageContext> {
  if (run.status === "cancelled" || getTaskCompletionReport(run)?.status !== "review_ready")
    throw new Error("Message generation requires a review_ready development report.");
  const worktree = await assertAppliedState(run);
  const applied = artifactOf(run, "change-applied");
  const proposal = artifactOf(run, "change-proposal");
  const validation = artifactOf(run, "development-validation");
  const review = artifactOf(run, "independent-review");
  const changes = appliedChangeSet(worktree);
  if (
    !applied ||
    !proposal ||
    !validation ||
    validation.metadata?.passed !== true ||
    !review ||
    validation.metadata?.proposalArtifactId !== proposal.id ||
    review.metadata?.proposalArtifactId !== proposal.id ||
    validation.metadata?.fingerprint !== applied.metadata?.fingerprint ||
    review.metadata?.fingerprint !== applied.metadata?.fingerprint ||
    JSON.stringify(review.metadata?.changes) !== JSON.stringify(changes)
  )
    throw new Error(
      "Message generation requires fresh validation and review of every changed path."
    );
  return {
    objective: run.objective,
    summary:
      "All scoped changes, including accumulated repairs, passed validation and independent source review. Describe only features supported by this metadata; do not invent implementation details.",
    changes,
    checks: z
      .array(z.object({ commandId: z.string(), status: z.string() }))
      .parse(validation.metadata?.checks)
  };
}
