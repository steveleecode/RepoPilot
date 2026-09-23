# 0005: Source Context Broker

Status: Accepted for Phase 8.

RepoPilot's primary process must not load target repository source code for model context. A separate
Node process in `packages/provider/src/change-broker.ts` performs bounded, read-only source selection
and sends it directly to a configured loopback Ollama model. It never imports, evaluates, or executes
target source. The parent receives only a context manifest and normalized change proposal.

The broker accepts only planned read/write scopes and explicit files within those scopes. It rejects
absolute paths, traversal, symlinks, binary files, oversized files, known build/dependency directories,
Git-ignored paths, and secret-shaped paths. It caps selection at 12 files and 64 KiB. The manifest
records path, SHA-256, size, reason, and filesystem evidence. The proposal must cite selected context,
remain within write scopes, and pass strict schema validation before any apply action.

This is a process boundary, not an OS sandbox. A compromised local model or tool configuration remains
a risk. Execution of target validation tooling is separately opt-in through `--execute-checks`.
