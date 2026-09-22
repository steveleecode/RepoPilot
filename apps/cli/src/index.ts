#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeRepository, type RepositoryAnalysis } from "@repopilot/analyzer";
import { WorkflowEngine } from "@repopilot/orchestrator";
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
import {
  CodexAgentProvider,
  FakeAgentProvider,
  inspectProviders,
  listProviderDefinitions,
  ProviderRegistry,
  type ProviderDefinition,
  type ProviderInspection
} from "@repopilot/provider";
import {
  loadModelConfig,
  modelConfigPath,
  OllamaAgentProvider,
  writeModelConfig
} from "@repopilot/provider/ollama";
import type { CodexTransport } from "@repopilot/provider";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";

export const cliExitCode = {
  success: 0,
  generalError: 1,
  usageError: 2,
  environmentError: 3,
  invalidConfiguration: 4,
  analysisError: 5,
  workflowError: 6
} as const;

export interface CliResult {
  exitCode: number;
  output: string;
}

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

const cliVersion = readCliVersion();
const supportedNodeRange = ">=22 <26";

const helpText = `RepoPilot

Usage:
  repopilot --help
  repopilot version [--json]
  repopilot doctor [--repo path] [--json]
  repopilot init [--repo path] [--json]
  repopilot scan [--repo path] [--json]
  repopilot providers <list|doctor> [--repo path] [--json]
  repopilot providers configure ollama --model name [--endpoint url] [--repo path]
  repopilot validate [--repo path] [--json]
  repopilot runs create <objective> [--provider name] [--repo path] [--json]
  repopilot runs list [--repo path] [--json]
  repopilot status <run-id> [--repo path] [--json]
  repopilot resume <run-id> [--repo path] [--json]
  repopilot policy show [--repo path] [--json]
  repopilot policy validate [--repo path] [--json]
  repopilot policy init [--repo path] [--json]
  repopilot policy set <path> <value> [--repo path] [--json]
  repopilot run [--repo path] [--json] [--non-interactive]
                [--parallel] [--max-workers n] [--auto-commit] [--no-push]
  repopilot run <objective> --provider <fake|ollama|codex> [--repo path] [--json]

Commands:
  version   Print the RepoPilot CLI version.
  doctor    Inspect the local RepoPilot environment.
  init      Initialize repository policy using the balanced preset.
  scan      Analyze repository metadata and print evidence-backed facts.
  providers Discover available agent-provider adapters and capabilities.
  validate  Validate the repository policy configuration.
  runs      Create and list durable workflow runs.
  status    Show a reconstructed workflow run snapshot.
  resume    Move an interrupted or failed run back to planning.
  policy    Show, validate, initialize, or update execution policy.
  run       Preview policy or execute a provider-backed read-only workflow.

Global command options:
  --repo <path>       Target repository. Defaults to the current directory.
  --json              Emit machine-readable JSON.
  -h, --help          Show help.`;

export interface CliProviderRuntime {
  fetcher?: typeof fetch;
  codexTransport?: CodexTransport;
}

export async function runCli(
  argv: string[],
  cwd = process.cwd(),
  runtime: CliProviderRuntime = {}
): Promise<CliResult> {
  const args = argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);
  const wantsJson = args.includes("--json");

  try {
    if (!command || command === "--help" || command === "-h") return textResult(helpText);
    if (command === "version") return handleVersionCommand(commandArgs);
    if (command === "doctor") return handleDoctorCommand(commandArgs, cwd);
    if (command === "init") return await handlePolicyCommand(["init", ...commandArgs], cwd);
    if (command === "scan") return await handleScanCommand(commandArgs, cwd);
    if (command === "providers") return await handleProvidersCommand(commandArgs, cwd, runtime);
    if (command === "validate") {
      return await handlePolicyCommand(["validate", ...commandArgs], cwd);
    }
    if (command === "policy") return await handlePolicyCommand(commandArgs, cwd);
    if (command === "runs") return await handleRunsCommand(commandArgs, cwd);
    if (command === "status") return await handleStatusCommand(commandArgs, cwd);
    if (command === "resume") return await handleResumeCommand(commandArgs, cwd);
    if (command === "run") return await handleRunCommand(commandArgs, cwd, runtime);
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    const exitCode = classifyError(error, command);
    const message = error instanceof Error ? error.message : "Unknown error.";
    return wantsJson
      ? jsonResult(exitCode, { ok: false, error: { message, exitCode } })
      : textResult(`Error: ${message}\n\nRun repopilot --help for usage.`, exitCode);
  }
}

