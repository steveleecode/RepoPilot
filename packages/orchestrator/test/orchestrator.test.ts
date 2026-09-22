import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { balancedPolicy, type PolicyTask } from "@repopilot/policy";
import { FakeAgentProvider, ProviderRegistry } from "@repopilot/provider";
import { WorkflowStore } from "@repopilot/workflow";
import { parsePlanningIntent, planTaskBatches, WorkflowEngine } from "../src/index.js";

describe("PlanningIntent", () => {
  const plan = {
    summary: "Plan parser coverage.",
    tasks: [
      {
        id: "parser",
        objective: "Add coverage",
        dependencies: [],
        expectedScopes: ["tests"],
        readSet: [],
        writeSet: [],
        validationCommandIds: [],
        completionCriteria: ["Tests planned"]
      }
    ],
    risks: [],
    questions: []
  };

  it("accepts a bounded plan and rejects unsafe scopes, commands, and cycles", () => {
    expect(parsePlanningIntent(plan).tasks[0]?.id).toBe("parser");
    expect(() =>
      parsePlanningIntent({ ...plan, tasks: [{ ...plan.tasks[0], writeSet: ["../secret"] }] })
    ).toThrow();
    expect(() =>
      parsePlanningIntent({
        ...plan,
        tasks: [{ ...plan.tasks[0], validationCommandIds: ["shell"] }]
      })
    ).toThrow("untrusted command ID");
    expect(() =>
      parsePlanningIntent({ ...plan, tasks: [{ ...plan.tasks[0], dependencies: ["parser"] }] })
    ).toThrow("cycle");
  });
});

describe("planTaskBatches", () => {
  it("batches independent read-only tasks up to the policy worker limit", () => {
    const tasks = [policyTask("c"), policyTask("a"), policyTask("b")];

    expect(planTaskBatches(balancedPolicy, tasks).map(ids)).toEqual([["a", "b", "c"]]);
  });

  it("orders dependent tasks after their prerequisites", () => {
    const tasks = [policyTask("build", ["analyze"]), policyTask("analyze")];

    expect(planTaskBatches(balancedPolicy, tasks).map(ids)).toEqual([["analyze"], ["build"]]);
  });

  it("separates tasks with overlapping write scopes", () => {
    const tasks = [policyTask("a", [], ["src"]), policyTask("b", [], ["src/index.ts"])];

    expect(planTaskBatches(balancedPolicy, tasks).map(ids)).toEqual([["a"], ["b"]]);
  });

  it("rejects unknown dependencies and dependency cycles", () => {
    expect(() => planTaskBatches(balancedPolicy, [policyTask("a", ["missing"])])).toThrow(
      "depends on unknown task"
    );
    expect(() =>
      planTaskBatches(balancedPolicy, [policyTask("a", ["b"]), policyTask("b", ["a"])])
    ).toThrow("contains a cycle");
  });
});

describe("WorkflowEngine", () => {
  it("runs discovery, planning, provider execution, validation, and review in order", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Plan parser coverage", provider: "fake" });
    const engine = engineFor(store);

    const outcome = await engine.run(run.id);
    const statuses = await statusTransitions(root, run.id);

    expect(outcome.run.status).toBe("completed");
    expect(outcome.run.tasks[0]?.status).toBe("completed");
    expect(outcome.run.providerThreadId).toBeTruthy();
    expect(outcome.run.artifacts.map((artifact) => artifact.metadata?.type)).toEqual([
      "repository-discovery",
      "provider-result",
      "planning-intent",
      "engine-validation"
    ]);
    expect(statuses).toEqual([
      "discovering",
      "analyzing",
      "planning",
      "authorizing",
      "running",
      "validating",
      "reviewing",
      "completed"
    ]);
  });

  it("persists validation failure and resumes without rerunning the provider", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Validate a plan", provider: "fake" });
    let validationAttempts = 0;
    const engine = engineFor(store, {
      validate: () => {
        validationAttempts += 1;
        return validationAttempts === 1
          ? { passed: false, summary: "Review failed." }
          : { passed: true, summary: "Review passed." };
      }
    });

    const failed = await engine.run(run.id);
    const resumed = await engine.execute(run.id);

    expect(failed.run.status).toBe("failed");
    expect(failed.run.tasks[0]?.status).toBe("failed");
    expect(resumed.run.status).toBe("completed");
    expect(resumed.run.tasks[0]?.status).toBe("completed");
    expect(
      resumed.run.artifacts.filter((artifact) => artifact.metadata?.type === "provider-result")
    ).toHaveLength(1);
    expect(validationAttempts).toBe(2);
  });

  it("fails closed when the selected provider is not configured", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Use missing provider", provider: "codex" });
    const engine = new WorkflowEngine({
      store,
      providers: new ProviderRegistry(),
      policy: balancedPolicy
    });

    const outcome = await engine.run(run.id);

    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.tasks[0]?.status).toBe("failed");
    expect(outcome.run.artifacts.at(-1)?.summary).toContain("not configured");
  });

  it("cancels a prepared run and all pending tasks", async () => {
    const root = await fixture();
    const store = new WorkflowStore(root);
    const run = await store.createRun({ objective: "Cancel safely", provider: "fake" });
    const engine = engineFor(store);
    await engine.prepare(run.id);

    const cancelled = await engine.cancel(run.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.tasks[0]?.status).toBe("cancelled");
  });
});

function engineFor(
  store: WorkflowStore,
  overrides: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {}
): WorkflowEngine {
  return new WorkflowEngine({
    store,
    providers: new ProviderRegistry([new FakeAgentProvider({ response: "Plan complete." })]),
    policy: balancedPolicy,
    ...overrides
  });
}

async function fixture(): Promise<string> {
  const root = await mkdir(path.join(tmpdir(), `repopilot-engine-${crypto.randomUUID()}`), {
    recursive: true
  });
  await writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}');
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

async function statusTransitions(root: string, runId: string): Promise<string[]> {
  const journal = await readFile(
    path.join(root, ".repopilot", "runs", runId, "events.jsonl"),
    "utf8"
  );
  return journal
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload?: { to?: string } })
    .filter((event) => event.type === "run.status_changed")
    .flatMap((event) => (event.payload?.to ? [event.payload.to] : []));
}

function policyTask(id: string, dependencies: string[] = [], writeSet: string[] = []): PolicyTask {
  return {
    id,
    objective: `Complete ${id}`,
    expectedScopes: writeSet.length > 0 ? writeSet : [`docs/${id}`],
    dependencies,
    readSet: [],
    writeSet,
    validationCommands: [`validate-${id}`],
    completionCriteria: [`${id} is complete`]
  };
}

function ids(tasks: PolicyTask[]): string[] {
  return tasks.map((task) => task.id);
}
