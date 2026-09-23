import { describe, expect, it } from "vitest";
import { OllamaAgentProvider, parseModelConfig } from "../src/ollama.js";
import type { ProviderEvent } from "../src/index.js";

const plan = {
  summary: "Inspect parser tests.",
  tasks: [
    {
      id: "inspect",
      objective: "Inspect parser tests",
      dependencies: [],
      expectedScopes: ["tests"],
      readSet: ["package.json"],
      writeSet: [],
      validationCommandIds: [],
      completionCriteria: ["Plan is reviewable."]
    }
  ],
  risks: [],
  questions: []
};

describe("OllamaAgentProvider", () => {
  it("uses loopback chat and returns a normalized structured plan", async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url.endsWith("/api/tags"))
        return Promise.resolve(Response.json({ models: [{ name: "local-coder" }] }));
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      expect(body).toMatchObject({
        model: "local-coder",
        stream: false,
        format: "json"
      });
      return Promise.resolve(Response.json({ message: { content: JSON.stringify(plan) } }));
    };
    const provider = new OllamaAgentProvider(
      { ...config(), endpoint: "http://127.0.0.1:11434/" },
      fetcher
    );

    expect((await provider.healthCheck()).status).toBe("available");
    const execution = await provider.start({ objective: "Plan tests", repositoryRoot: "/repo" });
    const events = await collect(execution.events);

    expect(requests).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/chat"
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "result.completed"
    ]);
    expect(events.at(-1)).toMatchObject({ type: "result.completed", result: { output: { plan } } });
  });

  it("fails closed for missing models, malformed responses, and oversized responses", async () => {
    const missing = new OllamaAgentProvider(config(), () =>
      Promise.resolve(Response.json({ models: [] }))
    );
    expect((await missing.healthCheck()).message).toContain("not installed");

    const malformed = new OllamaAgentProvider(config(), () =>
      Promise.resolve(Response.json({ message: { content: "not-json" } }))
    );
    const execution = await malformed.start({ objective: "Plan", repositoryRoot: "/repo" });
    expect((await collect(execution.events)).at(-1)).toMatchObject({
      type: "run.failed",
      message: "Ollama returned invalid JSON."
    });

    const oversized = new OllamaAgentProvider(config(), () =>
      Promise.resolve(new Response("x".repeat(2000)))
    );
    const oversizedRun = await oversized.start({ objective: "Plan", repositoryRoot: "/repo" });
    const last = (await collect(oversizedRun.events)).at(-1);
    expect(last?.type).toBe("run.failed");
    if (last?.type === "run.failed") expect(last.message).toContain("size limit");
  });

  it("rejects endpoints outside loopback and cancellation before a request", async () => {
    expect(() =>
      parseModelConfig({ version: 1, ollama: { model: "x", endpoint: "https://example.com" } })
    ).toThrow("loopback");
    const provider = new OllamaAgentProvider(config(), () =>
      Promise.reject(new Error("should not fetch"))
    );
    const execution = await provider.start({ objective: "Plan", repositoryRoot: "/repo" });
    await provider.cancel(execution.threadId);
    expect((await collect(execution.events)).at(-1)?.type).toBe("run.cancelled");
  });
});

function config() {
  return {
    model: "local-coder",
    endpoint: "http://127.0.0.1:11434",
    timeoutMs: 1000,
    maxResponseBytes: 1024
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
