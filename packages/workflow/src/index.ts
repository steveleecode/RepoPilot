import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const runStatusSchema = z.enum([
  "created",
  "planning",
  "awaiting_approval",
  "running",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled"
]);

export const workflowTaskSchema = z.object({
  id: z.uuid(),
  objective: z.string().min(1),
  status: taskStatusSchema,
  dependencies: z.array(z.uuid()),
  expectedScopes: z.array(z.string()),
  readSet: z.array(z.string()),
  writeSet: z.array(z.string()),
  validationCommands: z.array(z.string()),
  completionCriteria: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const workflowArtifactSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["proposal", "diff", "report", "log"]),
  path: z.string().min(1).optional(),
  summary: z.string().min(1),
  createdAt: z.iso.datetime()
});

export const workflowApprovalSchema = z.object({
  id: z.uuid(),
  action: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected"]),
  requestedAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().optional(),
  reason: z.string().min(1).optional()
});

const createdRunSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  objective: z.string().min(1),
  repositoryRoot: z.string().min(1),
  status: z.literal("created"),
  provider: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export const runSnapshotSchema = createdRunSchema.omit({ status: true }).extend({
  status: runStatusSchema,
  providerThreadId: z.string().min(1).optional(),
  lastSequence: z.number().int().positive(),
  tasks: z.array(workflowTaskSchema),
  artifacts: z.array(workflowArtifactSchema),
  approvals: z.array(workflowApprovalSchema)
});

const eventEnvelope = {
  version: z.literal(1),
  runId: z.uuid(),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime()
};

export const workflowEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventEnvelope,
    type: z.literal("run.created"),
    payload: z.object({ run: createdRunSchema })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.status_changed"),
    payload: z.object({
      from: runStatusSchema,
      to: runStatusSchema,
      reason: z.string().min(1).optional()
    })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.created"),
    payload: z.object({ task: workflowTaskSchema })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.status_changed"),
    payload: z.object({
      taskId: z.uuid(),
      from: taskStatusSchema,
      to: taskStatusSchema,
      summary: z.string().min(1).optional()
    })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("artifact.recorded"),
    payload: z.object({ artifact: workflowArtifactSchema })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("approval.requested"),
    payload: z.object({ approval: workflowApprovalSchema })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("approval.decided"),
    payload: z.object({
      approvalId: z.uuid(),
      approved: z.boolean(),
      decidedAt: z.iso.datetime(),
      reason: z.string().min(1).optional()
    })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("provider.thread_linked"),
    payload: z.object({ provider: z.string().min(1), threadId: z.string().min(1) })
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("note.recorded"),
    payload: z.object({ message: z.string().min(1) })
  })
]);

export type RunStatus = z.infer<typeof runStatusSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type WorkflowTask = z.infer<typeof workflowTaskSchema>;
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>;
export type WorkflowApproval = z.infer<typeof workflowApprovalSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type WorkflowEvent = z.infer<typeof workflowEventSchema>;

export interface CreateTaskInput {
  objective: string;
  dependencies?: string[];
  expectedScopes?: string[];
  readSet?: string[];
  writeSet?: string[];
  validationCommands?: string[];
  completionCriteria?: string[];
}

const runTransitions: Record<RunStatus, RunStatus[]> = {
  created: ["planning", "cancelled", "interrupted"],
  planning: ["awaiting_approval", "running", "failed", "cancelled", "interrupted"],
  awaiting_approval: ["running", "cancelled", "interrupted"],
  running: ["awaiting_approval", "validating", "completed", "failed", "cancelled", "interrupted"],
  validating: ["running", "completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: ["planning", "running", "cancelled"],
  cancelled: [],
  interrupted: ["planning", "running", "cancelled"]
};

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running", "blocked", "cancelled"],
  running: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["pending", "running", "cancelled"],
  completed: [],
  failed: ["pending", "running", "cancelled"],
  cancelled: []
};

export class WorkflowStore {
  readonly runsRoot: string;