export function createDoctorReport(cwd = process.cwd()): DoctorReport {
  const nodeVersion = process.version;
  const pnpm = commandVersion("pnpm", ["--version"]);
  const git = commandVersion("git", ["--version"]);
  const isGitRepository = commandSucceeds("git", ["rev-parse", "--is-inside-work-tree"], cwd);

  const checks: DoctorCheck[] = [
    {
      label: "Node version",
      ok: isSupportedNodeVersion(nodeVersion),
      value: `${nodeVersion} (required ${supportedNodeRange})`,
      required: true
    },
    { label: "pnpm availability", ok: pnpm.ok, value: pnpm.value, required: true },
    { label: "Git availability", ok: git.ok, value: git.value, required: true },
    { label: "Current directory", ok: isDirectory(cwd), value: path.resolve(cwd), required: true },
    {
      label: "Git repository",
      ok: isGitRepository,
      value: isGitRepository ? "yes" : "no",
      required: false
    }
  ];

  return {
    checks,
    exitCode: checks.some((check) => check.required && !check.ok)
      ? cliExitCode.environmentError
      : cliExitCode.success
  };
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\./u.exec(version);
  if (!match?.[1]) return false;
  const major = Number(match[1]);
  return major >= 22 && major < 26;
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

function handleVersionCommand(args: string[]): CliResult {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: commonOptions(false)
  });
  requireNoPositionals(positionals, "repopilot version [--json]");
  if (values.help) return textResult(helpText);
  return values.json
    ? jsonResult(cliExitCode.success, { ok: true, command: "version", version: cliVersion })
    : textResult(cliVersion);
}

function handleDoctorCommand(args: string[], cwd: string): CliResult {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: commonOptions()
  });
  requireNoPositionals(positionals, "repopilot doctor [--repo path] [--json]");
  if (values.help) return textResult(helpText);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const report = createDoctorReport(repositoryRoot);
  return values.json
    ? jsonResult(report.exitCode, {
        ok: report.exitCode === cliExitCode.success,
        command: "doctor",
        repositoryRoot,
        checks: report.checks
      })
    : textResult(formatDoctorReport(report), report.exitCode);
}

async function handleScanCommand(args: string[], cwd: string): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: commonOptions()
  });
  requireNoPositionals(positionals, "repopilot scan [--repo path] [--json]");
  if (values.help) return textResult(helpText);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const analysis = await analyzeRepository(repositoryRoot);
  return values.json
    ? jsonResult(cliExitCode.success, {
        ok: true,
        command: "scan",
        repositoryRoot,
        analysis
      })
    : textResult(formatAnalysis(analysis));
}

async function handleProvidersCommand(
  args: string[],
  cwd: string,
  runtime: CliProviderRuntime
): Promise<CliResult> {
  const subcommand = args[0] ?? "list";
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      ...commonOptions(),
      model: { type: "string" },
      endpoint: { type: "string" }
    }
  });
  if (values.help) return textResult(helpText);
  if (subcommand !== "configure")
    requireNoPositionals(positionals, "repopilot providers <list|doctor|configure> [--json]");
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  if (subcommand === "list") {
    const providers = listProviderDefinitions();
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "providers list", providers })
      : textResult(formatProviders(providers));
  }
  if (subcommand === "doctor") {
    const providers = await inspectProviders(await configuredProviders(repositoryRoot, runtime));
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "providers doctor", providers })
      : textResult(formatProviderHealth(providers));
  }
  if (subcommand === "configure") {
    if (positionals.length !== 1 || positionals[0] !== "ollama")
      throw new CliUsageError("Usage: repopilot providers configure ollama --model name");
    const model = stringOption(values.model, "--model");
    if (!model) throw new CliUsageError("--model is required.");
    const config = {
      version: 1 as const,
      ollama: {
        model,
        endpoint: stringOption(values.endpoint, "--endpoint") ?? "http://127.0.0.1:11434",
        timeoutMs: 120_000,
        maxResponseBytes: 100_000
      }
    };
    const configPath = await writeModelConfig(repositoryRoot, config);
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "providers configure", configPath })
      : textResult(`Configured Ollama in ${modelConfigPath}.`);
  }
  throw new CliUsageError(`Unknown providers command: ${subcommand}`);
}

