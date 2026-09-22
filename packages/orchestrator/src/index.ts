import { analyzeRepository, type RepositoryAnalysis } from "@repopilot/analyzer";
import path from "node:path";
import { z } from "zod";
import {
  canParallelizeTasks,
  safePolicy,
  type ExecutionPolicy,
  type PolicyTask
} from "@repopilot/policy";
import {
  providerResultSchema,
  type ProviderEvent,
  type ProviderRegistry,
  type ProviderResult
} from "@repopilot/provider";
import {
  WorkflowStore,
  type RunSnapshot,
  type WorkflowArtifact,
  type WorkflowTask
} from "@repopilot/workflow";

export interface WorkflowPlanInput {
  expectedScopes?: string[];
  readSet?: string[];
  completionCriteria?: string[];
}

export interface EngineValidationContext {
  run: RunSnapshot;
  task: WorkflowTask;
  result: ProviderResult;
}

export interface EngineValidationResult {
  passed: boolean;
  summary: string;
}

export type EngineValidator = (
  context: EngineValidationContext
) => Promise<EngineValidationResult> | EngineValidationResult;

export interface WorkflowEngineOptions {
  store: WorkflowStore;
  providers: ProviderRegistry;
  policy: ExecutionPolicy;
  analyze?: typeof analyzeRepository;
  validate?: EngineValidator;
  maxProviderEvents?: number;
}

export interface EngineOutcome {
  run: RunSnapshot;
  analysis?: RepositoryAnalysis;
  providerEvents: number;
}

const discoveryArtifactType = "repository-discovery";
const providerResultArtifactType = "provider-result";
const validationArtifactType = "engine-validation";
const planningArtifactType = "planning-intent";

const relativeScopeSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !path.win32.isAbsolute(value) &&
      !value.split(/[\\/]/u).includes("..") &&
      !value.includes("\0"),
    "Scope must be repository-relative."
  );

export const planningIntentSchema = z.strictObject({
  summary: z.string().trim().min(1).max(10_000),
  tasks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
        objective: z.string().trim().min(1).max(2_000),
        dependencies: z.array(z.string()).max(30),
        expectedScopes: z.array(relativeScopeSchema).min(1).max(50),
        readSet: z.array(relativeScopeSchema).max(100),
        writeSet: z.array(relativeScopeSchema).max(100),
        validationCommandIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/u)).max(30),
        completionCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(30)
      })
    )
    .min(1)
    .max(30),
  risks: z.array(z.string().trim().min(1).max(500)).max(30),
  questions: z.array(z.string().trim().min(1).max(500)).max(30)
});
export type PlanningIntent = z.infer<typeof planningIntentSchema>;

export function parsePlanningIntent(
  value: unknown,
  allowedCommandIds: readonly string[] = []
): PlanningIntent {
  const plan = planningIntentSchema.parse(value);
  const ids = new Set(plan.tasks.map((task) => task.id));
  if (ids.size !== plan.tasks.length) throw new Error("Planning task IDs must be unique.");
  const allowed = new Set(allowedCommandIds);
  for (const task of plan.tasks) {
    if (task.validationCommandIds.some((id) => !allowed.has(id))) {
      throw new Error(`Planning task ${task.id} references an untrusted command ID.`);
    }
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency))
        throw new Error(`Planning task ${task.id} has an unknown dependency.`);
    }
  }
  planTaskBatches(
    safePolicy,
    plan.tasks.map((task): PolicyTask => ({
      ...task,
      validationCommands: task.validationCommandIds
    }))
  );
  return plan;
}

