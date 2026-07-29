import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeGitAction,
  autonomousPolicy,
  balancedPolicy,
  canParallelizeTasks,
  createAuditRecord,
  defaultConfig,
  loadRepositoryConfig,
  parsePolicyConfig,
  resolvePolicy,
  safePolicy,
  setPolicyValue,
  writeRepositoryConfig,
  type PolicyTask
} from "../src/index.js";

describe("policy presets and schema", () => {
  it("keeps safe defaults non-destructive", () => {
    expect(safePolicy.parallelism.enabled).toBe(false);
    expect(safePolicy.commits.enabled).toBe(false);
    expect(safePolicy.pushes.enabled).toBe(false);
    expect(safePolicy.pull_requests.enabled).toBe(false);
    expect(safePolicy.approvals.before_apply).toBe(true);
  });

  it("validates versioned YAML configuration", () => {
    const parsed = parsePolicyConfig(
      [
        "version: 1",
        "execution:",
        "  autonomy: balanced",
        "  parallelism:",
        "    enabled: true",
        "    max_workers: 3",
        "    strategy: isolated_worktrees",
        "    allow_parallel_reads: true",
        "    allow_parallel_writes: true",
        "    require_independent_scopes: true",
        "  commits:",
        "    enabled: true",
        "    strategy: after_feature",
        "    require_clean_validation: true",
        "    allow_checkpoint_commits: false",
        "    message_format: conventional",
        "    sign_commits: false",
        "  pushes:",
        "    enabled: false",
        "    strategy: never",
        "    remote: origin",
        "    allowed_branch_patterns: [repopilot/**]",
        "    prohibited_branches: [main]",
        "    allow_force_push: false",
        "  pull_requests:",
        "    enabled: false",
        "    create_as_draft: true",
        "    require_validation: true",
        "    require_human_approval: true",
        "  validation:",
        "    before_commit: [format, lint]",
        "    before_push: [unit_tests]",
        "    before_pull_request: [full_check]",
        "    stop_on_failure: true",
        "  approvals:",
        "    before_apply: false",
        "    before_commit: false",
        "    before_push: true",
        "    before_pull_request: true",
        "    before_destructive_action: true",
        "  failure_handling:",
        "    preserve_worktree: true",
        "    create_failure_report: true",
        "    allow_partial_commit: false",
        "    retry_limit: 2"
      ].join("\n")
    );

    expect(parsed.execution.autonomy).toBe("balanced");
  });

  it("writes and loads .repopilot/config.yaml", async () => {
    const root = await fixture();
    await writeRepositoryConfig(root, defaultConfig("safe"));
    const loaded = await loadRepositoryConfig(root);
    const written = await readFile(path.join(root, ".repopilot", "config.yaml"), "utf8");

    expect(loaded?.execution.autonomy).toBe("safe");
    expect(written).toContain("version: 1");
  });

  it("applies repository configuration and command-line overrides after presets", () => {
    const resolved = resolvePolicy({
      selectedPreset: "safe",
      repositoryConfig: defaultConfig("balanced"),
      cliOverrides: { pushes: { enabled: false, strategy: "never" } }
    });

    expect(resolved.execution.autonomy).toBe("balanced");
    expect(resolved.execution.parallelism.enabled).toBe(true);
    expect(resolved.execution.pushes.enabled).toBe(false);
    expect(resolved.sources).toEqual(
      expect.arrayContaining(["built-in safe defaults", "safe preset", ".repopilot/config.yaml"])
    );
  });

  it("sets custom values by dotted path and revalidates the schema", () => {
    const updated = setPolicyValue(defaultConfig("safe"), "parallelism.max_workers", "4");

    expect(updated.execution.parallelism.max_workers).toBe(4);
  });
});

describe("deterministic enforcement", () => {
  it("blocks disabled commits even when an AI asks for one", () => {
    const decision = authorizeGitAction(safePolicy, {
      action: "commit",
      validation: { status: "passed", checks: safePolicy.validation.before_commit, summary: "ok" },
      approval: { approved: true }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("Automatic commits are disabled by policy.");
  });

  it("allows balanced commits only after configured validation succeeds", () => {
    const failed = authorizeGitAction(balancedPolicy, {
      action: "commit",
      validation: {
        status: "failed",
        checks: balancedPolicy.validation.before_commit,
        summary: "lint failed"
      }
    });
    const passed = authorizeGitAction(balancedPolicy, {
      action: "commit",
      validation: {
        status: "passed",
        checks: balancedPolicy.validation.before_commit,
        summary: "ok"
      }
    });

    expect(failed.allowed).toBe(false);
    expect(passed.allowed).toBe(true);
  });

  it("blocks pushes to default and protected branches", () => {
    const decision = authorizeGitAction(autonomousPolicy, {
      action: "push",
      branch: "main",
      remote: "origin",
      defaultBranch: "main",
      protectedBranches: ["main"],
      validation: {
        status: "passed",
        checks: autonomousPolicy.validation.before_push,
        summary: "ok"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not permitted");
  });

  it("requires push approvals when policy demands them", () => {
    const decision = authorizeGitAction(balancedPolicy, {
      action: "push",
      branch: "repopilot/example",
      remote: "origin",
      validation: { status: "passed", checks: balancedPolicy.validation.before_push, summary: "ok" }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiredApprovals).toContain("push");
  });

  it("allows autonomous pushes only to agent-owned branches after validation", () => {
    const decision = authorizeGitAction(autonomousPolicy, {
      action: "push",
      branch: "repopilot/example",
      remote: "origin",
      validation: {
        status: "passed",
        checks: autonomousPolicy.validation.before_push,
        summary: "ok"
      }
    });

    expect(decision.allowed).toBe(true);
  });

  it("does not parallelize overlapping write scopes", () => {
    const decision = canParallelizeTasks(
      balancedPolicy,
      task("a", ["packages/shared"]),
      task("b", ["packages/shared/src/index.ts"])
    );

    expect(decision.canRunInParallel).toBe(false);
    expect(decision.reasons).toContain("Expected write scopes overlap.");
  });

  it("allows independent read-only analysis in parallel", () => {
    const first = task("docs", []);
    const second = task("tests", []);
    first.expectedScopes = ["docs"];
    second.expectedScopes = ["tests"];
    const decision = canParallelizeTasks(balancedPolicy, first, second);

    expect(decision.canRunInParallel).toBe(true);
  });

  it("redacts secrets in audit records", () => {
    const record = createAuditRecord({
      action: "push_attempted",
      summary: "push token=abc123",
      policy: autonomousPolicy,
      metadata: { branch: "repopilot/example", secret_token: "abc123" }
    });

    expect(record.summary).toContain("[REDACTED]");
    expect(record.metadata.secret_token).toBe("[REDACTED]");
  });
});

async function fixture(): Promise<string> {
  const directory = path.join(tmpdir(), `repopilot-policy-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

function task(id: string, writeSet: string[]): PolicyTask {
  return {
    id,
    objective: `Task ${id}`,
    expectedScopes: writeSet.length > 0 ? writeSet : [id],
    dependencies: [],
    readSet: [],
    writeSet,
    validationCommands: ["pnpm test"],
    completionCriteria: ["tests pass"]
  };
}
