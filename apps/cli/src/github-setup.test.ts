import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateGithubReinforcement } from "./github-setup.js";

async function fixture(): Promise<string> {
  const root = path.join(tmpdir(), `repopilot-github-${crypto.randomUUID()}`);
  await mkdir(root);
  expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
  return root;
}

describe("GitHub reinforcement", () => {
  it("generates mandatory CI from a GitHub remote and existing root checks", async () => {
    const root = await fixture();
    expect(
      spawnSync("git", ["remote", "add", "origin", "git@github.com:example/project.git"], {
        cwd: root
      }).status
    ).toBe(0);
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { check: "echo check" } })
    );

    const first = await generateGithubReinforcement(root);
    expect(first.detected).toBe(true);
    expect(first.evidence).toEqual(
      expect.arrayContaining([expect.stringContaining("package.json scripts: check")])
    );
    expect(first.created).toEqual([".github/workflows/repopilot-ci.yml"]);
    const workflow = await readFile(path.join(root, first.created[0]!), "utf8");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
    expect(workflow).toContain("pnpm run check");
    expect(workflow).not.toContain("--if-present");

    const second = await generateGithubReinforcement(root);
    expect(second.skipped).toEqual(first.created);
  });

  it("does not generate CI for a non-GitHub remote", async () => {
    const root = await fixture();
    expect(
      spawnSync("git", ["remote", "add", "origin", "https://gitlab.com/example/project.git"], {
        cwd: root
      }).status
    ).toBe(0);
    const result = await generateGithubReinforcement(root);
    expect(result.detected).toBe(false);
    expect(result.created).toEqual([]);
  });
});