export function planTaskBatches(policy: ExecutionPolicy, tasks: PolicyTask[]): PolicyTask[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  if (remaining.size !== tasks.length) throw new Error("Task IDs must be unique.");
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!remaining.has(dependency)) {
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}.`);
      }
    }
  }
  const completed = new Set<string>();
  const batches: PolicyTask[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((task) => task.dependencies.every((dependency) => completed.has(dependency)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) throw new Error("Task dependency graph contains a cycle.");

    while (ready.length > 0) {
      const first = ready.shift();
      if (!first) break;
      const batch = [first];
      for (let index = 0; index < ready.length && batch.length < policy.parallelism.max_workers;) {
        const candidate = ready[index];
        if (
          candidate &&
          batch.every(
            (existing) => canParallelizeTasks(policy, existing, candidate).canRunInParallel
          )
        ) {
          batch.push(candidate);
          ready.splice(index, 1);
        } else {
          index += 1;
        }
      }
      batches.push(batch);
      for (const task of batch) {
        remaining.delete(task.id);
        completed.add(task.id);
      }
    }
  }
  return batches;
}

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly providers: ProviderRegistry;
  private readonly policy: ExecutionPolicy;
  private readonly analyze: typeof analyzeRepository;
  private readonly validate: EngineValidator;
  private readonly maxProviderEvents: number;
  private readonly activeRuns = new Set<string>();

  constructor(options: WorkflowEngineOptions) {
    this.store = options.store;
    this.providers = options.providers;
    this.policy = options.policy;
    this.analyze = options.analyze ?? analyzeRepository;
    this.validate = options.validate ?? defaultEngineValidator;
    this.maxProviderEvents = options.maxProviderEvents ?? 10_000;
    if (!Number.isInteger(this.maxProviderEvents) || this.maxProviderEvents < 1) {
      throw new Error("maxProviderEvents must be a positive integer.");
    }
  }

  async run(runId: string, plan: WorkflowPlanInput = {}): Promise<EngineOutcome> {
    return this.exclusive(runId, async () => {
      let analysis: RepositoryAnalysis | undefined;
      let providerEvents = 0;
      try {
        const prepared = await this.prepareInternal(runId, plan);
        analysis = prepared.analysis;
        const executed = await this.executeInternal(runId);
        providerEvents = executed.providerEvents;
        return {
          run: executed.run,
          ...(analysis ? { analysis } : {}),
          providerEvents
        };
      } catch (error) {
        return {
          run: await this.failRun(runId, error),
          ...(analysis ? { analysis } : {}),
          providerEvents
        };
      }
    });
  }

  async prepare(runId: string, plan: WorkflowPlanInput = {}): Promise<RunSnapshot> {
    return this.exclusive(runId, async () => (await this.prepareInternal(runId, plan)).run);
  }

  async execute(runId: string): Promise<EngineOutcome> {
    return this.exclusive(runId, async () => {
      try {
        return await this.executeInternal(runId);
      } catch (error) {
        return { run: await this.failRun(runId, error), providerEvents: 0 };
      }
    });
  }

  async cancel(runId: string): Promise<RunSnapshot> {
    return this.exclusive(runId, async () => {
      let run = await this.store.loadRun(runId);
      if (run.status === "completed" || run.status === "cancelled") return run;
      if (run.provider && run.providerThreadId) {
        try {
          await this.providers.get(run.provider).cancel(run.providerThreadId);
        } catch (error) {
          await this.store.recordNote(runId, errorMessage(error));
        }
      }
      for (const task of run.tasks) {
        if (["pending", "running", "blocked", "failed"].includes(task.status)) {
          await this.store.transitionTask(runId, task.id, "cancelled", "Run cancelled.");
        }
      }
      run = await this.store.loadRun(runId);
      if (run.status !== "cancelled") {
        run = await this.store.transitionRun(runId, "cancelled", "Run cancelled.");
      }
      return run;
    });
  }

  private async prepareInternal(
    runId: string,
    plan: WorkflowPlanInput
  ): Promise<{ run: RunSnapshot; analysis?: RepositoryAnalysis }> {
    let run = await this.store.loadRun(runId);
    let analysis: RepositoryAnalysis | undefined;
    if (run.status === "failed" || run.status === "interrupted") {
      run = await this.store.resumeRun(runId);
    }
    if (run.status === "created") {
      run = await this.store.transitionRun(runId, "discovering", "Repository discovery started.");
    }
    if (run.status === "discovering") {
      analysis = await this.analyze(run.repositoryRoot);
      if (!findArtifact(run, discoveryArtifactType)) {
        await this.store.recordArtifact(runId, {
          kind: "report",
          summary: discoverySummary(analysis),
          metadata: { type: discoveryArtifactType, repositoryEvidence: planningEvidence(analysis) }
        });
      }
      run = await this.store.transitionRun(runId, "analyzing", "Repository evidence normalized.");
    }
    if (run.status === "analyzing") {
      if (run.tasks.length === 0) {
        await this.store.createTask(runId, {
          objective: run.objective,
          expectedScopes: plan.expectedScopes ?? ["."],
          readSet: plan.readSet ?? analysisReadSet(analysis),
          writeSet: [],
          validationCommands: [],
          completionCriteria: plan.completionCriteria ?? ["Provider returns a structured result."]
        });
      }
      run = await this.store.transitionRun(runId, "planning", "Deterministic task plan created.");
    }
    if (run.status !== "planning") {
      throw new Error(`Run ${runId} cannot be prepared from status ${run.status}.`);
    }
    return { run, ...(analysis ? { analysis } : {}) };
  }

  private async executeInternal(runId: string): Promise<EngineOutcome> {
    let run = await this.store.loadRun(runId);
    const retryingFailedRun = run.status === "failed";
    if (["created", "discovering", "analyzing", "failed", "interrupted"].includes(run.status)) {
      run = (await this.prepareInternal(runId, {})).run;
    }
    const task = requireSingleTask(run);
    let providerEvents = 0;

    if (run.status === "planning") {
      run = await this.store.transitionRun(runId, "authorizing", "Provider authorization started.");
    }
    if (run.status === "authorizing") {
      const provider = requireProvider(run, this.providers);
      const health = await provider.healthCheck();
      if (health.status !== "available") {
        throw new Error(`Provider ${provider.id} is ${health.status}: ${health.message}`);
      }
      if (!provider.capabilities().includes("structured_results")) {
        throw new Error(`Provider ${provider.id} does not support structured results.`);
      }
      if (task.status === "failed") await this.store.transitionTask(runId, task.id, "pending");
      run = await this.store.transitionRun(
        runId,
        "running",
        "Provider authorized for read-only planning."
      );
    }

    if (run.status === "running") {
      const currentTask = requireSingleTask(run);
      if (currentTask.status === "pending" || currentTask.status === "blocked") {
        await this.store.transitionTask(runId, currentTask.id, "running");
      }
      let result = recoverProviderResult(run, currentTask.id);
      if (!result) {
        const provider = requireProvider(run, this.providers);
        const execution = run.providerThreadId
          ? await provider.resume(run.providerThreadId, providerRequest(run, currentTask.id))
          : await provider.start(providerRequest(run, currentTask.id));
        if (!run.providerThreadId) {
          run = await this.store.linkProviderThread(runId, provider.id, execution.threadId);
        }
        const consumed = await consumeProviderEvents(execution.events, this.maxProviderEvents);
        providerEvents = consumed.count;
        if (consumed.terminal.type === "run.cancelled") {
          await this.store.transitionTask(
            runId,
            currentTask.id,
            "cancelled",
            "Provider cancelled."
          );
          return {
            run: await this.store.transitionRun(runId, "cancelled", "Provider cancelled the run."),
            providerEvents
          };
        }
        if (consumed.terminal.type === "run.failed") {
          throw new Error(consumed.terminal.message);
        }
        result = consumed.terminal.result;
        const output = persistableOutput(result.output);
        await this.store.recordArtifact(runId, {
          kind: "report",
          summary: boundedSummary(result.summary),
          metadata: {
            type: providerResultArtifactType,
            taskId: currentTask.id,
            status: result.status,
            output
          }
        });
      }
      run = await this.store.transitionRun(runId, "validating", "Provider result recorded.");
    }

    if (run.status === "validating") {
      const currentTask = requireSingleTask(run);
      const result = recoverProviderResult(run, currentTask.id);
      if (!result) throw new Error("Recorded provider result is missing before validation.");
      const plan = parsePlanningIntent(result.output.plan);
      if (!run.artifacts.some((artifact) => artifact.metadata?.type === planningArtifactType)) {
        await this.store.recordArtifact(runId, {
          kind: "proposal",
          summary: plan.summary,
          metadata: { type: planningArtifactType, plan }
        });
      }
      let validation = retryingFailedRun ? undefined : recoverEngineValidation(run, currentTask.id);
      if (!validation) {
        validation = await this.validate({ run, task: currentTask, result });
        await this.store.recordArtifact(runId, {
          kind: "report",
          summary: boundedSummary(validation.summary),
          metadata: {
            type: validationArtifactType,
            taskId: currentTask.id,
            passed: validation.passed
          }
        });
      }
      if (!validation.passed) throw new Error(`Engine validation failed: ${validation.summary}`);
      if (currentTask.status === "running") {
        await this.store.transitionTask(runId, currentTask.id, "completed", validation.summary);
      }
      run = await this.store.transitionRun(runId, "reviewing", "Validation passed.");
    }

    if (run.status === "reviewing") {
      run = await this.store.transitionRun(
        runId,
        "completed",
        "Read-only provider workflow completed."
      );
    }
    if (run.status !== "completed") {
      throw new Error(`Run ${runId} stopped in unsupported status ${run.status}.`);
    }
    return { run, providerEvents };
  }

  private async failRun(runId: string, error: unknown): Promise<RunSnapshot> {
    const message = boundedSummary(errorMessage(error));
    let run = await this.store.loadRun(runId);
    const task = run.tasks[0];
    if (task && ["pending", "running", "blocked"].includes(task.status)) {
      await this.store.transitionTask(runId, task.id, "failed", message);
    }
    if (this.policy.failure_handling.create_failure_report) {
      await this.store.recordArtifact(runId, {
        kind: "report",
        summary: message,
        metadata: { type: "failure-report" }
      });
    }
    run = await this.store.loadRun(runId);
    if (!["failed", "completed", "cancelled"].includes(run.status)) {
      run = await this.store.transitionRun(runId, "failed", message);
    }
    return run;
  }

  private async exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeRuns.has(runId)) throw new Error(`Run is already active: ${runId}`);
    this.activeRuns.add(runId);
    try {
      return await operation();
    } finally {
      this.activeRuns.delete(runId);
    }
  }
}

function requireSingleTask(run: RunSnapshot): WorkflowTask {
  if (run.tasks.length !== 1 || !run.tasks[0]) {
    throw new Error(`Run ${run.id} must contain exactly one task in this milestone.`);
  }
  return run.tasks[0];
}

function requireProvider(run: RunSnapshot, providers: ProviderRegistry) {
  if (!run.provider) throw new Error(`Run ${run.id} does not select a provider.`);
  return providers.get(run.provider);
}

function providerRequest(run: RunSnapshot, taskId: string) {
  const evidence = findArtifact(run, discoveryArtifactType)?.metadata?.repositoryEvidence ?? {};
  return {
    objective: `Plan this task without modifying repository files: ${run.objective}`,
    repositoryRoot: run.repositoryRoot,
    metadata: {
      runId: run.id,
      taskId,
      access: "read-only",
      repositoryEvidence: JSON.stringify(evidence)
    }
  };
}

function planningEvidence(analysis: RepositoryAnalysis): Record<string, unknown> {
  const evidence: Record<string, unknown> = {
    scannedFileCount: analysis.metadata.scannedFileCount,
    truncated: false
  };
  const categories = {
    languages: analysis.languages,
    packageManagers: analysis.packageManagers,
    manifests: analysis.manifests,
    workspaces: analysis.workspaces,
    testFrameworks: analysis.testFrameworks,
    ciWorkflows: analysis.ciWorkflows,
    agentInstructions: analysis.agentInstructions
  };
  for (const [name, entries] of Object.entries(categories)) {
    const selected: unknown[] = [];
    evidence[name] = selected;
    for (const entry of entries) {
      selected.push(entry);
      if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > 20_000) {
        selected.pop();
        evidence.truncated = true;
        break;
      }
    }
  }
  return evidence;
}

async function consumeProviderEvents(
  events: AsyncIterable<ProviderEvent>,
  maximum: number
): Promise<{
  terminal: Extract<ProviderEvent, { type: "result.completed" | "run.failed" | "run.cancelled" }>;
  count: number;
}> {
  let count = 0;
  for await (const event of events) {
    count += 1;
    if (count > maximum) throw new Error(`Provider event limit exceeded (${maximum}).`);
    if (
      event.type === "result.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      return { terminal: event, count };
    }
  }
  throw new Error("Provider stream ended without a terminal event.");
}

function findArtifact(run: RunSnapshot, type: string): WorkflowArtifact | undefined {
  return run.artifacts.find((artifact) => artifact.metadata?.type === type);
}

function recoverProviderResult(run: RunSnapshot, taskId: string): ProviderResult | undefined {
  const artifact = run.artifacts.find(
    (candidate) =>
      candidate.metadata?.type === providerResultArtifactType &&
      candidate.metadata.taskId === taskId
  );
  if (!artifact) return undefined;
  return providerResultSchema.parse({
    status: artifact.metadata?.status,
    summary: artifact.summary,
    output: artifact.metadata?.output ?? {}
  });
}

function recoverEngineValidation(
  run: RunSnapshot,
  taskId: string
): EngineValidationResult | undefined {
  const artifact = [...run.artifacts]
    .reverse()
    .find(
      (candidate) =>
        candidate.metadata?.type === validationArtifactType && candidate.metadata.taskId === taskId
    );
  if (!artifact || typeof artifact.metadata?.passed !== "boolean") return undefined;
  return { passed: artifact.metadata.passed, summary: artifact.summary };
}

function discoverySummary(analysis: RepositoryAnalysis): string {
  return `Repository discovery completed: ${analysis.metadata.scannedFileCount.value} files scanned, ${analysis.manifests.length} manifests, ${analysis.warnings.length} warnings.`;
}

function analysisReadSet(analysis: RepositoryAnalysis | undefined): string[] {
  if (!analysis) return [];
  return [
    ...analysis.manifests.map((manifest) => manifest.path),
    ...analysis.ciWorkflows.map((workflow) => workflow.path),
    ...analysis.agentInstructions.map((instruction) => instruction.path)
  ].sort();
}

function boundedSummary(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "No summary was provided.";
  return trimmed.length <= 10_000 ? trimmed : `${trimmed.slice(0, 9_997)}...`;
}

function persistableOutput(output: Record<string, unknown>): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    throw new Error("Provider structured output is not JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 100_000) {
    throw new Error("Provider structured output exceeds the 100,000-byte persistence limit.");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider structured output must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workflow engine failed.";
}

function defaultEngineValidator(context: EngineValidationContext): EngineValidationResult {
  return context.result.status === "completed"
    ? { passed: true, summary: "Structured provider result validated." }
    : { passed: false, summary: `Provider result status is ${context.result.status}.` };
}
