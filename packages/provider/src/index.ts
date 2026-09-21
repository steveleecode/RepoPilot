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

export interface ProviderInspection extends ProviderDefinition {
  configured: boolean;
  health: ProviderHealth;
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

export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  constructor(providers: AgentProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): AgentProvider {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error(`Provider is not configured: ${providerId}`);
    return provider;
  }

  list(): AgentProvider[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}

export async function inspectProviders(registry: ProviderRegistry): Promise<ProviderInspection[]> {
  return Promise.all(
    listProviderDefinitions().map(async (definition) => {
      let provider: AgentProvider;
      try {
        provider = registry.get(definition.id);
      } catch {
        return {
          ...definition,
          configured: false,
          health: {
            status: "unavailable" as const,
            message:
              definition.integration === "transport-required"
                ? `${definition.displayName} requires a configured transport.`
                : `${definition.displayName} is not registered.`
          }
        };
      }
      try {
        return {
          ...definition,
          configured: true,
          health: providerHealthSchema.parse(await provider.healthCheck())
        };
      } catch (error) {
        return {
          ...definition,
          configured: true,
          health: {
            status: "unavailable" as const,
            message: error instanceof Error ? error.message : "Provider health check failed."
          }
        };
      }
    })
  );
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
    const started = await this.transport.startThread({
      repositoryRoot: parsed.repositoryRoot
    });
    const threadId = z.string().min(1).parse(started.threadId);
    return { threadId, events: this.events(threadId, parsed, true) };
  }

  async resume(threadId: string, request: ProviderRunRequest): Promise<ProviderExecution> {
    const parsedThreadId = z.string().min(1).parse(threadId);
    const parsed = providerRunRequestSchema.parse(request);
    await this.transport.resumeThread(parsedThreadId);
    return { threadId: parsedThreadId, events: this.events(parsedThreadId, parsed, false) };
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
    let terminal = false;
    try {
      for await (const transportEvent of this.transport.runTurn(threadId, request)) {
        if (transportEvent.type === "message.delta") {
          yield event(transportEvent);
          continue;
        }
        terminal = true;
        if (transportEvent.type === "result.completed") {
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
        break;
      }
    } catch (error) {
      terminal = true;
      yield event({
        type: "run.failed",
        message: error instanceof Error ? error.message : "Codex transport failed."
      });
    }
    if (!terminal) {
      yield event({
        type: "run.failed",
        message: "Codex transport ended without a terminal result."
      });
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
