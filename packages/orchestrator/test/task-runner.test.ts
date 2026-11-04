import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { balancedPolicy } from "@repopilot/policy";
import { ProviderRegistry } from "@repopilot/provider";
import type { IndependentReview } from "@repopilot/provider/review";
import { WorkflowStore } from "@repopilot/workflow";
import { parsePlanningIntent, type PlanningIntent } from "../src/index.js";
import {
  applyChanges,
  artifactOf,
  validateAppliedChanges,
  type ChangeProposal
} from "../src/development.js";
import {
  getTaskCompletionReport,
  initializeDevelopmentTask,
  VerifiedTaskRunner,
  type TaskRunnerOperations
} from "../src/task-runner.js";

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    const listing = git(root, ["worktree", "list", "--porcelain"]);
    for (const line of listing.split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== root)
        await rm(line.slice(9), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});

const basePlan = parsePlanningIntent({
  summary: "Update the greeting.",
  tasks: [
    {
      id: "greeting",
      objective: "Update greeting",
      dependencies: [],
      expectedScopes: ["src"],
      readSet: ["src"],
      writeSet: ["src"],
      validationCommandIds: [],
      completionCriteria: ["Greeting says goodbye"]
    }
  ],
  risks: [],
  questions: []
});
const supportedReview: IndependentReview = {
  summary: "The scoped greeting change is supported by source evidence.",
  findings: [],
  criteria: [
    {
      id: "criterion-1",
      status: "supported",
      evidence: [{ file: "src/greeting.txt", line: 1, description: "The greeting is goodbye." }]
    }
  ]
};

