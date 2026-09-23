# Implementation Roadmap

This roadmap reflects the architecture implemented through Phase 6 and the decision to make a local
coding model the first live AI integration.

The product principle is:

> The model proposes. RepoPilot authorizes, applies, and verifies.

Model output is always untrusted structured input. A model cannot directly write files, start a
process, approve an action, change workflow state, or perform a Git operation.

## Completed Foundation

| Phase | Capability                                                   | Status   |
| ----- | ------------------------------------------------------------ | -------- |
| 1     | CLI product surface                                          | Complete |
| 2     | Durable run model and event-journal persistence              | Complete |
| 3     | Evidence-backed repository discovery                         | Complete |
| 4     | Vendor-neutral agent-provider abstraction                    | Complete |
| 5     | Deterministic workflow engine and policy-aware task batching | Complete |
| 6     | Trusted, bounded local command-execution boundary            | Complete |

## Revised Remaining Phases

### Phase 7: Local Model Planning Bridge (Implemented)

Make Ollama the first live provider and support one safe, read-only, schema-validated planning turn.
Extend the existing `packages/provider` abstraction rather than adding a second model abstraction.

Scope:

- Add versioned local-model configuration with provider ID, model name, endpoint, request timeout, and
  response-size limit. Do not store credentials in repository config.
- Implement an Ollama transport with dependency-injected HTTP for deterministic tests.
- Restrict the first implementation to loopback endpoints. LAN and cloud endpoints require a later,
  explicit network policy.
- Add health checks that distinguish an unreachable service, missing model, incompatible response,
  timeout, and cancellation.
- Define and validate an orchestrator-owned `PlanningIntent` result containing a summary, tasks,
  dependencies, read and write scopes, validation command IDs, completion criteria, risks, and
  questions.
- Reject arbitrary shell command strings. Plans may reference only command IDs that can later resolve
  through the trusted executor catalog.
- Build prompts from the objective and deterministic repository evidence only. Phase 7 does not send
  target source files to the model.
- Add `repopilot providers doctor` coverage for Ollama and allow
  `repopilot run "<objective>" --provider ollama` to persist a planning artifact without applying it.

Exit criteria:

- A local Ollama model can return a plan that passes schema validation and is persisted in a durable
  run.
- Invalid JSON, unknown fields, oversized responses, unavailable models, timeouts, and cancellations
  fail closed with actionable, redacted errors.
- The fake provider and Ollama provider pass the same planning contract tests.
- No file writes, repository commands, Git mutations, cloud calls, or implicit approvals occur.

### Phase 8: Bounded Source Context And Change Intent (Implemented first vertical slice)

Give the local model the minimum relevant source context needed to propose changes, then normalize its
response into validated change intentions.

This phase used the separate read-only context broker approach, documented in
`docs/decisions/0005-source-context-broker.md`. The primary RepoPilot process does not load target
source during context assembly. The broker sends bounded context only to loopback Ollama.

The first cut supported Ollama change generation. v0.2.0 added a standalone Codex App Server
transport and reused the same bounded context broker and proposal validator for Codex changes.

Scope after that decision:

- Select relevant files deterministically from task scopes, analyzer evidence, repository
  instructions, and explicit user input—not solely from model requests.
- Enforce repository containment, ignore rules, symlink rejection, binary detection, per-file limits,
  total byte/token budgets, and secret-path exclusions.
- Record a context manifest containing paths, hashes, truncation, selection reasons, and evidence.
- Separate planning from change generation so a validated plan exists before patch generation.
- Define structured `ChangeIntent` and `CommandIntent` schemas. File changes declare action, path,
  patch/content, evidence, and task ID. Commands reference trusted catalog IDs and exact argument
  variants.
- Store normalized proposals as workflow artifacts; never treat free-form model text as an executable
  instruction.

Exit criteria:

- Context selection is bounded, explainable, reproducible, and covered by traversal and secret-leak
  tests.
- Every proposed path and command is schema-valid and tied to a planned task and evidence.
- Proposals remain read-only artifacts; the target checkout is unchanged.

### Phase 9: Proposal Validation And Isolated Apply (Implemented first vertical slice)

Turn validated change intentions into reviewable changes inside disposable Git worktrees.

Scope:

- Add a proposal pipeline for create, modify, and delete operations with path, patch, conflict, size,
  and duplicate-target validation.
- Reject absolute paths, traversal, symlink escapes, writes outside declared task scopes, protected
  files, and stale base hashes.
- Authorize apply actions through execution policy and persist approval decisions.
- Create one isolated worktree per write task when policy permits; never perform parallel writes in the
  user's primary checkout.
