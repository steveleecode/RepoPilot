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

## Chat (Groq and Gemini)

### Get a Groq API key

1. Open [Groq Console](https://console.groq.com/) and create an account or sign in.
2. Open [API Keys](https://console.groq.com/keys), choose **Create API Key**, and give it a
   descriptive name such as `RepoPilot local`.
3. Copy the generated key and keep it in your password manager. Follow the
   [official quickstart](https://console.groq.com/docs/quickstart) if the console layout changes.
4. From the directory where you will use chat, run `repopilot config groq`. Paste the key into
   the hidden prompt and press Enter. Input appears as asterisks; the saved value is never printed.
5. Run `repopilot config status`, then `repopilot chat`. The banner should show
   `RepoPilot Chat · Groq openai/gpt-oss-120b`. A configured status confirms local credentials
   exist; the first reply confirms that the provider accepts them.

For a specific project, use the same `--repo` path for configuration and chat:

```bash
repopilot config groq --repo /path/to/project
repopilot config status --repo /path/to/project
repopilot chat --repo /path/to/project
```

No provider SDK installation is required. The API key belongs to your Groq account, but RepoPilot
stores it per project in `.repopilot/.env`; configuring it in your home directory does not configure
other projects. An existing `GROQ_API_KEY` environment variable overrides the saved key. Rotate a
saved key by rerunning `config groq`; revoke a compromised key in Groq Console. Never paste keys
into chat, source files, shell command arguments, or Git commits.

### Compare chat providers

| Topic                 | Groq (default)                                                                       | Gemini (optional)                                                                |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Select provider       | `repopilot chat` or `repopilot chat --provider groq`                                 | `repopilot chat --provider gemini`                                               |
| Default model         | `openai/gpt-oss-120b`, a pinned model ID                                             | `gemini-flash-latest`, a rolling Flash alias                                     |
| Recommended use       | First choice for responsive everyday development advice                              | Alternative model family or an existing Google API setup                         |
| Speed                 | Designed for fast generation; RepoPilot displays chunks immediately                  | May be slower, especially under high demand; no artificial typing delay is added |
| Quality               | Evaluate on your own coding questions; a larger model does not guarantee correctness | Evaluate on the same questions; RepoPilot has no comparative quality benchmark   |
| Key setup             | `repopilot config groq`; `GROQ_API_KEY` overrides the saved key                      | `repopilot config gemini`; `GEMINI_API_KEY` overrides the saved key              |
| Key portal            | [Groq API Keys](https://console.groq.com/keys)                                       | [Google AI Studio API Keys](https://aistudio.google.com/apikey)                  |
| Free access           | Rate-limited Free Plan; check model availability and account limits                  | Free-tier eligibility and limits vary by model and project                       |
| Data destination      | Groq's hosted API                                                                    | Google's hosted Gemini API                                                       |
| Missing key or outage | No automatic switch to Gemini                                                        | No automatic switch to Groq                                                      |

These recommendations are defaults, not measured latency or quality guarantees. Groq advertises
approximately 500 generated tokens/second for GPT-OSS 120B and 1,000 for GPT-OSS 20B in its
[model catalog](https://console.groq.com/docs/models); these are provider figures, not end-to-end
RepoPilot benchmarks. Prompt processing, reasoning, network latency, and load affect time to the
first visible word. Gemini's capabilities outside RepoPilot do not imply support here: this chat
integration sends text and bounded metadata, without image uploads, web search, or tool execution.

As checked on **November 4, 2026**, Groq lists free-plan limits for both `openai/gpt-oss-120b`
and `openai/gpt-oss-20b` of 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute, and
200,000 tokens/day. Any limit can stop requests; conversation history consumes tokens too.
Confirm current values in [Groq's rate-limit documentation](https://console.groq.com/docs/rate-limits)
and your account's Limits page. Gemini quotas vary by model and project; check your active limits
in [Google AI Studio](https://aistudio.google.com/rate-limit?timeRange=last-28-days) and its
[quota documentation](https://ai.google.dev/gemini-api/docs/rate-limits). Free access is not unlimited
or a guarantee of capacity; paid usage is subject to the provider's current pricing and billing settings.

Both integrations send your typed messages and recent conversation to the selected provider.
`--no-context` omits repository metadata but still sends those messages. RepoPilot's local key storage
and in-memory history do not determine a provider's retention or training policies; review
[Groq's data documentation](https://console.groq.com/docs/your-data) and
[Gemini's API terms](https://ai.google.dev/gemini-api/terms) before sending sensitive material.

### Switch providers or models

Groq requires its own key; an existing Gemini key cannot authenticate to Groq. To keep using Gemini,
create or select a key in [Google AI Studio](https://aistudio.google.com/apikey), following
[Google's key instructions](https://ai.google.dev/gemini-api/docs/api-key), then configure and select it:

```bash
repopilot config gemini
repopilot chat --provider gemini
```

To use Groq's smaller model or explicitly choose the default:

```bash
repopilot chat --provider groq --model openai/gpt-oss-20b
repopilot chat --provider groq --model openai/gpt-oss-120b
```

Provider and model flags apply to that invocation; they do not save a new default. Exit with `/exit`
and start a new session to switch. Conversation history is not transferred. `--model` alone changes
the model for Groq, so Gemini models require `--provider gemini` too.

### Other setup and chat behavior

```bash
repopilot config setup --repo ./my-project
repopilot config groq --repo ./my-project
repopilot config gemini --repo ./my-project
repopilot config status --repo ./my-project
repopilot chat --repo ./my-project
repopilot chat --repo ./my-project --provider gemini
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

`chat` defaults to **Groq**, using `openai/gpt-oss-120b`. Get a key at
https://console.groq.com/keys and run `repopilot config groq` (hidden input), or
`repopilot config groq --stdin` for piped input. Keys use the same private, ignored
`.repopilot/.env` storage described above; `GROQ_API_KEY` in the process environment takes precedence.
Run configuration and chat from the same directory, or supply the same `--repo` path.
`config status` reports both providers without displaying keys. Missing Groq credentials never
silently fall back to Gemini.

Use `repopilot chat --provider gemini` to switch to Gemini and its `gemini-flash-latest`
rolling alias. Configure it with `repopilot config gemini` or `GEMINI_API_KEY`.
**Gemini may be slower than Groq**, especially during high demand; actual latency depends on
model, prompt, and service availability. A warning appears when starting Gemini chat.
`--model <id>` overrides the selected provider's model, for example
`repopilot chat --provider groq --model openai/gpt-oss-20b`.
Groq's default is pinned; Google's alias can change versions over time.
An HTTP 404 means the model may be unavailable or unsupported; select a model available to your key.
HTTP 429 means a rate or quota limit was reached. HTTP 502/503/504 responses are retried twice
with increasing delays before any reply is streamed. Requests have a shared two-minute timeout;
provider outages can still prevent a response. No automatic provider switching occurs.

`--no-context` prevents repository metadata from being sent.

By default, RepoPilot sends a bounded summary of detected languages, package managers, test and lint
tools, and CI workflow paths, each with file-path evidence. It does not send source files, script
contents, credentials, or raw scan output. Your typed messages and up to twelve recent chat messages
are sent to the selected provider (Groq or Google) for follow-up context. Conversation history is held only in memory and is discarded
when chat exits; `/clear` forgets it sooner, `/help` shows commands, and `/exit` ends chat. Replies
stream as they arrive; both providers render Markdown headings, emphasis, lists, links, and code blocks for the terminal without an artificial typing delay. Formatting is buffered by line so Markdown split across network chunks stays intact. `NO_COLOR` disables ANSI styling; piped output uses readable plain text. Chat cannot edit files, run
commands on the target project, or start a RepoPilot workflow. Treat its suggestions as unverified.
Both providers have rate-limited free offerings; availability, limits, and model access can change.
Groq chat support does not change the Codex/Ollama development providers or Gemini AI tailoring.

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
planning turn does not execute target-repository scripts or apply changes. Codex is also available
through the installed, separately authenticated Codex CLI App Server transport. Use
`repopilot providers codex login` and `repopilot plan "Plan parser coverage" --provider codex`;
see [Providers](#providers) for prerequisites.

## Local Development Workflow (Phases 8–10)

For a supervised single-task workflow:

```bash
repopilot run "Change the greeting" --provider codex --develop --repo ./my-project
repopilot inspect <run-id> --repo ./my-project
repopilot resume <run-id> --develop --approve --repo ./my-project
# Inspect the preserved worktree and install dependencies there if needed, then:
repopilot resume <run-id> --develop --execute-checks --repo ./my-project
```

`--develop` supports Codex and configured Ollama. It requires exactly one planned task with a
nonempty write scope and no unresolved planning questions. Apply follows current repository policy;
`--approve` supplies approval for this invocation. Target checks require `--execute-checks` on the
invocation that executes them. Failed checks can trigger repairs up to the policy retry limit;
repair proposals remain subject to apply authorization.

The runner journals stages and resumes from recorded artifacts without repeating completed work.
`resume --develop` without an ID selects the latest unfinished development run. It rejects changed
repository HEAD, stale worktree contents, and interrupted applies requiring inspection. A fresh
independent provider session reviews bounded source and diff evidence after validation passes.
Review findings remain unverified and do not trigger automatic repair.

`status` displays the last recorded completion report; `resume --develop` rechecks freshness.
`inspect` includes review and completion artifacts. A `review_ready` report means required checks
passed and source review supports the criteria. Criterion judgments are not individually mapped
executable proof, and production behavior remains unverified. Other report statuses identify
approval, check authorization, planning input, validation failure, review concerns, or recovery needs.
The runner preserves worktrees for inspection and does not commit, push, or open pull requests.

The individual commands remain available:

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
`repair` only up to the policy retry limit and only within the original task scope. These individual
development commands leave Git delivery to the explicit commit and push commands below; PR creation
remains unimplemented.

A fresh worktree does not inherit the primary checkout's `node_modules`. For Node projects, install
dependencies in the returned worktree before `verify` (for example, `pnpm install --frozen-lockfile
--ignore-scripts`). This is a user-run step: RepoPilot does not automatically execute a target
repository's installation scripts.

The standalone CLI generates change proposals with either configured Ollama or authenticated Codex.
Both paths use the same bounded context broker, proposal validator, and isolated-worktree apply flow.

### Commit reviewed changes locally

```bash
repopilot commit <run-id> --message "feat: add greeting" --repo ./my-project
# Add --approve when current policy requires commit approval.
```

`commit` requires a `review_ready` development report, unchanged applied content, fresh passing
validation, and independent review supporting every acceptance criterion. It reloads the primary
repository's policy before mutations. This increment supports `after_feature` timing and conventional
or imperative messages. Disabled commits, other timing strategies, inferred/template message formats,
and signing requirements fail closed. Configure `user.name` and `user.email` in repository-local Git
configuration first; the command does not invent an identity.

The command creates `codex/repopilot-<run-id>` from the detached development worktree and commits only
proposed paths there. It leaves the primary checkout and its branch unchanged. It uses a private
index and Git plumbing, bypassing hooks, clean filters, and signers; repositories with configured Git
filters are rejected before freshness checks. Existing staged changes, branch collisions, stale
validation, and unexpected content require inspection. Nothing is pushed or published.

The commit and its pending intent are journaled. Repeating the same successful command checks the
recorded branch, HEAD, and clean worktree and returns the recorded commit. An interrupted intent
stops for manual inspection instead of replaying Git side effects. Preserve that worktree and inspect
its journal, branch, HEAD, and index before any manual recovery.

`status` shows the recorded `committed` state. Explicit `resume <run-id> --develop` rechecks the
recorded commit and worktree, then returns `committed` without repeating development. A changed
worktree instead requires attention. Implicit resume skips committed runs.

#### Generate a commit message with Groq

Configure Groq once for this project, then let it summarize all changes in a reviewed run:

```bash
repopilot config groq --repo ./my-project
repopilot commit <run-id> --message-provider groq --approve --repo ./my-project
# To commit and push after the same policy and approval checks:
repopilot commit <run-id> --message-provider groq --push --approve --execute-checks --repo ./my-project
```

The run must be `review_ready` with fresh validation and independent review. Groq receives the
run objective, every accumulated changed path and action (including repairs), and check results.
It receives no source files or raw diffs; the message describes features supported by that metadata,
so inspect the resulting commit before publishing. This covers the reviewed run, not unrelated
staged, unstaged, or untracked changes in your primary checkout. Metadata over 40,000 bytes is
rejected rather than silently omitting paths. Missing credentials, invalid output, or a failed request
stop message generation before committing. Generated messages must be a single-line conventional
commit of at most 500 characters. Choose either `--message` or `--message-provider`.

For a new supervised run, Groq can also supply the message during automatic delivery:

```bash
repopilot run "Add search and tests" --provider codex --develop --delivery commit --message-provider groq --approve --execute-checks
```

`--provider codex` selects the development agent; `--message-provider groq` only drafts the commit
message. Use `--delivery push` to request publishing as well, subject to repository policy. Automatic
delivery records the generated message and reuses it when resuming the same unchanged run; manual
`commit --message-provider` generates a new message per invocation. No provider option bypasses
review, validation, commit authorization, or push authorization.

## Choose commit only or commit and push

```bash
# Keep changes local (also the default when neither mode flag is supplied):
repopilot commit <run-id> --message "feat: add greeting" --commit-only --approve
# Commit, then publish the recorded branch:
repopilot commit <run-id> --message "feat: add greeting" --push --approve --execute-checks
# Publish an already committed run, or inspect/retry a paused publishing stage:
repopilot push <run-id> --approve --execute-checks
```

Commit and push permissions are independent. For commit-only operation, set `commits.enabled` to
`true`, `commits.strategy` to `after_feature`, and `pushes.enabled` to `false`. To allow publishing,
also set `pushes.enabled` to `true` and `pushes.strategy` to `after_feature` in
`.repopilot/config.yaml` (or use `repopilot policy set <path> <value>`). A CLI mode flag never enables
permission by itself. `--approve` explicitly approves each requested action for this invocation;
`--execute-checks` authorizes target tooling for additional current `validation.before_push` checks.
Dependency installation remains a manual step in the committed worktree. A failed or source-mutating
check blocks publication. Required check evidence is bound to the immutable commit and worktree state.

Publishing reloads policy, verifies the recorded commit and clean worktree, and publishes exactly its
`codex/repopilot-<run-id>` branch to the configured remote. Protected/disallowed branches are blocked.
The command never forces, mirrors, pushes tags, merges, or opens a PR. Additional remote refspecs,
mirror settings, target hooks, URL rewrites, and target transport programs cannot expand the push.
A remote must have one URL; differing or multiple `pushurl` values are rejected. Supported destinations
are HTTPS, SSH, and explicit local filesystem paths. URLs containing passwords, HTTPS usernames,
query strings, or fragments are rejected.

Transport runs with isolated Git metadata. SSH uses a fixed command with SSH config disabled and
noninteractive authentication via agent/default keys; custom SSH config aliases, ports, proxies, and
commands are not inherited (specify a real hostname and URL port). HTTPS is noninteractive and does
not run credential helpers; private HTTPS accounts requiring helpers are unsupported in this slice.
No GitHub authentication is added. Local receiving hooks are disabled; remote server-side hooks may
run normally on SSH/HTTPS servers.

Intent, validation, and confirmed result artifacts are available through `inspect`. Repeating a push
observes the exact remote branch. If it already equals the recorded commit, RepoPilot records or
returns confirmation without pushing again. A pending intent with a missing or different remote ref,
or a changed configured destination, requires inspection and never automatically replays. Errors
leave the local commit intact; inspect the run and remote branch before retrying `push`.

`status` includes the last recorded publishing result or pending intent, explicitly labeled as
historical. It does not contact the remote. For runs without automatic delivery, `resume --develop`
rechecks the local committed state without pushing; use the explicit `push` command to authorize
checks and observe the remote again. Runs with saved automatic delivery can continue an unfinished
publishing stage on resume, subject to current policy and invocation approvals.

### Automatic delivery during supervised runs

```bash
# Review-only remains the default:
repopilot run "Improve greeting" --provider codex --develop
# Automatically commit after passing validation and independent review:
repopilot run "Improve greeting" --provider codex --develop --delivery commit --message-provider codex --approve --execute-checks
# Automatically commit and push, with Gemini drafting the commit message:
repopilot run "Improve greeting" --provider codex --develop --delivery push --message-provider gemini --approve --execute-checks
# Continue the saved mode after a pause:
repopilot resume --develop --approve --execute-checks
```

`--delivery review|commit|push` records immutable run intent. `commit` keeps delivery local; `push`
commits then publishes the recorded branch. Neither mode enables Git permissions: repository policy,
current validation, and required approvals still gate each action. `--approve` and `--execute-checks`
apply only to the current invocation and must be supplied again when needed on resume. Legacy
`--auto-commit` and `--no-push` policy-preview flags are rejected with `--develop`; use delivery modes.

For automatic Git delivery, select exactly one `--message "fix: improve greeting"` or
`--message-provider codex|gemini|groq`. Generated messages use bounded objective/path/action/check-status
metadata, not target source, diff, diagnostics, or review excerpts. Gemini uses the existing local
key configuration (`repopilot config gemini`); Codex uses its existing separate authentication. Model
output must pass strict single-line conventional-message validation. The validated message is
journaled against its proposal and worktree fingerprint before commit and reused on resume.

`status` and `inspect` expose recorded delivery intent, message evidence, and completion or blocking
stage. A blocked publishing stage preserves the local commit and remains resumable. Implicit resume
selects unfinished delivery even when the code is already committed. Completed delivery resumes
recheck local committed state without regenerating messages or repeating pushes; remote publishing
remains last recorded. Use explicit `push` to authorize a fresh remote observation. Delivery mode and
message source cannot be changed on an existing run; start a new run instead. No merge or deployment
is performed. Existing SSH/HTTPS authentication restrictions still apply.

## Zsh command menus and completion

Global zsh package installation enables completion by default without a question or terminal
requirement. It appends a managed block to the current user's `~/.zshrc`, or `.zshrc` under an
absolute `ZDOTDIR` when set. Existing settings and file permissions are preserved, and existing
completion entries are not duplicated. Symlinked, hard-linked, nonregular, oversized, foreign-owned,
or incomplete managed configurations require manual setup. Startup configuration is never sourced
or executed during installation.

CI, local dependency installations, non-zsh shells, and sudo/root installs skip setup.
`REPOPILOT_SKIP_COMPLETION_SETUP=1` opts out, and package-manager `--ignore-scripts` suppresses the
hook entirely. Safe setup failures do not fail package installation. After a skipped install, or to
configure personal completion settings interactively, use:

```zsh
repopilot settings
```

`settings` asks before adding completion when it is absent, defaults to no, and leaves settings
unchanged when declined. The question expires after 30 seconds. Existing completion does not prompt
again. `repopilot completion install zsh` remains an equivalent explicit fallback. These commands
require a terminal and never treat npm's `--yes` as completion consent. Personal settings are separate
from project `repopilot setup`; project setup does not modify shell configuration. Open a new zsh
terminal after enabling completion. Neither install nor settings changes the current parent shell.

Enable described command and option menus in the current zsh terminal:

```zsh
eval "$(repopilot completion zsh --auto-menu)"
```

Use a freshly built/installed RepoPilot release; older globally installed versions may not have this
command. For a source checkout, build it first, then use
`eval "$(node /path/to/RepoPilot/apps/cli/dist/index.js completion zsh --auto-menu)"` with its absolute
path. `completion zsh` prints static shell support; it does not edit startup files. To keep support
across sessions, add the enable line yourself after your existing completion plugins in `~/.zshrc`.
Only source output from a trusted RepoPilot installation or checkout.

Type `repopilot ` to open a menu of commands and their descriptions. Arrow keys move the selection;
typing filters it. Enter accepts the selected completion without running the command; press Enter
again when the complete command is ready. Ctrl-G dismisses the menu and restores the previous text.
Tab completes prefixes such as `repopilot ru` or `repopilot run --pro`.

Menus also cover nested commands and values: `--provider` offers Codex/Ollama/fake planning providers
(fake is omitted with `--develop`), `--message-provider` offers Codex/Gemini/Groq, and `--delivery` explains
review/commit/push. Repository and file flags use native path completion. Suggestions never invoke a
provider, execute repository scripts, or run RepoPilot while you type. Run IDs and model names are
free-form rather than discovered dynamically.

Automatic menus are limited to recognized complete word boundaries on a simple `repopilot` command
at the end of the editing buffer. Closed quoted task descriptions are supported; unfinished quoted
arguments, command substitutions, shell operators, escaped input, and mid-line edits use Tab instead.
The automatic mode wraps Space in the emacs and vi insert keymaps, preserving the prior Space widget
for other input. Sourcing it again is safe. It does not replace your Tab binding or global completion
styles; menus are scoped to RepoPilot.

For Tab-only support, omit `--auto-menu`. If automatic support is already loaded, run
`_repopilot_disable_auto_menu` to restore the captured Space bindings; remove the enable line from
your startup file to disable it in future sessions. Shells other than zsh are not supported yet.
