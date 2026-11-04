import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  LocalCommandExecutor,
  type CommandDefinition,
  type CommandExecutionResult
} from "@repopilot/executor";
import {
  authorizeGitAction,
  loadRepositoryConfig,
  resolvePolicy,
  type ExecutionPolicy
} from "@repopilot/policy";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";
import {
  artifactOf,
  developmentFingerprint,
  redactDiagnostics,
  validationCommands
} from "./development.js";
import { assertDevelopmentCommit, type DevelopmentCommit } from "./git-lifecycle.js";
import { withTaskLock } from "./task-runner.js";

const resultSchema = z.strictObject({
  version: z.literal(1),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  branch: z.string().regex(/^codex\/repopilot-[a-zA-Z0-9-]+$/u),
  remote: z.string(),
  destinationHash: z.string().regex(/^[a-f0-9]{64}$/u)
});
export type DevelopmentPush = z.infer<typeof resultSchema>;
const checkSchema = z.array(z.object({ commandId: z.string(), status: z.string() }));

function git(
  root: string,
  args: string[],
  extra: Record<string, string> = {},
  timeout = 10_000
): string {
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd: root,
      shell: false,
      encoding: "utf8",
      timeout,
      maxBuffer: 100_000,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        ...extra
      }
    }
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "Git push transport failed. Inspect the push intent and remote branch before retrying."
    );
  return result.stdout.trim();
}

