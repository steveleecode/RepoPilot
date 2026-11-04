import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { authorizeGitAction, loadRepositoryConfig, resolvePolicy } from "@repopilot/policy";
import { independentReviewSchema } from "@repopilot/provider/review";
import { WorkflowStore, type RunSnapshot } from "@repopilot/workflow";
import {
  artifactOf,
  assertAppliedState,
  developmentFingerprint,
  appliedChangeSet
} from "./development.js";
import { getTaskCompletionReport, withTaskLock } from "./task-runner.js";

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/u);
const commitResultSchema = z.strictObject({
  version: z.literal(1),
  commit: objectId,
  tree: objectId,
  baseCommit: objectId,
  branch: z.string().regex(/^codex\/repopilot-[a-zA-Z0-9-]+$/u),
  worktree: z.string(),
  message: z.string()
});
export type DevelopmentCommit = z.infer<typeof commitResultSchema>;

function git(
  root: string,
  args: string[],
  options: {
    input?: string;
    index?: string;
    identity?: { name: string; email: string };
    allowFailure?: boolean;
  } = {}
): string {
  const identity = options.identity;
  const result = spawnSync(
    "git",
    [
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.quotePath=false",
      ...args
    ],
    {
      cwd: root,
      shell: false,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
      input: options.input,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
        ...(identity
          ? {
              GIT_AUTHOR_NAME: identity.name,
              GIT_AUTHOR_EMAIL: identity.email,
              GIT_COMMITTER_NAME: identity.name,
              GIT_COMMITTER_EMAIL: identity.email
            }
          : {})
      }
    }
  );
  if (result.error || result.status !== 0) {
    if (options.allowFailure && !result.error) return "";
    throw new Error("Git lifecycle operation failed; inspect the preserved worktree.");
  }
  return result.stdout.trimEnd();
}

function assertNoFilters(root: string): void {
  // Match freshness and commit helpers: ignore ambient config, but inspect repository includes
  // and config.worktree so target-controlled filters cannot run.
  const result = spawnSync("git", ["config", "--includes", "--get-regexp", "^filter\\."], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null"
    },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 100_000
  });
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stdout)
    throw new Error("Configured Git filters are unsupported for safe local commits.");
}

/** Recheck a recorded commit without performing any Git mutations. */
export async function assertDevelopmentCommit(
  run: RunSnapshot
): Promise<DevelopmentCommit | undefined> {
  const prior = artifactOf(run, "development-commit");
  if (!prior) return undefined;
  const result = commitResultSchema.parse(prior.metadata?.result);
  const root = await realpath(run.repositoryRoot);
  assertNoFilters(root);
  assertNoFilters(result.worktree);
  if (
    git(result.worktree, ["rev-parse", "HEAD"]) !== result.commit ||
    git(root, ["rev-parse", `refs/heads/${result.branch}`]) !== result.commit ||
    git(result.worktree, ["symbolic-ref", "--short", "HEAD"]) !== result.branch ||
    git(result.worktree, ["status", "--porcelain", "--untracked-files=all"]) !== "" ||
    (await developmentFingerprint(result.worktree)) !== prior.metadata?.fingerprint
  )
    throw new Error("Recorded commit or worktree changed; inspect before continuing.");
  return result;
}

