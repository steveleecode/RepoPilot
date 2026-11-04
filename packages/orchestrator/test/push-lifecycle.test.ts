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

import { pushDevelopmentTask } from "../src/push-lifecycle.js";
const roots: string[] = [];
const remotes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const remote of remotes.splice(0)) await rm(remote, { recursive: true, force: true });
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

describe("reviewed push", () => {
  it("keeps default commits local and publishes only the immutable reviewed branch when explicitly requested", async () => {
    const fixture = await ready();
    expect(git(fixture.remote, ["for-each-ref", "--format=%(refname)"])).toBe("");
    const result = await fixture.push();
    expect(result.commit).toBe(fixture.committed.commit);
    expect(git(fixture.remote, ["for-each-ref", "--format=%(refname)"])).toBe(
      `refs/heads/${fixture.committed.branch}`
    );
    expect(git(fixture.remote, ["rev-parse", `refs/heads/${fixture.committed.branch}`])).toBe(
      fixture.committed.commit
    );
    expect(git(fixture.remote, ["show", `${fixture.committed.branch}:src/greeting.txt`])).toBe(
      "goodbye"
    );
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.base);
    expect(await fixture.push()).toEqual(result);
    expect(
      (await fixture.store.loadRun(fixture.runId)).artifacts.filter(
        (item) => item.metadata?.type === "development-push"
      )
    ).toHaveLength(1);
  });
  it("enforces enablement, approval and branch patterns before contacting a remote", async () => {
    const fixture = await ready();
    fixture.config.execution.pushes.enabled = false;
    await fixture.save();
    await expect(fixture.push()).rejects.toThrow("disabled");
    fixture.config.execution.pushes.enabled = true;
    await fixture.save();
    await expect(fixture.push(false)).rejects.toThrow("approval");
    fixture.config.execution.pushes.allowed_branch_patterns = ["agent/**"];
    await fixture.save();
    await expect(fixture.push()).rejects.toThrow("not permitted");
    expect(git(fixture.remote, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });
  it("requires explicit execution of additional current pre-push checks", async () => {
    const fixture = await ready();
    fixture.config.execution.validation.before_push = ["unit_tests", "build"];
    await fixture.save();
    await expect(fixture.push()).rejects.toThrow("--execute-checks");
    await mkdir(path.join(fixture.worktree, "node_modules"));
    const log = path.join(fixture.root, ".git", "check-log");
    await fakePnpm(
      fixture,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`
    );
    await fixture.push(true, true);
    expect(await readFile(log, "utf8")).toBe("exec vitest run\nrun build\n");
  });
  it("does not reuse completed commands from a failed freshness check after source is restored", async () => {
    const fixture = await ready();
    fixture.config.execution.validation.before_push = ["build"];
    await fixture.save();
    await mkdir(path.join(fixture.worktree, "node_modules"));
    await fakePnpm(
      fixture,
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(fixture.worktree, "src/greeting.txt"))}, "mutated\\n");`
    );
    await expect(fixture.push(true, true)).rejects.toThrow("changed the committed");
    await writeFile(path.join(fixture.worktree, "src/greeting.txt"), "goodbye\n");
    await expect(fixture.push()).rejects.toThrow("--execute-checks");
    expect(git(fixture.remote, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });
  it("retains successful checks when policy adds another check", async () => {
    const fixture = await ready();
    fixture.config.execution.validation.before_push = ["build"];
    await fixture.save();
    await mkdir(path.join(fixture.worktree, "node_modules"));
    const log = path.join(fixture.root, ".git", "checks-growth");
    await fakePnpm(
      fixture,
      `require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");`
    );
    await fixture.push(true, true);
    fixture.config.execution.validation.before_push = ["build", "unit_tests"];
    await fixture.save();
    await expect(fixture.push()).rejects.toThrow("--execute-checks");
    await fixture.push(true, true);
    expect(await readFile(log, "utf8")).toBe("run build\nexec vitest run\n");
  }, 15_000);
  it("ignores target mirror/refspec/hooks and suppresses local receiver hooks", async () => {
    const fixture = await ready();
    const marker = path.join(fixture.root, ".git", "hook-marker");
    const hook = path.join(fixture.remote, "hooks", "pre-receive");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    await chmod(hook, 0o755);
    git(fixture.root, ["config", "remote.origin.mirror", "true"]);
    git(fixture.root, ["config", "remote.origin.push", "HEAD:refs/heads/main"]);
    git(fixture.root, ["config", "remote.origin.receivepack", `touch ${marker}`]);
    git(fixture.root, ["config", "core.sshCommand", `touch ${marker}`]);
    git(fixture.root, ["tag", "do-not-publish"]);
    await fixture.push();
    await expect(readFile(marker)).rejects.toThrow();
    expect(git(fixture.remote, ["for-each-ref", "--format=%(refname)"])).toBe(
      `refs/heads/${fixture.committed.branch}`
    );
  });
  it("pins destinations and refuses divergent pending intents", async () => {
    const fixture = await ready();
    git(fixture.root, ["config", "remote.origin.pushurl", `${fixture.remote}-other`]);
    await expect(fixture.push()).rejects.toThrow("push URLs");
    git(fixture.root, ["config", "--unset", "remote.origin.pushurl"]);
    await fixture.push();
    const other = await mkdtemp(path.join(tmpdir(), "repopilot-push-other-"));
    remotes.push(other);
    git(other, ["init", "--bare", "-q"]);
    git(fixture.root, ["remote", "set-url", "origin", other]);
    await expect(fixture.push()).rejects.toThrow("destination changed");
    expect(git(other, ["for-each-ref", "--format=%(refname)"])).toBe("");
  });
  it("rejects custom helpers, URL credentials and multiple URLs without contacting them", async () => {
    const fixture = await ready();
    for (const url of [
      "ext::touch /tmp/not-run",
      "https://token@example.test/repo",
      "https://example.test/repo?token=secret",
      "ssh://-invalid/repo"
    ]) {
      git(fixture.root, ["remote", "set-url", "origin", url]);
      await expect(fixture.push()).rejects.toThrow();
    }
    git(fixture.root, ["remote", "set-url", "origin", fixture.remote]);
    git(fixture.root, ["config", "--add", "remote.origin.url", fixture.remote]);
    await expect(fixture.push()).rejects.toThrow("exactly one");
  });
  it("recovers an observed successful push without replay and rejects a diverged branch", async () => {
    const fixture = await ready();
    git(fixture.root, [
      "push",
      fixture.remote,
      `${fixture.committed.commit}:refs/heads/${fixture.committed.branch}`
    ]);
    const result = {
      version: 1,
      commit: fixture.committed.commit,
      branch: fixture.committed.branch,
      remote: "origin",
      destinationHash: createHash("sha256").update(fixture.remote).digest("hex")
    };
    // Remote accepted the commit, but the process stopped before recording a result.
    await fixture.store.recordArtifact(fixture.runId, {
      kind: "report",
      summary: "Pending",
      metadata: { type: "development-push-intent", result }
    });
    expect(await fixture.push()).toEqual(result);
    expect(
      artifactOf(await fixture.store.loadRun(fixture.runId), "development-push")?.metadata
        ?.recovered
    ).toBe(true);
    git(fixture.remote, ["update-ref", `refs/heads/${fixture.committed.branch}`, fixture.base]);
    await expect(fixture.push()).rejects.toThrow("automatic replay is disabled");
    // This case exercises real Git transport, recovery, and divergence checks on hosted runners.
  }, 15_000);
});

async function fakePnpm(fixture: Awaited<ReturnType<typeof ready>>, code: string) {
  const tools = path.join(fixture.root, ".git", "tools");
  await mkdir(tools);
  const binary = path.join(tools, "pnpm");
  await writeFile(binary, `#!/usr/bin/env node\n${code}\n`);
  await chmod(binary, 0o755);
  vi.stubEnv("PATH", `${tools}${path.delimiter}${process.env.PATH ?? ""}`);
}
async function ready() {
  const fixture = await setup();
  const remote = await mkdtemp(path.join(tmpdir(), "repopilot-push-remote-"));
  remotes.push(remote);
  git(remote, ["init", "--bare", "-q"]);
  git(fixture.root, ["remote", "add", "origin", remote]);
  fixture.config.execution.pushes.enabled = true;
  fixture.config.execution.pushes.strategy = "after_feature";
  fixture.config.execution.validation.before_push = [];
  await fixture.save();
  const committed = await fixture.commit();
  return {
    ...fixture,
    remote,
    committed,
    push: (approval = true, executeChecks = false) =>
      pushDevelopmentTask({ store: fixture.store, runId: fixture.runId, approval, executeChecks })
  };
}

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
