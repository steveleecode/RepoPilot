import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, writeRepositoryConfig } from "@repopilot/policy";
import { WorkflowStore } from "@repopilot/workflow";
import {
  applyChanges,
  artifactOf,
  validateAppliedChanges,
  type ChangeProposal
} from "../src/development.js";
import { commitDevelopmentTask } from "../src/git-lifecycle.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    for (const line of git(root, ["worktree", "list", "--porcelain"]).split("\n"))
      if (line.startsWith("worktree ") && line.slice(9) !== root)
        await rm(line.slice(9), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
function git(root: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

describe("reviewed local commit", () => {
  it("commits on its own branch, preserves primary HEAD, and is idempotent", async () => {
    const fixture = await setup();
    const result = await fixture.commit();
    expect(result.branch).toBe(`codex/repopilot-${fixture.runId}`);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.base);
    expect(git(fixture.worktree, ["show", "HEAD:src/greeting.txt"])).toBe("goodbye");
    expect(git(fixture.worktree, ["status", "--porcelain"])).toBe("");
    expect(await fixture.commit()).toEqual(result);
    expect(
      (await fixture.store.loadRun(fixture.runId)).artifacts.filter(
        (item) => item.metadata?.type === "development-commit"
      )
    ).toHaveLength(1);
    await expect(fixture.commit("fix: another message")).rejects.toThrow("Recorded commit");
  });
  it("rechecks disabled commits, approval, strategy, signing, message and current validation policy", async () => {
    const fixture = await setup();
    fixture.config.execution.commits.enabled = false;
    await fixture.save();
    await expect(fixture.commit()).rejects.toThrow("disabled");
    fixture.config.execution.commits.enabled = true;
    fixture.config.execution.approvals.before_commit = true;
    await fixture.save();
    await expect(fixture.commit()).rejects.toThrow("approval");
    fixture.config.execution.approvals.before_commit = false;
    fixture.config.execution.commits.strategy = "never";
    await fixture.save();
    await expect(fixture.commit()).rejects.toThrow("after_feature");
    fixture.config.execution.commits.strategy = "after_feature";
    fixture.config.execution.commits.sign_commits = true;
    await fixture.save();
    await expect(fixture.commit()).rejects.toThrow("Signed");
    fixture.config.execution.commits.sign_commits = false;
    await fixture.save();
    await expect(fixture.commit("bad message")).rejects.toThrow("conventional");
    fixture.config.execution.validation.before_commit = ["lint"];
    await fixture.save();
    await expect(fixture.commit()).rejects.toThrow("current commit policy");
    fixture.config.execution.validation.before_commit = [];
    fixture.config.execution.approvals.before_commit = true;
    await fixture.save();
    await fixture.commit("fix: greeting", true);
    expect(
      (await fixture.store.loadRun(fixture.runId)).approvals.some((item) =>
        item.action.startsWith("commit:")
      )
    ).toBe(true);
  });
  it("rejects stale source, extra staged files and colliding branches", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.worktree, "src/greeting.txt"), "changed\n");
    await expect(fixture.commit()).rejects.toThrow("contents changed");
    await writeFile(path.join(fixture.worktree, "src/greeting.txt"), "goodbye\n");
    git(fixture.worktree, ["add", "src/greeting.txt"]);
    await expect(fixture.commit()).rejects.toThrow("contents changed");
    git(fixture.worktree, ["reset", "--quiet"]);
    git(fixture.root, ["branch", `codex/repopilot-${fixture.runId}`]);
    await expect(fixture.commit()).rejects.toThrow("already exists");
  });
  it("requires fresh independent review and preserves interrupted intents for inspection", async () => {
    const fixture = await setup();
    const run = await fixture.store.loadRun(fixture.runId);
    const previous = artifactOf(run, "independent-review")!;
    await fixture.store.recordArtifact(fixture.runId, {
      kind: "report",
      summary: "Stale review",
      metadata: { ...previous.metadata, fingerprint: "stale" }
    });
    await expect(fixture.commit()).rejects.toThrow("fresh validation");
    await fixture.store.recordArtifact(fixture.runId, {
      kind: "report",
      summary: "Interrupted",
      metadata: { type: "development-commit-intent" }
    });
    await expect(fixture.commit()).rejects.toThrow("interrupted");
  });
  it("isolates filter inspection, freshness checks and commits from ambient Git configuration", async () => {
    const fixture = await setup();
    const resolved = spawnSync("which", ["git"], { encoding: "utf8" });
    expect(resolved.status).toBe(0);
    const tools = path.join(fixture.root, ".git", "isolated-tools");
    await mkdir(tools);
    const binary = path.join(tools, "git");
    const ambientConfigRead = path.join(tools, "ambient-config-read");
    // Simulate a runner with an ambient filter unless the caller explicitly isolates config.
    await writeFile(
      binary,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.GIT_CONFIG_NOSYSTEM !== "1" || process.env.GIT_CONFIG_GLOBAL !== "/dev/null") {
  require("node:fs").writeFileSync(${JSON.stringify(ambientConfigRead)}, "unexpected ambient config");
  args.unshift("-c", "filter.runner.clean=false");
}
const result = spawnSync(${JSON.stringify(resolved.stdout.trim())}, args, {
  env: process.env, stdio: "inherit"
});
process.exit(result.status ?? 1);
`
    );
    await chmod(binary, 0o755);
    vi.stubEnv("PATH", `${tools}${path.delimiter}${process.env.PATH ?? ""}`);
    const committed = await fixture.commit();
    expect(committed.branch).toBe(`codex/repopilot-${fixture.runId}`);
    expect(await fixture.commit()).toEqual(committed);
    await expect(readFile(ambientConfigRead)).rejects.toThrow();
  }, 15_000);
  it("rejects worktree-specific filters before freshness helpers can execute them", async () => {
    const fixture = await setup();
    const marker = path.join(fixture.root, "worktree-filter-marker");
    git(fixture.root, ["config", "extensions.worktreeConfig", "true"]);
    git(fixture.worktree, ["config", "--worktree", "filter.evil.clean", `touch ${marker}`]);
    await writeFile(path.join(fixture.worktree, ".gitattributes"), "*.txt filter=evil\n");
    await expect(fixture.commit()).rejects.toThrow("filters");
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("does not execute configured filters", async () => {
    const fixture = await setup();
    const marker = path.join(fixture.root, "marker");
    git(fixture.root, ["config", "filter.evil.clean", `touch ${marker}`]);
    await writeFile(path.join(fixture.worktree, ".gitattributes"), "*.txt filter=evil\n");
    await expect(fixture.commit()).rejects.toThrow("filters");
    await expect(readFile(marker)).rejects.toThrow();
  });
  it("bypasses repository hooks and configured signing programs", async () => {
    const fixture = await setup();
    const marker = path.join(fixture.root, "hook-marker");
    for (const name of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "reference-transaction"
    ]) {
      const hook = path.join(fixture.root, ".git", "hooks", name);
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      await chmod(hook, 0o755);
    }
    const signer = path.join(fixture.root, ".git", "hooks", "pre-commit");
    git(fixture.root, ["config", "commit.gpgSign", "true"]);
    git(fixture.root, ["config", "gpg.program", signer]);
    await fixture.commit();
    await expect(readFile(marker)).rejects.toThrow();
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-commit-test-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/greeting.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), ".repopilot/\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  const config = defaultConfig("balanced");
  config.execution.validation.before_commit = [];
  await writeRepositoryConfig(root, config);
  const store = new WorkflowStore(root);
  const run = await store.createRun({ objective: "Greeting", provider: "codex" });
  const hash = createHash("sha256").update("hello\n").digest("hex");
  await store.recordArtifact(run.id, {
    kind: "report",
    summary: "Plan",
    metadata: {
      type: "planning-intent",
      plan: {
        summary: "Greeting",
        tasks: [
          {
            id: "greeting",
            objective: "Greeting",
            dependencies: [],
            expectedScopes: ["src"],
            readSet: ["src"],
            writeSet: ["src"],
            validationCommandIds: [],
            completionCriteria: ["Greeting changed"]
          }
        ],
        risks: [],
        questions: []
      }
    }
  });
  const proposal: ChangeProposal = {
    summary: "Greeting",
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
        content: "goodbye\n",
        taskId: "greeting",
        baseHash: hash,
        evidencePaths: ["src/greeting.txt"]
      }
    ],
    commandIntents: []
  };
  const proposed = await store.recordArtifact(run.id, {
    kind: "proposal",
    summary: "Greeting",
    metadata: { type: "change-proposal", proposal }
  });
  const worktree = await applyChanges({ store, runId: run.id, policy: config.execution });
  await validateAppliedChanges({
    store,
    runId: run.id,
    policy: config.execution,
    executeChecks: true
  });
  const applied = artifactOf(await store.loadRun(run.id), "change-applied")!;
  await store.recordArtifact(run.id, {
    kind: "report",
    summary: "Reviewed",
    metadata: {
      type: "independent-review",
      proposalArtifactId: proposed.id,
      fingerprint: applied.metadata?.fingerprint,
      changes: [{ path: "src/greeting.txt", action: "modify" }],
      review: {
        summary: "Reviewed",
        findings: [],
        criteria: [
          {
            id: "criterion-1",
            status: "supported",
            evidence: [{ file: "src/greeting.txt", line: 1, description: "Greeting changed" }]
          }
        ]
      }
    }
  });
  await store.recordArtifact(run.id, {
    kind: "report",
    summary: "Ready",
    metadata: {
      type: "task-completion",
      report: {
        status: "review_ready",
        proposalArtifactId: proposed.id,
        acceptanceCriteria: [{ id: "criterion-1", judgment: "supported" }]
      }
    }
  });
  return {
    root,
    store,
    runId: run.id,
    base,
    worktree,
    config,
    save: () => writeRepositoryConfig(root, config),
    commit: (message = "fix: greeting", approval = false) =>
      commitDevelopmentTask({ store, runId: run.id, message, approval })
  };
}