/** Explicit local commit only. Never executes hooks, filters, signers, or repository scripts. */
export async function commitDevelopmentTask(input: {
  store: WorkflowStore;
  runId: string;
  message: string;
  approval?: boolean;
}): Promise<DevelopmentCommit> {
  if (!input.message.trim() || input.message.length > 500 || /[\r\n\0]/u.test(input.message))
    throw new Error("Provide a single-line commit message of at most 500 characters.");
  return withTaskLock(input.store, input.runId, async () => {
    const run = await input.store.loadRun(input.runId);
    const root = await realpath(run.repositoryRoot);
    assertNoFilters(root);
    const prior = await assertDevelopmentCommit(run);
    if (prior) {
      if (prior.message !== input.message)
        throw new Error("Recorded commit or worktree changed; inspect before continuing.");
      return prior;
    }
    if (artifactOf(run, "development-commit-intent"))
      throw new Error(
        "Commit was interrupted. Inspect its durable intent and preserved worktree; automatic replay is disabled."
      );
    const report = getTaskCompletionReport(run);
    if (report?.status !== "review_ready")
      throw new Error("Commit requires a review_ready development report.");
    const recordedWorktree = z
      .string()
      .parse(artifactOf(run, "change-applied")?.metadata?.worktree);
    assertNoFilters(recordedWorktree);
    const worktree = await assertAppliedState(run);
    if (worktree === root) throw new Error("Commit requires a dedicated worktree.");
    const applied = artifactOf(run, "change-applied")!;
    const proposal = artifactOf(run, "change-proposal")!;
    const validation = artifactOf(run, "development-validation");
    const review = artifactOf(run, "independent-review");
    if (
      validation?.metadata?.passed !== true ||
      validation.metadata.proposalArtifactId !== proposal.id ||
      validation.metadata.fingerprint !== applied.metadata?.fingerprint ||
      review?.metadata?.proposalArtifactId !== proposal.id ||
      review.metadata.fingerprint !== applied.metadata?.fingerprint ||
      report.proposalArtifactId !== proposal.id
    )
      throw new Error(
        "Commit requires fresh validation and independent review for the applied proposal."
      );
    if (JSON.stringify(review.metadata.changes) !== JSON.stringify(appliedChangeSet(worktree)))
      throw new Error(
        "Independent review must cover every final changed path. Resume development to review again."
      );
    const judgment = independentReviewSchema.parse(review.metadata.review);
    if (
      judgment.findings.some((finding) => finding.severity !== "low") ||
      judgment.criteria.some((criterion) => criterion.status !== "supported") ||
      report.acceptanceCriteria.length !== judgment.criteria.length ||
      report.acceptanceCriteria.some(
        (criterion) =>
          criterion.judgment !== "supported" ||
          !judgment.criteria.some((item) => item.id === criterion.id)
      )
    )
      throw new Error("Independent review does not support every acceptance criterion.");
    const checks = z
      .array(z.object({ commandId: z.string(), status: z.string() }))
      .parse(validation.metadata.checks);
    const authorize = async () => {
      assertNoFilters(root);
      assertNoFilters(worktree);
      const policy = resolvePolicy({
        repositoryConfig: await loadRepositoryConfig(root)
      }).execution;
      if (policy.commits.strategy !== "after_feature")
        throw new Error("Explicit commits require the after_feature commit strategy.");
      if (!["conventional", "imperative"].includes(policy.commits.message_format))
        throw new Error(
          "Commit message format requires an unsupported inference or template adapter."
        );
      if (policy.commits.sign_commits)
        throw new Error("Signed commits require a trusted signer adapter and are not supported.");
      if (
        policy.commits.message_format === "conventional" &&
        !/^[a-z]+(?:\([^()\r\n]+\))?!?: .+/u.test(input.message)
      )
        throw new Error("Policy requires a conventional commit message.");
      if (
        !["diff-check", ...policy.validation.before_commit].every((id) =>
          checks.some((check) => check.commandId === id && check.status === "completed")
        )
      )
        throw new Error("Recorded validation does not satisfy current commit policy.");
      const authorization = authorizeGitAction(policy, {
        action: "commit",
        validation: {
          status: "passed",
          checks: policy.validation.before_commit,
          summary: "Fresh recorded checks."
        },
        ...(input.approval ? { approval: { approved: true, approver: "CLI user" } } : {})
      });
      if (!authorization.allowed) throw new Error(authorization.reasons.join(" "));
    };
    await authorize();
    if (git(worktree, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true }))
      throw new Error("Expected the original detached development worktree; inspect its branch.");
    if (git(worktree, ["diff", "--cached", "--name-only"]) !== "")
      throw new Error("Unexpected staged changes; inspect the worktree.");
    const baseCommit = objectId.parse(applied.metadata?.baseCommit);
    const branch = `codex/repopilot-${run.id}`;
    const ref = `refs/heads/${branch}`;
    git(root, ["check-ref-format", ref]);
    if (git(root, ["rev-parse", "--verify", ref], { allowFailure: true }))
      throw new Error("Commit branch already exists; refusing to overwrite it.");
    const identity = {
      name: git(root, ["config", "--get", "user.name"], { allowFailure: true }),
      email: git(root, ["config", "--get", "user.email"], { allowFailure: true })
    };
    if (!identity.name || !identity.email || /[\r\n<>\0]/u.test(identity.name + identity.email))
      throw new Error(
        "Configure a valid repository-local Git user.name and user.email before committing."
      );
    const directory = await mkdtemp(path.join(tmpdir(), "repopilot-commit-index-"));
    try {
      const index = path.join(directory, "index");
      git(worktree, ["read-tree", baseCommit], { index });
      const files = [
        ...new Set(
          (
            git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD"]) +
            "\0" +
            git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
          )
            .split("\0")
            .filter(Boolean)
        )
      ];
      if (!files.length) throw new Error("No changes to commit.");
      // All current changes must have appeared in an applied, validated proposal.
      const allowed = new Set(
        run.artifacts
          .filter((item) => item.metadata?.type === "change-applied")
          .flatMap((item) =>
            z
              .array(z.object({ path: z.string() }))
              .parse(item.metadata?.changes)
              .map((change) => change.path)
          )
      );
      for (const file of files) {
        if (
          !allowed.has(file) ||
          path.isAbsolute(file) ||
          file.split("/").some((part) => part === ".." || part === ".git")
        )
          throw new Error("Commit contains an unproposed path.");
        const target = path.join(worktree, file);
        const stat = await lstat(target).catch(() => undefined);
        if (!stat) git(worktree, ["update-index", "--force-remove", "--", file], { index });
        else {
          if (!stat.isFile() || !(await realpath(target)).startsWith(`${worktree}${path.sep}`))
            throw new Error("Commit target is not a contained regular file.");
          const blob = objectId.parse(
            git(worktree, ["hash-object", "-w", "--no-filters", "--", file])
          );
          git(
            worktree,
            [
              "update-index",
              "--add",
              "--cacheinfo",
              stat.mode & 0o111 ? "100755" : "100644",
              blob,
              file
            ],
            { index }
          );
        }
      }
      const tree = objectId.parse(git(worktree, ["write-tree"], { index }));
      if (tree === git(worktree, ["rev-parse", `${baseCommit}^{tree}`]))
        throw new Error("No changes to commit.");
      await assertAppliedState(await input.store.loadRun(run.id));
      await authorize();
      if (input.approval) {
        const approval = await input.store.requestApproval(run.id, `commit:${proposal.id}`);
        await input.store.decideApproval(
          run.id,
          approval.id,
          true,
          "Explicit --approve for local commit."
        );
      }
      const commit = objectId.parse(
        git(worktree, ["commit-tree", tree, "-p", baseCommit], {
          input: `${input.message}\n`,
          identity
        })
      );
      const result = commitResultSchema.parse({
        version: 1,
        commit,
        tree,
        baseCommit,
        branch,
        worktree,
        message: input.message
      });
      await input.store.recordArtifact(run.id, {
        kind: "report",
        summary: "Local commit prepared; ref update pending.",
        metadata: { type: "development-commit-intent", result }
      });
      await assertAppliedState(await input.store.loadRun(run.id));
      await authorize();
      git(root, ["update-ref", ref, commit, "0".repeat(baseCommit.length)]);
      await authorize();
      git(worktree, ["symbolic-ref", "HEAD", ref]);
      await authorize();
      git(worktree, ["read-tree", commit]);
      if (git(worktree, ["status", "--porcelain", "--untracked-files=all"]) !== "")
        throw new Error("Worktree changed during commit; inspect the durable commit intent.");
      await input.store.recordArtifact(run.id, {
        kind: "report",
        summary: `Committed reviewed changes on ${branch}.`,
        metadata: {
          type: "development-commit",
          result,
          fingerprint: await developmentFingerprint(worktree)
        }
      });
      return result;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
