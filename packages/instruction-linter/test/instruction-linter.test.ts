import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintInstructions } from "../src/index.js";

describe("lintInstructions", () => {
  it("detects instruction files exceeding a line threshold", () => {
    const findings = lintInstructions("one\ntwo\nthree", {
      repositoryRoot: "/tmp",
      lineThreshold: 2
    });

    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "line-threshold" })])
    );
  });

  it("detects duplicate headings and exact instruction lines", () => {
    const findings = lintInstructions("# Build\n- Run tests\n# Build\n- Run tests", {
      repositoryRoot: "/tmp"
    });

    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(["duplicate-heading", "duplicate-instruction-line"])
    );
  });

  it("detects missing repository paths", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "README.md"), "# test");
    const findings = lintInstructions("Read `docs/missing.md` before editing.", {
      repositoryRoot: root
    });

    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: "missing-repository-path" })])
    );
  });

  it("detects missing package.json scripts and deterministic command conflicts", async () => {
    const root = await fixture();
    const findings = lintInstructions(
      "Always run `pnpm build`.\nNever run `pnpm build`.\nRun `pnpm missing`.",
      {
        repositoryRoot: root,
        packageJson: { scripts: { build: "next build" } }
      }
    );

    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(["missing-package-script", "conflicting-command-instruction"])
    );
  });
});

async function fixture(): Promise<string> {
  return mkdir(path.join(tmpdir(), `repopilot-linter-${crypto.randomUUID()}`), { recursive: true });
}
