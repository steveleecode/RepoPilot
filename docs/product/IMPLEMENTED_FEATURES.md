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
- `providers list` and `providers doctor` for machine-readable discovery and health inspection
- `validate` as a top-level policy validation command
- `runs create` and `runs list` for durable local workflow state
- `status <run-id>` and `resume <run-id>`
- `policy show`
- `policy validate`
- `policy init`
- `policy set <path> <value>`
- `run` with one-run policy overrides
- `run <objective> --provider fake` for a persisted read-only provider workflow
- `run <objective> --provider ollama` for a local-model planning turn
- `propose`, `inspect`, `apply`, `verify`, and `repair` for the first local development workflow

Repository-oriented commands accept `--repo <path>`. Data-producing commands support JSON output,
unknown flags are rejected, and command failures use stable categorized exit codes.

## Workflow State

`packages/workflow` provides versioned schemas and an append-only JSONL event journal for runs, tasks,
artifacts, approvals, provider thread links, and notes. It reconstructs snapshots deterministically,
enforces run and task status transitions, supports resuming interrupted or failed runs, and rejects
corrupt or out-of-sequence journals. Local journals live under `.repopilot/runs/`.

Run transitions include explicit discovery, analysis, authorization, validation, and review gates.
The journal rejects direct `running` or `validating` transitions to `completed`.

## Agent Providers

`packages/provider` defines a vendor-neutral `AgentProvider` contract for capability discovery, health
checks, thread start/resume, cancellation, asynchronous normalized events, and structured results. A
deterministic fake provider and transport-injected Codex provider pass the same contract suite.

A provider registry rejects duplicate IDs, performs deterministic selection, and converts health-check
failures into normalized unavailable results. Codex event streams emit exactly one terminal result;
transport exceptions and incomplete streams become normalized failure events.

The Codex adapter follows the official SDK lifecycle of starting and resuming local threads while
leaving streamed transport details behind an injected boundary suitable for an SDK or App Server
implementation. The Codex adapter does not create credentials or authenticate on its own.

Ollama is the first configured live provider. `.repopilot/models.json` records a versioned model name,
loopback endpoint, timeout, and response limit. The provider checks model availability, requests a JSON
plan through `/api/chat`, and normalizes failures and cancellation. Fake, Ollama, and injected Codex
results pass through the same planning schema.

## Workflow Engine

`packages/orchestrator` coordinates deterministic repository discovery, task creation, provider health
and capability authorization, read-only provider execution, structured-result persistence, validation,
review, and completion. Provider failures and cancellations become durable run/task states. Failed or
interrupted validation can resume from its recorded provider result without repeating provider work.

The engine bounds provider event consumption and records failure reports according to execution policy.
It also produces stable dependency-ordered task batches and uses policy scope-overlap rules to keep
unsafe work out of the same batch. Separate development commands now apply generated changes only in
isolated Git worktrees and run opt-in validation. They do not commit or push.

## Execution Boundary

`packages/executor` provides a provider-neutral `CommandExecutor` contract and a bounded local
implementation. Commands must be registered in a trusted catalog; arbitrary command lines are not
accepted. Additional arguments must exactly match an allowed variant, working directories are checked
lexically and through real paths, and subprocesses run without a shell or inherited environment.

Execution results distinguish completion, non-zero failure, denial, timeout, output-limit termination,
cancellation, and spawn failure. Captured output is bounded and redacted. `verify --execute-checks`
uses this boundary, but it is not a substitute for OS-level container isolation.

`doctor` inspects the RepoPilot development environment, validates the supported Node major-version
range, and reports pnpm, Git, the current directory, and whether the directory is a Git repository.

## Analyzer

`packages/analyzer` defines deterministic repository analysis contracts. Every detected fact includes evidence. The current detector performs bounded metadata traversal and recognizes:

- Git repository presence, current branch, and working-tree state through hardened read-only Git commands.
- Top-level files and directories.
- Nested `package.json` files and their scripts and dependency metadata.
- `pnpm-lock.yaml`.
- `yarn.lock`.
- `package-lock.json`.
- `pyproject.toml`.
- `requirements.txt`.
- `Cargo.toml`.
- `go.mod`.
- `.github/workflows`.
- Nested `AGENTS.md` files.
- pnpm, npm, Yarn, and Turborepo workspace configuration.
- TypeScript, JavaScript, Python, Rust, and Go evidence.
- Common test, formatting, linting, and type-checking tools.

Traversal excludes dependency/build directories and symlinks, enforces depth, entry-count, metadata-size,
Git timeout, and Git output limits, and emits evidence-backed warnings instead of silently swallowing
malformed manifests or inaccessible metadata.

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

- Additional language ecosystems beyond the currently supported manifest and tool families.
- Directly configured Codex SDK or App Server transport in the CLI.
- OS-level container or remote execution sandboxing.
- Interactive approval, cancel, and cleanup operations for development worktrees.
- Arbitrary language/tool validation catalogs beyond the current Node/pnpm checks.
- Automatic commit, push, or pull-request execution.
- GitHub authentication.
- Cloud AI calls.
- Telemetry.
- Hosted execution.
- Pull-request merging.
