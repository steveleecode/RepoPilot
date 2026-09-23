import { appendFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowStore } from "../src/index.js";

describe("WorkflowStore", () => {
  it("persists a created run as a versioned append-only journal", async () => {
    const root = await fixture();
    const store = deterministicStore(root);

    const created = await store.createRun({ objective: "Add parser coverage", provider: "codex" });
    const loaded = await store.loadRun(created.id);
    const listed = await store.listRuns();
    const journal = await readFile(
      path.join(root, ".repopilot", "runs", created.id, "events.jsonl"),
      "utf8"
    );

    expect(loaded).toEqual(created);
    expect(listed).toEqual([created]);
    expect(created).toMatchObject({
      version: 1,
      objective: "Add parser coverage",
      provider: "codex",
      status: "created",
      lastSequence: 1
    });
    expect(JSON.parse(journal.trim())).toMatchObject({
      version: 1,
      sequence: 1,
      type: "run.created"
    });
  });

  it("reconstructs tasks, artifacts, approvals, provider links, and status", async () => {
    const root = await fixture();
    const store = deterministicStore(root);
    const run = await store.createRun({ objective: "Implement workflow state" });

    await store.transitionRun(run.id, "planning");
    const task = await store.createTask(run.id, {
      objective: "Add event journal",
      writeSet: ["packages/workflow"],
      validationCommands: ["pnpm test"],
      completionCriteria: ["Journal reloads after restart"]
    });
    await store.transitionTask(run.id, task.id, "running");
    await store.transitionTask(run.id, task.id, "completed", "Journal implemented.");
    await store.recordArtifact(run.id, {
      kind: "report",
      path: ".repopilot/reports/workflow.md",
      summary: "Workflow implementation report"
    });
    const approval = await store.requestApproval(run.id, "apply");
    await store.decideApproval(run.id, approval.id, true, "Reviewed by maintainer.");
    await store.linkProviderThread(run.id, "codex", "thread-123");
    await store.transitionRun(run.id, "running");
    await store.transitionRun(run.id, "validating");
    await store.transitionRun(run.id, "reviewing");
    const completed = await store.transitionRun(run.id, "completed");

    expect(completed.status).toBe("completed");
    expect(completed.providerThreadId).toBe("thread-123");
    expect(completed.tasks).toEqual([
      expect.objectContaining({ id: task.id, status: "completed", writeSet: ["packages/workflow"] })
    ]);
    expect(completed.artifacts).toEqual([
      expect.objectContaining({ kind: "report", summary: "Workflow implementation report" })
    ]);
    expect(completed.approvals).toEqual([
      expect.objectContaining({ id: approval.id, status: "approved" })
    ]);
    expect(completed.lastSequence).toBe(13);
  });

  it("rejects invalid transitions and resumes interrupted runs through planning", async () => {
    const root = await fixture();
    const store = deterministicStore(root);
    const run = await store.createRun({ objective: "Resume safely" });

    await expect(store.transitionRun(run.id, "completed")).rejects.toThrow(
      "Invalid run status transition"
    );
    await store.transitionRun(run.id, "interrupted");
    const resumed = await store.resumeRun(run.id);

    expect(resumed.status).toBe("planning");
  });

  it("does not allow execution to skip validation and review gates", async () => {
    const root = await fixture();
    const store = deterministicStore(root);
    const run = await store.createRun({ objective: "Enforce workflow gates" });

    await store.transitionRun(run.id, "planning");
    await store.transitionRun(run.id, "running");
    await expect(store.transitionRun(run.id, "completed")).rejects.toThrow(
      "Invalid run status transition"
    );
    await store.transitionRun(run.id, "validating");
    await expect(store.transitionRun(run.id, "completed")).rejects.toThrow(
      "Invalid run status transition"
    );
  });

  it("detects corrupted journals instead of silently discarding events", async () => {
    const root = await fixture();
    const store = deterministicStore(root);
    const run = await store.createRun({ objective: "Detect corruption" });
    await appendFile(
      path.join(root, ".repopilot", "runs", run.id, "events.jsonl"),
      "not-json\n",
      "utf8"
    );

    await expect(store.loadRun(run.id)).rejects.toThrow("Invalid workflow journal at line 2");
  });
});

async function fixture(): Promise<string> {
  return mkdir(path.join(tmpdir(), `repopilot-workflow-${crypto.randomUUID()}`), {
    recursive: true
  });
}

function deterministicStore(root: string): WorkflowStore {
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000004"
  ];
  return new WorkflowStore(
    root,
    () => new Date("2026-09-20T12:00:00.000Z"),
    () => {
      const id = ids.shift();
      if (!id) throw new Error("Test ID pool exhausted.");
      return id;
    }
  );
}
