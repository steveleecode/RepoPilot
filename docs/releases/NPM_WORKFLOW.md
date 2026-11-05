# Publishing repilot with GitHub Actions

The [Publish repilot to npm workflow](../../.github/workflows/publish-npm.yml) packages the selected
Git commit as the standalone `repilot` CLI. It runs `pnpm check` and archive install/uninstall smoke
tests on Node 22 on Linux and macOS. Publishing downloads the exact validated Linux archive rather
than rebuilding it in the publishing job.

Pushes affecting release configuration build dry-run artifacts only. A real npm release requires a
manual `workflow_dispatch` with `publish=true`. The publishing job uses the GitHub environment
`npm`; configure environment reviewers or deployment branch restrictions if desired. This workflow
does not commit version changes, push Git branches, open pull requests, or merge changes.

## Configuration status

Configured November 4, 2026: the workflow is uploaded to `codex/proprietary-eula` and registered in
GitHub Actions. npm trusted publisher `6000f4db-2e0a-411b-92ea-30d83576cac7` binds `repilot` to
`steveleecode/RepoPilot`, `publish-npm.yml`, environment `npm`, with direct publishing allowed.
The [manual feature-branch dry run](https://github.com/steveleecode/RepoPilot/actions/runs/41894747201)
passed on Linux and macOS with version override `0.3.1`, including full checks, archive smoke tests,
and artifact upload. The publish job was skipped as requested. No new npm version was published
while setting up the action. Live OIDC publication remains to be exercised on the next authorized release.

## One-time setup

1. Upload `.github/workflows/publish-npm.yml` to `steveleecode/RepoPilot`. GitHub credentials must
   permit workflow changes; the previously used OAuth token lacked the `workflow` scope.
2. In the `repilot` package settings on npm, add a GitHub trusted publisher:

   | Field                | Value                |
   | -------------------- | -------------------- |
   | Organization or user | `steveleecode`       |
   | Repository           | `RepoPilot`          |
   | Workflow filename    | `publish-npm.yml`    |
   | Environment          | `npm`                |
   | Allowed action       | Direct `npm publish` |

   Use the filename alone, without `.github/workflows/`. No `NPM_TOKEN` secret is needed. The job
   receives `id-token: write`; build/test jobs do not. Direct publish must be explicitly allowed;
   stage-only permission cannot run this workflow's publish step.

3. To use GitHub's **Run workflow** button, the workflow must be on the default branch. Until it is
   merged under repository policy, the release-configuration push trigger can validate the feature
   branch, and GitHub CLI dispatch can be tried after the workflow has been registered by a run.
   Do not bypass the repository's Git or PR policy to make the button appear.

The equivalent npm CLI setup, using npm 11.15 or later, is:

```bash
npm trust github repilot --file publish-npm.yml --repo steveleecode/RepoPilot --env npm --allow-publish --yes
```

npm may require account-owner browser/2FA approval for this one-time trust change. Existing trust
configurations should be inspected rather than deleted automatically. The workflow pins a compatible
npm CLI for OIDC publishing and supplies no long-lived token.

## Build the current state without publishing

Run **Publish repilot to npm**, select the desired source branch, and leave `publish` unchecked.
Leave `version` blank to use the root/CLI version, or choose a specific new release version. Build
artifacts are retained for 14 days. Source changes not committed to that selected ref are not included.

For example, after the workflow is registered:

```bash
gh workflow run publish-npm.yml --repo steveleecode/RepoPilot \
  --ref codex/proprietary-eula -f version=0.3.1 -f tag=latest -f publish=false
```

## Publish

Choose a version not already present on npm. `0.3.0` is already published and cannot be overwritten.
For example:

```bash
gh workflow run publish-npm.yml --repo steveleecode/RepoPilot \
  --ref codex/proprietary-eula -f version=0.3.1 -f tag=latest -f publish=true
```

The workflow temporarily sets the root and CLI versions in its disposable checkout, then validates
and builds that version. It leaves the selected Git commit and your local files unchanged. This is a
versioned snapshot of the selected source state. To keep the source manifests aligned with a release,
update both in a separate reviewed change; the workflow does not grant itself Git write access.

Stable releases can use `latest`; prereleases such as `0.4.0-rc.1` must use `next`. Publishing is
serialized, checks archive identity/checksum and version availability, and refuses to overwrite any
existing npm version. Failed or ambiguous uploads must be inspected before retrying; do not blindly
rerun with another version just to bypass a failure.

After npm accepts the upload, the job waits for both the exact version and selected distribution tag
to be publicly readable and checks that their SHA-512 integrity matches the validated tarball. An
accepted-but-processing response is not reported as a verified deployment. Timeout or mismatch fails
the job with an inspection message. Provenance is requested for this public repository's release.

## References

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [GitHub workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
