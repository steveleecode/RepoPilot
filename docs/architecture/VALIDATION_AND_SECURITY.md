# Validation And Security

RepoPilot is designed around deterministic validation and conservative execution boundaries.

## Security Boundaries

RepoPilot currently follows these boundaries:

- Treat analyzed repository contents as untrusted input.
- Do not execute target repository scripts during analysis.
- Do not load target repository code into the RepoPilot process.
- Do not collect environment variables.
- Do not print secrets.
- Do not add telemetry.
- Do not make cloud AI calls. Local Ollama calls require explicit configuration.
- Do not authenticate with GitHub.
- Do not merge pull requests.

## Local Execution Boundary

`packages/executor` provides the only local subprocess primitive intended for future workflow use. It:

- Selects executables from trusted code-owned command definitions, never raw provider command text.
- Uses exact allowlisted argument vectors and invokes the executable directly with `shell: false`.
- Rejects absolute, traversing, out-of-scope, missing, and symlink-escaping working directories.
- Starts with no inherited environment and accepts only explicitly allowlisted variables.
- Enforces time and combined-output ceilings that requests may only lower, supports cancellation, and
  escalates termination after a bounded grace period.
- Redacts injected secret values and common credential-shaped output before returning structured
  results.

This is a process-level safety boundary, not kernel isolation. `repopilot verify --execute-checks`
uses it to run code-owned validation commands in an isolated worktree and persists bounded results.
Validation tools may execute target configuration or package scripts, so the flag is an explicit user
approval to run them. Analysis never executes repository scripts.

## Path Safety

Shared path normalization rejects path traversal. Repository-relative paths are normalized by removing empty and `.` segments and rejecting `..`.

## Evidence Requirements

Analyzer facts must include evidence. RepoPilot must not claim a repository fact was detected without a source path, source type, and description.

Repository traversal is bounded by depth and entry-count limits, does not follow symbolic links, skips
known dependency and build-output directories, and applies a byte limit before reading known metadata
files. Git branch and dirty-state detection uses only read-only Git commands with hooks and filesystem
monitoring disabled, plus time and output limits.

## Proposed Changes Before Writes

Generated content is represented as proposed files or edits. Validators operate on proposed changes before write operations whenever possible.

The workflow journal enforces planning validation and review gates. The development commands record
separate proposal, apply, and validation artifacts after a completed planning run. The source-context
broker is a separate process that reads bounded, selected files and sends them only to loopback Ollama;
the main process sees hashes and generated proposals, not assembled source context. Apply targets an
isolated worktree, checks stale hashes, and never writes the primary checkout. This is not an OS sandbox.

## Validation Commands

The root validation gate is:

```bash
pnpm check
```

It runs:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`

End-to-end smoke tests are available separately:

```bash
pnpm test:e2e
```

## Policy Enforcement

Execution policy is deterministic code, not natural-language guidance.

The policy layer blocks:

- Commits when automatic commits are disabled.
- Commits when required validation is missing or failed.
- Pushes when automatic pushes are disabled.
- Pushes to default, protected, production, or release branches.
- Pushes to branches outside allowed agent-owned patterns.
- Force pushes by default.
- Pull requests when pull-request automation is disabled.
- Destructive actions without approval.
- Parallel write tasks without isolated worktrees.
- Parallel write tasks with overlapping write scopes.

## Audit Records

Audit records are typed and redact obvious secrets in summaries and metadata. Future execution layers should persist audit records for policy resolution, task execution, validation, commits, pushes, pull requests, approvals, failures, and retries.

## Known Warnings

Next.js currently prints a non-failing warning during `next build` that the Next ESLint plugin was not detected in the flat ESLint configuration. RepoPilot imports the plugin rules directly and `pnpm lint` passes.
