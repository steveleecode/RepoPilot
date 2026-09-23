import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateChangeProposal } from "../src/change-broker.js";

const ollama = {
  model: "test-model",
  endpoint: "http://127.0.0.1:11434",
  timeoutMs: 10_000,
  maxResponseBytes: 100_000
};

describe("change context broker", () => {
  it("sends bounded source context and returns an evidence-backed proposal", async () => {
    const root = await fixture();
    let sent: unknown;
    const fetcher: typeof fetch = (_url, options) => {
      sent = JSON.parse(typeof options?.body === "string" ? options.body : "") as unknown;
      return Promise.resolve(
        Response.json({
          message: {
            content: JSON.stringify({
              summary: "Update greeting",
              changes: [
                {
                  action: "modify",
                  path: "src/greeting.txt",
                  content: "goodbye\n",
                  evidencePaths: ["src/greeting.txt"]
                }
              ]
            })
          }
        })
      );
    };
    const result = (await generateChangeProposal(request(root), fetcher)) as {
      contextManifest: { path: string }[];
      changes: { baseHash: string }[];
    };
    expect(result.contextManifest.map((item) => item.path)).toEqual(["src/greeting.txt"]);
    expect(result.changes[0]?.baseHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(sent)).not.toContain("hidden-secret");
    expect(JSON.stringify(sent)).toContain("hello");
  });

  it("rejects scope traversal and symlink context", async () => {
    const root = await fixture();
    await symlink(path.join(root, "src", "greeting.txt"), path.join(root, "src", "linked.txt"));
    await expect(
      generateChangeProposal({ ...request(root), files: ["../outside"] }, () =>
        Promise.reject(new Error("should not fetch"))
      )
    ).rejects.toThrow();
    const fetcher: typeof fetch = (_url, options) => {
      expect(typeof options?.body === "string" ? options.body : "").not.toContain("linked.txt");
      return Promise.resolve(
        Response.json({
          message: {
            content: JSON.stringify({
              summary: "No change",
              changes: [
                {
                  action: "create",
                  path: "src/new.txt",
                  content: "new",
                  evidencePaths: ["src/greeting.txt"]
                }
              ]
            })
          }
        })
      );
    };
    await expect(
      generateChangeProposal({ ...request(root), files: ["src/linked.txt"] }, fetcher)
    ).resolves.toBeTruthy();
  });
});

function request(repositoryRoot: string) {
  return {
    repositoryRoot,
    objective: "Update greeting",
    taskId: "greeting",
    taskObjective: "Update greeting",
    readSet: ["src"],
    writeSet: ["src"],
    files: [],
    ollama
  };
}

async function fixture(): Promise<string> {
  const root = path.join(tmpdir(), `repopilot-broker-${crypto.randomUUID()}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "greeting.txt"), "hello\n");
  await writeFile(path.join(root, "src", ".env"), "hidden-secret");
  return root;
}
