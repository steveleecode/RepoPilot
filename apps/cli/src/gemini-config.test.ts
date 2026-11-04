import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadGeminiKey, readKeyFromStdin, saveGeminiKey } from "./gemini-config.js";

async function fixture(): Promise<string> {
  const directory = path.join(tmpdir(), `repopilot-gemini-config-${crypto.randomUUID()}`);
  await mkdir(directory);
  return directory;
}

describe("local Gemini configuration", () => {
  it("saves a private, ignored .env and loads only the Gemini key", async () => {
    const root = await fixture();
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await saveGeminiKey(root, "test-gemini-key-123456789");

    expect(await loadGeminiKey(root)).toBe("test-gemini-key-123456789");
    expect(await readFile(path.join(root, ".repopilot/.gitignore"), "utf8")).toBe(
      ".env\n.env.tmp-*\n"
    );
    expect((await lstat(path.join(root, ".repopilot/.env"))).mode & 0o777).toBe(0o600);
    expect(spawnSync("git", ["check-ignore", "-q", ".repopilot/.env"], { cwd: root }).status).toBe(
      0
    );
    expect(
      spawnSync("git", ["check-ignore", "-q", ".repopilot/.env.tmp-example"], { cwd: root }).status
    ).toBe(0);
  });

  it("rotates the key without destroying other local environment entries", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".repopilot"));
    await writeFile(path.join(root, ".repopilot/.env"), "OTHER_VALUE=keep\n");
    await saveGeminiKey(root, "first-gemini-key-123456789");
    await saveGeminiKey(root, "second-gemini-key-123456789");

    const content = await readFile(path.join(root, ".repopilot/.env"), "utf8");
    expect(content).toContain("OTHER_VALUE=keep");
    expect(content).toContain("GEMINI_API_KEY=second-gemini-key-123456789");
    expect(content).not.toContain("first-gemini-key-123456789");
  });

  it("accepts a key from stdin without putting it in arguments", async () => {
    const key = await readKeyFromStdin(Readable.from(["test-gemini-key-123456789\n"]));
    expect(key).toBe("test-gemini-key-123456789");
  });

  it("accepts dotted keys through stdin and persisted local config", async () => {
    const root = await fixture();
    const key = "test.gemini.key-123456789";
    expect(await readKeyFromStdin(Readable.from([`${key}\n`]))).toBe(key);
    await saveGeminiKey(root, key);
    expect(await loadGeminiKey(root)).toBe(key);
  });

  it("rejects environment-file injection in a key", async () => {
    const root = await fixture();
    await expect(saveGeminiKey(root, "valid-key-123456789\nOTHER=value")).rejects.toThrow(
      "Gemini API key must be a single"
    );
  });

  it("rejects symlinks and a Git-tracked secret path", async () => {
    const outside = await fixture();
    const linked = await fixture();
    await symlink(outside, path.join(linked, ".repopilot"));
    await expect(saveGeminiKey(linked, "test-gemini-key-123456789")).rejects.toThrow("symlinked");

    const fileLink = await fixture();
    await mkdir(path.join(fileLink, ".repopilot"));
    await symlink(path.join(outside, "secret"), path.join(fileLink, ".repopilot/.env"));
    await expect(saveGeminiKey(fileLink, "test-gemini-key-123456789")).rejects.toThrow("non-file");

    const root = await fixture();
    await mkdir(path.join(root, ".repopilot"));
    await writeFile(path.join(root, ".repopilot/.env"), "GEMINI_API_KEY=old-value-123456789\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "-f", ".repopilot/.env"], { cwd: root }).status).toBe(0);
    await expect(saveGeminiKey(root, "test-gemini-key-123456789")).rejects.toThrow("tracked");
  });
});
