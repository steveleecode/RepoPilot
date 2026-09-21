import { randomUUID } from "node:crypto";
import { z } from "zod";

export const providerCapabilitySchema = z.enum([
  "start",
  "resume",
  "cancel",
  "event_streaming",
  "structured_results",
  "health_check"
]);

export const providerHealthSchema = z.object({
  status: z.enum(["available", "unavailable", "degraded"]),
  message: z.string().min(1),
  version: z.string().min(1).optional()
});

export const providerRunRequestSchema = z.object({
  objective: z.string().min(1),
  repositoryRoot: z.string().min(1),
  metadata: z.record(z.string(), z.string()).default({})
});

const eventEnvelope = {
  id: z.uuid(),
  providerId: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime()
};

export const providerResultSchema = z.object({
  status: z.enum(["completed", "failed", "cancelled"]),
  summary: z.string().min(1),
  output: z.record(z.string(), z.unknown()).default({})
});

export const providerEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventEnvelope, type: z.literal("thread.started") }),
  z.object({ ...eventEnvelope, type: z.literal("turn.started") }),
  z.object({
    ...eventEnvelope,
    type: z.literal("message.delta"),
    delta: z.string()
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("result.completed"),
    result: providerResultSchema
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.failed"),
    message: z.string().min(1)
  }),
  z.object({ ...eventEnvelope, type: z.literal("run.cancelled") })
]);

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type ProviderRunRequest = z.infer<typeof providerRunRequestSchema>;
export type ProviderResult = z.infer<typeof providerResultSchema>;
export type ProviderEvent = z.infer<typeof providerEventSchema>;

export interface ProviderExecution {
  threadId: string;
  events: AsyncIterable<ProviderEvent>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  capabilities(): ProviderCapability[];
  healthCheck(): Promise<ProviderHealth>;
  start(request: ProviderRunRequest): Promise<ProviderExecution>;
  resume(threadId: string, request: ProviderRunRequest): Promise<ProviderExecution>;
  cancel(threadId: string): Promise<void>;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  integration: "built-in" | "transport-required";
  capabilities: ProviderCapability[];
}

const standardCapabilities: ProviderCapability[] = [
  "start",
  "resume",
  "cancel",
  "event_streaming",
  "structured_results",
  "health_check"
];

export function listProviderDefinitions(): ProviderDefinition[] {
  return [
    {
      id: "codex",
      displayName: "OpenAI Codex",
      integration: "transport-required",
      capabilities: [...standardCapabilities]
    },
    {
      id: "fake",
      displayName: "Deterministic fake provider",
      integration: "built-in",
      capabilities: [...standardCapabilities]
    }
  ];
}

export interface FakeProviderOptions {
  response?: string;
  now?: () => Date;
  createId?: () => string;
}

export class FakeAgentProvider implements AgentProvider {
  readonly id = "fake";
  readonly displayName = "Deterministic fake provider";
  private readonly cancelledThreads = new Set<string>();
  private readonly knownThreads = new Set<string>();
  private readonly response: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: FakeProviderOptions = {}) {
    this.response = options.response ?? "Fake provider completed the task.";
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  capabilities(): ProviderCapability[] {
    return [...standardCapabilities];
  }

  healthCheck(): Promise<ProviderHealth> {
    return Promise.resolve({
      status: "available",
      message: "The deterministic fake provider is available."
    });
  }

  start(request: ProviderRunRequest): Promise<ProviderExecution> {
    const parsed = providerRunRequestSchema.parse(request);
    const threadId = this.createId();
    this.knownThreads.add(threadId);
    return Promise.resolve({ threadId, events: this.events(threadId, parsed, true) });
  }

  resume(threadId: string, request: ProviderRunRequest): Promise<ProviderExecution> {
    if (!this.knownThreads.has(threadId))
      throw new Error(`Unknown fake provider thread: ${threadId}`);
    const parsed = providerRunRequestSchema.parse(request);
    return Promise.resolve({ threadId, events: this.events(threadId, parsed, false) });
  }

  cancel(threadId: string): Promise<void> {
    if (!this.knownThreads.has(threadId))
      throw new Error(`Unknown fake provider thread: ${threadId}`);
    this.cancelledThreads.add(threadId);
    return Promise.resolve();
  }

  private async *events(
    threadId: string,
    request: ProviderRunRequest,
    started: boolean
  ): AsyncIterable<ProviderEvent> {
    await Promise.resolve();
    let sequence = 0;
    const event = (value: ProviderEventInput): ProviderEvent =>
      providerEventSchema.parse({
        ...value,
        id: this.createId(),
        providerId: this.id,
        threadId,
        sequence: (sequence += 1),
        timestamp: this.now().toISOString()
      });
    if (started) yield event({ type: "thread.started" });
    yield event({ type: "turn.started" });
    if (this.cancelledThreads.has(threadId)) {
      yield event({ type: "run.cancelled" });
      return;
    }
    yield event({ type: "message.delta", delta: this.response });
    yield event({
      type: "result.completed",
      result: {
        status: "completed",
        summary: this.response,
        output: { objective: request.objective }
      }
    });
  }
}