function configValues(root: string, key: string): string[] {
  const result = spawnSync("git", ["config", "--null", "--get-all", key], {
    cwd: root,
    shell: false,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_384,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new Error("Unable to read the configured push destination.");
  return result.stdout.split("\0").filter(Boolean);
}

function destination(root: string, remote: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u.test(remote))
    throw new Error("Push remote must be a simple configured remote name.");
  const pushUrls = configValues(root, `remote.${remote}.pushurl`);
  const urls = configValues(root, `remote.${remote}.url`);
  if (urls.length !== 1) throw new Error("Push requires exactly one configured destination URL.");
  if (pushUrls.length && (pushUrls.length !== 1 || pushUrls[0] !== urls[0]))
    throw new Error(
      "Separate or multiple push URLs are unsupported; configure one matching remote URL."
    );
  const value = urls[0]!;
  if (
    !value ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    value.startsWith("-")
  )
    throw new Error("Unsafe push destination.");
  if (path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../"))
    return path.resolve(root, value);
  if (/\s/u.test(value)) throw new Error("Unsafe push destination.");
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    const url = new URL(value);
    if (
      url.password ||
      (url.protocol === "https:" && url.username) ||
      url.search ||
      url.hash ||
      !url.hostname ||
      url.hostname.startsWith("-") ||
      (url.username && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(url.username))
    )
      throw new Error("Push URLs must not contain credentials, query parameters or fragments.");
    return url.href;
  }
  if (
    /^(?:[a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[^\s:][^\s]*$/u.test(value) &&
    !value.includes("://")
  )
    return value;
  throw new Error(
    "Push supports HTTPS, SSH, or an explicit local filesystem path; custom remote helpers are unsupported."
  );
}

function passedChecks(
  run: RunSnapshot,
  commit: DevelopmentCommit,
  fingerprint: string
): Set<string> {
  const checks = new Set<string>();
  const applied = artifactOf(run, "change-applied");
  const validation = artifactOf(run, "development-validation");
  if (
    validation?.metadata?.passed === true &&
    validation.metadata.fingerprint === applied?.metadata?.fingerprint &&
    validation.metadata.proposalArtifactId === applied?.metadata?.proposalArtifactId
  ) {
    for (const check of checkSchema.parse(validation.metadata.checks))
      if (check.status === "completed") checks.add(check.commandId);
  }
  const pushValidation = artifactOf(run, "push-validation");
  if (
    pushValidation?.metadata?.commit === commit.commit &&
    pushValidation.metadata.fingerprint === fingerprint
  ) {
    // A newer failure supersedes any previous pre-push result for the same check.
    for (const check of checkSchema.parse(pushValidation.metadata.checks)) {
      if (pushValidation.metadata.passed === true && check.status === "completed")
        checks.add(check.commandId);
      else checks.delete(check.commandId);
    }
  }
  return checks;
}

async function validateForPush(
  input: { store: WorkflowStore; runId: string; executeChecks?: boolean },
  commit: DevelopmentCommit,
  policy: ExecutionPolicy
): Promise<void> {
  const run = await input.store.loadRun(input.runId);
  const fingerprint = await developmentFingerprint(commit.worktree);
  const passed = passedChecks(run, commit, fingerprint);
  const missing = policy.validation.before_push.filter((id) => !passed.has(id));
  if (!missing.length) return;
  if (!input.executeChecks)
    throw new Error(
      `Push requires additional checks (${missing.join(", ")}). Inspect the committed worktree and retry with --execute-checks.`
    );
  if (!(await lstat(path.join(commit.worktree, "node_modules")).catch(() => undefined)))
    throw new Error(
      "Push validation worktree has no node_modules. Install dependencies there manually before retrying with --execute-checks."
    );
  const approval = await input.store.requestApproval(
    input.runId,
    `execute-push-validation:${commit.commit}`
  );
  await input.store.decideApproval(
    input.runId,
    approval.id,
    true,
    "Explicit --execute-checks for this invocation."
  );
  const executor = new LocalCommandExecutor({
    repositoryRoot: commit.worktree,
    commands: missing
      .map((id) => validationCommands[id])
      .filter((item): item is CommandDefinition => !!item),
    environment: { PATH: process.env.PATH ?? "", CI: "true" },
    allowedEnvironmentVariables: ["PATH", "CI"],
    defaultTimeoutMs: 180_000,
    defaultMaxOutputBytes: 16_384
  });
  const results: CommandExecutionResult[] = [];
  for (const commandId of missing) {
    const result = await executor.execute({ commandId });
    results.push(result);
    if (result.status !== "completed" && policy.validation.stop_on_failure) break;
  }
  const unchanged = (await developmentFingerprint(commit.worktree)) === fingerprint;
  await input.store.recordArtifact(input.runId, {
    kind: "report",
    summary: "Committed worktree pre-push validation.",
    metadata: {
      type: "push-validation",
      commit: commit.commit,
      fingerprint,
      passed:
        unchanged &&
        results.length === missing.length &&
        results.every((item) => item.status === "completed"),
      checks: [
        ...[...passed]
          .filter((id) => !new Set<string>(missing).has(id))
          .map((commandId) => ({ commandId, status: "completed" })),
        ...results.map(({ commandId, status, exitCode, stdout, stderr }) => ({
          commandId,
          status,
          exitCode,
          stdout: redactDiagnostics(stdout),
          stderr: redactDiagnostics(stderr)
        }))
      ]
    }
  });
  if (!unchanged)
    throw new Error(
      "Push checks changed the committed worktree. Review and validate a new development task before publishing."
    );
  if (results.length !== missing.length || results.some((item) => item.status !== "completed"))
    throw new Error("Pre-push validation failed; no push was attempted.");
}

/** Push one immutable reviewed commit to one allowed branch, without loading target transport config. */
export async function pushDevelopmentTask(input: {
  store: WorkflowStore;
  runId: string;
  approval?: boolean;
  executeChecks?: boolean;
}): Promise<DevelopmentPush> {
  return withTaskLock(input.store, input.runId, async () => {
    let run = await input.store.loadRun(input.runId);
    const commit = await assertDevelopmentCommit(run);
    if (!commit)
      throw new Error(
        "Push requires a completed reviewed local commit. Run repopilot commit first."
      );
    const root = await realpath(run.repositoryRoot);
    const load = async () =>
      resolvePolicy({ repositoryConfig: await loadRepositoryConfig(root) }).execution;
    let policy = await load();
    const authorize = async (url: string, remote: string) => {
      policy = await load();
      if (policy.pushes.strategy !== "after_feature")
        throw new Error("Explicit push requires the after_feature push strategy.");
      if (policy.pushes.remote !== remote || destination(root, remote) !== url)
        throw new Error("Push destination changed; inspect policy and remote configuration.");
      const snapshot = await input.store.loadRun(input.runId);
      await assertDevelopmentCommit(snapshot);
      const checks = passedChecks(snapshot, commit, await developmentFingerprint(commit.worktree));
      const authorization = authorizeGitAction(policy, {
        action: "push",
        branch: commit.branch,
        remote,
        validation: {
          status: "passed",
          checks: policy.validation.before_push.filter((id) => checks.has(id)),
          summary: "Fresh checks for recorded reviewed commit."
        },
        ...(input.approval ? { approval: { approved: true, approver: "CLI user" } } : {})
      });
      if (!authorization.allowed) throw new Error(authorization.reasons.join(" "));
    };
    // Fail permission checks before executing target tooling or contacting a remote.
    const preliminary = authorizeGitAction(policy, {
      action: "push",
      branch: commit.branch,
      remote: policy.pushes.remote,
      validation: {
        status: "passed",
        checks: policy.validation.before_push,
        summary: "Validation follows permission checks."
      },
      ...(input.approval ? { approval: { approved: true, approver: "CLI user" } } : {})
    });
    if (!preliminary.allowed) throw new Error(preliminary.reasons.join(" "));
    if (policy.pushes.strategy !== "after_feature")
      throw new Error("Explicit push requires the after_feature push strategy.");
    const remote = policy.pushes.remote;
    const url = destination(root, remote);
    const result: DevelopmentPush = {
      version: 1,
      commit: commit.commit,
      branch: commit.branch,
      remote,
      destinationHash: createHash("sha256").update(url).digest("hex")
    };
    const prior = artifactOf(run, "development-push");
    const intent = artifactOf(run, "development-push-intent");
    if (
      prior &&
      JSON.stringify(resultSchema.parse(prior.metadata?.result)) !== JSON.stringify(result)
    )
      throw new Error("Recorded push destination changed; inspect before continuing.");
    if (
      intent &&
      JSON.stringify(resultSchema.parse(intent.metadata?.result)) !== JSON.stringify(result)
    )
      throw new Error("Pending push destination changed; inspect before continuing.");
    await validateForPush(input, commit, policy);
    await authorize(url, remote);
    const directory = await mkdtemp(path.join(tmpdir(), "repopilot-push-"));
    try {
      const format = git(commit.worktree, ["rev-parse", "--show-object-format"]);
      if (format !== "sha1" && format !== "sha256")
        throw new Error("Unsupported Git object format.");
      git(directory, ["init", "--bare", "--template=", `--object-format=${format}`, directory]);
      const objects = git(commit.worktree, ["rev-parse", "--git-path", "objects"]);
      const objectDirectory = await realpath(path.resolve(commit.worktree, objects));
      const transportEnv = {
        GIT_OBJECT_DIRECTORY: objectDirectory,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/usr/bin/false",
        SSH_ASKPASS: "/usr/bin/false",
        GIT_SSH_COMMAND: "/usr/bin/ssh -F /dev/null -oBatchMode=yes",
        GIT_SSH_VARIANT: "ssh",
        ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {})
      };
      const transport = (args: string[]) =>
        git(
          directory,
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.https.allow=always",
            "-c",
            "protocol.ssh.allow=always",
            "-c",
            "protocol.file.allow=always",
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
            ...args
          ],
          transportEnv,
          30_000
        );
      const ref = `refs/heads/${commit.branch}`;
      const localUploader = path.isAbsolute(url)
        ? [
            "--upload-pack=git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.alternateRefsCommand= -c uploadpack.packObjectsHook= upload-pack"
          ]
        : [];
      const observed = () => {
        const value = transport(["ls-remote", "--refs", ...localUploader, "--", url, ref]);
        if (!value) return null;
        const parts = value.split(/\s/u);
        if (parts.length !== 2 || parts[1] !== ref || !/^[a-f0-9]{40,64}$/u.test(parts[0]!))
          throw new Error("Unexpected remote branch observation.");
        return parts[0]!;
      };
      await authorize(url, remote);
      const before = observed();
      if (before === commit.commit) {
        if (!prior)
          await input.store.recordArtifact(input.runId, {
            kind: "report",
            summary: "Remote branch already contains the recorded commit; observed without replay.",
            metadata: { type: "development-push", result, recovered: Boolean(intent) }
          });
        return result;
      }
      if (prior || intent)
        throw new Error(
          "Push was interrupted or the remote branch changed. Inspect the push intent and remote branch; automatic replay is disabled."
        );
      if (input.approval) {
        const approval = await input.store.requestApproval(
          input.runId,
          `push:${commit.commit}:${remote}:${result.destinationHash}`
        );
        await input.store.decideApproval(
          input.runId,
          approval.id,
          true,
          "Explicit --approve for this invocation and destination."
        );
      }
      await input.store.recordArtifact(input.runId, {
        kind: "report",
        summary: "Push authorized; remote mutation pending.",
        metadata: { type: "development-push-intent", result, previousRemoteCommit: before }
      });
      await authorize(url, remote);
      // Explicit immutable source + destination; fresh config means no mirror/refspec/tag/helper expansion.
      const localReceiver = path.isAbsolute(url)
        ? [
            "--receive-pack=git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.alternateRefsCommand= -c receive.autogc=false -c gc.auto=0 -c maintenance.auto=false receive-pack"
          ]
        : [];
      transport([
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--recurse-submodules=no",
        ...localReceiver,
        "--",
        url,
        `${commit.commit}:${ref}`
      ]);
      if (observed() !== commit.commit)
        throw new Error(
          "Push result could not be confirmed. Inspect the durable push intent and remote branch."
        );
      run = await input.store.loadRun(input.runId);
      await assertDevelopmentCommit(run);
      await input.store.recordArtifact(input.runId, {
        kind: "report",
        summary: `Pushed reviewed commit to ${remote}/${commit.branch}.`,
        metadata: { type: "development-push", result }
      });
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
