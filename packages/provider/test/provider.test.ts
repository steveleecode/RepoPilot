import { describe, expect, it } from "vitest";
import {
  CodexAgentProvider,
  FakeAgentProvider,
  inspectProviders,
  listProviderDefinitions,
  providerEventSchema,
  ProviderRegistry,
  type AgentProvider,
  type CodexTransport,
  type CodexTransportEvent,
  type ProviderEvent
} from "../src/index.js";

const request = {
  objective: "Add parser coverage",
  repositoryRoot: "/repository",
  metadata: { runId: "run-1" }
};

describe.each([
  ["fake", () => new FakeAgentProvider({ response: "done" })],
  ["codex", () => new CodexAgentProvider(new TestCodexTransport())]
] as const)("%s provider contract", (_name, createProvider) => {
  it("discovers capabilities and reports health", async () => {
    const provider = createProvider();

    expect(provider.capabilities()).toEqual(
      expect.arrayContaining([
        "start",
        "resume",
        "cancel",
        "event_streaming",
        "structured_results",
        "health_check"
      ])
    );
    expect(await provider.healthCheck()).toMatchObject({ status: "available" });
  });

  it("starts and resumes a thread with normalized events", async () => {
    const provider: AgentProvider = createProvider();
    const started = await provider.start(request);
    const startEvents = await collect(started.events);
    const resumed = await provider.resume(started.threadId, {
      ...request,
      objective: "Continue the task"
    });
    const resumeEvents = await collect(resumed.events);

    expect(started.threadId).toBeTruthy();
    expect(startEvents.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "message.delta",
      "result.completed"
    ]);
    expect(resumed.threadId).toBe(started.threadId);
    expect(resumeEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "message.delta",
      "result.completed"
    ]);
    for (const event of [...startEvents, ...resumeEvents]) {
      expect(providerEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it("supports cancellation through the same contract", async () => {
    const provider: AgentProvider = createProvider();
    const started = await provider.start(request);
    await provider.cancel(started.threadId);
    const resumed = await provider.resume(started.threadId, request);
    const events = await collect(resumed.events);

    expect(events.at(-1)?.type).toBe("run.cancelled");
  });
});

it("publishes deterministic provider discovery metadata", () => {
  expect(listProviderDefinitions()).toEqual([
    expect.objectContaining({ id: "codex", integration: "transport-required" }),
    expect.objectContaining({ id: "fake", integration: "built-in" })
  ]);
});

it("registers and resolves providers without allowing ambiguous duplicates", () => {
  const provider = new FakeAgentProvider();
  const registry = new ProviderRegistry([provider]);

  expect(registry.get("fake")).toBe(provider);
  expect(registry.list()).toEqual([provider]);
  expect(() => registry.register(new FakeAgentProvider())).toThrow("already registered");
  expect(() => registry.get("missing")).toThrow("not configured");
});

it("inspects configured and transport-required providers", async () => {
  const inspections = await inspectProviders(new ProviderRegistry([new FakeAgentProvider()]));
  const codex = inspections.find((inspection) => inspection.id === "codex");
  const fake = inspections.find((inspection) => inspection.id === "fake");

  expect(codex?.configured).toBe(false);
  expect(codex?.health.status).toBe("unavailable");
  expect(fake?.configured).toBe(true);
  expect(fake?.health.status).toBe("available");
});

it("converts a missing Codex terminal result into a normalized failure", async () => {
  const provider = new CodexAgentProvider(
    new TestCodexTransport([{ type: "message.delta", delta: "partial" }])
  );
  const execution = await provider.start(request);
  const events = await collect(execution.events);

  expect(events.map((event) => event.type)).toEqual([
    "thread.started",
    "turn.started",
    "message.delta",
    "run.failed"
  ]);
});

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

class TestCodexTransport implements CodexTransport {
  private readonly threads = new Set<string>();
  private readonly cancelled = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly scriptedEvents: CodexTransportEvent[] = [
      { type: "message.delta", delta: "working" },
      { type: "result.completed", summary: "done", output: { changed: false } }
    ]
  ) {}

  healthCheck() {
    return Promise.resolve({
      status: "available" as const,
      message: "Test Codex transport is available."
    });
  }

  startThread() {
    const threadId = `codex-thread-${this.nextId++}`;
    this.threads.add(threadId);
    return Promise.resolve({ threadId });
  }

  resumeThread(threadId: string) {
    if (!this.threads.has(threadId)) throw new Error(`Unknown thread: ${threadId}`);
    return Promise.resolve();
  }

  async *runTurn(threadId: string): AsyncIterable<CodexTransportEvent> {
    await Promise.resolve();
    if (this.cancelled.has(threadId)) {
      yield { type: "run.cancelled" };
      return;
    }
    for (const event of this.scriptedEvents) yield event;
  }

  cancelThread(threadId: string) {
    if (!this.threads.has(threadId)) throw new Error(`Unknown thread: ${threadId}`);
    this.cancelled.add(threadId);
    return Promise.resolve();
  }
}