describe("supervised task runner", () => {
  it("quotes repository paths literally in suggested shell commands", async () => {
    const fixture = await setup({ rootPrefix: "repo space ' $(id) `id` $HOME\n" });
    fixture.policy.approvals.before_apply = true;
    const report = await fixture.runner().run(fixture.runId);
    const result = spawnSync("/bin/sh", ["-c", `set -- ${report.nextCommand}; printf '%s' "$6"`], {
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(fixture.root);
  });

  it("pauses for apply approval and validation authorization, then resumes without repeating work", async () => {
    const fixture = await setup();
    fixture.policy.approvals.before_apply = true;
    const first = await fixture.runner().run(fixture.runId);
    expect(first.status).toBe("awaiting_approval");
    expect(first.worktree).toBeNull();
    expect(fixture.operations.apply).not.toHaveBeenCalled();
    const second = await fixture.runner({ approve: true }).run(fixture.runId);
    expect(second.status).toBe("awaiting_validation_authorization");
    expect(fixture.operations.validate).not.toHaveBeenCalled();
    expect(await readFile(path.join(fixture.root, "src/greeting.txt"), "utf8")).toBe("hello\n");
    const third = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(third.status).toBe("review_ready");
    expect(third.acceptanceCriteria[0]).toMatchObject({
      judgment: "supported",
      executableVerification: "not_mapped"
    });
    expect(third.validation.status).toBe("passed");
    expect(third.review.status).toBe("completed");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(1);
    expect(fixture.operations.apply).toHaveBeenCalledTimes(1);
    expect(fixture.operations.validate).toHaveBeenCalledTimes(1);
    const fourth = await fixture.runner().run(fixture.runId);
    expect(fourth.status).toBe("review_ready");
    expect(fixture.operations.review).toHaveBeenCalledTimes(1);
    expect(getTaskCompletionReport(await fixture.store.loadRun(fixture.runId))).toEqual(fourth);
    const approvals = (await fixture.store.loadRun(fixture.runId)).approvals;
    expect(approvals.map((approval) => approval.action)).toEqual([
      expect.stringMatching(/^apply:/),
      expect.stringMatching(/^execute-validation:/)
    ]);
  });

  it("repairs a real failed diff check within the retry budget and revalidates", async () => {
    const fixture = await setup({ firstContent: "goodbye  \n" });
    const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(report.status).toBe("review_ready");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(2);
    expect(fixture.operations.propose).toHaveBeenLastCalledWith(
      expect.objectContaining({ repair: true })
    );
    expect(fixture.operations.validate).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(report.worktree!, "src/greeting.txt"), "utf8")).toBe(
      "goodbye\n"
    );
  });

  it("stops at the repair limit and does not treat a failing check as success", async () => {
    const fixture = await setup({ firstContent: "goodbye  \n", alwaysFail: true });
    fixture.policy.failure_handling.retry_limit = 1;
    const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(report.status).toBe("validation_failed");
    expect(report.validation.status).toBe("failed");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(2);
    expect(fixture.operations.review).not.toHaveBeenCalled();
    await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(fixture.operations.propose).toHaveBeenCalledTimes(2);
  });

  it("preserves a repair proposal while waiting for a new apply approval", async () => {
    const fixture = await setup({ firstContent: "goodbye  \n" });
    // Initial apply happens under balanced policy; the next invocation strengthens it.
    await fixture.runner().run(fixture.runId);
    fixture.policy.approvals.before_apply = true;
    const paused = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(paused.status).toBe("awaiting_approval");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(2);
    const result = await fixture.runner({ approve: true, executeChecks: true }).run(fixture.runId);
    expect(result.status).toBe("review_ready");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(2);
  });

  it("rejects changed worktree content rather than reusing old checks or review", async () => {
    const fixture = await setup();
    const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    await writeFile(path.join(report.worktree!, "src/greeting.txt"), "tampered\n");
    const resumed = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(resumed.status).toBe("needs_attention");
    expect(resumed.summary).toContain("contents changed");
    expect(resumed.evidenceFreshness).toBe("not_rechecked");
    expect(fixture.operations.review).toHaveBeenCalledTimes(1);
    expect(fixture.operations.validate).toHaveBeenCalledTimes(1);
  });

  it("detects source-changing validation commands", async () => {
    const fixture = await setup();
    fixture.operations.validate = vi.fn(
      async (input: Parameters<TaskRunnerOperations["validate"]>[0]) => {
        const run = await input.store.loadRun(input.runId);
        const applied = artifactOf(run, "change-applied")!;
        await writeFile(
          path.join(String(applied.metadata?.worktree), "src/greeting.txt"),
          "changed by tooling\n"
        );
        return validateAppliedChanges(input);
      }
    );
    const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(report.status).toBe("needs_attention");
    expect(fixture.operations.review).not.toHaveBeenCalled();
  });

  it("checks the current validation policy when resuming a previously passing result", async () => {
    const fixture = await setup();
    await fixture.runner({ executeChecks: true }).run(fixture.runId);
    fixture.policy.validation.before_commit = ["unit_tests"];
    const report = await fixture.runner().run(fixture.runId);
    expect(report.status).toBe("needs_attention");
    expect(report.summary).toContain("policy changed");
  });

  it("does not auto-repair unverified review findings or unsupported criteria", async () => {
    const review = structuredClone(supportedReview);
    review.criteria[0]!.status = "unverified";
    review.criteria[0]!.evidence = [];
    review.findings = [
      {
        file: "src/greeting.txt",
        line: 1,
        severity: "high",
        description: "Potential defect requiring reproduction.",
        evidence: [{ file: "src/greeting.txt", line: 1, description: "Source-level observation." }],
        suggestedFix: "Investigate before changing behavior.",
        verificationStatus: "unverified"
      }
    ];
    const fixture = await setup({ review });
    const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(report.status).toBe("needs_review");
    expect(report.review.findings[0]?.verificationStatus).toBe("unverified");
    expect(fixture.operations.propose).toHaveBeenCalledTimes(1);
  });

  it("requires every criterion to be assessed exactly once", async () => {
    const review = structuredClone(supportedReview);
    review.criteria[0]!.id = "made-up";
    const fixture = await setup({ review });
    expect((await fixture.runner({ executeChecks: true }).run(fixture.runId)).status).toBe(
      "needs_attention"
    );
  });

  it("stops for planning questions and multi-task plans without applying a partial solution", async () => {
    for (const plan of [
      { ...basePlan, questions: ["Which behavior is expected?"] },
      { ...basePlan, tasks: [...basePlan.tasks, { ...basePlan.tasks[0]!, id: "second" }] }
    ]) {
      const fixture = await setup({ plan });
      const report = await fixture.runner({ executeChecks: true }).run(fixture.runId);
      expect(report.status).toBe("needs_input");
      expect(fixture.operations.propose).not.toHaveBeenCalled();
      expect(fixture.operations.apply).not.toHaveBeenCalled();
    }
  });

  it("detects a changed Git base and an interrupted apply without replaying writes", async () => {
    const fixture = await setup();
    fixture.policy.approvals.before_apply = true;
    await fixture.runner().run(fixture.runId);
    const run = await fixture.store.loadRun(fixture.runId);
    await fixture.store.recordArtifact(run.id, {
      kind: "report",
      summary: "Apply started before a simulated crash.",
      metadata: {
        type: "task-stage",
        stage: "applying",
        proposalArtifactId: artifactOf(run, "change-proposal")!.id
      }
    });
    const report = await fixture.runner({ approve: true, executeChecks: true }).run(run.id);
    expect(report.status).toBe("needs_attention");
    expect(report.summary).toContain("interrupted");
    expect(fixture.operations.apply).not.toHaveBeenCalled();
    git(fixture.root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "changed base"
    ]);
    expect((await fixture.runner().run(run.id)).summary).toContain("HEAD changed");
  });

  it("resumes review after an interruption without rerunning completed checks", async () => {
    const fixture = await setup();
    const original = fixture.operations.review;
    fixture.operations.review = vi.fn().mockRejectedValueOnce(new Error("Reviewer unavailable."));
    const first = await fixture.runner({ executeChecks: true }).run(fixture.runId);
    expect(first.status).toBe("needs_attention");
    fixture.operations.review = original;
    expect((await fixture.runner().run(fixture.runId)).status).toBe("review_ready");
    expect(fixture.operations.validate).toHaveBeenCalledTimes(1);
  });

  it("rejects simultaneous invocations for the same durable run", async () => {
    const fixture = await setup();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fixture.operations.propose;
    fixture.operations.propose = async (input) => {
      entered();
      await blocked;
      return original(input);
    };
    const first = fixture.runner().run(fixture.runId);
    await ready;
    await expect(fixture.runner().run(fixture.runId)).rejects.toThrow("already running");
    release();
    await first;
  });

  it("records a failure report even when the planning artifact is invalid", async () => {
    const fixture = await setup();
    await fixture.store.recordArtifact(fixture.runId, {
      kind: "proposal",
      summary: "Invalid plan",
      metadata: { type: "planning-intent", plan: {} }
    });
    const report = await fixture.runner().run(fixture.runId);
    expect(report.status).toBe("needs_attention");
    expect(report.acceptanceCriteria).toEqual([]);
  });
});