- Apply validated proposals deterministically and record before/after hashes plus a bounded diff.
- Preserve rejected proposals and failure reports without partially applying them.

Exit criteria:

- Safe policy requires approval before apply; balanced/autonomous behavior matches resolved policy.
- Failed validation leaves the worktree unchanged, and interrupted apply can be inspected or safely
  resumed.
- The model has no direct filesystem or Git authority.

### Phase 10: Validation And Bounded Repair Loop (Implemented first vertical slice)

Connect applied worktrees to the Phase 6 executor and feed concise failures back to the provider.

Scope:

- Resolve policy validation checks to code-owned executor command definitions. A detected package
  script is evidence, not automatic permission to execute it.
- Run formatting, lint, typecheck, and relevant tests through the no-shell executor with explicit
  working directories, environment allowlists, timeouts, output ceilings, and cancellation.
- Persist redacted command results and validation artifacts in the workflow journal.
- Send only bounded diagnostics and the current proposal state back to the model.
- Enforce retry limits from execution policy and prevent a retry from expanding scopes or permissions
  without reauthorization.
- Stop in a reviewable failed state when repair attempts are exhausted.

Exit criteria:

- Validation cannot be skipped before review or Git actions.
- Every executed command maps to a trusted catalog entry and a policy decision.
- Retry behavior survives restart and never repeats an already completed side effect.

### Phase 11: Review And Git Lifecycle

Complete the local development workflow after validation succeeds.

Scope:

- Present the plan, approvals, changed files, diff, validation results, retries, and remaining risks.
- Add deterministic Git adapters for status, diff, branch creation, commit, and push.
- Enforce clean-validation, branch-pattern, remote, force-push, protected-branch, and approval rules
  immediately before each Git action.
- Use policy-selected commit timing and message format.
- Add optional draft pull-request creation only after GitHub authentication is designed as a separate
  adapter; never add merge automation.
- Keep worktrees on failure when policy requires preservation and provide an explicit cleanup command.

Exit criteria:

- A successful run can produce a reviewed commit on an allowed agent branch.
- Push and pull-request actions remain disabled or approval-gated exactly as configured.
- No model response can bypass deterministic Git authorization.

### Phase 12: Terminal Workflow Experience

Make the full agentic loop understandable and controllable from the terminal.

Scope:

- Add interactive and `--non-interactive` run modes with stable JSON output.
- Show phase progress, provider/model identity, context budget, pending approvals, command execution,
  retry count, and validation state without exposing hidden reasoning or secrets.
- Add commands to inspect plans, context manifests, proposals, diffs, artifacts, approvals, and audit
  events.
- Make cancel, resume, retry, approve, reject, and cleanup explicit operations.
- Provide clear exit codes for configuration, provider, authorization, proposal, execution,
  validation, and Git failures.

Exit criteria:

- A user can understand what RepoPilot intends to read, change, and execute before granting approval.
- Interrupted runs resume from durable state, and automation can consume the same state through JSON.

### Phase 13: Distribution And Provider Hardening

Prepare RepoPilot for reliable installation and additional local or remote providers.

Scope:

- Package and test the CLI across supported Node 22+ environments and macOS architectures.
- Add configuration migration, completion scripts, release artifacts, upgrade guidance, and an
  uninstall path.
- Add OpenAI-compatible local endpoints, llama.cpp, and MLX behind the existing provider contract only
  after Ollama contract parity is stable.
- Harden the now-implemented Codex App Server transport with broader compatibility fixtures and
  failure injection across Codex CLI versions.
- Add explicit network-egress policy before supporting LAN or cloud endpoints.
- Add compatibility fixtures, provider conformance tests, performance budgets, and failure injection.
- Document model sizing and context guidance for Apple Silicon without hard-coding one model family.

Exit criteria:

- A clean machine can install, configure, diagnose, run, upgrade, and remove the CLI predictably.
- Every provider passes the same health, cancellation, structured-result, size, timeout, and error
  normalization suite.

## Deferred Beyond This Roadmap

- Hosted execution and multi-tenant orchestration.
- Automatic pull-request merging.
- Broad cloud-provider support before network and credential policy exists.
- Telemetry without a separate privacy design and explicit opt-in.
- Treating free-form model output as executable authority.

## Recommended Next Increment

Complete Phase 11 review and Git lifecycle, then Phase 12 terminal ergonomics. The current
development workflow can plan, propose, apply in an isolated worktree, validate, and propose bounded
repairs, but it does not commit, push, open PRs, or offer automatic interactive approval.
