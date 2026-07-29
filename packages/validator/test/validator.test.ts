import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProposedFile } from "@repopilot/generator";
import {
  validateDuplicateProposedFilePaths,
  validateGeneratedJson,
  validateGeneratedYaml,
  validateReferencedPackageScripts
} from "../src/index.js";

const provenance = {
  templateId: "test",
  variables: {},
  evidence: [{ sourcePath: "test", sourceType: "config" as const, description: "test" }]
};

describe("validators", () => {
  it("validates generated JSON parsing", async () => {
    const report = await Promise.resolve(
      validateGeneratedJson({
        repositoryRoot: "/tmp",
        proposedFiles: [file("settings.json", "{")]
      })
    );

    expect(report.status).toBe("failed");
    expect(report.findings.at(0)?.path).toBe("settings.json");
  });

  it("validates generated YAML parsing", async () => {
    const report = await Promise.resolve(
      validateGeneratedYaml({
        repositoryRoot: "/tmp",
        proposedFiles: [file("workflow.yml", "name: [")]
      })
    );

    expect(report.status).toBe("failed");
  });

  it("validates referenced package.json scripts", async () => {
    const report = await Promise.resolve(
      validateReferencedPackageScripts(["check"])({
        repositoryRoot: "/tmp",
        proposedFiles: [],
        packageJson: { scripts: { test: "vitest run" } }
      })
    );

    expect(report.status).toBe("failed");
    expect(report.findings.at(0)?.message).toContain("check");
  });

  it("detects duplicate proposed file paths", async () => {
    const report = await Promise.resolve(
      validateDuplicateProposedFilePaths({
        repositoryRoot: "/tmp",
        proposedFiles: [file("AGENTS.md", "a"), file("./AGENTS.md", "b")]
      })
    );

    expect(report.status).toBe("failed");
    expect(report.findings.at(0)?.path).toBe("AGENTS.md");
  });

  it("passes path-aware validators when a referenced script exists", async () => {
    const root = await mkdir(path.join(tmpdir(), `repopilot-validator-${crypto.randomUUID()}`), {
      recursive: true
    });
    await writeFile(path.join(root, "README.md"), "# RepoPilot");
    const report = await Promise.resolve(
      validateReferencedPackageScripts(["test"])({
        repositoryRoot: root,
        proposedFiles: [],
        packageJson: { scripts: { test: "vitest run" } }
      })
    );
    expect(report.status).toBe("passed");
  });
});

function file(filePath: string, content: string): ProposedFile {
  return { path: filePath, content, provenance };
}
