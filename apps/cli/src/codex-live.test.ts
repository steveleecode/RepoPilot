import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, writeRepositoryConfig } from "@repopilot/policy";
import { expect, it } from "vitest";
import { runCli } from "./index.js";

it.skipIf(process.env.REPOPILOT_LIVE_CODEX !== "1")(
  "runs the complete Codex plan, proposal, apply, and verify flow",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "repopilot-live-codex-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/greeting.txt"), "hello\n");
    for (const args of [
      ["init"],
      ["add", "."],
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]
    ]) {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    const config = defaultConfig("balanced");
    config.execution.validation.before_commit = [];
    await writeRepositoryConfig(root, config);
    const run = await command(
      root,
      "run",
      "Change src/greeting.txt from hello to goodbye. Do not change any other file.",
      "--provider",
      "codex"
    );
    const runId = (run.run as { id: string }).id;
    const proposed = await command(root, "propose", runId);
    expect((proposed.result as { changes: unknown[] }).changes.length).toBeGreaterThan(0);
    const applied = await command(root, "apply", runId, "--approve");
    const worktree = (applied.result as { worktree: string }).worktree;
    expect(await readFile(path.join(root, "src/greeting.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(path.join(worktree, "src/greeting.txt"), "utf8")).toContain("goodbye");
    const verified = await command(root, "verify", runId, "--execute-checks");
    expect((verified.result as { passed: boolean }).passed).toBe(true);
  },
  240_000
);

async function command(root: string, ...args: string[]): Promise<Record<string, unknown>> {
  const executable = process.env.REPOPILOT_RELEASE_CLI;
  const argv = ["node", "repopilot", ...args, "--repo", root, "--json"];
  const result = executable
    ? (() => {
        const processResult = spawnSync(process.execPath, [executable, ...argv.slice(2)], {
          cwd: root,
          encoding: "utf8",
          timeout: 200_000
        });
        return {
          exitCode: processResult.status,
          output: processResult.stdout || processResult.stderr
        };
      })()
    : await runCli(argv, root);
  if (result.exitCode !== 0) throw new Error(result.output);
  return JSON.parse(result.output) as Record<string, unknown>;
}
