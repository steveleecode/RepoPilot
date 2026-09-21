# RepoPilot System Overview

## Monorepo Boundaries

- `apps/web` renders the local dashboard shell.
- `apps/cli` exposes the `repopilot` executable.
- `packages/analyzer` owns deterministic repository analysis contracts and detectors.
- `packages/executor` owns trusted command authorization and bounded local subprocess execution.
- `packages/generator` owns proposed change and template rendering contracts.
- `packages/validator` owns pre-write validation pipeline contracts and validators.
- `packages/instruction-linter` owns deterministic checks for repository agent instructions.
- `packages/policy` owns versioned execution-policy configuration, presets, resolution order, authorization checks, task parallel-safety, and audit records.
- `packages/provider` owns vendor-neutral agent-provider contracts, normalized events, capability discovery, health checks, and provider adapters.
- `packages/orchestrator` owns deterministic run coordination across analysis, provider execution, validation, and persisted workflow gates.
- `packages/workflow` owns durable run state, event journals, state transitions, tasks, artifacts, and approvals.
- `packages/shared` holds only cross-package schemas, results, errors, filesystem, and logging interfaces.
- `packages/ui` holds reusable accessible UI primitives.

## Data Flow

Repository files are read as untrusted input. The analyzer produces evidence-backed facts. The generator turns facts and validated variables into proposed changes without writing files. Validators inspect those proposed changes and report structured results. The UI and CLI explain the current state without fabricating unavailable analysis.

Execution policy is resolved from built-in safe defaults, presets, repository config, command-line overrides, and temporary approvals. The resolved policy is used by deterministic authorization functions before applying files, committing, pushing, opening pull requests, or running parallel write tasks.

Workflow state is persisted as versioned append-only JSONL events under `.repopilot/runs/`. Snapshots
are reconstructed from the journal so interrupted processes can inspect and resume work without asking
an AI provider to recreate orchestration state.

Provider adapters expose the same start, resume, cancel, health, capability, event-streaming, and
structured-result contract. The Codex adapter accepts an injected transport so the deterministic core
does not authenticate, make network calls, or grant a provider authority over workflow or policy state.

The workflow engine advances persisted runs through discovery, analysis, planning, authorization,
execution, validation, and review. Provider results are recorded before validation, allowing an
interrupted validation attempt to resume without rerunning the provider. Direct execution-to-complete
and validation-to-complete transitions are rejected by the workflow store.

## Deterministic Analysis Before AI

Repository facts must come from deterministic inspection because downstream suggestions are only trustworthy if their inputs are traceable. AI may later interpret facts or draft proposals, but it must not be the source of record for repository detection.

## Validation After Generation

Generation can introduce syntax errors, missing references, or conflicting paths. Validation follows generation so RepoPilot can reject unsafe or broken proposals before any write step.

## Trust Boundaries

Analyzed repository contents are untrusted. RepoPilot does not execute repository scripts during analysis, does not load repository code, does not collect environment variables, and does not print secrets.

Policy enforcement is a trust boundary. LLM recommendations cannot authorize Git actions directly. Pushes to default, protected, production, or release branches are blocked by deterministic code even if an agent requests them.

## Execution Boundary

The local execution boundary resolves commands from a trusted catalog rather than provider-supplied
command lines. It never invokes a shell, accepts only exact argument variants, constrains working
directories to real paths inside the repository, starts with an empty environment, and enforces time,
output, cancellation, and redaction controls. Results are structured for durable audit storage.

This process boundary is not an OS-level container or hosted sandbox. It is not connected to analysis
or the CLI yet, so repository scripts remain unexecuted in the current product workflow.

## Future GitHub Integration

GitHub integration should arrive after the local deterministic core. Authentication, pull request creation, checks, and review comments should be separate adapters over the same analysis, generation, and validation packages.
