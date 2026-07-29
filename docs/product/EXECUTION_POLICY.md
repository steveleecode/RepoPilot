# Execution Policy

RepoPilot uses deterministic execution policies to control how AI coding agents may plan, modify files, validate work, commit, push, and prepare pull requests.

The canonical repository config file is:

```text
.repopilot/config.yaml
```

The file is versioned and validated before use.

## Resolution Order

Policy is resolved in this order:

1. Built-in safe defaults.
2. Selected preset.
3. Global user configuration.
4. Repository `.repopilot/config.yaml`.
5. Explicit command-line flags.
6. Temporary approval decisions.

The current implementation supports built-in defaults, presets, repository config, and explicit one-run CLI flags. Global user config and temporary approval persistence are reserved for future execution work.

## Presets

### Safe

Safe is the non-destructive baseline.

- Parallel execution disabled.
- Automatic commits disabled.
- Automatic pushes disabled.
- Pull-request automation disabled.
- Human approval required before applying generated files.
- Destructive actions always require approval.

### Balanced

Balanced is the repository default in this project.

- Parallel execution enabled with isolated worktree strategy.
- Automatic commits enabled after completed features.
- Pushes disabled.
- Pull requests disabled.
- Formatting, linting, type checking, and relevant tests required before commits.
- Push and pull-request approval gates enabled.

### Autonomous

Autonomous is intended for trusted repositories.

- Parallel execution enabled.
- Automatic feature commits enabled.
- Pushes allowed only to agent-owned branch patterns.
- Draft pull-request automation enabled.
- Default, protected, production, and release branches remain prohibited.
- Validation remains required.
- Destructive actions still require approval.

### Custom

Custom starts from safe defaults and allows each policy section to be changed explicitly.

## Configuration Sections

### `parallelism`

Controls concurrent work.

- `enabled`: whether parallel work may run.
- `max_workers`: maximum concurrent workers.
- `strategy`: `disabled`, `parallel_analysis`, `isolated_worktrees`, or future `isolated_sandboxes`.
- `allow_parallel_reads`: whether read-only work can run concurrently.
- `allow_parallel_writes`: whether write tasks can run concurrently.
- `require_independent_scopes`: whether parallel tasks must declare independent scopes.

Parallel writes require isolated worktrees and non-overlapping task scopes.

### `commits`

Controls automatic commit authorization.

- `enabled`: whether RepoPilot may create commits.
- `strategy`: `never`, `after_task`, `after_feature`, or `after_milestone`.
- `require_clean_validation`: whether required validation must pass first.
- `allow_checkpoint_commits`: whether temporary checkpoint commits are allowed.
- `message_format`: `conventional`, `imperative`, `repository_inferred`, or `custom_template`.
- `sign_commits`: whether commits should be signed.

The current implementation authorizes or rejects commit requests. It does not yet perform automatic commits.

### `pushes`

Controls automatic push authorization.

- `enabled`: whether RepoPilot may push.
- `strategy`: `never`, `after_feature`, `after_milestone`, or `on_completion`.
- `remote`: expected remote name.
- `allowed_branch_patterns`: branch patterns that may receive pushes.
- `prohibited_branches`: branches that are always blocked.
- `allow_force_push`: force push permission. Defaults to false.

Default, protected, production, and release branches are blocked deterministically.

### `pull_requests`

Controls pull-request automation.

- `enabled`: whether RepoPilot may create pull requests.
- `create_as_draft`: whether created pull requests should be draft PRs.
- `require_validation`: whether validation must pass before PR creation.
- `require_human_approval`: whether human approval is required.

RepoPilot does not merge pull requests in this milestone.

### `validation`

Defines required checks before Git actions.

- `before_commit`.
- `before_push`.
- `before_pull_request`.
- `stop_on_failure`.

Supported validation check identifiers:

- `format`
- `lint`
- `typecheck`
- `relevant_tests`
- `unit_tests`
- `build`
- `full_check`

### `approvals`

Defines human approval gates.

- `before_apply`
- `before_commit`
- `before_push`
- `before_pull_request`
- `before_destructive_action`

Destructive actions should always require approval.

### `failure_handling`

Controls how failed or partial work is handled.

- `preserve_worktree`
- `create_failure_report`
- `allow_partial_commit`
- `retry_limit`

## Deterministic Enforcement

Policy is enforced in application code. Agent or LLM requests do not authorize Git operations.

Examples:

- Pushes are rejected when `pushes.enabled` is false.
- Commits are rejected when required validation is missing or failed.
- Pushes to default/protected/prohibited branches are blocked even when pushes are enabled.
- Force pushes are blocked by default.
- Parallel write tasks are rejected when scopes overlap.
- Parallel write tasks are rejected unless isolated worktrees are configured.

## Audit Records

The policy package defines audit records for:

- Policy resolution.
- Task parallelization.
- Worktree creation.
- Commit creation.
- Validation.
- Push attempts.
- Pull-request creation.
- Approval decisions.
- Failures and retries.

Audit summaries and metadata redact obvious secret-bearing fields.
