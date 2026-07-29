# RepoPilot System Overview

## Monorepo Boundaries

- `apps/web` renders the local dashboard shell.
- `apps/cli` exposes the `repopilot` executable.
- `packages/analyzer` owns deterministic repository analysis contracts and detectors.
- `packages/generator` owns proposed change and template rendering contracts.
- `packages/validator` owns pre-write validation pipeline contracts and validators.
- `packages/instruction-linter` owns deterministic checks for repository agent instructions.
- `packages/policy` owns versioned execution-policy configuration, presets, resolution order, authorization checks, task parallel-safety, and audit records.
- `packages/shared` holds only cross-package schemas, results, errors, filesystem, and logging interfaces.
- `packages/ui` holds reusable accessible UI primitives.

## Data Flow

Repository files are read as untrusted input. The analyzer produces evidence-backed facts. The generator turns facts and validated variables into proposed changes without writing files. Validators inspect those proposed changes and report structured results. The UI and CLI explain the current state without fabricating unavailable analysis.

Execution policy is resolved from built-in safe defaults, presets, repository config, command-line overrides, and temporary approvals. The resolved policy is used by deterministic authorization functions before applying files, committing, pushing, opening pull requests, or running parallel write tasks.

## Deterministic Analysis Before AI

Repository facts must come from deterministic inspection because downstream suggestions are only trustworthy if their inputs are traceable. AI may later interpret facts or draft proposals, but it must not be the source of record for repository detection.

## Validation After Generation

Generation can introduce syntax errors, missing references, or conflicting paths. Validation follows generation so RepoPilot can reject unsafe or broken proposals before any write step.

## Trust Boundaries

Analyzed repository contents are untrusted. RepoPilot does not execute repository scripts during analysis, does not load repository code, does not collect environment variables, and does not print secrets.

Policy enforcement is a trust boundary. LLM recommendations cannot authorize Git actions directly. Pushes to default, protected, production, or release branches are blocked by deterministic code even if an agent requests them.

## Future Execution Sandbox

Future command execution should run in a constrained sandbox with explicit command allowlists, timeouts, redacted output, and a clear separation between analysis and execution.

## Future GitHub Integration

GitHub integration should arrive after the local deterministic core. Authentication, pull request creation, checks, and review comments should be separate adapters over the same analysis, generation, and validation packages.
