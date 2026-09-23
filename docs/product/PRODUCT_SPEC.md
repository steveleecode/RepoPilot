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

Repository owners can configure execution policy in `.repopilot/config.yaml`, through the CLI, and in the dashboard settings view. The policy controls parallel work, commits, pushes, pull requests, validation gates, approvals, autonomy, and failure handling.

## Initial Strategy

RepoPilot starts CLI-first with a local dashboard shell. The CLI is the first trustworthy execution surface because it can inspect the developer environment directly and avoid hosted access or authentication complexity.

## Local Model Direction

The first live AI integration will be a local model, beginning with Ollama behind the existing
agent-provider contract. The local model interprets deterministic repository evidence and returns
schema-validated plans and, in later phases, structured change and command intentions. It never gains
direct filesystem, process, approval, workflow-state, or Git authority.

RepoPilot remains responsible for selecting and bounding context, validating paths and commands,
authorizing actions through execution policy, applying changes in isolated worktrees, running trusted
validation commands, and presenting the final diff. This lets smaller local models focus on narrow,
well-grounded tasks while deterministic systems retain control.

Source-code context requires an explicit security decision before implementation because current
repository guidance prohibits loading target source into the RepoPilot process. The initial Ollama
milestone therefore uses objectives and evidence-backed metadata only.

## MVP Non-Goals

- Hosted GitHub App behavior.
- Pull request creation.
- Cloud AI calls during the local-first milestone.
- Telemetry.
- Repository script execution during analysis.
- Production deployment.
- Automatic merge behavior.

## Future GitHub App Direction

After the local core is trustworthy, RepoPilot can add GitHub authentication, hosted analysis orchestration, pull request creation, review comments, and repository readiness dashboards.
