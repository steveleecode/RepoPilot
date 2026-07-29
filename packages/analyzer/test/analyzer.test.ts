import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeRepository } from "../src/index.js";

describe("analyzeRepository", () => {
  it("detects whether a directory is a Git repository with evidence", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".git"));

    const analysis = await analyzeRepository(root);

    expect(analysis.metadata.isGitRepository.value).toBe(true);
    expect(analysis.metadata.isGitRepository.evidence).toHaveLength(1);
  });

  it("detects manifests, lockfiles, workflows, AGENTS.md, and attaches evidence", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    await writeFile(path.join(root, "AGENTS.md"), "# Guidance");
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: CI");

    const analysis = await analyzeRepository(root);

    expect(analysis.manifests).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "package.json" })])
    );
    expect(analysis.packageManagers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pnpm" })])
    );
    expect(analysis.ciWorkflows).toHaveLength(1);
    expect(analysis.agentInstructions).toHaveLength(1);
    for (const fact of [
      ...analysis.manifests,
      ...analysis.packageManagers,
      ...analysis.ciWorkflows,
      ...analysis.agentInstructions
    ]) {
      expect(fact.evidence.length).toBeGreaterThan(0);
    }
  });
});

async function fixture(): Promise<string> {
  return mkdir(path.join(tmpdir(), `repopilot-analyzer-${crypto.randomUUID()}`), {
    recursive: true
  });
}
