import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDoctorReport, runCli } from "./index.js";

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
    expect(result.output).toContain("Run execution is not implemented");
  });
});

async function fixture(): Promise<string> {
  const directory = path.join(tmpdir(), `repopilot-cli-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  return directory;
}
