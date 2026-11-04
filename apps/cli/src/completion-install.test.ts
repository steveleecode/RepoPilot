import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askCompletionConsent,
  completionConfigPath,
  completionEnableLine,
  installZshCompletion
} from "./completion-install.js";
import { offerInstalledCompletion } from "./postinstall.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-completion-install-"));
  roots.push(root);
  return root;
}

describe("completion installation", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "enables completion by default without a terminal and remains idempotent",
    async () => {
      const home = await fixture();
      const target = path.join(home, ".zshrc");
      await writeFile(target, "# preserved personal settings\n");
      await chmod(target, 0o640);
      const environment = { npm_config_global: "true", SHELL: "/bin/zsh", HOME: home };
      await offerInstalledCompletion(environment);
      const content = await readFile(target, "utf8");
      expect(content).toContain(completionEnableLine);
      expect(content.startsWith("# preserved personal settings\n")).toBe(true);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      await offerInstalledCompletion(environment);
      expect(await readFile(target, "utf8")).toBe(content);
      const other = await fixture();
      await offerInstalledCompletion({
        ...environment,
        HOME: other,
        REPOPILOT_SKIP_COMPLETION_SETUP: "1"
      });
      await expect(lstat(path.join(other, ".zshrc"))).rejects.toThrow();
    }
  );
  it.skipIf(process.platform === "win32")(
    "appends only after affirmative consent, preserving original bytes/mode and avoiding duplicates",
    async () => {
      const home = await fixture();
      const target = path.join(home, ".zshrc");
      const original = Buffer.from("# user's settings\nexport EXAMPLE=keep");
      await writeFile(target, original);
      await chmod(target, 0o640);
      const no = vi.fn(() => Promise.resolve(false));
      expect(
        await installZshCompletion({ homeDirectory: home, environment: {}, confirm: no })
      ).toBe("declined");
      expect(await readFile(target)).toEqual(original);
      const yes = vi.fn(() => Promise.resolve(true));
      expect(
        await installZshCompletion({ homeDirectory: home, environment: {}, confirm: yes })
      ).toBe("enabled");
      const result = await readFile(target);
      expect(result.subarray(0, original.length)).toEqual(original);
      expect(result.toString()).toContain(completionEnableLine);
      expect((await lstat(target)).mode & 0o777).toBe(0o640);
      expect(
        await installZshCompletion({ homeDirectory: home, environment: {}, confirm: yes })
      ).toBe("already_enabled");
      expect(yes).toHaveBeenCalledTimes(1);
      expect(await readFile(target)).toEqual(result);
    }
  );
  it.skipIf(process.platform === "win32")(
    "honors absolute ZDOTDIR, creates missing rc privately and rejects unsafe targets",
    async () => {
      const home = await fixture();
      const custom = path.join(home, "zsh");
      await mkdir(custom);
      expect(
        await completionConfigPath({ homeDirectory: home, environment: { ZDOTDIR: custom } })
      ).toBe(
        path.join(await import("node:fs/promises").then((fs) => fs.realpath(custom)), ".zshrc")
      );
      await installZshCompletion({
        homeDirectory: home,
        environment: { ZDOTDIR: custom },
        confirm: () => Promise.resolve(true)
      });
      expect((await lstat(path.join(custom, ".zshrc"))).mode & 0o777).toBe(0o600);
      await expect(
        completionConfigPath({ homeDirectory: home, environment: { ZDOTDIR: "relative" } })
      ).rejects.toThrow("absolute");
      const target = path.join(home, ".zshrc");
      await symlink(path.join(custom, ".zshrc"), target);
      await expect(
        installZshCompletion({
          homeDirectory: home,
          environment: {},
          confirm: () => Promise.resolve(true)
        })
      ).rejects.toThrow();
      await rm(target);
      await link(path.join(custom, ".zshrc"), target);
      await expect(
        installZshCompletion({
          homeDirectory: home,
          environment: {},
          confirm: () => Promise.resolve(true)
        })
      ).rejects.toThrow();
    }
  );
  it.skipIf(process.platform === "win32")(
    "rejects special/oversized files, incomplete blocks and existing locks without printing startup content",
    async () => {
      const home = await fixture();
      const target = path.join(home, ".zshrc");
      const confirm = vi.fn(() => Promise.resolve(true));
      const fifo = spawnSync("mkfifo", [target]);
      if (fifo.status === 0) {
        await expect(
          installZshCompletion({ homeDirectory: home, environment: {}, confirm })
        ).rejects.toThrow("regular");
        await rm(target);
      }
      await writeFile(target, "x".repeat(1_048_577));
      await expect(
        installZshCompletion({ homeDirectory: home, environment: {}, confirm })
      ).rejects.toThrow("1 MiB");
      await writeFile(target, "# >>> RepoPilot completion >>>\nprivate startup text");
      await expect(
        installZshCompletion({ homeDirectory: home, environment: {}, confirm })
      ).rejects.toThrow("incomplete");
      await writeFile(target, "# original\n");
      await writeFile(`${target}.repopilot.lock`, "");
      await expect(
        installZshCompletion({ homeDirectory: home, environment: {}, confirm })
      ).rejects.toThrow("locked");
      expect(await readFile(target, "utf8")).toBe("# original\n");
    }
  );
  it("defaults no on empty input/timeout and accepts only exact yes", async () => {
    for (const answer of ["\n", "yep\n", "yes please\n", "no\n"]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const result = askCompletionConsent(input, output, "/fixture/.zshrc", 100);
      input.end(answer);
      expect(await result).toBe(false);
    }
    const input = new PassThrough();
    const output = new PassThrough();
    const accepted = askCompletionConsent(input, output, "/fixture/.zshrc", 100);
    input.end("YES\n");
    expect(await accepted).toBe(true);
    expect(
      await askCompletionConsent(new PassThrough(), new PassThrough(), "/fixture/.zshrc", 5)
    ).toBe(false);
    for (const stream of ["input", "output"] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      const result = askCompletionConsent(input, output, "/fixture/.zshrc", 100);
      (stream === "input" ? input : output).emit("error", new Error("terminal disconnected"));
      expect(await result).toBe(false);
    }
  });
  it("skips non-global, CI, non-zsh and opted-out lifecycle installs", async () => {
    for (const environment of [
      {},
      { npm_config_global: "true", SHELL: "/bin/bash" },
      { npm_config_global: "true", SHELL: "/bin/zsh", CI: "true" },
      { npm_config_global: "true", SHELL: "/bin/zsh", REPOPILOT_SKIP_COMPLETION_SETUP: "1" }
    ])
      await expect(offerInstalledCompletion(environment)).resolves.toBeUndefined();
  });
});