async function configuredProviders(
  repositoryRoot: string,
  runtime: CliProviderRuntime
): Promise<ProviderRegistry> {
  const providers = new ProviderRegistry([new FakeAgentProvider()]);
  const config = await loadModelConfig(repositoryRoot);
  if (config?.ollama) providers.register(new OllamaAgentProvider(config.ollama, runtime.fetcher));
  if (runtime.codexTransport) providers.register(new CodexAgentProvider(runtime.codexTransport));
  return providers;
}

async function handlePolicyCommand(args: string[], cwd: string): Promise<CliResult> {
  const subcommand = args[0] ?? "show";
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: commonOptions()
  });
  if (values.help) return textResult(helpText);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);

  if (subcommand === "show") {
    requireNoPositionals(positionals, "repopilot policy show [--repo path] [--json]");
    const repositoryConfig = await loadRepositoryConfig(repositoryRoot);
    const resolved = resolvePolicy({ repositoryConfig });
    return values.json
      ? jsonResult(cliExitCode.success, {
          ok: true,
          command: "policy show",
          repositoryRoot,
          policy: resolved
        })
      : textResult(`Resolved RepoPilot policy\n${formatResolvedPolicy(resolved)}`);
  }
  if (subcommand === "validate") {
    requireNoPositionals(positionals, "repopilot policy validate [--repo path] [--json]");
    const repositoryConfig = await loadRepositoryConfig(repositoryRoot);
    if (!repositoryConfig) {
      const message = `Missing ${repoPilotConfigPath}. Run repopilot init.`;
      return values.json
        ? jsonResult(cliExitCode.invalidConfiguration, {
            ok: false,
            command: "policy validate",
            repositoryRoot,
            error: { message }
          })
        : textResult(message, cliExitCode.invalidConfiguration);
    }
    const resolved = resolvePolicy({ repositoryConfig });
    return values.json
      ? jsonResult(cliExitCode.success, {
          ok: true,
          command: "policy validate",
          repositoryRoot,
          policy: resolved
        })
      : textResult(`Policy configuration is valid.\n${formatResolvedPolicy(resolved)}`);
  }
  if (subcommand === "init") {
    requireNoPositionals(positionals, "repopilot init [--repo path] [--json]");
    if (existsSync(path.join(repositoryRoot, repoPilotConfigPath))) {
      const message = `${repoPilotConfigPath} already exists.`;
      return values.json
        ? jsonResult(cliExitCode.invalidConfiguration, {
            ok: false,
            command: "policy init",
            repositoryRoot,
            error: { message }
          })
        : textResult(message, cliExitCode.invalidConfiguration);
    }
    await writeRepositoryConfig(repositoryRoot, defaultConfig("balanced"));
    const message = `Created ${repoPilotConfigPath} using the balanced preset.`;
    return values.json
      ? jsonResult(cliExitCode.success, {
          ok: true,
          command: "policy init",
          repositoryRoot,
          configPath: path.join(repositoryRoot, repoPilotConfigPath)
        })
      : textResult(message);
  }
  if (subcommand === "set") {
    if (positionals.length !== 2) {
      throw new CliUsageError("Usage: repopilot policy set <path> <value> [--repo path] [--json]");
    }
    const [key, value] = positionals;
    if (!key || value === undefined) throw new CliUsageError("Policy path and value are required.");
    const existing = (await loadRepositoryConfig(repositoryRoot)) ?? defaultConfig("balanced");
    const updated = setPolicyValue(existing, key, value);
    await writeRepositoryConfig(repositoryRoot, updated);
    return values.json
      ? jsonResult(cliExitCode.success, {
          ok: true,
          command: "policy set",
          repositoryRoot,
          path: key,
          value
        })
      : textResult(`Updated ${repoPilotConfigPath}: ${key} = ${value}`);
  }
  throw new CliUsageError(`Unknown policy command: ${subcommand}`);
}

