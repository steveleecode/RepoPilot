# RepoPilot

RepoPilot is a local-first CLI for setting up an agentic development workflow in an existing
repository. It can analyze repository evidence, generate Codex agent guidance and GitHub CI starters,
chat with Gemini, plan work with Codex or Ollama, and apply validated proposals in isolated worktrees.

## Status

RepoPilot v0.3.0 is a developer preview, not an unattended coding or deployment service. Gemini chat
and agent tailoring are opt-in and use a locally configured key. Codex uses its own authentication.
RepoPilot does not authenticate to GitHub or silently push, merge, or deploy.

Implemented foundations:

- Bounded evidence-backed repository analysis for nested manifests, scripts, workspace layouts, tool configurations, Git metadata, workflows, and agent instructions.
- Deterministic generation contracts and template rendering that returns proposed files without writing them.
- Pre-write validators for generated JSON/YAML, referenced paths, referenced package scripts, and duplicate proposed paths.
- Deterministic instruction linting for long files, duplicate headings, duplicate instructions, missing paths/scripts, and simple command conflicts.
- Versioned execution policy in `.repopilot/config.yaml`, with presets, CLI commands, dashboard display, enforcement helpers, task parallel-safety checks, and audit records.
- Durable local workflow runs backed by versioned append-only event journals.
- Vendor-neutral agent-provider contracts with deterministic fake and transport-injected Codex adapters.
- Local Ollama planning with versioned model configuration and strict plan validation.
- A separate bounded source-context broker for Ollama change proposals, with manifests and strict
  task-scope validation.
- Isolated Git-worktree apply with stale-base detection, plus opt-in trusted validation and bounded
  repair proposals.
- Deterministic workflow orchestration with persisted discovery, planning, authorization, execution, validation, and review gates.
- A bounded local command-execution boundary with a trusted catalog, argument and working-directory authorization, environment isolation, cancellation, output limits, and redaction.
- Next.js dashboard shell with repository placeholders, validation timeline, command palette foundation, and Agent Policy settings.
- CLI commands for doctor checks and policy inspection/update.
- Unit, build, lint, typecheck, CI, and Playwright smoke-test coverage.

## Architecture

RepoPilot is a TypeScript monorepo with apps for the dashboard and CLI, plus packages for deterministic analysis, generation planning, validation, instruction linting, execution policy, shared contracts, and UI primitives. Repository facts must be backed by evidence. Generated content is represented as proposed changes first, then validated before any future write step.

## Setup

Requirements:

- Node.js 22
- pnpm 11
- Git

Install dependencies:

```bash
pnpm install
```

For a standalone installation, download `repopilot-0.3.0.tgz` and its checksum from the release:

```bash
shasum -a 256 -c repopilot-0.3.0.sha256
npm install -g ./repopilot-0.3.0.tgz
repopilot doctor
```

The release archive contains the CLI and context broker; it does not require the monorepo or a
global pnpm installation for the CLI itself. pnpm 11 is needed when validating pnpm projects.
See the [v0.3.0 developer-preview notes](docs/releases/v0.3.0.md) for the supported workflow,
limitations, upgrade, and uninstall instructions.

## Quick start

From any repository you want RepoPilot to manage:

```bash
repopilot setup --repo /path/to/project
repopilot scan --repo /path/to/project
repopilot config status --repo /path/to/project
repopilot codex prompt "Add a search filter" --repo /path/to/project
```

`setup` is guided in a terminal. It creates the project policy and lets you select Codex specialist
agents. Gemini chat and AI tailoring are optional; if used, the API key is saved only in the
project's ignored `.repopilot/.env`. If a GitHub remote and supported checks are detected, setup
generates a CI starter, but GitHub branch protection must be enabled separately. Existing files are
preserved. Run `repopilot help setup` for focused guidance.

To use RepoPilot's provider-backed workflow:

```bash
repopilot providers codex login
repopilot plan "Improve parser coverage" --provider codex --repo /path/to/project
repopilot propose <run-id> --repo /path/to/project
repopilot inspect <run-id> --repo /path/to/project
repopilot apply <run-id> --approve --repo /path/to/project
repopilot verify <run-id> --execute-checks --repo /path/to/project
```

Planning is read-only; inspect before apply. `apply` writes to an isolated worktree and `verify`
executes target-project checks only with the explicit flag. Use validation only for repositories you
trust. `repopilot help workflow` explains the sequence.

## Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm check
```

For the source checkout, prefix CLI commands with `pnpm repopilot`. The focused help topics are:

```bash
pnpm repopilot help setup
pnpm repopilot help workflow
pnpm repopilot help providers
pnpm repopilot help policy
pnpm repopilot --help
```

## Monorepo Layout

- `apps/web`: Next.js App Router dashboard shell.
- `apps/cli`: `repopilot` command line app.
- `packages/analyzer`: deterministic repository evidence contracts and initial detection.
- `packages/executor`: bounded, no-shell command authorization and local subprocess execution.
- `packages/generator`: generation plan contracts and deterministic template rendering.
- `packages/validator`: validation pipeline and proposed-change validators.
- `packages/instruction-linter`: deterministic linter for agent instruction files.
- `packages/policy`: execution policy presets, schema validation, deterministic authorization, task parallel-safety, and audit records.
- `packages/provider`: provider contracts, normalized events, fake provider, and Codex adapter.
- `packages/orchestrator`: recoverable deterministic workflow engine and gate coordination.
- `packages/workflow`: persistent run, task, event, artifact, and approval state.
- `packages/shared`: shared schemas, result utilities, errors, filesystem and logging interfaces.
- `packages/ui`: accessible UI primitives used by the dashboard.
- `templates`: future template families.
- `docs`: product, architecture, and decision records.

## Documentation

- [Product Spec](docs/product/PRODUCT_SPEC.md)
- [Implementation Roadmap](docs/product/IMPLEMENTATION_ROADMAP.md)
- [Implemented Features](docs/product/IMPLEMENTED_FEATURES.md)
- [CLI Reference](docs/product/CLI_REFERENCE.md)
- [Execution Policy](docs/product/EXECUTION_POLICY.md)
- [System Overview](docs/architecture/SYSTEM_OVERVIEW.md)
- [Package Reference](docs/architecture/PACKAGE_REFERENCE.md)
- [Validation and Security](docs/architecture/VALIDATION_AND_SECURITY.md)
- [Decision Records](docs/decisions)
- [Release Notes](docs/releases/v0.3.0.md)

## Development Workflow

Run `pnpm check` before committing. Analysis must treat repository contents as untrusted input,
avoid executing repository scripts, avoid loading repository code in the main process, and attach
evidence to every detected fact. Validation executes target tooling only with `--execute-checks`;
use it only for repositories you trust, because this is not an OS sandbox.

Execution policy is configured in `.repopilot/config.yaml`. Built-in safe defaults are applied first, then presets, repository config, and one-run CLI flags. No automated commits, pushes, pull requests, destructive actions, or parallel writes may run unless deterministic policy authorization allows them.

## Security Boundaries

RepoPilot does not add telemetry or authenticate with GitHub. Ollama uses a configured loopback
endpoint; choosing Codex sends bounded planning evidence or source context through the authenticated
Codex CLI to OpenAI. Gemini chat sends bounded evidence-backed metadata and typed messages to Google;
agent tailoring sends selected default TOML templates and an optional description only when enabled.
Source context for Codex and Ollama is read by a separate broker process and capped before either
provider receives it. The executor accepts only code-owned commands, uses no shell,
and receives an explicit environment allowlist. Validation may execute target tool configuration and
scripts after `--execute-checks`; it is not an OS-level container or remote sandbox.
