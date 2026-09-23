# CLI Reference

RepoPilot exposes a local development command through:

```bash
pnpm repopilot <command>
```

The package binary is named `repopilot`; the root script runs the built CLI from `apps/cli/dist/index.js`.

Commands that operate on a repository accept `--repo <path>` and default to the current directory.
Commands that return data accept `--json` for stable, machine-readable output. Invalid command usage
returns exit code `2`; environment failures return `3`; invalid policy configuration returns `4`; and
analysis failures return `5`; workflow persistence or transition failures return `6`.

## Help

```bash
pnpm repopilot --help
```

Prints usage and the available commands.

## Version

```bash
pnpm repopilot version
```

Prints the current CLI version.

## Doctor

```bash
pnpm repopilot doctor
```

Inspects the RepoPilot development environment. It reports:

- Node version.
- pnpm availability.
- Git availability.
- Current directory.
- Whether the current directory is a Git repository.

The command returns a nonzero exit code when a required dependency is missing.

## Init

```bash
repopilot init --repo ./my-project
```

Initializes `.repopilot/config.yaml` using the balanced preset. This is a top-level alias for
`repopilot policy init` and refuses to overwrite an existing configuration.

## Scan

```bash
repopilot scan --repo ./my-project
repopilot scan --repo ./my-project --json
```

Runs a bounded deterministic repository analysis and reports evidence-backed Git state, languages,
manifests, package scripts, workspace layouts, package managers, test/format/lint/type-check tools, CI
workflows, and nested agent instruction files. Scan skips dependency and build outputs, does not follow
symbolic links, caps traversal and metadata-file sizes, and reports limit or parse failures as warnings.
It does not execute target-repository scripts or load target source code into RepoPilot.

## Providers

```bash
repopilot providers list
repopilot providers list --json
repopilot providers doctor
repopilot providers codex login
repopilot providers codex login --device-code
repopilot providers codex status
```

Lists provider adapters, integration status, and supported capabilities. The deterministic fake
provider is built in for contract and workflow tests. `providers doctor` checks a configured Ollama
model and the local Codex App Server. Codex uses the Codex CLI's existing login; RepoPilot does not
read or store its credentials. The standalone CLI uses a local App Server transport by default.

## Validate

```bash
repopilot validate --repo ./my-project
```

Validates the repository execution-policy configuration. This is a top-level alias for
`repopilot policy validate`.

## Workflow Runs

```bash
repopilot runs create "Add parser coverage" --provider codex
repopilot runs list
repopilot runs list --json
```

`runs create` creates a durable local workflow run. `runs list` reconstructs known runs from their
event journals. Run state is stored under `.repopilot/runs/<run-id>/events.jsonl` and is excluded from
Git by RepoPilot's own `.gitignore`.

## Run Status

```bash
repopilot status <run-id>
repopilot status <run-id> --json
```

Shows the reconstructed run status, provider, task count, pending approvals, artifacts, latest event
sequence, and update timestamp.

## Resume Run

```bash
repopilot resume <run-id>
```

Moves an interrupted or failed run back to `planning`. Completed and cancelled runs are terminal and
cannot be resumed.

## Policy Show

```bash
pnpm repopilot policy show
```

Loads `.repopilot/config.yaml` when present, resolves the policy, and prints the effective configuration and sources.

## Policy Validate

```bash
pnpm repopilot policy validate
```

Validates `.repopilot/config.yaml` against the versioned schema. It returns a nonzero exit code when the file is missing or invalid.

## Policy Init

```bash
pnpm repopilot policy init
```

Creates `.repopilot/config.yaml` using the balanced preset. The command refuses to overwrite an existing config.

## Policy Set

```bash
pnpm repopilot policy set <path> <value>
```

Updates a dotted execution-policy path and revalidates the full config before writing.

Examples:

```bash
pnpm repopilot policy set commits.enabled true
pnpm repopilot policy set commits.strategy after_feature
pnpm repopilot policy set parallelism.enabled true
pnpm repopilot policy set parallelism.max_workers 3
pnpm repopilot policy set pushes.enabled false
```

## Run Policy Preview

```bash
pnpm repopilot run --parallel --max-workers 3 --auto-commit --no-push
```

Without an objective, the command resolves the policy for a planned run and displays the effective
configuration. One-run flags do not edit `.repopilot/config.yaml`. Use `--non-interactive` to declare
automation intent; it is included in JSON output.

Supported one-run flags:

- `--parallel`: enables read-only parallel analysis for this invocation.
- `--max-workers <n>`: sets worker count for this invocation.
- `--auto-commit`: enables after-feature automatic commits for this invocation.
- `--no-push`: disables automatic pushes for this invocation.

## Read-only Provider Workflow

```bash
repopilot run "Plan parser coverage" --provider fake
repopilot run "Plan parser coverage" --provider fake --json
```

Creates a durable run and advances it through repository discovery, analysis, planning, provider
authorization, read-only execution, validation, review, and completion. The fake provider is useful
for local checks. To use Ollama, start it separately and configure an installed model:

```bash
repopilot providers configure ollama --model <installed-model>
repopilot providers doctor
repopilot run "Plan parser coverage" --provider ollama --json
```

The versioned configuration is stored at `.repopilot/models.json`. `--endpoint` accepts a plain HTTP
loopback origin; the default is `http://127.0.0.1:11434`. The model receives the objective and bounded
evidence-backed repository metadata, then returns a plan that RepoPilot validates and records. The
planning turn does not execute target-repository scripts or apply changes. Codex remains available
through the transport-injected provider adapter for applications embedding the CLI; direct Codex CLI
transport configuration is a later increment.

## Local Development Workflow (Phases 8–10)

```bash
repopilot propose <run-id> --task <planned-task-id> --file src/example.ts --json
repopilot inspect <run-id> --json
repopilot apply <run-id> --approve --json
repopilot verify <run-id> --execute-checks --json
# If validation fails and policy permits a retry:
repopilot repair <run-id> --json
repopilot inspect <run-id> --json
repopilot apply <run-id> --approve --json
repopilot verify <run-id> --execute-checks --json
```

`propose` uses a separate read-only broker to gather bounded source context and ask loopback Ollama
for structured changes. `--file` is repeatable and must remain within planned read/write scopes.
`inspect` shows the plan, proposal, worktree, and validation artifacts. Review the proposal before
`apply`. Apply checks policy and base hashes, then writes only to a dedicated worktree under the
system temporary directory (its exact path is returned and recorded in the run).
The primary checkout is unchanged. `--approve` records explicit apply approval when used.

`verify` requires `--execute-checks` because repository tooling can run code. It runs a code-owned
command catalog through the no-shell executor: `git diff --check` plus policy-selected format, lint,
typecheck, test, and build checks. Results are bounded and recorded. Failed validation permits
`repair` only up to the policy retry limit and only within the original task scope. No command here
commits, pushes, or opens a pull request; those remain later phases.

A fresh worktree does not inherit the primary checkout's `node_modules`. For Node projects, install
dependencies in the returned worktree before `verify` (for example, `pnpm install --frozen-lockfile
--ignore-scripts`). This is a user-run step: RepoPilot does not automatically execute a target
repository's installation scripts.

The standalone CLI generates change proposals with either configured Ollama or authenticated Codex.
Both paths use the same bounded context broker, proposal validator, and isolated-worktree apply flow.
