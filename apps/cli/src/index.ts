#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface DoctorCheck {
  label: string;
  ok: boolean;
  value: string;
  required: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exitCode: number;
}

const helpText = `RepoPilot

Usage:
  repopilot --help
  repopilot version
  repopilot doctor

Commands:
  version   Print the RepoPilot CLI version.
  doctor    Inspect the local RepoPilot development environment.`;

export function runCli(argv: string[], cwd = process.cwd()): { exitCode: number; output: string } {
  const command = argv[2];
  if (!command || command === "--help" || command === "-h") {
    return { exitCode: 0, output: helpText };
  }
  if (command === "version") {
    return { exitCode: 0, output: "0.1.0" };
  }
  if (command === "doctor") {
    const report = createDoctorReport(cwd);
    return { exitCode: report.exitCode, output: formatDoctorReport(report) };
  }
  return { exitCode: 1, output: `Unknown command: ${command}\n\n${helpText}` };
}

export function createDoctorReport(cwd = process.cwd()): DoctorReport {
  const nodeVersion = process.version;
  const pnpm = commandVersion("pnpm", ["--version"]);
  const git = commandVersion("git", ["--version"]);
  const isGitRepository = commandSucceeds("git", ["rev-parse", "--is-inside-work-tree"], cwd);

  const checks: DoctorCheck[] = [
    { label: "Node version", ok: true, value: nodeVersion, required: true },
    { label: "pnpm availability", ok: pnpm.ok, value: pnpm.value, required: true },
    { label: "Git availability", ok: git.ok, value: git.value, required: true },
    { label: "Current directory", ok: existsSync(cwd), value: path.resolve(cwd), required: true },
    {
      label: "Git repository",
      ok: isGitRepository,
      value: isGitRepository ? "yes" : "no",
      required: false
    }
  ];

  return {
    checks,
    exitCode: checks.some((check) => check.required && !check.ok) ? 1 : 0
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  return [
    "RepoPilot doctor",
    ...report.checks.map((check) => {
      const marker = check.ok ? "ok" : check.required ? "missing" : "unavailable";
      return `- ${check.label}: ${marker} (${check.value})`;
    })
  ].join("\n");
}

function commandVersion(command: string, args: string[]): { ok: boolean; value: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { ok: false, value: "not found" };
  }
  return { ok: true, value: result.stdout.trim() };
}

function commandSucceeds(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return !result.error && result.status === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runCli(process.argv);
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
