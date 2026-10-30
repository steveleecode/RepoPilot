#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { analyzeRepository, type RepositoryAnalysis } from "@repopilot/analyzer";
import {
  applyChanges,
  getDevelopmentArtifacts,
  proposeChanges,
  validateAppliedChanges,
  WorkflowEngine
} from "@repopilot/orchestrator";
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
import { CodexAppServerTransport } from "@repopilot/provider/codex-app-server";
import {
  loadModelConfig,
  modelConfigPath,
  OllamaAgentProvider,
  writeModelConfig
} from "@repopilot/provider/ollama";
import type { CodexTransport } from "@repopilot/provider";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";
import {
  codexAgentRoles,
  featurePrompt,
  generateCodexSetup,
  promptCodexSetup,
  selectedAgentIds
} from "./codex-setup.js";
import { tailorCodexAgents } from "./codex-tailoring.js";
import { generateGithubReinforcement } from "./github-setup.js";
import { defaultGeminiModel, runInteractiveGeminiChat } from "./gemini-chat.js";
import {
  loadGeminiKey,
  prepareGeminiEnv,
  promptGeminiKey,
  readKeyFromStdin,
  saveGeminiKey
} from "./gemini-config.js";

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

const overviewText = `RepoPilot ${cliVersion}

Start with a repository:
  repopilot setup --repo <path>            Configure policy, agents, and optional Gemini chat
  repopilot doctor --repo <path>           Check local requirements
  repopilot scan --repo <path>             See evidence-backed repository facts

Work on a task:
  repopilot codex prompt "<task>"          Generate a multi-agent launch prompt
  repopilot plan "<task>" --provider codex  Create a read-only plan
  repopilot propose <run-id>               Generate reviewable changes
  repopilot inspect <run-id>               Review the plan and proposed changes
  repopilot apply <run-id> --approve        Apply to an isolated worktree
  repopilot verify <run-id> --execute-checks  Run trusted checks in that worktree

Other paths:
  repopilot chat                          Gemini advice (read-only)
  repopilot providers doctor              Check Codex and Ollama integrations
  repopilot help <setup|workflow|providers|policy>  Show a focused guide
  repopilot --help                        Show every command and option

Commands use the current directory unless --repo <path> is given. No command silently pushes, merges, or deploys.`;

const helpTopics: Record<string, string> = {
  setup: `Setup
  repopilot setup --repo <path>             Guided setup in a terminal
  repopilot codex setup --repo <path>       Select agents without full setup
  repopilot config gemini --repo <path>     Add or rotate a local Gemini key
  repopilot config status --repo <path>     Show setup status without secrets

Setup preserves existing files. Gemini tailoring is opt-in. For scripted setup, use --agents id,id and --description text; --ai --yes accepts validated AI focus.`,
  workflow: `Workflow
  repopilot plan "<task>" --provider codex --repo <path>
  repopilot propose <run-id> --repo <path>
  repopilot inspect <run-id> --repo <path>
  repopilot apply <run-id> --approve --repo <path>
  repopilot verify <run-id> --execute-checks --repo <path>

Planning is read-only. Inspect before apply. Apply writes only to an isolated worktree; verify may execute target-project scripts and should be used only for trusted projects.`,
  providers: `Providers
  repopilot providers list
  repopilot providers doctor --repo <path>
  repopilot providers codex login
  repopilot providers codex status
  repopilot providers configure ollama --model <installed-model> --repo <path>

Codex uses its own login. Ollama requires a locally running server and installed model. Gemini chat uses a local .repopilot/.env key.`,
  policy: `Policy
  repopilot policy show --repo <path>
  repopilot policy validate --repo <path>
  repopilot policy set <path> <value> --repo <path>
  repopilot run --repo <path>               Preview effective policy

Repository policy controls Git actions and validation gates. Setup never authorizes a push or pull request by itself.`
};

