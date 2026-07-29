# 0002: Deterministic Core

## Status

Accepted

## Context

AI-assisted development depends on accurate repository context. If repository facts are inferred without evidence, generated recommendations become hard to trust and difficult to validate.

## Decision

Repository facts and validation results must come from deterministic tools. Every detected fact must include evidence. AI is limited to future interpretation and proposal generation and cannot be the source of truth for detection or validation.

## Consequences

The core remains auditable and testable. AI proposals can be added later behind typed contracts and must still pass deterministic validation before files are written.