async function handleRunCommand(
  args: string[],
  cwd: string,
  runtime: CliProviderRuntime
): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      ...commonOptions(),
      parallel: { type: "boolean" },
      "max-workers": { type: "string" },
      "auto-commit": { type: "boolean" },
      "no-push": { type: "boolean" },
      "non-interactive": { type: "boolean" },
      provider: { type: "string" }
    }
  });
  if (values.help) return textResult(helpText);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const repositoryConfig = await loadRepositoryConfig(repositoryRoot);
  const cliOverrides = parseRunOverrides(values);
  const resolved = resolvePolicy({ repositoryConfig, cliOverrides });
  if (positionals.length > 0) {
    const providerId = stringOption(values.provider, "--provider");
    if (!providerId) {
      throw new CliUsageError("Provider-backed runs require --provider.");
    }
    const objective = positionals.join(" ").trim();
    if (!objective) throw new CliUsageError("Run objective is required.");
    const store = new WorkflowStore(repositoryRoot);
    const created = await store.createRun({ objective, provider: providerId });
    const outcome = await new WorkflowEngine({
      store,
      providers: await configuredProviders(repositoryRoot, runtime),
      policy: resolved.execution
    }).run(created.id);
    const exitCode =
      outcome.run.status === "completed" ? cliExitCode.success : cliExitCode.workflowError;
    return values.json
      ? jsonResult(exitCode, {
          ok: exitCode === cliExitCode.success,
          command: "run",
          repositoryRoot,
          executionImplemented: true,
          providerEvents: outcome.providerEvents,
          run: outcome.run
        })
      : textResult(
          `RepoPilot workflow\n${formatRun(outcome.run)}\nProvider events: ${outcome.providerEvents}`,
          exitCode
        );
  }
  if (values.provider) throw new CliUsageError("--provider requires a run objective.");
  const externalWriteNotice =
    resolved.execution.pushes.enabled || resolved.execution.pull_requests.enabled
      ? "\nExternal write actions are enabled by policy and must be authorized before execution."
      : "";
  if (values.json) {
    return jsonResult(cliExitCode.success, {
      ok: true,
      command: "run",
      repositoryRoot,
      nonInteractive: values["non-interactive"] ?? false,
      executionImplemented: false,
      policy: resolved
    });
  }
  return textResult(
    `Resolved RepoPilot policy for this run\n${formatResolvedPolicy(resolved)}No objective supplied; no workflow was started.${externalWriteNotice}`
  );
}

async function handleRunsCommand(args: string[], cwd: string): Promise<CliResult> {
  const subcommand = args[0] ?? "list";
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: { ...commonOptions(), provider: { type: "string" } }
  });
  if (values.help) return textResult(helpText);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const store = new WorkflowStore(repositoryRoot);

  if (subcommand === "list") {
    requireNoPositionals(positionals, "repopilot runs list [--repo path] [--json]");
    if (values.provider) throw new CliUsageError("--provider is only valid with runs create.");
    const runs = await store.listRuns();
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "runs list", repositoryRoot, runs })
      : textResult(formatRunList(runs));
  }
  if (subcommand === "create") {
    if (positionals.length === 0) {
      throw new CliUsageError(
        "Usage: repopilot runs create <objective> [--provider name] [--repo path] [--json]"
      );
    }
    const objective = positionals.join(" ").trim();
    const provider = stringOption(values.provider, "--provider");
    const run = await store.createRun({ objective, ...(provider ? { provider } : {}) });
    return values.json
      ? jsonResult(cliExitCode.success, {
          ok: true,
          command: "runs create",
          repositoryRoot,
          run
        })
      : textResult(`Created workflow run ${run.id}\n${formatRun(run)}`);
  }
  throw new CliUsageError(`Unknown runs command: ${subcommand}`);
}

