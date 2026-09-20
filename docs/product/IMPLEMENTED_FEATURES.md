# Implemented Features

This document summarizes the RepoPilot foundation implemented so far.

## Repository Foundation

RepoPilot is a strict TypeScript monorepo using pnpm workspaces and Turborepo. It includes a Next.js dashboard app, a Node CLI app, shared package boundaries, CI, formatting, linting, type checking, unit tests, Playwright smoke tests, and product/architecture documentation.

## Web Dashboard

The dashboard in `apps/web` provides a polished local-first shell for RepoPilot. It includes:

- Left navigation.
- Repository header.
- Repository summary placeholders.
- Readiness score placeholder.
- Analysis status timeline.
- Recent audits empty state.
- Command palette foundation.
- Agent Policy settings area.
- Responsive layout.
- Light and dark theme support.

The dashboard intentionally labels incomplete behavior as planned or unavailable. It does not display fabricated repository analysis.

## CLI

The CLI in `apps/cli` exposes the `repopilot` command through the local `pnpm repopilot` script. It supports:

- `--help`
- `version`
- `doctor`
- `init` as a top-level policy initialization command
- `scan` with text and JSON output
- `validate` as a top-level policy validation command
- `policy show`
- `policy validate`
- `policy init`
- `policy set <path> <value>`
- `run` with one-run policy overrides

Repository-oriented commands accept `--repo <path>`. Data-producing commands support JSON output,
unknown flags are rejected, and command failures use stable categorized exit codes.

`doctor` inspects the RepoPilot development environment, validates the supported Node major-version
range, and reports pnpm, Git, the current directory, and whether the directory is a Git repository.

## Analyzer

`packages/analyzer` defines deterministic repository analysis contracts. Every detected fact includes evidence. The current detector recognizes:

- Git repository presence.
- Top-level files.
- `package.json`.
- `pnpm-lock.yaml`.
- `yarn.lock`.
- `package-lock.json`.
- `pyproject.toml`.
- `requirements.txt`.
- `Cargo.toml`.
- `go.mod`.
- `.github/workflows`.
- `AGENTS.md`.

## Generator

`packages/generator` defines proposed files, proposed edits, generation plans, warnings, and provenance. It includes a deterministic template renderer that returns proposed file content without writing to disk.

## Validator

`packages/validator` defines validation-result types and a validation pipeline. Initial validators cover:

- Generated JSON parsing.
- Generated YAML parsing.
- Referenced-path existence.
- Referenced `package.json` script existence.
- Duplicate proposed file paths.

Validators operate on proposed changes before write operations whenever possible.

## Instruction Linter

`packages/instruction-linter` provides deterministic checks for repository agent instructions. It detects:

- Instruction files above a configurable line threshold.
- Duplicate headings.
- Duplicate exact instruction lines.
- References to nonexistent repository paths.
- References to nonexistent `package.json` scripts.
- Deterministic command conflicts, such as requiring and prohibiting the same command.

## Execution Policy

`packages/policy` provides the execution-policy system. It supports:

- Versioned `.repopilot/config.yaml`.
- Safe, balanced, autonomous, and custom policy presets.
- Schema validation with Zod.
- Policy resolution from safe defaults, presets, repository config, and one-run CLI flags.
- Git action authorization for apply, commit, push, pull request, and destructive actions.
- Branch-pattern checks for agent-owned branch policies.
- Default/protected/production/release branch blocking.
- Validation gate enforcement.
- Approval gate enforcement.
- Parallel task safety checks.
- Redacted audit records.

## Tests And CI

The repository includes Vitest unit tests for analyzer, validator, instruction-linter, policy, and CLI behavior. It also includes a Playwright smoke test for the dashboard. GitHub Actions CI installs Node and pnpm, uses the lockfile, and runs `pnpm check`.

## Not Implemented Yet

RepoPilot still does not implement:

- Full repository analysis beyond the initial detector list.
- Real write application of generated files.
- Agent task execution.
- Git worktree orchestration.
- Actual automatic commit, push, or pull-request execution.
- GitHub authentication.
- External AI calls.
- Telemetry.
- Hosted execution.
- Pull-request merging.