export type CodexTransportEvent =
  | { type: "message.delta"; delta: string }
  | { type: "result.completed"; summary: string; output?: Record<string, unknown> }
  | { type: "run.failed"; message: string }
  | { type: "run.cancelled" };

export interface CodexTransport {
  healthCheck(): Promise<ProviderHealth>;
  startThread(input: { repositoryRoot: string }): Promise<{ threadId: string }>;
  resumeThread(threadId: string): Promise<void>;
  runTurn(
    threadId: string,
    input: { objective: string; repositoryRoot: string; metadata: Record<string, string> }
  ): AsyncIterable<CodexTransportEvent>;
  cancelThread(threadId: string): Promise<void>;
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = "codex";
  readonly displayName = "OpenAI Codex";

  constructor(
    private readonly transport: CodexTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {}

  capabilities(): ProviderCapability[] {
    return [...standardCapabilities];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealthSchema.parse(await this.transport.healthCheck());
  }

  async start(request: ProviderRunRequest): Promise<ProviderExecution> {
    const parsed = providerRunRequestSchema.parse(request);
    const { threadId } = await this.transport.startThread({
      repositoryRoot: parsed.repositoryRoot
    });
    return { threadId, events: this.events(threadId, parsed, true) };
  }

  async resume(threadId: string, request: ProviderRunRequest): Promise<ProviderExecution> {
    const parsed = providerRunRequestSchema.parse(request);
    await this.transport.resumeThread(threadId);
    return { threadId, events: this.events(threadId, parsed, false) };
  }

  async cancel(threadId: string): Promise<void> {
    await this.transport.cancelThread(threadId);
  }

  private async *events(
    threadId: string,
    request: ProviderRunRequest,
    started: boolean
  ): AsyncIterable<ProviderEvent> {
    let sequence = 0;
    const event = (value: ProviderEventInput): ProviderEvent =>
      providerEventSchema.parse({
        ...value,
        id: this.createId(),
        providerId: this.id,
        threadId,
        sequence: (sequence += 1),
        timestamp: this.now().toISOString()
      });
    if (started) yield event({ type: "thread.started" });
    yield event({ type: "turn.started" });
    for await (const transportEvent of this.transport.runTurn(threadId, request)) {
      if (transportEvent.type === "message.delta") {
        yield event(transportEvent);
      } else if (transportEvent.type === "result.completed") {
        yield event({
          type: "result.completed",
          result: {
            status: "completed",
            summary: transportEvent.summary,
            output: transportEvent.output ?? {}
          }
        });
      } else if (transportEvent.type === "run.failed") {
        yield event(transportEvent);
      } else {
        yield event({ type: "run.cancelled" });
      }
    }
  }
}

type ProviderEventInput =
  | { type: "thread.started" }
  | { type: "turn.started" }
  | { type: "message.delta"; delta: string }
  | { type: "result.completed"; result: ProviderResult }
  | { type: "run.failed"; message: string }
  | { type: "run.cancelled" };
