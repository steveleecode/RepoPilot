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

  it("detects nested manifests, scripts, workspaces, tools, workflows, and instructions", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        workspaces: ["apps/*"],
        scripts: { check: "pnpm lint && pnpm test" },
        devDependencies: {
          eslint: "1.0.0",
          prettier: "1.0.0",
          typescript: "1.0.0",
          vitest: "1.0.0"
        }
      })
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Guidance");
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    await writeFile(path.join(root, "eslint.config.mjs"), "export default []");
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: CI");
    await mkdir(path.join(root, "apps", "api"), { recursive: true });
    await writeFile(
      path.join(root, "apps", "api", "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } })
    );
    await writeFile(path.join(root, "apps", "api", "AGENTS.md"), "# API guidance");
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "ignored", "package.json"), "{}");

    const analysis = await analyzeRepository(root);

    expect(analysis.manifests).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "package.json" })])
    );
    expect(analysis.packageManagers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "pnpm" })])
    );
    expect(analysis.manifests.map((manifest) => manifest.path)).toEqual([
      "apps/api/package.json",
      "package.json"
    ]);
    expect(analysis.scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "check", packagePath: "package.json" }),
        expect.objectContaining({ name: "test", packagePath: "apps/api/package.json" })
      ])
    );
    expect(analysis.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "pnpm", packagePatterns: ["apps/*"] })
      ])
    );
    expect(analysis.languages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "TypeScript" })])
    );
    expect(analysis.testFrameworks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "vitest" })])
    );
    expect(analysis.formattingTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "prettier" })])
    );
    expect(analysis.lintingTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "eslint" })])
    );
    expect(analysis.typeCheckingTools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "typescript" })])
    );
    expect(analysis.ciWorkflows).toHaveLength(1);
    expect(analysis.agentInstructions).toHaveLength(2);
    expect(analysis.metadata.scanTruncated.value).toBe(false);
    for (const fact of [
      ...analysis.languages,
      ...analysis.manifests,
      ...analysis.packageManagers,
      ...analysis.workspaces,
      ...analysis.scripts,
      ...analysis.testFrameworks,
      ...analysis.formattingTools,
      ...analysis.lintingTools,
      ...analysis.typeCheckingTools,
      ...analysis.ciWorkflows,
      ...analysis.agentInstructions
    ]) {
      expect(fact.evidence.length).toBeGreaterThan(0);
    }
    for (const fact of [
      analysis.metadata.isGitRepository,
      analysis.metadata.currentBranch,
      analysis.metadata.isDirty,
      analysis.metadata.topLevelFiles,
      analysis.metadata.topLevelDirectories,
      analysis.metadata.scannedFileCount,
      analysis.metadata.scanTruncated
    ]) {
      expect(fact.evidence.length).toBeGreaterThan(0);
    }
  });

  it("reports malformed manifests and traversal limits as evidence-backed warnings", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "package.json"), "{not-json");
    await writeFile(path.join(root, "one.txt"), "one");
    await writeFile(path.join(root, "two.txt"), "two");

    const analysis = await analyzeRepository(root, { maxEntries: 1 });

    expect(analysis.metadata.scanTruncated.value).toBe(true);
    expect(analysis.warnings.some((warning) => warning.message.includes("scan stopped"))).toBe(
      true
    );
    for (const warning of analysis.warnings) {
      expect(warning.evidence?.length).toBeGreaterThan(0);
    }
  });

  it("warns instead of throwing when a discovered package manifest is invalid", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "package.json"), "{not-json");

    const analysis = await analyzeRepository(root);

    expect(analysis.manifests).toHaveLength(1);
    expect(analysis.scripts).toEqual([]);
    expect(
      analysis.warnings.some((warning) => warning.message.includes("Could not parse package.json"))
    ).toBe(true);
  });
});

async function fixture(): Promise<string> {
  return mkdir(path.join(tmpdir(), `repopilot-analyzer-${crypto.randomUUID()}`), {
    recursive: true
  });
}
