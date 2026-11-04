# Product Feature Roadmap

Updated November 4, 2026. This tracks the product growth roadmap discussed alongside the v0.3.0
analysis. The [engineering roadmap](IMPLEMENTATION_ROADMAP.md) tracks the underlying implementation
phases; [implemented features](IMPLEMENTED_FEATURES.md) and the [CLI reference](CLI_REFERENCE.md)
describe the current interface.

RepoPilot's product direction is to turn a scoped task into a verified, reviewable change while
keeping authorization in deterministic policy. Status below describes delivered scope, not measured
user outcomes. **Partial** means a usable slice or supporting foundation exists, with material work
still outstanding. **Planned** means the requested product workflow is not implemented.

## Delivered increments

- [x] Evidence-backed discovery, durable journals, provider contracts, deterministic policy, and a
      bounded command executor. See packages `analyzer`, `workflow`, `provider`, `policy`, and `executor`.
- [x] Scoped Codex/Ollama planning and bounded proposal generation through a separate source broker.
      See [development orchestration](../../packages/orchestrator/src/development.ts).
- [x] Isolated worktree apply, passing-check gates, and bounded repair after executable check failures.
- [x] Supervised `run --develop` with stage progress, recorded acceptance criteria, independent review,
      completion reports, and `resume --develop` with freshness checks.
      See [task runner](../../packages/orchestrator/src/task-runner.ts).
- [x] Independent review of the complete final change set, including changes retained after narrower
      repairs; review judgments remain separate from executable proof.
- [x] Explicit policy-gated local commits, a dedicated agent branch, durable commit intent, and safe
      repeated commands. See [commit lifecycle](../../packages/orchestrator/src/git-lifecycle.ts).
- [x] Commit-only and commit-and-push modes, separate push approval and validation gates, isolated
      transport configuration, and destination-bound publishing recovery.
      See [push lifecycle](../../packages/orchestrator/src/push-lifecycle.ts).
- [x] Opt-in automatic run delivery with `--delivery commit` or `--delivery push`, saved message
      strategy, and resumable delivery gates. Codex or Gemini can draft validated conventional
      messages from bounded metadata; explicit messages remain supported. Completed delivery is
      reused without republishing. See [automatic delivery](../../packages/orchestrator/src/auto-delivery.ts).
- [x] Standalone release packaging and a clean-install smoke test.
      See [release builder](../../scripts/build-release.mjs).
