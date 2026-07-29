#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  defaultConfig,
  formatResolvedPolicy,
  loadRepositoryConfig,
  repoPilotConfigPath,
  resolvePolicy,
  setPolicyValue,
  writeRepositoryConfig,
  type PolicyOverride
} from "@repopilot/policy";

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
  repopilot policy show
  repopilot policy validate
  repopilot policy init
  repopilot policy set <path> <value>
  repopilot run [--parallel] [--max-workers n] [--auto-commit] [--no-push]

Commands:
  version   Print the RepoPilot CLI version.
  doctor    Inspect the local RepoPilot development environment.
  policy    Show, validate, initialize, or update execution policy.
  run       Display the resolved policy for a planned RepoPilot run.`;

export async function runCli(
  argv: string[],
  cwd = process.cwd()
): Promise<{ exitCode: number; output: string }> {
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
  if (command === "policy") {
    return handlePolicyCommand(argv.slice(3), cwd);
  }
  if (command === "run") {
    return handleRunCommand(argv.slice(3), cwd);
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

async function handlePolicyCommand(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; output: string }> {
  const subcommand = args[0] ?? "show";
  if (subcommand === "show") {
    const repositoryConfig = await loadRepositoryConfig(cwd);
    const resolved = resolvePolicy({ repositoryConfig });
    return { exitCode: 0, output: `Resolved RepoPilot policy\n${formatResolvedPolicy(resolved)}` };
  }
  if (subcommand === "validate") {
    const repositoryConfig = await loadRepositoryConfig(cwd);
    if (!repositoryConfig) {
      return { exitCode: 1, output: `Missing ${repoPilotConfigPath}. Run repopilot policy init.` };
    }
    const resolved = resolvePolicy({ repositoryConfig });
    return {
      exitCode: 0,
      output: `Policy configuration is valid.\n${formatResolvedPolicy(resolved)}`
    };
  }
  if (subcommand === "init") {
    if (existsSync(path.join(cwd, repoPilotConfigPath))) {
      return { exitCode: 1, output: `${repoPilotConfigPath} already exists.` };
    }
    await writeRepositoryConfig(cwd, defaultConfig("balanced"));
    return { exitCode: 0, output: `Created ${repoPilotConfigPath} using the balanced preset.` };
  }
  if (subcommand === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) {
      return { exitCode: 1, output: "Usage: repopilot policy set <path> <value>" };
    }
    const existing = (await loadRepositoryConfig(cwd)) ?? defaultConfig("balanced");
    const updated = setPolicyValue(existing, key, value);
    await writeRepositoryConfig(cwd, updated);
    return { exitCode: 0, output: `Updated ${repoPilotConfigPath}: ${key} = ${value}` };
  }
  return { exitCode: 1, output: `Unknown policy command: ${subcommand}` };
}

async function handleRunCommand(
  args: string[],
  cwd: string
): Promise<{ exitCode: number; output: string }> {
  const repositoryConfig = await loadRepositoryConfig(cwd);
  const cliOverrides = parseRunOverrides(args);
  const resolved = resolvePolicy({ repositoryConfig, cliOverrides });
  const externalWriteNotice =
    resolved.execution.pushes.enabled || resolved.execution.pull_requests.enabled
      ? "\nExternal write actions are enabled by policy and must be authorized before execution."
      : "";
  return {
    exitCode: 0,
    output: `Resolved RepoPilot policy for this run\n${formatResolvedPolicy(resolved)}Run execution is not implemented in this milestone.${externalWriteNotice}`
  };
}

function parseRunOverrides(args: string[]): PolicyOverride {
  const override: PolicyOverride = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--parallel") {
      override.parallelism = {
        ...override.parallelism,
        enabled: true,
        strategy: "parallel_analysis",
        allow_parallel_reads: true,
        allow_parallel_writes: false
      };
    }
    if (arg === "--max-workers") {
      const value = args[index + 1];
      if (!value) throw new Error("--max-workers requires a value.");
      override.parallelism = { ...override.parallelism, max_workers: Number(value) };
      index += 1;
    }
    if (arg === "--auto-commit") {
      override.commits = { ...override.commits, enabled: true, strategy: "after_feature" };
    }
    if (arg === "--no-push") {
      override.pushes = { ...override.pushes, enabled: false, strategy: "never" };
    }
  }
  return override;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv);
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
