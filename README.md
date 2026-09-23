# RepoPilot

RepoPilot is a local-first developer tool for preparing software repositories for reliable AI-assisted development. It analyzes repository evidence, proposes tailored configuration, validates proposed changes before writing them, and explains what is ready or missing.

## Status

RepoPilot is an early local development tool. It can plan with Ollama, propose bounded changes, apply
them in an isolated Git worktree, and run explicitly approved validation checks. It is not
production-ready and does not yet call cloud AI services, authenticate to GitHub, or commit/push
changes.

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

For a standalone installation, download `repopilot-0.2.0.tgz` from the release and run:

```bash
npm install -g ./repopilot-0.2.0.tgz
repopilot doctor
```

The release archive contains the CLI and context broker; it does not require the monorepo or a
global pnpm installation for the CLI itself. pnpm 11 is needed when validating pnpm projects.
See the [v0.2.0 developer-preview notes](docs/releases/v0.2.0.md) for the supported workflow,
limitations, upgrade, and uninstall instructions.

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

CLI examples:

```bash
pnpm repopilot --help
pnpm repopilot version
pnpm repopilot doctor
pnpm repopilot scan --repo .
pnpm repopilot scan --repo . --json
pnpm repopilot providers list
pnpm repopilot providers doctor
pnpm repopilot providers configure ollama --model <installed-model>
pnpm repopilot run "Plan parser coverage" --provider ollama
pnpm repopilot propose <run-id> --task <planned-task-id>
pnpm repopilot inspect <run-id>
pnpm repopilot apply <run-id> --approve
pnpm repopilot verify <run-id> --execute-checks
pnpm repopilot repair <run-id>
pnpm repopilot run "Plan parser coverage" --provider fake
pnpm repopilot init --repo ../another-repository
pnpm repopilot validate --repo ../another-repository
pnpm repopilot runs create "Add parser coverage" --provider codex
pnpm repopilot runs list
pnpm repopilot status <run-id>
pnpm repopilot resume <run-id>
pnpm repopilot policy show
pnpm repopilot policy validate
pnpm repopilot policy init
pnpm repopilot policy set commits.enabled true
pnpm repopilot run --parallel --max-workers 3 --auto-commit --no-push
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
- [Release Notes](docs/releases/v0.2.0.md)

## Development Workflow

Run `pnpm check` before committing. Analysis must treat repository contents as untrusted input,
avoid executing repository scripts, avoid loading repository code in the main process, and attach
evidence to every detected fact. Validation executes target tooling only with `--execute-checks`;
use it only for repositories you trust, because this is not an OS sandbox.

Execution policy is configured in `.repopilot/config.yaml`. Built-in safe defaults are applied first, then presets, repository config, and one-run CLI flags. No automated commits, pushes, pull requests, destructive actions, or parallel writes may run unless deterministic policy authorization allows them.

## Security Boundaries

RepoPilot does not add telemetry or authenticate with GitHub. Ollama uses a configured loopback
endpoint; choosing Codex sends bounded planning evidence or source context through the authenticated
Codex CLI to OpenAI. Source context is read by a separate broker process and capped before either
provider receives it. The executor accepts only code-owned commands, uses no shell,
and receives an explicit environment allowlist. Validation may execute target tool configuration and
scripts after `--execute-checks`; it is not an OS-level container or remote sandbox.