async function handleStatusCommand(args: string[], cwd: string): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: commonOptions()
  });
  if (values.help) return textResult(helpText);
  if (positionals.length !== 1 || !positionals[0]) {
    throw new CliUsageError("Usage: repopilot status <run-id> [--repo path] [--json]");
  }
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const run = await new WorkflowStore(repositoryRoot).loadRun(positionals[0]);
  return values.json
    ? jsonResult(cliExitCode.success, { ok: true, command: "status", repositoryRoot, run })
    : textResult(formatRun(run));
}

async function handleResumeCommand(args: string[], cwd: string): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: commonOptions()
  });
  if (values.help) return textResult(helpText);
  if (positionals.length !== 1 || !positionals[0]) {
    throw new CliUsageError("Usage: repopilot resume <run-id> [--repo path] [--json]");
  }
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const run = await new WorkflowStore(repositoryRoot).resumeRun(positionals[0]);
  return values.json
    ? jsonResult(cliExitCode.success, { ok: true, command: "resume", repositoryRoot, run })
    : textResult(`Resumed workflow run ${run.id}\n${formatRun(run)}`);
}

function parseRunOverrides(values: {
  parallel?: boolean | undefined;
  "max-workers"?: string | undefined;
  "auto-commit"?: boolean | undefined;
  "no-push"?: boolean | undefined;
}): PolicyOverride {
  const override: PolicyOverride = {};
  if (values.parallel) {
    override.parallelism = {
      enabled: true,
      strategy: "parallel_analysis",
      allow_parallel_reads: true,
      allow_parallel_writes: false
    };
  }
  if (values["max-workers"] !== undefined) {
    const workerCount = Number(values["max-workers"]);
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 16) {
      throw new CliUsageError("--max-workers must be an integer between 1 and 16.");
    }
    override.parallelism = { ...override.parallelism, max_workers: workerCount };
  }
  if (values["auto-commit"]) override.commits = { enabled: true, strategy: "after_feature" };
  if (values["no-push"]) override.pushes = { enabled: false, strategy: "never" };
  return override;
}

function formatAnalysis(analysis: RepositoryAnalysis): string {
  const evidenceCount = [
    ...analysis.metadata.isGitRepository.evidence,
    ...analysis.metadata.topLevelFiles.evidence,
    ...analysis.languages.flatMap((item) => item.evidence),
    ...analysis.packageManagers.flatMap((item) => item.evidence),
    ...analysis.manifests.flatMap((item) => item.evidence),
    ...analysis.ciWorkflows.flatMap((item) => item.evidence),
    ...analysis.agentInstructions.flatMap((item) => item.evidence)
  ].length;
  const names = (items: string[]): string =>
    items.length > 0 ? items.join(", ") : "none detected";
  return [
    "RepoPilot scan",
    `- Repository: ${analysis.metadata.rootPath}`,
    `- Git repository: ${analysis.metadata.isGitRepository.value ? "yes" : "no"}`,
    `- Current branch: ${analysis.metadata.currentBranch.value ?? "unavailable"}`,
    `- Working tree: ${analysis.metadata.isDirty.value === null ? "unavailable" : analysis.metadata.isDirty.value ? "dirty" : "clean"}`,
    `- Files scanned: ${analysis.metadata.scannedFileCount.value}${analysis.metadata.scanTruncated.value ? " (truncated)" : ""}`,
    `- Languages: ${names(analysis.languages.map((item) => item.name))}`,
    `- Package managers: ${names(analysis.packageManagers.map((item) => item.name))}`,
    `- Manifests: ${names(analysis.manifests.map((item) => item.path))}`,
    `- Workspaces: ${names(analysis.workspaces.map((item) => `${item.kind}:${item.configPath}`))}`,
    `- Package scripts: ${analysis.scripts.length}`,
    `- Test tools: ${names(analysis.testFrameworks.map((item) => item.name))}`,
    `- Formatting tools: ${names(analysis.formattingTools.map((item) => item.name))}`,
    `- Linting tools: ${names(analysis.lintingTools.map((item) => item.name))}`,
    `- Type-checking tools: ${names(analysis.typeCheckingTools.map((item) => item.name))}`,
    `- CI workflows: ${analysis.ciWorkflows.length}`,
    `- Agent instruction files: ${analysis.agentInstructions.length}`,
    `- Evidence records: ${evidenceCount}`,
    `- Warnings: ${analysis.warnings.length}`
  ].join("\n");
}

