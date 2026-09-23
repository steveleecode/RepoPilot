import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerTransport,
  codexAccountHealth,
  runCodexStructuredTurn
} from "../src/codex-app-server.js";

describe("Codex App Server transport", () => {
  it("reports a missing Codex executable without crashing", async () => {
    const health = await codexAccountHealth(
      path.join(tmpdir(), `missing-codex-${crypto.randomUUID()}`)
    );
    expect(health.status).toBe("unavailable");
  });

  it("checks login and parses a bounded structured turn", async () => {
    const fixture = await fakeServer();
    try {
      expect((await codexAccountHealth(fixture.binary)).status).toBe("available");
      const result = await runCodexStructuredTurn(
        "Return JSON",
        { type: "object" },
        fixture.binary
      );
      expect(result).toEqual({ summary: "Done", tasks: [], risks: [], questions: [] });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("maps Codex planning into provider events and resumes a thread", async () => {
    const fixture = await fakeServer();
    try {
      const transport = new CodexAppServerTransport(fixture.binary);
      const started = await transport.startThread({ repositoryRoot: "/untrusted/repository" });
      const events = [];
      for await (const event of transport.runTurn(started.threadId, {
        objective: "Plan",
        repositoryRoot: "/untrusted/repository",
        metadata: {}
      }))
        events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "result.completed",
        output: { plan: { summary: "Done" } }
      });
      await transport.resumeThread(started.threadId);
      const resumed = [];
      for await (const event of transport.runTurn(started.threadId, {
        objective: "Plan again",
        repositoryRoot: "/untrusted/repository",
        metadata: {}
      }))
        resumed.push(event);
      expect(resumed.at(-1)?.type).toBe("result.completed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function fakeServer(): Promise<{ root: string; binary: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-codex-test-"));
  const binary = path.join(root, "codex-fake");
  await writeFile(
    binary,
    String.raw`#!/usr/bin/env node
const readline = require("node:readline");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const plan = { summary: "Done", tasks: [], risks: [], questions: [] };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") output({ id: message.id, result: {} });
  else if (message.method === "account/read") output({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
  else if (message.method === "thread/start" || message.method === "thread/resume") output({ id: message.id, result: { thread: { id: "thr_test" } } });
  else if (message.method === "turn/start") {
    output({ id: message.id, result: { turn: { id: "turn_test" } } });
    output({ method: "item/agentMessage/delta", params: { threadId: "thr_test", turnId: "turn_test", delta: JSON.stringify(plan) } });
    output({ method: "turn/completed", params: { threadId: "thr_test", turn: { id: "turn_test", status: "completed" } } });
  }
});
`
  );
  await chmod(binary, 0o755);
  return { root, binary };
}
