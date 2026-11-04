# RepoPilot

**Turn a scoped task into reviewed, verified changes—with an audit trail.**

RepoPilot is published on npm as **`repilot`**. It provides evidence-backed repository analysis,
Codex specialist setup, policy-gated development in isolated Git worktrees, checks, independent
review, and recoverable run history. This is a developer preview.

## Install

Requires **Node.js 22–25 and Git** on **macOS or Linux**. Node 22 is the validated development version.
Windows installation is currently unsupported.

```bash
npm install -g repilot
repopilot --license
```

RepoPilot is proprietary software with publicly visible source. Read the EULA before use. Only if
you agree to **EULA v1.0**, explicitly accept it in your shell:

```bash
export REPOPILOT_ACCEPT_EULA=1
repopilot version
repopilot doctor
```

`repilot` and `repopilot` are aliases for the same CLI. For example, `repilot --license` displays the
same agreement. Without acceptance, only the license-display command is available in this package.
Installation without acceptance skips optional shell setup.

## Start with a repository

Replace `/path/to/project` with an existing local repository:

```bash
repopilot scan --repo /path/to/project
repopilot setup --repo /path/to/project
repopilot codex prompt "Add a search filter" --repo /path/to/project
```

`scan` records facts and evidence without executing project scripts. `setup` proposes policy and
specialist guidance while preserving existing files. Review the proposed setup for your repository.
Model credentials are unnecessary for scanning and prompt preparation.

## Supervised development

Configure Codex or loopback Ollama using the
[provider guide](https://github.com/steveleecode/RepoPilot/blob/codex/proprietary-eula/docs/product/CLI_REFERENCE.md#providers).
Then start a scoped task:

```bash
repopilot run "Improve parser coverage" --develop --provider codex --repo /path/to/project
```

The supervised runner plans, proposes changes, applies them in an isolated worktree when authorized,
runs authorized checks, and performs independent review. Repository execution policy and approval
gates still apply; the command can pause when authorization is required. Inspect results and use the
[CLI reference](https://github.com/steveleecode/RepoPilot/blob/codex/proprietary-eula/docs/product/CLI_REFERENCE.md)
for inspection, approval, and resume options. Commit and push delivery are opt-in.

Use executable checks only with repositories you trust. Passing checks and source review do not
guarantee correctness or production readiness. Review model-generated changes before use.

## Completion

For zsh menus, after accepting the EULA:

```bash
repopilot completion install zsh
```

This edits your zsh startup file with a managed completion block. Global installs made with acceptance
may offer automatic setup; set `REPOPILOT_SKIP_COMPLETION_SETUP=1` to opt out. See the
[completion guide](https://github.com/steveleecode/RepoPilot/blob/codex/proprietary-eula/docs/product/CLI_REFERENCE.md#zsh-command-menus-and-completion)
for removal instructions.

## Upgrade or uninstall

```bash
npm install -g repilot@latest
npm uninstall -g repilot
```

Uninstallation removes both commands. Project policy and run journals remain in their repositories;
remove any configured shell completion block separately if desired.

## Package contents and license

The package contains the bundled CLI, source-context and review brokers, optional completion
installer, this README, **`eula.txt`**, and **`THIRD_PARTY_NOTICES.txt`**. The source repository also
contains development packages and a dashboard preview; this npm release installs the standalone CLI.

Copyright © 2026 Stephen Lee. All rights reserved. Personal and internal business use are permitted
under the EULA. Redistribution, reuse in other products, and hosted services require separate
permission. GitHub platform rights and third-party licenses remain unaffected. Public source
availability does not make RepoPilot open source. Licensing: **stlee208@gmail.com**.

[Source](https://github.com/steveleecode/RepoPilot/tree/codex/proprietary-eula) ·
[Documentation](https://github.com/steveleecode/RepoPilot/blob/codex/proprietary-eula/docs/README.md) ·
[Report an issue](https://github.com/steveleecode/RepoPilot/issues) ·
[EULA](https://github.com/steveleecode/RepoPilot/blob/codex/proprietary-eula/docs/legal/EULA.txt)
