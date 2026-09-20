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
- Display one-run policy override previews.

The CLI does not yet execute repository analysis, generation, write application, commits, pushes, or pull requests.

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