- [x] Native zsh command menus with descriptions, arrow-key selection, contextual flags/providers,
      and opt-in automatic popups after recognized word boundaries. Static completion performs no
      repository or provider execution while typing. See [completion guide](CLI_REFERENCE.md#zsh-command-menus-and-completion).
- [x] Default-on completion for supported global zsh installs: safe managed zshrc append preserves
      existing settings and avoids duplicates, without requiring a terminal. CI, opted-out and
      unsupported installs skip setup. `settings` provides separate interactive personal setup;
      `completion install zsh` remains an explicit fallback. Project setup does not edit shell settings.

These are implemented slices. They do not imply completion of every feature in the original analysis.

## Release readiness comes first

The November 4 product assessment is a prioritization input, not a verified code audit. Existing
supervised execution, commit/push delivery, and archive packaging remain delivered slices; the
illustrative `repopilot implement 42` command is a target experience, not a supported command.
The product promise is: give RepoPilot a scoped task and get reviewed, verified changes with an
audit trail. Issue ingestion and draft PR creation are future extensions of that workflow.

| Priority | Release gate                           | Status and evidence                                                                                                                                                                                                                                                                                                                                                   | Exit criteria                                                                                                                                                                                                                           |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Installable standalone CLI             | Partial: [release builder](../../scripts/build-release.mjs) bundles the CLI and brokers, checks version/setup, and exercises isolated global install/uninstall. [CI](../../.github/workflows/ci.yml) runs Node 22 Linux checks. The macOS/Linux matrix expansion is prepared locally but awaits workflow publishing permission; hosted results remain to be observed. | Passing platform jobs, checksum artifacts, documented upgrade/removal, and a tested public installation path. Windows remains unvalidated and unsupported for this release gate.                                                        |
| P0       | License and publication readiness      | Proprietary/public-source terms adopted: [EULA v1.0](../legal/EULA.txt), effective November 4, 2026. Release packaging includes terms, reviewed dependency notices, and explicit packaged EULA acceptance; see [review](../legal/REVIEW.txt). [Root manifest](../../package.json) remains private.                                                                    | Local CLI review and acceptance smoke tests delivered. Observe hosted platform results and validate upgrades before any public binary release; review new components before distribution. Do not imply a public package already exists. |
| P0       | Clear core value and reproducible demo | Partial: [README workflow](../../README.md#your-first-useful-workflow) and [task runner](../../packages/orchestrator/src/task-runner.ts).                                                                                                                                                                                                                             | A clean fixture demonstrates task, plan, isolated changes, checks, independent review, and inspection without credentials for offline mode; document live-provider prerequisites separately.                                            |
| P1       | Evidence of usefulness                 | Planned: measurement protocol below.                                                                                                                                                                                                                                                                                                                                  | Matched baseline tasks, raw local results, failures, cost availability, and limitations; no unmeasured speed or quality claims.                                                                                                         |

## Prioritized feature status

| Priority | Feature                                         | Status  | Delivered scope and remaining work                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Unified task-to-verified-change workflow        | Partial | Scoped single-task runner delivered. Multi-task implementation, pause/cancel controls, and broader task coverage remain.                                                                                                                                                   |
| P0       | Independent code review and repair              | Partial | Fresh source review and bounded repair of failed executable checks delivered. Reproducing reviewer findings and routing confirmed findings into repair remain.                                                                                                             |
| P0       | Acceptance criteria and completion evidence     | Partial | Criteria and supported/not-met/unverified review judgments delivered. Mapping each criterion to meaningful executable verification remains.                                                                                                                                |
| P0       | Resume, retry, and recover sessions             | Partial | Durable stages, freshness checks, repair budgets, and safe completed-step reuse delivered. Interrupted apply/commit require inspection; ambiguous pushes are reconciled only when the exact remote commit is observed. Pause/cancel and general automatic recovery remain. |
| P1       | Repository memory and architecture intelligence | Planned | Discovery facts and manifests are foundations. Persistent project memory, retrieval, preferences, and commit-aware invalidation remain.                                                                                                                                    |
| P1       | Issue-to-reviewed-PR workflow                   | Partial | Explicit local commit and remote branch publishing delivered. Issue ingestion, GitHub authentication, draft PR creation, and linked completion reports remain.                                                                                                             |
| P1       | Actionable agent dashboard                      | Planned | The existing dashboard is a shell with policy settings. Live task state, approvals, review decisions, and artifact inspection remain.                                                                                                                                      |
| P1       | Bug reproduction and regression testing         | Planned | Validation and repair exist. A dedicated reproduce-before-fix workflow with a demonstrated failing-then-passing regression test remains.                                                                                                                                   |
| P1       | Task-aware model and agent routing              | Planned | Manual provider choice and specialist configuration exist. Automatic routing by task, privacy, budget, and measured results remains.                                                                                                                                       |
| P2       | Parallel agents with dependency management      | Partial | Planning batches and scope-conflict policy exist. The development runner still implements one task; concurrent implementation, integration, and final combined verification remain.                                                                                        |
| P2       | Risk-based approvals and verification           | Partial | Deterministic per-action policy and approvals delivered. Evidence-based risk classification and adaptive verification remain.                                                                                                                                              |
| P2       | Cost and performance analytics                  | Planned | No measured developer speedup or product analytics workflow is established. Local benchmarks and consent-aware reporting remain.                                                                                                                                           |
| P2       | Continuous repository maintenance               | Planned | No recurring health-to-task workflow is implemented. Prioritized findings and authorized maintenance loops remain.                                                                                                                                                         |
| P3       | Team collaboration and shared policies          | Planned | Repository-local policy exists. Shared policy distribution, team review, and collaboration workflows remain.                                                                                                                                                               |

## Four product release stages

### 1. Make the core workflow effortless — partial

Delivered: the bounded Verified Task Runner MVP, unified reports, acceptance criteria, stage progress,
durable resume, opt-in automatic delivery after the review gate, and described zsh command menus.
The runner reuses existing provider, worktree, executor, and policy components; delivery mode never
grants policy permission.

Remaining: explicit pause/cancel/retry controls, worktree cleanup, and support for more than one scoped
implementation task. Demonstrate ordinary task completion without manual stage coordination in a
representative pilot before calling this product stage complete.

### 2. Make results trustworthy — partial

Delivered: independent source review, complete accumulated-diff coverage, failed-check repair budgets,
freshness gates, and honest reporting of unresolved requirements and production limitations.

Remaining: reproduce review findings, map acceptance criteria to executable proof, verify regression
tests meaningfully fail before fixes, and measure review precision against an implementation-only
baseline. A passing check or favorable source review alone is not production verification.

### 3. Integrate into daily developer work — partial

Delivered: authorized commit-only or commit-and-push delivery to a dedicated branch, either explicitly
or automatically after a supervised run. Message generation can use explicitly selected Codex or
Gemini without sending source files or diffs. Provider behavior is tested with offline substitutes;
live model connectivity is not established by those tests.

Remaining: issue-to-draft-PR automation, durable repository memory, an actionable dashboard, and the
bug reproduction workflow. Private HTTPS authentication through credential helpers is unsupported;
SSH uses an existing agent or default keys with custom SSH configuration disabled. Live remote
authentication compatibility has not been established by local-remote tests.

### 4. Scale the workflow — planned

Scope: safe parallel implementation with dependencies and integration checks, provider optimization,
project health monitoring, shared policy templates, and team collaboration. Measure delivery time,
review effort, rework, and escaped defects before expanding agent counts or provider breadth.

## Next increments

1. **Distribution gate (started):** run archive smoke tests in Node 22 macOS/Linux CI; exercise the
   global command shim and uninstall in a disposable prefix; retain checksummed artifacts. Observe
   hosted CI before declaring either platform validated. The proprietary EULA, reviewed CLI notices, and explicit packaged acceptance are implemented.
   Review records document ownership limitations. Confirm package identity and observe platform CI
   before release publication. Validate upgrades and document supported environments.
2. **Core workflow demo and positioning:** use the existing `run --develop` path for a concise,
   reproducible task-to-reviewed-change walkthrough. Keep the lower-level commands available.
   Design quick/supervised/strict interaction modes only within existing policy; no implicit approvals.
3. **Terminal lifecycle:** cancel, pause, explicit retry, and policy-authorized worktree cleanup,
   preserving journals and interrupted-operation evidence.
4. **Trust and measurement:** executable acceptance evidence, reproduce-before-repair review findings,
   and a local matched-task benchmark. Start with a small pilot, then 20–50 tasks comparing direct
   Codex, manually configured guidance, and RepoPilot under consistent budgets and criteria.
5. **Daily integration:** issue ingestion and draft PRs through a separately designed credential and
   permission adapter; actionable Run History, Live Execution, Code Review, and Repository Health
   views backed by durable state. PR creation still requires policy and delivery approval.
6. **Scale after evidence:** dependent multi-task orchestration with isolated write scopes, independent
   review and combined validation. Measure the benefit before adding agents, roles, or providers.

Keep merge/deployment automation, broad cloud-provider expansion, telemetry, and hosted execution
outside these increments unless separately designed and authorized. Public publishing, merging a
release branch, and remote publication are not implied by this roadmap.

## Outcome measurement — proposed, not achieved

Track accepted-task completion rate, time to a verified change, hands-on developer time, review
precision, interventions, repeat usage, and safe recovery rate. The earlier analysis proposed pilot
targets of at least 70% task completion, 25% less elapsed time, at least 80% review precision, at least
40% seven-day repeat usage, and at least 95% safe recovery. These remain hypotheses, not RepoPilot
performance claims. Compare matched tasks and consistent acceptance criteria against a baseline;
record task count, failures, environment, and limitations alongside any reported improvement.
