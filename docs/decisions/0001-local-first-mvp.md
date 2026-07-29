# 0001: Local-First MVP

## Status

Accepted

## Context

RepoPilot needs to inspect repositories, developer tooling, and generated changes before it can safely automate hosted workflows. A hosted GitHub App would add authentication, permissions, infrastructure, and remote execution concerns before the core evidence model is proven.

## Decision

Begin with a local-first CLI and dashboard shell. The CLI provides the initial execution surface, and the dashboard presents repository readiness states without pretending unavailable analysis has run.

## Consequences

This keeps the first milestone simpler, testable, and privacy-preserving. Hosted GitHub App behavior, pull requests, and remote orchestration are deferred until the deterministic core is reliable.
