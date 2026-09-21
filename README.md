# RepoPilot

RepoPilot is a local-first developer tool for preparing software repositories for reliable AI-assisted development. It analyzes repository evidence, proposes tailored configuration, validates proposed changes before writing them, and explains what is ready or missing.

## Status

RepoPilot is an early foundation. The CLI, web shell, typed contracts, deterministic analyzer, template renderer, validators, instruction linter, execution policy layer, tests, and CI scaffolding exist. It is not production-ready and does not yet call external AI services, authenticate to GitHub, or modify target repositories.

Implemented foundations:

- Bounded evidence-backed repository analysis for nested manifests, scripts, workspace layouts, tool configurations, Git metadata, workflows, and agent instructions.
- Deterministic generation contracts and template rendering that returns proposed files without writing them.
- Pre-write validators for generated JSON/YAML, referenced paths, referenced package scripts, and duplicate proposed paths.
- Deterministic instruction linting for long files, duplicate headings, duplicate instructions, missing paths/scripts, and simple command conflicts.
- Versioned execution policy in `.repopilot/config.yaml`, with presets, CLI commands, dashboard display, enforcement helpers, task parallel-safety checks, and audit records.
- Durable local workflow runs backed by versioned append-only event journals.
- Vendor-neutral agent-provider contracts with deterministic fake and transport-injected Codex adapters.
- Deterministic workflow orchestration with persisted discovery, planning, authorization, execution, validation, and review gates.
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
- [Implemented Features](docs/product/IMPLEMENTED_FEATURES.md)
- [CLI Reference](docs/product/CLI_REFERENCE.md)
- [Execution Policy](docs/product/EXECUTION_POLICY.md)
- [System Overview](docs/architecture/SYSTEM_OVERVIEW.md)
- [Package Reference](docs/architecture/PACKAGE_REFERENCE.md)
- [Validation and Security](docs/architecture/VALIDATION_AND_SECURITY.md)
- [Decision Records](docs/decisions)

## Development Workflow

Run `pnpm check` before committing. Analysis must treat repository contents as untrusted input, avoid executing repository scripts, avoid loading repository code, and attach evidence to every detected fact.

Execution policy is configured in `.repopilot/config.yaml`. Built-in safe defaults are applied first, then presets, repository config, and one-run CLI flags. No automated commits, pushes, pull requests, destructive actions, or parallel writes may run unless deterministic policy authorization allows them.

## Security Boundaries

RepoPilot does not collect environment variables, print secrets, add telemetry, make external AI calls, or authenticate with GitHub in this milestone. Future execution of repository commands must happen behind an explicit sandbox boundary.