const helpText = `RepoPilot

Usage:
  repopilot --help
  repopilot help [setup|workflow|providers|policy]
  repopilot setup [--repo path] [--agents id,id] [--description text] [--ai] [--yes]
  repopilot version [--json]
  repopilot doctor [--repo path] [--json]
  repopilot init [--repo path] [--json]
  repopilot scan [--repo path] [--json]
  repopilot providers <list|doctor> [--repo path] [--json]
  repopilot providers codex login [--device-code]
  repopilot providers codex status
  repopilot codex setup [--repo path] [--agents id,id] [--description text] [--ai] [--yes] [--json]
  repopilot codex prompt <feature or bug> [--repo path]
  repopilot config <setup|gemini|status> [--repo path]
  repopilot config gemini --stdin [--repo path]
  repopilot chat [--repo path] [--model name] [--no-context]
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
  repopilot plan <objective> --provider <fake|ollama|codex> [--repo path] [--json]
  repopilot propose <run-id> [--task id] [--file path] [--repo path] [--json]
  repopilot repair <run-id> [--file path] [--repo path] [--json]
  repopilot apply <run-id> [--approve] [--repo path] [--json]
  repopilot verify <run-id> --execute-checks [--repo path] [--json]
  repopilot inspect <run-id> [--repo path] [--json]

Commands:
  setup     Guided project setup (alias for config setup).
  plan      Create a provider-backed read-only plan (alias for run <objective>).
  version   Print the RepoPilot CLI version.
  doctor    Inspect the local RepoPilot environment.
  init      Initialize repository policy using the balanced preset.
  scan      Analyze repository metadata and print evidence-backed facts.
  providers Discover available agent-provider adapters and capabilities.
  codex     Generate multi-agent configuration or a task-specific launch prompt.
  config    Set up project configuration, GitHub CI when detected, and a local Gemini key.
  chat      Start a read-only, streaming Gemini advice session.
  validate  Validate the repository policy configuration.
  runs      Create and list durable workflow runs.
  status    Show a reconstructed workflow run snapshot.
  resume    Move an interrupted or failed run back to planning.
  policy    Show, validate, initialize, or update execution policy.
  run       Preview policy or execute a provider-backed read-only workflow.
  propose   Ask Ollama or Codex for bounded, reviewable changes to a planned task.
  repair    Propose a bounded repair after failed validation.
  apply     Apply a validated proposal to an isolated Git worktree.
  verify    Execute trusted validation checks in the applied worktree.
  inspect   Show the plan, proposal, applied worktree, and validation artifacts.

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
    if (!command) return textResult(overviewText);
    if (command === "--help" || command === "-h") return textResult(helpText);
    if (command === "help") {
      if (commandArgs.length > 1)
        throw new CliUsageError("Usage: repopilot help [setup|workflow|providers|policy]");
      const topic = commandArgs[0];
      if (!topic) return textResult(overviewText);
      if (!helpTopics[topic])
        throw new CliUsageError(
          `Unknown help topic: ${topic}. Choose setup, workflow, providers, or policy.`
        );
      return textResult(helpTopics[topic]);
    }
    if (command === "setup")
      return await handleConfigCommand(["setup", ...commandArgs], cwd, runtime);
    if (command === "version") return handleVersionCommand(commandArgs);
    if (command === "doctor") return handleDoctorCommand(commandArgs, cwd);
    if (command === "init") return await handlePolicyCommand(["init", ...commandArgs], cwd);
    if (command === "scan") return await handleScanCommand(commandArgs, cwd);
    if (command === "providers") return await handleProvidersCommand(commandArgs, cwd, runtime);
    if (command === "codex") return await handleCodexCommand(commandArgs, cwd, runtime);
    if (command === "config") return await handleConfigCommand(commandArgs, cwd, runtime);
    if (command === "chat") return await handleChatCommand(commandArgs, cwd, runtime);
    if (command === "validate") {
      return await handlePolicyCommand(["validate", ...commandArgs], cwd);
    }
    if (command === "policy") return await handlePolicyCommand(commandArgs, cwd);
    if (command === "runs") return await handleRunsCommand(commandArgs, cwd);
    if (command === "status") return await handleStatusCommand(commandArgs, cwd);
    if (command === "resume") return await handleResumeCommand(commandArgs, cwd);
    if (command === "run") return await handleRunCommand(commandArgs, cwd, runtime);
    if (command === "plan") return await handleRunCommand(commandArgs, cwd, runtime, true);
    if (
      command === "propose" ||
      command === "repair" ||
      command === "apply" ||
      command === "verify" ||
      command === "inspect"
    ) {
      return await handleDevelopmentCommand(command, commandArgs, cwd);
    }
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    const exitCode = classifyError(error, command);
    const message = error instanceof Error ? error.message : "Unknown error.";
    return wantsJson
      ? jsonResult(exitCode, { ok: false, error: { message, exitCode } })
      : textResult(`Error: ${message}\n\nRun repopilot --help for usage.`, exitCode);
  }
}

interface CodexSetupFlags {
  agents: string | undefined;
  description: string | undefined;
  ai: boolean;
  yes: boolean;
  interactive: boolean;
}

async function runCodexSetup(
  repositoryRoot: string,
  flags: CodexSetupFlags,
  runtime: CliProviderRuntime
) {
  if (flags.yes && !flags.ai) throw new CliUsageError("--yes requires --ai.");
  let agents =
    flags.agents === undefined
      ? selectedAgentIds()
      : selectedAgentIds(
          flags.agents === "none"
            ? []
            : flags.agents
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean)
        );
  let description = flags.description ?? "";
  let useGemini = flags.ai;
  const guided =
    flags.interactive && flags.agents === undefined && flags.description === undefined && !flags.ai;
  if (guided) {
    const geminiAvailable = Boolean(
      process.env.GEMINI_API_KEY || (await loadGeminiKey(repositoryRoot))
    );
    const choices = await promptCodexSetup(process.stdin, process.stdout, geminiAvailable);
    agents = choices.agents;
    description = choices.description;
    useGemini = choices.useGemini;
  }
  if (description.length > 2_000)
    throw new CliUsageError("Project description must be 2,000 characters or less.");
  let focus: Record<string, string> | undefined;
  if (useGemini) {
    if (!flags.interactive && !flags.yes)
      throw new CliUsageError("Non-interactive AI tailoring requires --ai --yes.");
    const key = process.env.GEMINI_API_KEY || (await loadGeminiKey(repositoryRoot)) || "";
    focus = await tailorCodexAgents({
      apiKey: key,
      agents,
      description,
      ...(runtime.fetcher ? { fetcher: runtime.fetcher } : {})
    });
    if (flags.interactive && !flags.yes) {
      process.stdout.write("\nGemini-proposed focus (base rules remain unchanged):\n");
      for (const [id, value] of Object.entries(focus)) process.stdout.write(`  ${id}: ${value}\n`);
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      try {
        const answer = await rl.question("Accept these additions? [y/N]: ");
        if (!/^y(?:es)?$/i.test(answer.trim())) focus = undefined;
      } finally {
        rl.close();
      }
    }
  }
  const result = await generateCodexSetup(repositoryRoot, { agents, ...(focus ? { focus } : {}) });
  return { ...result, agents, aiTailored: Boolean(focus) };
}

async function handleConfigCommand(
  args: string[],
  cwd: string,
  runtime: CliProviderRuntime
): Promise<CliResult> {
  const subcommand = args[0];
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      ...commonOptions(),
      stdin: { type: "boolean" },
      "skip-gemini": { type: "boolean" },
      agents: { type: "string" },
      description: { type: "string" },
      ai: { type: "boolean" },
      yes: { type: "boolean" }
    }
  });
  if (values.help) return textResult(helpText);
  requireNoPositionals(positionals, "repopilot config <setup|gemini|status> [--repo path]");
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  if (subcommand === "status") {
    if (
      values.stdin ||
      values["skip-gemini"] ||
      values.agents ||
      values.description ||
      values.ai ||
      values.yes
    )
      throw new CliUsageError("--stdin and --skip-gemini are not valid with config status.");
    const report = {
      policyConfigured: existsSync(path.join(repositoryRoot, repoPilotConfigPath)),
      codexConfigured: existsSync(path.join(repositoryRoot, ".codex/config.toml")),
      geminiConfigured: Boolean(await loadGeminiKey(repositoryRoot))
    };
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "config status", ...report })
      : textResult(
          `RepoPilot configuration\nPolicy: ${report.policyConfigured ? "configured" : "missing"}\nCodex agents: ${report.codexConfigured ? "configured" : "missing"}\nGemini key: ${report.geminiConfigured ? "configured" : "missing"}`
        );
  }
  if (values.json) throw new CliUsageError("Interactive configuration does not support --json.");
  if (subcommand === "gemini") {
    if (values["skip-gemini"] || values.agents || values.description || values.ai || values.yes)
      throw new CliUsageError("--skip-gemini is only valid with config setup.");
    const key = values.stdin
      ? await readKeyFromStdin(process.stdin)
      : await promptGeminiKey(process.stdin, process.stdout);
    if (!key) return textResult("Gemini key unchanged.");
    await saveGeminiKey(repositoryRoot, key);
    return textResult("Gemini key saved to .repopilot/.env (value hidden).");
  }
  if (subcommand === "setup") {
    if (values.stdin) throw new CliUsageError("--stdin is only valid with config gemini.");
    await prepareGeminiEnv(repositoryRoot);
    const policyCreated = !existsSync(path.join(repositoryRoot, repoPilotConfigPath));
    if (policyCreated) await writeRepositoryConfig(repositoryRoot, defaultConfig("balanced"));
    let geminiConfigured = Boolean(await loadGeminiKey(repositoryRoot));
    if (
      !geminiConfigured &&
      !values["skip-gemini"] &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const key = await promptGeminiKey(process.stdin, process.stdout);
      if (key) {
        await saveGeminiKey(repositoryRoot, key);
        geminiConfigured = true;
      }
    }
    const codex = await runCodexSetup(
      repositoryRoot,
      {
        agents: stringOption(values.agents, "--agents"),
        description: stringOption(values.description, "--description"),
        ai: Boolean(values.ai),
        yes: Boolean(values.yes),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
      },
      runtime
    );
    const github = await generateGithubReinforcement(repositoryRoot);
    return textResult(
      `RepoPilot setup complete.\nPolicy: ${policyCreated ? "created" : "existing"}\nCodex files created: ${codex.created.join(", ") || "none"}\nCodex files skipped: ${codex.skipped.join(", ") || "none"}\nExisting unselected agents left untouched: ${codex.existingUnselected.join(", ") || "none"}\nGitHub: ${github.detected ? "detected" : "not detected"}\nCI files created: ${github.created.join(", ") || "none"}\nCI files skipped: ${github.skipped.join(", ") || "none"}\n${github.guidance.join("\n")}${github.guidance.length ? "\n" : ""}Gemini key: ${geminiConfigured ? "configured" : "not configured; run repopilot config gemini"}`
    );
  }
  throw new CliUsageError("Usage: repopilot config <setup|gemini|status> [--repo path]");
}

async function handleChatCommand(
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
      model: { type: "string" },
      "no-context": { type: "boolean" }
    }
  });
  if (values.help) return textResult(helpText);
  requireNoPositionals(positionals, "repopilot chat [--repo path] [--model name] [--no-context]");
  if (values.json) throw new CliUsageError("Interactive chat does not support --json.");
  if (!process.stdin.isTTY) throw new CliUsageError("Interactive chat requires a terminal.");
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  await runInteractiveGeminiChat({
    repositoryRoot,
    apiKey: process.env.GEMINI_API_KEY || (await loadGeminiKey(repositoryRoot)) || "",
    model: stringOption(values.model, "--model") ?? defaultGeminiModel,
    includeContext: !values["no-context"],
    input: process.stdin,
    output: process.stdout,
    ...(runtime.fetcher ? { fetcher: runtime.fetcher } : {}),
    animate: Boolean(process.stdout.isTTY)
  });
  return textResult("Chat ended.");
}

async function handleCodexCommand(
  args: string[],
  cwd: string,
  runtime: CliProviderRuntime
): Promise<CliResult> {
  const subcommand = args[0];
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      ...commonOptions(),
      agents: { type: "string" },
      description: { type: "string" },
      ai: { type: "boolean" },
      yes: { type: "boolean" }
    }
  });
  if (values.help) return textResult(helpText);
  if (subcommand === "prompt") {
    if (values.agents || values.description || values.ai || values.yes)
      throw new CliUsageError("Agent setup options are not valid with codex prompt.");
    if (positionals.length !== 1 || !positionals[0])
      throw new CliUsageError("Usage: repopilot codex prompt <feature or bug> [--repo path]");
    const prompt = featurePrompt(positionals[0]);
    return values.json
      ? jsonResult(cliExitCode.success, { ok: true, command: "codex prompt", prompt })
      : textResult(prompt);
  }
  if (subcommand !== "setup" || positionals.length !== 0)
    throw new CliUsageError("Usage: repopilot codex <setup|prompt> [--repo path] [--json]");
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const result = await runCodexSetup(
    repositoryRoot,
    {
      agents: stringOption(values.agents, "--agents"),
      description: stringOption(values.description, "--description"),
      ai: Boolean(values.ai),
      yes: Boolean(values.yes),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.json)
    },
    runtime
  );
  const github = await generateGithubReinforcement(repositoryRoot);
  return values.json
    ? jsonResult(cliExitCode.success, {
        ok: true,
        command: "codex setup",
        repositoryRoot,
        ...result,
        availableAgents: codexAgentRoles.map(({ id, label, default: defaultSelected }) => ({
          id,
          label,
          defaultSelected
        })),
        github
      })
    : textResult(
        `Codex multi-agent setup generated; no agents were run.\nSelected agents: ${result.agents.join(", ") || "none"}\nGemini tailored: ${result.aiTailored ? "yes" : "no"}\nCreated: ${result.created.join(", ") || "none"}\nSkipped existing: ${result.skipped.join(", ") || "none"}\nExisting unselected agents left untouched: ${result.existingUnselected.join(", ") || "none"}\nGitHub: ${github.detected ? "detected" : "not detected"}\nCI files created: ${github.created.join(", ") || "none"}\n${github.guidance.join("\n")}`
      );
}

async function handleDevelopmentCommand(
  command: "propose" | "repair" | "apply" | "verify" | "inspect",
  args: string[],
  cwd: string
): Promise<CliResult> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      ...commonOptions(),
      task: { type: "string" },
      file: { type: "string", multiple: true },
      approve: { type: "boolean" },
      "execute-checks": { type: "boolean" }
    }
  });
  if (values.help) return textResult(helpText);
  if (positionals.length !== 1 || !positionals[0])
    throw new CliUsageError(`Usage: repopilot ${command} <run-id>`);
  const repositoryRoot = resolveRepository(stringOption(values.repo, "--repo"), cwd);
  const store = new WorkflowStore(repositoryRoot);
  const runId = positionals[0];
  let result: unknown;
  if (command === "propose" || command === "repair") {
    const run = await store.loadRun(runId);
    const config = run.provider === "ollama" ? await loadModelConfig(repositoryRoot) : undefined;
    if (run.provider === "ollama" && !config?.ollama)
      throw new Error("Ollama is not configured. Run providers configure ollama.");
    const taskId = stringOption(values.task, "--task");
    const policy = resolvePolicy({
      repositoryConfig: await loadRepositoryConfig(repositoryRoot)
    }).execution;
    result = await proposeChanges({
      store,
      runId,
      ...(config?.ollama ? { ollama: config.ollama } : {}),
      policy,
      repair: command === "repair",
      ...(taskId ? { taskId } : {}),
      files: values.file ?? []
    });
  } else if (command === "apply") {
    const config = await loadRepositoryConfig(repositoryRoot);
    const policy = resolvePolicy({ repositoryConfig: config }).execution;
    if (values.approve) {
      const approval = await store.requestApproval(runId, "apply");
      await store.decideApproval(runId, approval.id, true, "Explicit --approve CLI flag.");
    }
    result = {
      worktree: await applyChanges({ store, runId, policy, approval: values.approve ?? false })
    };
  } else if (command === "verify") {
    const config = await loadRepositoryConfig(repositoryRoot);
    const policy = resolvePolicy({ repositoryConfig: config }).execution;
    if (values["execute-checks"]) {
      const approval = await store.requestApproval(runId, "execute-validation");
      await store.decideApproval(runId, approval.id, true, "Explicit --execute-checks CLI flag.");
    }
    result = await validateAppliedChanges({
      store,
      runId,
      policy,
      executeChecks: values["execute-checks"] ?? false
    });
  } else {
    result = getDevelopmentArtifacts(await store.loadRun(runId));
  }
  const exitCode =
    command === "verify" &&
    typeof result === "object" &&
    result !== null &&
    "passed" in result &&
    result.passed === false
      ? cliExitCode.workflowError
      : cliExitCode.success;
  return values.json
    ? jsonResult(exitCode, {
        ok: exitCode === cliExitCode.success,
        command,
        repositoryRoot,
        runId,
        result
      })
    : textResult(`${command}: ${JSON.stringify(result, null, 2)}`, exitCode);
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
      endpoint: { type: "string" },
      "device-code": { type: "boolean" }
    }
  });
  if (values.help) return textResult(helpText);
  if (subcommand === "codex") {
    if (positionals.length !== 1 || !["login", "status"].includes(positionals[0] ?? ""))
      throw new CliUsageError("Usage: repopilot providers codex <login|status>");
    if (values.json && positionals[0] === "login")
      throw new CliUsageError("Interactive Codex login does not support --json.");
    const action = positionals[0] as "login" | "status";
    const result = spawnSync(
      "codex",
      action === "login"
        ? ["login", ...(values["device-code"] ? ["--device-auth"] : [])]
        : ["login", "status"],
      {
        encoding: "utf8",
        stdio: action === "login" ? "inherit" : "pipe",
        timeout: action === "login" ? 300_000 : 10_000
      }
    );
    if (result.error || result.status !== 0)
      throw new Error(
        action === "login"
          ? "Codex login failed or timed out."
          : "Codex is not signed in. Run repopilot providers codex login."
      );
    return textResult(
      action === "login" ? "Codex login completed." : result.stdout?.trim() || "Codex is signed in."
    );
  }
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
  providers.register(
    new CodexAgentProvider(runtime.codexTransport ?? new CodexAppServerTransport())
  );
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
  runtime: CliProviderRuntime,
  requireObjective = false
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
  if (requireObjective && positionals.length === 0)
    throw new CliUsageError(
      "Usage: repopilot plan <objective> --provider <codex|ollama|fake> [--repo path]"
    );
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

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const result = await runCli(process.argv);
  const stream = result.exitCode === cliExitCode.success ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.exitCode;
}
