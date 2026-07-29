# 0003: Policy-Enforced Execution

## Status

Accepted

## Context

RepoPilot will eventually coordinate AI coding agents that can modify files and perform Git operations. Natural-language instructions are not enough to protect repositories from accidental commits, pushes, pull requests, destructive actions, or unsafe parallel writes.

## Decision

Add a versioned `.repopilot/config.yaml` execution policy. Resolve policy from safe defaults, presets, repository configuration, command-line overrides, and temporary approvals. Enforce the resolved policy in deterministic code before applying files, committing, pushing, creating pull requests, or parallelizing write tasks.

## Consequences

External writes are disabled by default and cannot be enabled silently. The CLI and dashboard expose the same resolved policy. Future execution layers must call policy authorization APIs rather than trusting agent intent.
