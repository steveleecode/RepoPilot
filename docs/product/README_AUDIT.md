# README capability audit

Audit date: November 4, 2026. This inventory describes the current working tree, including existing
uncommitted product work. It does not establish that a package has been published.

[README](../../README.md) · [Documentation index](../README.md)

## Verified implementation

| Claim                                                                                                  | Source evidence                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded repository metadata analysis with evidence                                                     | [Analyzer](../../packages/analyzer/src/index.ts), including manifest, script, language, and tooling detectors                                                                                                                                               |
| Described zsh command, flag, and value completion                                                      | [Completion implementation](../../apps/cli/src/completion.ts) and [tests](../../apps/cli/src/completion.test.ts)                                                                                                                                            |
| Specialist selection, generated Codex files, eight-stage task guidance, preservation of existing files | [Codex setup](../../apps/cli/src/codex-setup.ts) and [tests](../../apps/cli/src/codex-setup.test.ts)                                                                                                                                                        |
| Codex App Server, Ollama planning, provider selection                                                  | [CLI entry point](../../apps/cli/src/index.ts) and [provider package](../../packages/provider/src)                                                                                                                                                          |
| Supervised development, durable recovery, one scoped implementation task, independent review           | [Task runner](../../packages/orchestrator/src/task-runner.ts) and [tests](../../packages/orchestrator/test/task-runner.test.ts)                                                                                                                             |
| Isolated-worktree application and bounded proposals                                                    | [Development orchestrator](../../packages/orchestrator/src/development.ts), [change broker](../../packages/provider/src/change-broker.ts), [review broker](../../packages/provider/src/review-broker.ts)                                                    |
| Policy authorization and explicit automatic delivery modes                                             | [Policy package](../../packages/policy/src), [automatic delivery](../../packages/orchestrator/src/auto-delivery.ts), [Git lifecycle](../../packages/orchestrator/src/git-lifecycle.ts), [push lifecycle](../../packages/orchestrator/src/push-lifecycle.ts) |
| Groq default read-only chat and optional Gemini                                                        | [Chat implementation](../../apps/cli/src/gemini-chat.ts), [configuration](../../apps/cli/src/gemini-config.ts), [CLI dispatch](../../apps/cli/src/index.ts)                                                                                                 |
| Private source workspace and locally generated standalone archive                                      | [Root manifest](../../package.json), [CLI manifest](../../apps/cli/package.json), [release builder](../../scripts/build-release.mjs)                                                                                                                        |

Language detection is metadata recognition, not a claim that every language has a supported validation
catalog. Specialist setup generates Codex configuration and instructions; it does not execute a parallel
agent team. Policy support for isolated parallel tasks is distinct from the supervised runner's
single-task limit.

## Preview and unavailable functionality

The [dashboard](../../apps/web) is a shell with placeholders. Provider-backed output requires human
judgment; validation is not an OS sandbox. Arbitrary multi-task supervised implementation,
pull-request creation/merging, hosted execution, and GitHub authentication are not advertised as
available. Design documents and roadmaps include future work and should be read accordingly.
No license file was found in the checkout; the README makes no license grant.

## Demo provenance

[repopilot-demo.gif](../assets/repopilot-demo.gif) captures the running source-built CLI in a real
VS Code integrated zsh terminal. It shows `repopilot sc`, genuine Tab completion to `scan`, selection,
and a successful metadata scan. The CLI used Node.js 22.23.4. A disposable directory contained only
a minimal package manifest and JavaScript module. No target script was executed and no provider
credentials were used.

The native Terminal app was unavailable to computer automation, and native display recording was
unavailable. The fallback captured real application screenshots continuously during interaction,
then encoded the timestamped sequence with FFmpeg. Only crop, scale, palette optimization, and loop
encoding were applied; no terminal text or output was synthesized. The GIF is 1100 × 596, 43 frames,
10.56 seconds, and 234,841 bytes. The cropped frames show no personal paths, credentials, or desktop
content. This demonstrates local command discovery and analysis, not model-backed implementation.

To recreate: build the CLI, use a clean zsh session with the CLI on PATH, load
`eval "$(repopilot completion zsh --auto-menu)"`, and record `repopilot sc` → Tab → Enter → Enter
in a disposable project. Capture only the terminal content and inspect every frame before sharing.

## Verification

- Node.js 22.23.4 and pnpm 11.6.0 used for final validation.
- `pnpm install --frozen-lockfile --offline` succeeded with the existing local dependency cache.
- `pnpm build` succeeded; `pnpm release:build` bundled the CLI and both brokers and passed its isolated
  offline clean-install smoke test. SHA-256 verification passed from the archive directory.
- `doctor`, `scan`, credential-free `setup --skip-gemini`, and `codex prompt` executed successfully.
  Setup generated policy, five default specialist files, Codex configuration, agent guidance, and a
  task prompt in the disposable project.
- `pnpm check` passed: formatting, lint, typecheck, 193 passing tests (one skipped), and all 13
  workspace builds. Turbo reused cached build/lint/typecheck results where valid.
- All 62 relative file links and heading anchors in the README, documentation index, and this audit
  resolved. `git diff --check` passed. FFmpeg decoded the entire GIF without errors; captured frames
  were inspected for readability and sensitive content.
- Independent review checked claims, archive instructions, completion, onboarding, and the GIF.
  Its actionable handoff clarification was incorporated; no substantive blocker remained.

Hosted-provider execution, authenticated Codex/Ollama development, Git publication, and global shell
startup modifications were not exercised for this documentation task. No release was published,
no global package was installed, and no application dependencies were added.
