# 0004: Trusted Command Execution Boundary

## Status

Accepted

## Context

Agent providers and repository contents are untrusted inputs. Passing provider-produced command lines
to a shell would allow quoting, expansion, path, environment, and persistence behavior to bypass the
deterministic workflow and policy layers. Future validation and task execution still need a controlled
way to start approved local tools.

## Decision

Introduce a provider-neutral command-executor contract backed by a local process implementation.
Callers select code-owned command IDs rather than supplying executable strings. Definitions contain
the executable, fixed arguments, exact permitted argument variants, and working-directory scopes.
Before spawning, the executor checks repository containment through real paths and constructs a child
environment only from explicitly supplied allowlisted values.

Commands run directly without a shell or interactive stdin. The executor bounds runtime and combined
output with ceilings that requests may only lower, supports cancellation, escalates termination after
a grace period, redacts output, and returns a structured result for later audit persistence.

## Consequences

The executor can safely become the sole subprocess primitive used by later orchestration phases, but
it does not make a local process equivalent to a container. Network, filesystem writes inside the
allowed repository scope, and operating-system capabilities are not isolated. Higher-risk tasks will
still require an OS-level sandbox or isolated worktree, deterministic policy authorization, and
explicit workflow integration. Analysis and current CLI workflows do not invoke the executor.
