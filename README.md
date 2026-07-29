# RepoPilot

RepoPilot is a local-first developer tool for preparing software repositories for reliable AI-assisted development. It analyzes repository evidence, proposes tailored configuration, validates proposed changes before writing them, and explains what is ready or missing.

## Status

RepoPilot is an early foundation. The CLI, web shell, typed contracts, deterministic analyzer, template renderer, validators, instruction linter, tests, and CI scaffolding exist. It is not production-ready and does not yet call external AI services, authenticate to GitHub, or modify target repositories.

## Architecture

RepoPilot is a TypeScript monorepo with apps for the dashboard and CLI, plus packages for deterministic analysis, generation planning, validation, instruction linting, shared contracts, and UI primitives. Repository facts must be backed by evidence. Generated content is represented as proposed changes first, then validated before any future write step.

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
```

## Monorepo Layout

- `apps/web`: Next.js App Router dashboard shell.
- `apps/cli`: `repopilot` command line app.
- `packages/analyzer`: deterministic repository evidence contracts and initial detection.
- `packages/generator`: generation plan contracts and deterministic template rendering.
- `packages/validator`: validation pipeline and proposed-change validators.
- `packages/instruction-linter`: deterministic linter for agent instruction files.
- `packages/shared`: shared schemas, result utilities, errors, filesystem and logging interfaces.
- `packages/ui`: accessible UI primitives used by the dashboard.
- `templates`: future template families.
- `docs`: product, architecture, and decision records.

## Development Workflow

Run `pnpm check` before committing. Analysis must treat repository contents as untrusted input, avoid executing repository scripts, avoid loading repository code, and attach evidence to every detected fact.

## Security Boundaries

RepoPilot does not collect environment variables, print secrets, add telemetry, make external AI calls, or authenticate with GitHub in this milestone. Future execution of repository commands must happen behind an explicit sandbox boundary.
