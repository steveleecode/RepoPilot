import { mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCommandExecutor, type CommandDefinition } from "../src/index.js";

describe("LocalCommandExecutor", () => {
  it("executes only a catalogued fixed command without a shell", async () => {
    const root = await fixture();
    const executor = createExecutor(root, [
      nodeCommand("inspect", 'console.log(`${process.cwd()}|${process.env.UNLISTED ?? "missing"}`)')
    ]);

    const result = await executor.execute({ commandId: "inspect" });

    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe(`${await realpath(root)}|missing`);
    expect(result.stderr).toBe("");
  });

  it("denies unknown commands and argument variants", async () => {
    const root = await fixture();
    const executor = createExecutor(root, [nodeCommand("safe", 'console.log("safe")')]);

    const unknown = await executor.execute({ commandId: "missing" });
    const argumentsDenied = await executor.execute({ commandId: "safe", arguments: ["--write"] });
    const limitsDenied = await executor.execute({ commandId: "safe", timeoutMs: 60_001 });

    expect(unknown.status).toBe("denied");
    expect(unknown.denialReasons).toContain("Command is not in the trusted catalog.");
    expect(argumentsDenied.status).toBe("denied");
    expect(argumentsDenied.denialReasons?.join(" ")).toContain("not an explicitly allowed variant");
    expect(limitsDenied.status).toBe("denied");
    expect(limitsDenied.denialReasons?.join(" ")).toContain("exceeds the executor limit");
  });

  it("executes only exact explicitly allowed argument variants", async () => {
    const root = await fixture();
    const definition = nodeCommand("variant", "console.log(process.argv[1])");
    definition.allowedArgumentVectors = [["check"]];
    const executor = createExecutor(root, [definition]);

    const allowed = await executor.execute({ commandId: "variant", arguments: ["check"] });
    definition.allowedArgumentVectors = [["mutated"]];
    const mutationDenied = await executor.execute({ commandId: "variant", arguments: ["mutated"] });

    expect(allowed.status).toBe("completed");
    expect(allowed.stdout.trim()).toBe("check");
    expect(mutationDenied.status).toBe("denied");
  });

  it("passes only explicitly allowed environment variables and redacts output", async () => {
    const root = await fixture();
    const executor = new LocalCommandExecutor({
      repositoryRoot: root,
      commands: [
        nodeCommand(
          "environment",
          'console.log(`token=${process.env.ALLOWED};OTHER=${process.env.OTHER ?? "missing"}`)'
        )
      ],
      environment: { ALLOWED: "base-secret" },
      allowedEnvironmentVariables: ["ALLOWED"],
      redactedValues: ["override-secret"]
    });

    const result = await executor.execute({
      commandId: "environment",
      environment: { ALLOWED: "override-secret" }
    });
    const denied = await executor.execute({
      commandId: "environment",
      environment: { OTHER: "not-allowed" }
    });

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("token=[REDACTED]");
    expect(result.stdout).toContain("OTHER=missing");
    expect(result.stdout).not.toContain("override-secret");
    expect(denied.status).toBe("denied");
    expect(
      () =>
        new LocalCommandExecutor({
          repositoryRoot: root,
          commands: [],
          environment: { OTHER: "not-allowed" }
        })
    ).toThrow("Environment variable is not allowed");
  });

  it("enforces repository-relative working-directory scopes and symlink containment", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    await symlink(tmpdir(), path.join(root, "packages", "escape"));
    const executor = createExecutor(root, [
      {
        ...nodeCommand("scoped", "console.log(process.cwd())"),
        workingDirectoryScopes: ["packages"]
      }
    ]);

    const allowed = await executor.execute({
      commandId: "scoped",
      workingDirectory: "packages/app"
    });
    const traversal = await executor.execute({
      commandId: "scoped",
      workingDirectory: "../outside"
    });
    const escaped = await executor.execute({
      commandId: "scoped",
      workingDirectory: "packages/escape"
    });

    expect(allowed.status).toBe("completed");
    expect(allowed.workingDirectory).toBe("packages/app");
    expect(traversal.status).toBe("denied");
    expect(escaped.status).toBe("denied");
    expect(escaped.denialReasons?.join(" ")).toContain("outside the repository root");
  });

  it("terminates commands that exceed time or output limits", async () => {
    const root = await fixture();
    const executor = createExecutor(root, [
      nodeCommand("wait", "setTimeout(() => {}, 10_000)"),
      nodeCommand("noisy", 'process.stdout.write("x".repeat(10_000))')
    ]);

    const timedOut = await executor.execute({ commandId: "wait", timeoutMs: 25 });
    const noisy = await executor.execute({ commandId: "noisy", maxOutputBytes: 100 });

    expect(timedOut.status).toBe("timed_out");
    expect(noisy.status).toBe("output_limit");
    expect(Buffer.byteLength(noisy.stdout)).toBe(100);
    expect(noisy.outputTruncated).toBe(true);
  });

  it("supports abort-driven cancellation", async () => {
    const root = await fixture();
    const executor = createExecutor(root, [nodeCommand("wait", "setTimeout(() => {}, 10_000)")]);
    const controller = new AbortController();
    const execution = executor.execute({ commandId: "wait" }, { signal: controller.signal });
    controller.abort();

    expect((await execution).status).toBe("cancelled");
  });

  it("reports non-zero exits and spawn failures without throwing", async () => {
    const root = await fixture();
    const executor = createExecutor(root, [
      nodeCommand("failure", 'process.stderr.write("failed"); process.exit(7)'),
      { id: "missing", executable: path.join(root, "not-installed") }
    ]);

    const failure = await executor.execute({ commandId: "failure" });
    const missing = await executor.execute({ commandId: "missing" });

    expect(failure).toMatchObject({ status: "failed", exitCode: 7, stderr: "failed" });
    expect(missing.status).toBe("spawn_error");
    expect(missing.error).toBeTruthy();
  });
});

function createExecutor(root: string, commands: CommandDefinition[]): LocalCommandExecutor {
  return new LocalCommandExecutor({ repositoryRoot: root, commands });
}

function nodeCommand(id: string, source: string): CommandDefinition {
  return { id, executable: process.execPath, fixedArguments: ["--no-warnings", "-e", source] };
}

async function fixture(): Promise<string> {
  return await mkdir(path.join(tmpdir(), `repopilot-executor-${crypto.randomUUID()}`), {
    recursive: true
  });
}