async function setup(
  options: {
    firstContent?: string;
    alwaysFail?: boolean;
    review?: IndependentReview;
    plan?: PlanningIntent;
    rootPrefix?: string;
  } = {}
) {
  const root = await mkdtemp(path.join(tmpdir(), options.rootPrefix ?? "repopilot-task-runner-"));
  fixtures.push(await (await import("node:fs/promises")).realpath(root));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/greeting.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), ".repopilot/runs/\nnode_modules/\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "initial"
  ]);
  const store = new WorkflowStore(root);
  const run = await store.createRun({ objective: "Update greeting", provider: "codex" });
  await initializeDevelopmentTask(store, run.id);
  await store.recordArtifact(run.id, {
    kind: "proposal",
    summary: "Scoped plan.",
    metadata: { type: "planning-intent", plan: options.plan ?? basePlan }
  });
  for (const status of ["planning", "running", "validating", "reviewing", "completed"] as const)
    await store.transitionRun(run.id, status);
  const policy = structuredClone(balancedPolicy);
  policy.validation.before_commit = [];
  let proposals = 0;
  const operations: TaskRunnerOperations = {
    propose: vi.fn(async (input: Parameters<TaskRunnerOperations["propose"]>[0]) => {
      const snapshot = await store.loadRun(run.id);
      const contextRoot = input.repair
        ? String(artifactOf(snapshot, "change-applied")?.metadata?.worktree)
        : root;
      const hash = createHash("sha256")
        .update(await readFile(path.join(contextRoot, "src/greeting.txt")))
        .digest("hex");
      const proposal: ChangeProposal = {
        summary: "Update greeting",
        taskId: "greeting",
        contextManifest: [
          {
            path: "src/greeting.txt",
            hash,
            bytes: 6,
            truncated: false,
            reason: "scope",
            evidence: "filesystem:src/greeting.txt"
          }
        ],
        changes: [
          {
            action: "modify",
            path: "src/greeting.txt",
            taskId: "greeting",
            baseHash: hash,
            content:
              proposals++ === 0 || options.alwaysFail
                ? (options.firstContent ?? "goodbye\n")
                : "goodbye\n",
            evidencePaths: ["src/greeting.txt"]
          }
        ],
        commandIntents: []
      };
      await store.recordArtifact(run.id, {
        kind: "proposal",
        summary: proposal.summary,
        metadata: { type: "change-proposal", proposal }
      });
      return proposal;
    }),
    apply: vi.fn(applyChanges),
    validate: vi.fn(validateAppliedChanges),
    review: vi.fn(async () => {
      const snapshot = await store.loadRun(run.id);
      const applied = artifactOf(snapshot, "change-applied")!;
      const review = options.review ?? supportedReview;
      await store.recordArtifact(run.id, {
        kind: "report",
        summary: review.summary,
        metadata: {
          type: "independent-review",
          proposalArtifactId: applied.metadata?.proposalArtifactId,
          fingerprint: applied.metadata?.fingerprint,
          changes: [{ path: "src/greeting.txt", action: "modify" }],
          review
        }
      });
      return review;
    })
  };
  return {
    root,
    store,
    policy,
    operations,
    runId: run.id,
    runner: (flags: { approve?: boolean; executeChecks?: boolean } = {}) =>
      new VerifiedTaskRunner(
        {
          store,
          providers: new ProviderRegistry(),
          policy,
          ...flags
        },
        operations
      )
  };
}

function git(root: string, args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
