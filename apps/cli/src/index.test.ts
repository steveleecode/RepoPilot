import { describe, expect, it } from "vitest";
import { createDoctorReport, runCli } from "./index.js";

describe("RepoPilot CLI", () => {
  it("prints help", () => {
    const result = runCli(["node", "repopilot", "--help"]);

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
});
