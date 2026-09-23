import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { balancedPolicy } from "@repopilot/policy";
import { WorkflowStore } from "@repopilot/workflow";
import {
  applyChanges,
  validateAppliedChanges,
  validateChangeProposal
} from "../src/development.js";
import { parsePlanningIntent } from "../src/index.js";

const plan = parsePlanningIntent({
  summary: "Change the greeting.",
  tasks: [
    {
      id: "greeting",
      objective: "Update greeting",
      dependencies: [],
      expectedScopes: ["src"],
      readSet: ["src"],
      writeSet: ["src"],
      validationCommandIds: [],
      completionCriteria: ["Greeting updated"]
    }
  ],
  risks: [],
  questions: []
});

describe("development workflow", () => {
  it("rejects scope escapes, duplicate targets, and inconsistent base hashes", () => {
    const base = proposal("a".repeat(64));
    expect(validateChangeProposal(base, plan).changes).toHaveLength(1);
    expect(() =>
      validateChangeProposal(
        { ...base, changes: [{ ...base.changes[0], path: "../outside" }] },
        plan
      )
    ).toThrow();
    expect(() =>
      validateChangeProposal({ ...base, changes: [...base.changes, base.changes[0]] }, plan)
    ).toThrow("duplicate");
    expect(() =>
      validateChangeProposal(
        { ...base, changes: [{ ...base.changes[0], baseHash: "b".repeat(64) }] },
        plan
      )
    ).toThrow("base hash");
  });

  it("applies only in a worktree and validates with the trusted diff check", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Update greeting", provider: "ollama" });
    const original = await readFile(path.join(root, "src", "greeting.txt"));
    const hash = (await import("node:crypto")).createHash("sha256").update(original).digest("hex");
    await store.recordArtifact(run.id, {
      kind: "proposal",
      summary: plan.summary,
      metadata: { type: "planning-intent", plan }
    });
    await store.recordArtifact(run.id, {
      kind: "proposal",
      summary: "Replace greeting",
      metadata: { type: "change-proposal", proposal: proposal(hash) }
    });
    const worktree = await applyChanges({ store, runId: run.id, policy: balancedPolicy });
    expect(await readFile(path.join(root, "src", "greeting.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(path.join(worktree, "src", "greeting.txt"), "utf8")).toBe("goodbye\n");
    const policy = structuredClone(balancedPolicy);
    policy.validation.before_commit = [];
    const validation = await validateAppliedChanges({
      store,
      runId: run.id,
      policy,
      executeChecks: true
    });
    expect(validation.passed).toBe(true);
    expect(validation.results.map((item) => item.commandId)).toEqual(["diff-check"]);
  });

  it("leaves a fresh worktree unchanged when the base is stale", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Update greeting", provider: "ollama" });
    await store.recordArtifact(run.id, {
      kind: "proposal",
      summary: plan.summary,
      metadata: { type: "planning-intent", plan }
    });
    await store.recordArtifact(run.id, {
      kind: "proposal",
      summary: "Replace greeting",
      metadata: { type: "change-proposal", proposal: proposal("a".repeat(64)) }
    });
    await expect(applyChanges({ store, runId: run.id, policy: balancedPolicy })).rejects.toThrow(
      "Stale"
    );
    const snapshot = await store.loadRun(run.id);
    const failed = snapshot.artifacts.find((item) => item.metadata?.type === "apply-failure");
    expect(typeof failed?.metadata?.worktree).toBe("string");
    expect(
      await readFile(path.join(String(failed?.metadata?.worktree), "src", "greeting.txt"), "utf8")
    ).toBe("hello\n");
  });
});

function proposal(hash: string) {
  return {
    summary: "Replace greeting",
    taskId: "greeting",
    contextManifest: [
      {
        path: "src/greeting.txt",
        hash,
        bytes: 6,
        truncated: false,
        reason: "planned scope",
        evidence: "filesystem:src/greeting.txt"
      }
    ],
    changes: [
      {
        action: "modify",
        path: "src/greeting.txt",
        content: "goodbye\n",
        evidencePaths: ["src/greeting.txt"],
        taskId: "greeting",
        baseHash: hash
      }
    ],
    commandIntents: []
  };
}

async function fixture(): Promise<string> {
  const root = path.join(tmpdir(), `repopilot-dev-${crypto.randomUUID()}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "greeting.txt"), "hello\n");
  for (const args of [
    ["init"],
    ["add", "."],
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return root;
}
