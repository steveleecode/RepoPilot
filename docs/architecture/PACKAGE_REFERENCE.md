# Package Reference

This document describes the ownership boundaries of the current RepoPilot packages.

## `apps/web`

Next.js App Router dashboard shell.

Responsibilities:

- Render the main dashboard.
- Show repository summary placeholders without fake data.
- Show validation and audit empty states.
- Show the Agent Policy settings area from the resolved policy.
- Provide a command palette foundation.

The app currently reads `.repopilot/config.yaml` server-side and displays the resolved execution policy. Editing from the dashboard is planned but not implemented.

## `apps/cli`

Node CLI entrypoint.

Responsibilities:

- Print help and version.
- Run development-environment doctor checks.
- Initialize, validate, show, and update execution policy config.
- Analyze repository metadata.
- Display one-run policy override previews.
- Execute durable read-only planning workflows through fake, Ollama, or Codex providers.
- Propose bounded changes, inspect them, apply in isolated worktrees, validate, and request repairs.

The CLI does not yet commit, push, or open pull requests. Codex uses a local App Server process and
Codex-managed authentication.

## `packages/shared`

Shared cross-package utilities.

Responsibilities:

- Evidence schema and types.
- Severity type.
- Result helpers.
- Error shape.
- Filesystem and logging interfaces.
- Safe relative path normalization.

Package-specific domain types should remain in their owning package.

## `packages/analyzer`

Deterministic repository analysis contracts and initial detection.

Responsibilities:

- Bounded repository metadata traversal with explicit limits.
- Read-only Git branch and working-tree inspection.
- Detected languages.
- Package managers.
- Nested manifests and package scripts.
- Workspace configuration and package patterns.
- Scripts and commands.
- Tool categories.
- CI workflows.
- Agent instruction files.
- Evidence and warnings.

Detection never follows symlinks, skips dependency and build outputs, reads only known metadata files,
and reports parse, access, size, and traversal-limit failures as evidence-backed warnings.

## `packages/executor`

Trusted local command-execution boundary.

Responsibilities:

- Register code-owned command definitions with unique IDs and fixed executable paths.
- Authorize only exact additional argument variants.
- Constrain real working directories to configured scopes inside the repository root.
- Build a child environment only from explicitly supplied, allowlisted variables.
- Execute without a shell and without forwarding stdin.
- Enforce timeout, combined-output, cancellation, and termination-grace limits.
- Redact known values and credential-shaped output.
- Return structured authorization and execution results suitable for workflow audit persistence.

This package provides process isolation controls, not an OS-level container. It is deliberately not
wired into repository analysis or the CLI during this phase.

## `packages/generator`

Generation contracts and deterministic template rendering.

Responsibilities:

- Proposed file and edit types.
- Generation plans and warnings.
- Generation provenance.
- Built-in deterministic template rendering.

The generator never writes files directly.

## `packages/validator`

Validation pipeline and proposed-change checks.

Responsibilities:

- Validation result types.
- Validation findings.
- Command execution records.
- Repairability metadata.
- Pre-write validators.

Current validators cover generated JSON/YAML, referenced paths, referenced package scripts, and duplicate proposed paths.

## `packages/instruction-linter`

Deterministic linter for repository agent instructions.

Responsibilities:

- Line-threshold checks.
- Duplicate heading detection.
- Duplicate exact instruction detection.
- Missing repository path detection.
- Missing package script detection.
- Deterministic command conflict detection.

The linter does not use an LLM.

## `packages/policy`

Execution policy schema, resolution, enforcement, and audit records.

Responsibilities:

- Safe, balanced, autonomous, and custom presets.
- Versioned `.repopilot/config.yaml` schema.
- Config parsing, loading, writing, and dotted-path updates.
- Policy resolution.
- Git action authorization.
- Validation gate enforcement.
- Approval gate enforcement.
- Branch pattern and prohibited branch checks.
- Task parallel-safety checks.
- Redacted audit records.

Future execution layers must call this package before applying files, committing, pushing, opening pull requests, or parallelizing write tasks.

## `packages/workflow`

Persistent agentic-workflow state and transitions.

Responsibilities:

- Versioned run, task, event, artifact, and approval schemas.
- Append-only JSONL event journals.
- Deterministic snapshot reconstruction.
- Run and task status-transition enforcement.
- Provider-thread association.
- Interrupted and failed run resumption.

Workflow journals are local runtime state and are not committed to Git.

## `packages/provider`

Agent-provider contracts and adapters.

Responsibilities:

- Capability discovery and provider health checks.
- Provider registration, deterministic lookup, and duplicate-ID rejection.
- Start, resume, and cancel lifecycle methods.
- Normalized asynchronous provider events and structured results.
- A deterministic fake provider for workflow and contract tests.
- A Codex adapter with a local App Server transport and Codex-managed authentication.
- A configurable local Ollama adapter with bounded HTTP responses and loopback-only endpoints.
- A separate bounded source-context broker used for Ollama and Codex change proposals.
- Terminal-event enforcement and normalization of transport failures.

RepoPilot remains the workflow and policy authority. Provider events cannot authorize writes, Git
actions, approvals, or state transitions by themselves. The local Codex App Server remains behind
the `CodexTransport` boundary. Ollama and Codex return untrusted results for orchestrator validation.

## `packages/orchestrator`

Deterministic workflow engine.

Responsibilities:

- Advance persisted runs through discovery, analysis, planning, authorization, execution, validation,
  review, and completion.
- Select and health-check registered providers.
- Link provider thread IDs to durable workflow runs.
- Normalize provider completion, failure, and cancellation into run and task transitions.
- Record discovery, provider-result, validation, and failure artifacts.
- Resume failed or interrupted work from persisted provider results without repeating completed work.
- Bound provider event consumption and prevent concurrent execution of the same run in one process.
- Produce deterministic dependency-ordered task batches, using policy write-scope checks and worker
  limits to decide which tasks may run together.
- Validate change proposals against planned scopes and context hashes, apply to isolated Git
  worktrees, and run explicit policy-selected validation through the trusted executor.

The planning engine remains read-only. Separate development operations make proposals reviewable
before apply and require explicit approval to execute target tooling. Commits and pushes remain later
phases.

## `packages/ui`

Reusable typed UI primitives.

Responsibilities:

- Status badges.
- Score display.
- Finding card.
- Repository header.
- Validation timeline.
- Empty state.
- Icon button.

These primitives are accessible and styled for the RepoPilot dashboard.
