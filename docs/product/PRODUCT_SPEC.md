# RepoPilot Product Spec

## Vision

RepoPilot helps developers make repositories legible, reliable, and safer for AI-assisted development by grounding every recommendation in verified repository evidence.

## Target User

The initial user is a local developer or small team maintainer who wants to understand whether a repository has the structure, commands, tests, CI, and agent instructions needed for dependable AI coding workflows.

## Core Problem

AI tools often fail when repositories have unclear commands, stale instructions, missing validation, or hidden assumptions. RepoPilot reduces that ambiguity by analyzing the repository deterministically before any proposal is generated.

## Workflow

1. Analyze repository files, manifests, lockfiles, workflows, and instructions.
2. Normalize facts into typed evidence-backed data.
3. Generate proposed files or edits from deterministic templates and, later, constrained AI proposals.
4. Validate proposed output before writing files.
5. Explain the validated result and remaining gaps.

## Initial Strategy

RepoPilot starts CLI-first with a local dashboard shell. The CLI is the first trustworthy execution surface because it can inspect the developer environment directly and avoid hosted access or authentication complexity.

## MVP Non-Goals

- Hosted GitHub App behavior.
- Pull request creation.
- External AI calls.
- Telemetry.
- Repository script execution during analysis.
- Production deployment.

## Future GitHub App Direction

After the local core is trustworthy, RepoPilot can add GitHub authentication, hosted analysis orchestration, pull request creation, review comments, and repository readiness dashboards.