function formatProviders(providers: ProviderDefinition[]): string {
  return [
    "RepoPilot providers",
    ...providers.map(
      (provider) =>
        `- ${provider.id}: ${provider.displayName} [${provider.integration}] (${provider.capabilities.join(", ")})`
    )
  ].join("\n");
}

function formatProviderHealth(providers: ProviderInspection[]): string {
  return [
    "RepoPilot provider health",
    ...providers.map(
      (provider) => `- ${provider.id}: ${provider.health.status} (${provider.health.message})`
    )
  ].join("\n");
}

function formatRunList(runs: RunSnapshot[]): string {
  if (runs.length === 0) return "RepoPilot runs\nNo workflow runs found.";
  return [
    "RepoPilot runs",
    ...runs.map((run) => `- ${run.id} [${run.status}] ${run.objective}`)
  ].join("\n");
}

function formatRun(run: RunSnapshot): string {
  return [
    `Run: ${run.id}`,
    `Objective: ${run.objective}`,
    `Status: ${run.status}`,
    `Provider: ${run.provider ?? "not selected"}`,
    `Tasks: ${run.tasks.length}`,
    `Pending approvals: ${run.approvals.filter((approval) => approval.status === "pending").length}`,
    `Artifacts: ${run.artifacts.length}`,
    `Last event: ${run.lastSequence}`,
    `Updated: ${run.updatedAt}`
  ].join("\n");
}

function commonOptions(includeRepository = true) {
  return {
    ...(includeRepository ? { repo: { type: "string" as const } } : {}),
    json: { type: "boolean" as const },
    help: { type: "boolean" as const, short: "h" }
  };
}

function requireNoPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) throw new CliUsageError(`Usage: ${usage}`);
}

function stringOption(value: string | boolean | undefined, name: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  throw new CliUsageError(`${name} requires a value.`);
}

function resolveRepository(requestedPath: string | undefined, cwd: string): string {
  const repositoryRoot = path.resolve(cwd, requestedPath ?? ".");
  if (!isDirectory(repositoryRoot)) {
    throw new CliUsageError(`Repository path is not a directory: ${repositoryRoot}`);
  }
  return repositoryRoot;
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function commandVersion(command: string, args: string[]): { ok: boolean; value: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return { ok: false, value: "not found" };
  return { ok: true, value: result.stdout.trim() };
}

function commandSucceeds(command: string, args: string[], cwd: string): boolean {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return !result.error && result.status === 0;
}

function readCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("CLI package version is missing.");
  return packageJson.version;
}

function classifyError(error: unknown, command: string | undefined): number {
  if (error instanceof CliUsageError || isParseArgsError(error)) return cliExitCode.usageError;
  if (command === "policy" || command === "init" || command === "validate") {
    return cliExitCode.invalidConfiguration;
  }
  if (command === "scan") return cliExitCode.analysisError;
  if (command === "runs" || command === "status" || command === "resume") {
    return cliExitCode.workflowError;
  }
  return cliExitCode.generalError;
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

function textResult(output: string, exitCode: number = cliExitCode.success): CliResult {
  return { exitCode, output };
}

function jsonResult(exitCode: number, value: unknown): CliResult {
  return { exitCode, output: JSON.stringify(value, null, 2) };
}

class CliUsageError extends Error {}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv);
  const stream = result.exitCode === cliExitCode.success ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
