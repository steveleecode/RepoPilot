# RepoPilot documentation

[RepoPilot home](../README.md)

## For users

- [Getting started](../README.md#getting-started): build from source and scan your first repository.
- [CLI reference](product/CLI_REFERENCE.md): setup, completion, chat, providers, development, and recovery.
- [Execution policy](product/EXECUTION_POLICY.md): deterministic permissions and approval requirements.
- [v0.3.0 release notes](releases/v0.3.0.md): installation, upgrade, uninstall, and preview limits.
- [Feature roadmap](product/FEATURE_ROADMAP.md): current progress and future work.
- [Capability audit](product/README_AUDIT.md): source-backed README claims and verification.

For environment failures, start with `repopilot doctor` and `repopilot providers doctor`.
For a blocked workflow, use `repopilot status <run-id>` and `repopilot inspect <run-id>`;
review the CLI reference before resuming. Policy failures require reviewing the effective configuration,
not bypassing approval gates.

## For contributors

- [npm publishing workflow](releases/NPM_WORKFLOW.md): dry runs, versioned releases, and trusted publisher setup.
- [Agent guidance](../AGENTS.md): repository development constraints.
- [System overview](architecture/SYSTEM_OVERVIEW.md): architecture and package boundaries.
- [Package reference](architecture/PACKAGE_REFERENCE.md): package contracts.
- [Validation and security](architecture/VALIDATION_AND_SECURITY.md): trust and execution boundaries.
- [Decision records](decisions): design rationale.
- [Implemented features](product/IMPLEMENTED_FEATURES.md): detailed implementation inventory.
- [Implementation roadmap](product/IMPLEMENTATION_ROADMAP.md): engineering milestones.
- [Product specification](product/PRODUCT_SPEC.md): intended product design; not a promise of current availability.

Run `pnpm check` before submitting a change. See the root README for local development commands.
