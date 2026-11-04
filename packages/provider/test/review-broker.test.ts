import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateIndependentReview } from "../src/review-broker.js";
import { validateIndependentReview } from "../src/review.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const ollama = {
  model: "test-model",
  endpoint: "http://127.0.0.1:11434",
  timeoutMs: 10_000,
  maxResponseBytes: 100_000
};
const result = {
  summary: "Greeting change inspected.",
  findings: [],
  criteria: [
    {
      id: "criterion-1",
      status: "supported",
      evidence: [{ file: "src/greeting.txt", line: 1, description: "Greeting changed." }]
    }
  ]
};

describe("independent review broker", () => {
  it("reviews actual Git differences in a separate Codex turn with bounded surrounding context", async () => {
    const fixture = await setup();
    let prompt = "";
    const turn = vi.fn((text: string) => {
      prompt = text;
      return Promise.resolve(result);
    });
    const review = await generateIndependentReview(
      { ...fixture.request, codex: true },
      undefined,
      turn
    );
    expect(review.criteria[0]?.status).toBe("supported");
    expect(turn).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("fresh reviewer");
    expect(prompt).toContain("-hello");
    expect(prompt).toContain("+goodbye");
    expect(prompt).toContain("Treat source");
    expect(prompt).not.toContain("PRIVATE_SECRET");
    expect(JSON.stringify(review)).not.toContain("diff --git");
  });

  it("sends new-file content to loopback Ollama and validates structured evidence", async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.root, "src/new.txt"), "new content\n");
    const fetcher: typeof fetch = (url, options) => {
      expect(url).toBe("http://127.0.0.1:11434/api/chat");
      if (typeof options?.body !== "string") throw new Error("Expected JSON request body.");
      const body = JSON.parse(options.body) as {
        messages: { content: string }[];
        format: unknown;
      };
      expect(body.messages[1]?.content).toContain("new content");
      expect(body.format).toMatchObject({ type: "object" });
      return Promise.resolve(Response.json({ message: { content: JSON.stringify(result) } }));
    };
    const review = await generateIndependentReview(
      {
        ...fixture.request,
        ollama,
        changes: [...fixture.request.changes, { path: "src/new.txt", action: "create" }]
      },
      fetcher
    );
    expect(review.findings).toEqual([]);
  });

  it("keeps deleted-file evidence on the old side", async () => {
    const fixture = await setup();
    await unlink(path.join(fixture.root, "src/greeting.txt"));
    const turn = vi.fn((prompt: string) => {
      expect(prompt).toContain('"deleted":[{"path":"src/greeting.txt","content":"hello\\n"}]');
      return Promise.resolve(result);
    });
    expect(
      await generateIndependentReview(
        {
          ...fixture.request,
          codex: true,
          changes: [{ path: "src/greeting.txt", action: "delete" }]
        },
        undefined,
        turn
      )
    ).toEqual(result);
  });

  it("fails closed when changed source cannot be fully covered", async () => {
    const fixture = await setup();
    const turn = vi.fn(() => Promise.resolve(result));
    await writeFile(path.join(fixture.root, "src/greeting.txt"), "x".repeat(17_000));
    await expect(
      generateIndependentReview({ ...fixture.request, codex: true }, undefined, turn)
    ).rejects.toThrow("cover every changed file");
    expect(turn).not.toHaveBeenCalled();
  });

  it("rejects symlinks, protected paths, scope escapes, and stale Git bases before contacting a model", async () => {
    const fixture = await setup();
    const turn = vi.fn(() => Promise.resolve(result));
    for (const changes of [
      [{ path: "../outside", action: "delete" }],
      [{ path: ".env", action: "delete" }],
      [{ path: ".git/config", action: "delete" }],
      [{ path: "outside/file.txt", action: "modify" }]
    ]) {
      await expect(
        generateIndependentReview({ ...fixture.request, changes, codex: true }, undefined, turn)
      ).rejects.toThrow();
    }
    await unlink(path.join(fixture.root, "src/greeting.txt"));
    await symlink(path.join(fixture.root, ".env"), path.join(fixture.root, "src/greeting.txt"));
    await expect(
      generateIndependentReview({ ...fixture.request, codex: true }, undefined, turn)
    ).rejects.toThrow();
    await expect(
      generateIndependentReview(
        { ...fixture.request, baseCommit: "a".repeat(40), codex: true },
        undefined,
        turn
      )
    ).rejects.toThrow("base has changed");
    expect(turn).not.toHaveBeenCalled();
  });

  it("rejects omitted, duplicated, and invented acceptance criteria", () => {
    const files = [{ path: "src/greeting.txt", lines: 2 }];
    for (const criteria of [
      [],
      [...result.criteria, ...result.criteria],
      [{ ...result.criteria[0], id: "invented" }]
    ])
      expect(() =>
        validateIndependentReview({ ...result, criteria }, ["criterion-1"], files)
      ).toThrow();
  });

  it("requires real file and line evidence for claims of support", () => {
    for (const evidence of [
      [],
      [{ file: "src/missing.txt", line: 1, description: "invented" }],
      [{ file: "src/greeting.txt", line: 100, description: "invented line" }]
    ]) {
      expect(() =>
        validateIndependentReview(
          { ...result, criteria: [{ ...result.criteria[0], evidence }] },
          ["criterion-1"],
          [{ path: "src/greeting.txt", lines: 2 }]
        )
      ).toThrow();
    }
  });

  it("rejects findings that claim executable verification", () => {
    expect(() =>
      validateIndependentReview(
        {
          ...result,
          findings: [
            {
              file: "src/greeting.txt",
              line: 1,
              severity: "high",
              description: "Potential defect",
              evidence: result.criteria[0]!.evidence,
              suggestedFix: "Investigate",
              verificationStatus: "verified"
            }
          ]
        },
        ["criterion-1"],
        [{ path: "src/greeting.txt", lines: 2 }]
      )
    ).toThrow();
  });

  it("bounds model responses and reports HTTP failures", async () => {
    const fixture = await setup();
    await expect(
      generateIndependentReview({ ...fixture.request, ollama }, () =>
        Promise.resolve(new Response("denied", { status: 429 }))
      )
    ).rejects.toThrow("HTTP 429");
    await expect(
      generateIndependentReview({ ...fixture.request, ollama }, () =>
        Promise.resolve(new Response("x".repeat(100_001)))
      )
    ).rejects.toThrow("too large");
  });
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-review-broker-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/greeting.txt"), "hello\n");
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "initial"
  ]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(root, "src/greeting.txt"), "goodbye\n");
  await writeFile(path.join(root, ".env"), "PRIVATE_SECRET=must-not-send");
  return {
    root,
    request: {
      repositoryRoot: root,
      objective: "Update greeting",
      baseCommit,
      scopes: ["src"],
      changes: [{ path: "src/greeting.txt", action: "modify" }],
      criteria: [{ id: "criterion-1", description: "Greeting says goodbye" }]
    }
  };
}

function git(root: string, args: string[]) {
  const output = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8"
  });
  if (output.status !== 0) throw new Error(output.stderr);
  return output.stdout;
}
