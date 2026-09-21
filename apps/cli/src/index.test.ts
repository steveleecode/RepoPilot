import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowStore } from "@repopilot/workflow";
import { describe, expect, it } from "vitest";
import { cliExitCode, createDoctorReport, isSupportedNodeVersion, runCli } from "./index.js";

describe("RepoPilot CLI", () => {
  it("prints help", async () => {
    const result = await runCli(["node", "repopilot", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("repopilot doctor");
  });

  it("reports doctor checks for the current environment", () => {
    const report = createDoctorReport(process.cwd());

    expect(report.checks.map((check) => check.label)).toEqual(
      expect.arrayContaining([
        "Node version",
        "pnpm availability",
        "Git availability",
        "Current directory"
      ])
    );
    expect(report.exitCode).toBe(0);
  });

  it("validates the supported Node major-version range", () => {
    expect(isSupportedNodeVersion("v22.14.0")).toBe(true);
    expect(isSupportedNodeVersion("25.2.1")).toBe(true);
    expect(isSupportedNodeVersion("v21.9.0")).toBe(false);
    expect(isSupportedNodeVersion("v26.0.0")).toBe(false);
    expect(isSupportedNodeVersion("unknown")).toBe(false);
  });

  it("initializes, validates, shows, and updates repository policy", async () => {
    const cwd = await fixture();

    const init = await runCli(["node", "repopilot", "policy", "init"], cwd);
    const set = await runCli(
      ["node", "repopilot", "policy", "set", "parallelism.max_workers", "4"],
      cwd
    );
    const validate = await runCli(["node", "repopilot", "policy", "validate"], cwd);
    const show = await runCli(["node", "repopilot", "policy", "show"], cwd);

    expect(init.exitCode).toBe(0);
    expect(set.exitCode).toBe(0);
    expect(validate.output).toContain("Policy configuration is valid.");
    expect(show.output).toContain("max_workers: 4");
  });

  it("supports top-level init and validate commands", async () => {
    const cwd = await fixture();

    const init = await runCli(["node", "repopilot", "init", "--json"], cwd);
    const validate = await runCli(["node", "repopilot", "validate", "--json"], cwd);

    expect(init.exitCode).toBe(cliExitCode.success);
    expect(JSON.parse(init.output)).toMatchObject({ ok: true, command: "policy init" });
    expect(validate.exitCode).toBe(cliExitCode.success);
    expect(JSON.parse(validate.output)).toMatchObject({ ok: true, command: "policy validate" });
  });

  it("applies one-run overrides without editing repository policy", async () => {
    const cwd = await fixture();
    await runCli(["node", "repopilot", "policy", "init"], cwd);

    const result = await runCli(
      [
        "node",
        "repopilot",
        "run",
        "--parallel",
        "--max-workers",
        "2",
        "--auto-commit",
        "--no-push"
      ],
      cwd
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Resolved RepoPilot policy for this run");
    expect(result.output).toContain("max_workers: 2");
    expect(result.output).toContain("No objective supplied; no workflow was started.");
  });

  it("executes a durable read-only workflow through the fake provider", async () => {
    const cwd = await fixture();
    await writeFile(path.join(cwd, "package.json"), "{}");

    const result = await runCli(
      ["node", "repopilot", "run", "Plan parser coverage", "--provider", "fake", "--json"],
      cwd
    );
    const output = JSON.parse(result.output) as {
      executionImplemented: boolean;
      providerEvents: number;
      run: { status: string; tasks: Array<{ status: string }> };
    };

    expect(result.exitCode).toBe(cliExitCode.success);
    expect(output.executionImplemented).toBe(true);
    expect(output.providerEvents).toBeGreaterThan(0);
    expect(output.run.status).toBe("completed");
    expect(output.run.tasks[0]?.status).toBe("completed");
  });

  it("scans an explicitly selected repository and emits structured evidence", async () => {
    const cwd = await fixture();
    const repository = path.join(cwd, "target");
    await mkdir(repository);
    await writeFile(path.join(repository, "package.json"), "{}");
    await writeFile(path.join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");

    const result = await runCli(["node", "repopilot", "scan", "--repo", "target", "--json"], cwd);
    const output = JSON.parse(result.output) as {
      ok: boolean;
      repositoryRoot: string;
      analysis: { manifests: Array<{ kind: string }>; packageManagers: Array<{ name: string }> };
    };

    expect(result.exitCode).toBe(cliExitCode.success);
    expect(output.ok).toBe(true);
    expect(output.repositoryRoot).toBe(repository);
    expect(output.analysis.manifests).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "package.json" })])
    );
    expect(output.analysis.packageManagers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pnpm" })])
    );
  });

  it("rejects unknown options with a stable usage exit code", async () => {
    const result = await runCli(["node", "repopilot", "scan", "--not-a-real-option"]);

    expect(result.exitCode).toBe(cliExitCode.usageError);
    expect(result.output).toContain("Unknown option");
  });

  it("discovers provider adapters and capabilities", async () => {
    const result = await runCli(["node", "repopilot", "providers", "list", "--json"]);
    const output = JSON.parse(result.output) as {
      providers: Array<{ id: string; integration: string; capabilities: string[] }>;
    };

    expect(result.exitCode).toBe(cliExitCode.success);
    expect(output.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex", integration: "transport-required" }),
        expect.objectContaining({ id: "fake", integration: "built-in" })
      ])
    );
    expect(output.providers[0]?.capabilities).toContain("event_streaming");
  });

  it("reports provider configuration and health without making external calls", async () => {
    const result = await runCli(["node", "repopilot", "providers", "doctor", "--json"]);
    const output = JSON.parse(result.output) as {
      providers: Array<{ id: string; configured: boolean; health: { status: string } }>;
    };
    const codex = output.providers.find((provider) => provider.id === "codex");
    const fake = output.providers.find((provider) => provider.id === "fake");

    expect(result.exitCode).toBe(cliExitCode.success);
    expect(codex?.configured).toBe(false);
    expect(codex?.health.status).toBe("unavailable");
    expect(fake?.configured).toBe(true);
    expect(fake?.health.status).toBe("available");
  });

  it("rejects invalid worker counts without an uncaught exception", async () => {
    const result = await runCli([
      "node",
      "repopilot",
      "run",
      "--max-workers",
      "not-a-number",
      "--json"
    ]);
    const output = JSON.parse(result.output) as { ok: boolean; error: { exitCode: number } };

    expect(result.exitCode).toBe(cliExitCode.usageError);
    expect(output.ok).toBe(false);
    expect(output.error.exitCode).toBe(cliExitCode.usageError);
  });

  it("creates, lists, inspects, and resumes persistent workflow runs", async () => {
    const cwd = await fixture();
    const created = await runCli(
      ["node", "repopilot", "runs", "create", "Add durable state", "--provider", "codex", "--json"],
      cwd
    );
    const createdOutput = JSON.parse(created.output) as { run: { id: string; status: string } };

    const listed = await runCli(["node", "repopilot", "runs", "list", "--json"], cwd);
    const status = await runCli(
      ["node", "repopilot", "status", createdOutput.run.id, "--json"],
      cwd
    );
    await new WorkflowStore(cwd).transitionRun(createdOutput.run.id, "interrupted");
    const resumed = await runCli(
      ["node", "repopilot", "resume", createdOutput.run.id, "--json"],
      cwd
    );

    expect(created.exitCode).toBe(cliExitCode.success);
    expect(createdOutput.run.status).toBe("created");
    expect(JSON.parse(listed.output)).toMatchObject({ runs: [{ id: createdOutput.run.id }] });
    expect(JSON.parse(status.output)).toMatchObject({ run: { id: createdOutput.run.id } });
    expect(JSON.parse(resumed.output)).toMatchObject({ run: { status: "planning" } });
  });

  it("returns a stable workflow exit code for a missing run", async () => {
    const cwd = await fixture();
    const result = await runCli(
      ["node", "repopilot", "status", "00000000-0000-4000-8000-000000000099", "--json"],
      cwd
    );

    expect(result.exitCode).toBe(cliExitCode.workflowError);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: { exitCode: cliExitCode.workflowError }
    });
  });
});

async function fixture(): Promise<string> {
  const directory = path.join(tmpdir(), `repopilot-cli-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return directory;
}