  constructor(
    readonly repositoryRoot: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {
    this.runsRoot = path.join(path.resolve(repositoryRoot), ".repopilot", "runs");
  }

  async createRun(input: { objective: string; provider?: string }): Promise<RunSnapshot> {
    const id = z.uuid().parse(this.createId());
    const timestamp = this.now().toISOString();
    const run = createdRunSchema.parse({
      version: 1,
      id,
      objective: input.objective,
      repositoryRoot: path.resolve(this.repositoryRoot),
      status: "created",
      ...(input.provider ? { provider: input.provider } : {}),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const event = workflowEventSchema.parse({
      version: 1,
      runId: id,
      sequence: 1,
      timestamp,
      type: "run.created",
      payload: { run }
    });
    await mkdir(this.runsRoot, { recursive: true });
    await mkdir(this.runDirectory(id));
    await writeFile(this.journalPath(id), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    return this.loadRun(id);
  }

  async loadRun(runId: string): Promise<RunSnapshot> {
    return projectRun(await this.readEvents(runId));
  }

  async listRuns(): Promise<RunSnapshot[]> {
    let entries;
    try {
      entries = await readdir(this.runsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const runIds = entries
      .filter((entry) => entry.isDirectory() && z.uuid().safeParse(entry.name).success)
      .map((entry) => entry.name);
    const runs = await Promise.all(runIds.map((runId) => this.loadRun(runId)));
    return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async transitionRun(runId: string, to: RunStatus, reason?: string): Promise<RunSnapshot> {
    const snapshot = await this.loadRun(runId);
    requireTransition("run", snapshot.status, to, runTransitions[snapshot.status]);
    await this.appendEvent(runId, "run.status_changed", {
      from: snapshot.status,
      to,
      ...(reason ? { reason } : {})
    });
    return this.loadRun(runId);
  }

  async resumeRun(runId: string): Promise<RunSnapshot> {
    const snapshot = await this.loadRun(runId);
    if (snapshot.status !== "failed" && snapshot.status !== "interrupted") {
      throw new Error(`Run ${runId} cannot resume from status ${snapshot.status}.`);
    }
    return this.transitionRun(runId, "planning", "Run resumed by the user.");
  }

  async createTask(runId: string, input: CreateTaskInput): Promise<WorkflowTask> {
    await this.loadRun(runId);
    const timestamp = this.now().toISOString();
    const task = workflowTaskSchema.parse({
      id: this.createId(),
      objective: input.objective,
      status: "pending",
      dependencies: input.dependencies ?? [],
      expectedScopes: input.expectedScopes ?? [],
      readSet: input.readSet ?? [],
      writeSet: input.writeSet ?? [],
      validationCommands: input.validationCommands ?? [],
      completionCriteria: input.completionCriteria ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await this.appendEvent(runId, "task.created", { task });
    return task;
  }

  async transitionTask(
    runId: string,
    taskId: string,
    to: TaskStatus,
    summary?: string
  ): Promise<WorkflowTask> {
    const snapshot = await this.loadRun(runId);
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    requireTransition("task", task.status, to, taskTransitions[task.status]);
    await this.appendEvent(runId, "task.status_changed", {
      taskId,
      from: task.status,
      to,
      ...(summary ? { summary } : {})
    });
    const updated = (await this.loadRun(runId)).tasks.find((candidate) => candidate.id === taskId);
    if (!updated) throw new Error(`Task disappeared while updating: ${taskId}`);
    return updated;
  }

  async recordArtifact(
    runId: string,
    input: Omit<WorkflowArtifact, "id" | "createdAt">
  ): Promise<WorkflowArtifact> {
    await this.loadRun(runId);
    const artifact = workflowArtifactSchema.parse({
      id: this.createId(),
      ...input,
      createdAt: this.now().toISOString()
    });
    await this.appendEvent(runId, "artifact.recorded", { artifact });
    return artifact;
  }

  async requestApproval(runId: string, action: string): Promise<WorkflowApproval> {
    await this.loadRun(runId);
    const approval = workflowApprovalSchema.parse({
      id: this.createId(),
      action,
      status: "pending",
      requestedAt: this.now().toISOString()
    });
    await this.appendEvent(runId, "approval.requested", { approval });
    return approval;
  }

  async decideApproval(
    runId: string,
    approvalId: string,
    approved: boolean,
    reason?: string
  ): Promise<WorkflowApproval> {
    const snapshot = await this.loadRun(runId);
    const approval = snapshot.approvals.find((candidate) => candidate.id === approvalId);
    if (!approval) throw new Error(`Approval not found: ${approvalId}`);
    if (approval.status !== "pending")
      throw new Error(`Approval ${approvalId} is already decided.`);
    await this.appendEvent(runId, "approval.decided", {
      approvalId,
      approved,
      decidedAt: this.now().toISOString(),
      ...(reason ? { reason } : {})
    });
    const updated = (await this.loadRun(runId)).approvals.find(
      (candidate) => candidate.id === approvalId
    );
    if (!updated) throw new Error(`Approval disappeared while updating: ${approvalId}`);
    return updated;
  }

  async linkProviderThread(
    runId: string,
    provider: string,
    threadId: string
  ): Promise<RunSnapshot> {
    await this.appendEvent(runId, "provider.thread_linked", { provider, threadId });
    return this.loadRun(runId);
  }

  async recordNote(runId: string, message: string): Promise<void> {
    await this.appendEvent(runId, "note.recorded", { message });
  }

  private async appendEvent(runId: string, type: WorkflowEvent["type"], payload: unknown) {
    const events = await this.readEvents(runId);
    const event = workflowEventSchema.parse({
      version: 1,
      runId,
      sequence: events.length + 1,
      timestamp: this.now().toISOString(),
      type,
      payload
    });
    await appendFile(this.journalPath(runId), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  private async readEvents(runId: string): Promise<WorkflowEvent[]> {
    z.uuid().parse(runId);
    const content = await readFile(this.journalPath(runId), "utf8");
    const events = content
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return workflowEventSchema.parse(JSON.parse(line) as unknown);
        } catch (error) {
          throw new Error(`Invalid workflow journal at line ${index + 1}.`, { cause: error });
        }
      });
    if (events.length === 0) throw new Error(`Workflow journal is empty: ${runId}`);
    events.forEach((event, index) => {
      if (event.runId !== runId)
        throw new Error(`Workflow journal run ID mismatch at line ${index + 1}.`);
      if (event.sequence !== index + 1) {
        throw new Error(`Workflow journal sequence mismatch at line ${index + 1}.`);
      }
    });
    return events;
  }

  private runDirectory(runId: string): string {
    return path.join(this.runsRoot, z.uuid().parse(runId));
  }

  private journalPath(runId: string): string {
    return path.join(this.runDirectory(runId), "events.jsonl");
  }
}

function projectRun(events: WorkflowEvent[]): RunSnapshot {
  const first = events[0];
  if (!first || first.type !== "run.created") {
    throw new Error("Workflow journal must begin with run.created.");
  }
  const run = first.payload.run;
  let status: RunStatus = run.status;
  let updatedAt = run.updatedAt;
  let provider = run.provider;
  let providerThreadId: string | undefined;
  const tasks = new Map<string, WorkflowTask>();
  const artifacts = new Map<string, WorkflowArtifact>();
  const approvals = new Map<string, WorkflowApproval>();

  for (const event of events.slice(1)) {
    updatedAt = event.timestamp;
    if (event.type === "run.status_changed") {
      if (status !== event.payload.from)
        throw new Error("Run journal contains a stale status transition.");
      status = event.payload.to;
    } else if (event.type === "task.created") {
      if (tasks.has(event.payload.task.id))
        throw new Error("Run journal contains a duplicate task.");
      tasks.set(event.payload.task.id, event.payload.task);
    } else if (event.type === "task.status_changed") {
      const task = tasks.get(event.payload.taskId);
      if (!task) throw new Error(`Run journal references unknown task ${event.payload.taskId}.`);
      if (task.status !== event.payload.from)
        throw new Error("Run journal contains a stale task transition.");
      tasks.set(task.id, { ...task, status: event.payload.to, updatedAt: event.timestamp });
    } else if (event.type === "artifact.recorded") {
      artifacts.set(event.payload.artifact.id, event.payload.artifact);
    } else if (event.type === "approval.requested") {
      approvals.set(event.payload.approval.id, event.payload.approval);
    } else if (event.type === "approval.decided") {
      const approval = approvals.get(event.payload.approvalId);
      if (!approval)
        throw new Error(`Run journal references unknown approval ${event.payload.approvalId}.`);
      if (approval.status !== "pending")
        throw new Error("Run journal decides an approval more than once.");
      approvals.set(approval.id, {
        ...approval,
        status: event.payload.approved ? "approved" : "rejected",
        decidedAt: event.payload.decidedAt,
        ...(event.payload.reason ? { reason: event.payload.reason } : {})
      });
    } else if (event.type === "provider.thread_linked") {
      provider = event.payload.provider;
      providerThreadId = event.payload.threadId;
    }
  }

  return runSnapshotSchema.parse({
    ...run,
    status,
    updatedAt,
    ...(provider ? { provider } : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    lastSequence: events.length,
    tasks: [...tasks.values()],
    artifacts: [...artifacts.values()],
    approvals: [...approvals.values()]
  });
}

function requireTransition(
  subject: "run" | "task",
  from: string,
  to: string,
  allowed: string[]
): void {
  if (!allowed.includes(to))
    throw new Error(`Invalid ${subject} status transition: ${from} -> ${to}.`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
