import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

describe("commit CLI", () => {
  it("requires an explicit run and message", async () => {
    expect((await runCli(["node", "repopilot", "commit"])).exitCode).toBe(2);
    expect((await runCli(["node", "repopilot", "commit", "run-example"])).exitCode).toBe(2);
    expect((await runCli(["node", "repopilot", "commit", "run-example", "--push"])).exitCode).toBe(
      2
    );
  });
  it("documents the explicit local commit command", async () => {
    const result = await runCli(["node", "repopilot", "--help"]);
    expect(result.output).toContain("repopilot commit <run-id> --message <message>");
  });
});
