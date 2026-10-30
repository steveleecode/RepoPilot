# CLI Reference

RepoPilot's installed command is `repopilot`. In the source checkout, use:

```bash
pnpm repopilot <command>
```

The package binary is named `repopilot`; the root script runs the built CLI from `apps/cli/dist/index.js`.

Commands that operate on a repository accept `--repo <path>` and default to the current directory.
Commands that return data accept `--json` for stable, machine-readable output. Invalid command usage
returns exit code `2`; environment failures return `3`; invalid policy configuration returns `4`; and
analysis failures return `5`; workflow persistence or transition failures return `6`.

## Remember the main path

```bash
repopilot setup --repo ./my-project
repopilot scan --repo ./my-project
repopilot codex prompt "Add a feature" --repo ./my-project
repopilot plan "Add a feature" --provider codex --repo ./my-project
repopilot propose <run-id> --repo ./my-project
repopilot inspect <run-id> --repo ./my-project
repopilot apply <run-id> --approve --repo ./my-project
repopilot verify <run-id> --execute-checks --repo ./my-project
```

`setup` is an alias for `config setup`; `plan` is an alias for provider-backed `run <objective>`.
The older commands remain available for scripts. `repopilot` with no arguments shows a short overview;
`repopilot help setup`, `help workflow`, `help providers`, and `help policy` show focused guidance.

## Help

```bash
pnpm repopilot --help
```

Prints all commands and options. Use `repopilot help <topic>` for a shorter guide.

## Setup

```bash
repopilot setup --repo ./my-project
```

Guided project setup creates policy and agent guidance, offers local Gemini key entry, and proposes a
GitHub CI workflow when a GitHub remote and supported checks are present. It preserves existing
files. In a non-interactive shell it uses default agents and reports how to configure the key later.
See [Codex Multi-Agent Setup](#codex-multi-agent-setup) for agent selection and AI tailoring.

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

## Plan

```bash
repopilot plan "Improve parser coverage" --provider codex --repo ./my-project
```

Creates a durable, read-only provider-backed plan. Choose `codex`, `ollama`, or the test-only `fake`
provider. `plan` is an alias for `run <objective>`; `run` without an objective previews policy rather
than starting work. Continue with `propose`, `inspect`, `apply`, and `verify` as shown above.

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

## Codex Multi-Agent Setup

```bash
repopilot codex setup --repo ./my-project
repopilot codex setup --repo ./my-project --json
repopilot codex setup --repo ./my-project --agents researcher,developer,tester,reviewer,security,docs
repopilot codex setup --repo ./my-project --agents researcher,docs --description "React dashboard" --ai --yes
repopilot codex prompt "Describe the feature or bug" --repo ./my-project
```

In a terminal, `codex setup` guides you through keeping or deselecting default agents, adding
optional specialists, and optionally asking Gemini to tailor them. Defaults are Researcher,
Developer, Test Engineer, Code Reviewer, and Security Reviewer. Optional roles are Documentation
Writer, Accessibility Specialist, Performance Analyst, Operations Specialist, and Data Migration
Specialist. The main Codex agent is always the orchestrator for planning and delivery, rather than
another generated specialist. `--agents` selects roles non-interactively; `--agents none` selects no
specialists. Without a terminal, setup uses the defaults. The generated `AGENTS.md` includes the
eight-stage workflow and its required outputs. Specialists can raise focused questions to the main
Codex agent when requirements, evidence, or approvals are unclear; the main agent asks the user when
the decision is theirs. They can continue independent safe work while an answer is pending, but must
not guess or treat silence as approval.

Agent IDs for `--agents`: `researcher`, `developer`, `tester`, `reviewer`, `security`, `docs`,
`accessibility`, `performance`, `operations`, and `data`.

Setup generates project-scoped `.codex/config.toml`, selected agent files under `.codex/agents/`,
an `AGENTS.md` engineering workflow guide, and a reusable
`.codex/FEATURE_PROMPT.md` launch template. `codex prompt` renders that template with a specific task
without running agents. Gemini tailoring is opt-in and requires a locally configured key. Only the
selected default TOML templates and optional `--description` text are sent to Gemini; source files
are not sent. Gemini can add bounded, advisory project-specific focus but cannot replace the base
instructions. Interactive setup previews the additions for approval; non-interactive tailoring
requires `--ai --yes`. If validation fails, no Codex files are generated. The configuration permits
up to three concurrent subagents. Existing files are skipped, never overwritten; inspect the reported skipped
paths and merge guidance manually if needed. Deselecting a role does not delete a previously
generated agent file; remove or edit that file yourself if you no longer want it loaded. Without
`--ai`, the command creates files only: it does not sign in, start agents, run tests, or create a
RepoPilot workflow run. With `--ai`, it contacts Gemini for tailoring. Review the generated
instructions and commit them when suitable for the target project. Codex loads project config only
for trusted projects. To use the setup later, start Codex in that repository and give it a task.

When setup detects a Git remote on `github.com`, it also creates
`.github/workflows/repopilot-ci.yml` if a supported npm or pnpm lockfile and root check scripts are
present. The workflow runs explicit checks (`check` when available; otherwise defined `lint`, `test`,
and `build` scripts) on pull requests and pushes to `main`. It never overwrites an existing file or
changes remote GitHub settings. Review the generated Node version and commands, then enable branch
protection or a ruleset requiring the `validate` job before merges. Until that remote rule is enabled,
CI is advisory rather than a merge gate.

## Gemini Chat

```bash
repopilot config setup --repo ./my-project
repopilot config gemini --repo ./my-project
repopilot config status --repo ./my-project
repopilot chat --repo ./my-project
repopilot chat --repo ./my-project --no-context
```

`config setup` creates the default policy and Codex multi-agent files if missing and offers a
hidden-input prompt for a Gemini key when run in a terminal. Existing policy and Codex files are
preserved. `config gemini` can set or rotate the key later; `config gemini --stdin` accepts it from a
pipe without placing it in command arguments. RepoPilot saves the key only in the target project's
`.repopilot/.env`, sets file permissions to owner-only, and creates `.repopilot/.gitignore` entries
for the secret and temporary files during setup. It refuses a Git-tracked or symlinked secret file.
Do not commit the `.env` file or paste the key into a command line or chat. `config status` reports
whether a key exists without printing it.

`chat` starts an interactive, read-only development-advice session. It reads `GEMINI_API_KEY` from
`.repopilot/.env`, with an explicitly supplied process environment variable taking precedence. The
default model is `gemini-2.5-flash`; `--model <id>` selects another Gemini model available to your key.
`--no-context` prevents repository metadata from being sent.

By default, RepoPilot sends a bounded summary of detected languages, package managers, test and lint
tools, and CI workflow paths, each with file-path evidence. It does not send source files, script
contents, credentials, or raw scan output. Your typed messages and up to twelve recent chat messages
are sent to Gemini for follow-up context. Conversation history is held only in memory and is discarded
when chat exits; `/clear` forgets it sooner, `/help` shows commands, and `/exit` ends chat. Replies
stream as they arrive, with a subtle typewriter effect in a terminal. Chat cannot edit files, run
commands on the target project, or start a RepoPilot workflow. Treat its suggestions as unverified.
Gemini API free-tier availability and limits depend on your Google project and may change.

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
