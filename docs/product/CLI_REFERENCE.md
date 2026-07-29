# CLI Reference

RepoPilot exposes a local development command through:

```bash
pnpm repopilot <command>
```

The package binary is named `repopilot`; the root script runs the built CLI from `apps/cli/dist/index.js`.

## Help

```bash
pnpm repopilot --help
```

Prints usage and the available commands.

## Version

```bash
pnpm repopilot version
```

Prints the current CLI version.

## Doctor

```bash
pnpm repopilot doctor
```

Inspects the RepoPilot development environment. It reports:

- Node version.
- pnpm availability.
- Git availability.
- Current directory.
- Whether the current directory is a Git repository.

The command returns a nonzero exit code when a required dependency is missing.

## Policy Show

```bash
pnpm repopilot policy show
```

Loads `.repopilot/config.yaml` when present, resolves the policy, and prints the effective configuration and sources.

## Policy Validate

```bash
pnpm repopilot policy validate
```

Validates `.repopilot/config.yaml` against the versioned schema. It returns a nonzero exit code when the file is missing or invalid.

## Policy Init

```bash
pnpm repopilot policy init
```

Creates `.repopilot/config.yaml` using the balanced preset. The command refuses to overwrite an existing config.

## Policy Set

```bash
pnpm repopilot policy set <path> <value>
```

Updates a dotted execution-policy path and revalidates the full config before writing.

Examples:

```bash
pnpm repopilot policy set commits.enabled true
pnpm repopilot policy set commits.strategy after_feature
pnpm repopilot policy set parallelism.enabled true
pnpm repopilot policy set parallelism.max_workers 3
pnpm repopilot policy set pushes.enabled false
```

## Run Policy Preview

```bash
pnpm repopilot run --parallel --max-workers 3 --auto-commit --no-push
```

This milestone does not execute agent work. The command resolves the policy for a planned run and displays the effective configuration. One-run flags do not edit `.repopilot/config.yaml`.

Supported one-run flags:

- `--parallel`: enables read-only parallel analysis for this invocation.
- `--max-workers <n>`: sets worker count for this invocation.
- `--auto-commit`: enables after-feature automatic commits for this invocation.
- `--no-push`: disables automatic pushes for this invocation.
