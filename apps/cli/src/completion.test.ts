import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";
import { zshCompletion } from "./completion.js";

const hasZsh = spawnSync("zsh", ["--version"], { encoding: "utf8" }).status === 0;

function inspectCompletion(words: string[], current = words.length): string {
  // Stub only the zsh display/parser boundaries to inspect command routing and advertised flags.
  // Native interactive menu behavior is also exercised with a PTY during release verification.
  const program = `compdef() { :; }
${zshCompletion()}
_describe() { print -l -- $candidates; }
_arguments() { print -l -- "$@"; }
words=( ${words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ")} )
CURRENT=${current}
_repopilot
`;
  const result = spawnSync("zsh", ["-f", "-c", program], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("zsh completion", () => {
  it("generates syntactically valid static scripts without initializing a repository", async () => {
    for (const auto of [false, true]) {
      const args = ["node", "repopilot", "completion", "zsh", ...(auto ? ["--auto-menu"] : [])];
      const result = await runCli(args, "/does-not-exist/repopilot-completion");
      expect(result.exitCode).toBe(0);
      if (hasZsh) {
        const syntax = spawnSync("zsh", ["-n", "-c", result.output], { encoding: "utf8" });
        expect(syntax.status, syntax.stderr).toBe(0);
      }
      expect(result.output).toContain("compdef _repopilot repopilot");
      expect(result.output).not.toContain("repopilot scan");
      expect(result.output.includes("_repopilot_disable_auto_menu")).toBe(auto);
    }
  });

  it.skipIf(!hasZsh)("describes commands and routes nested command and option contexts", () => {
    expect(inspectCompletion(["repopilot", ""])).toContain("commit:Commit reviewed changes");
    expect(inspectCompletion(["repopilot", "providers", "codex", ""])).toContain("login:Sign in");
    expect(inspectCompletion(["repopilot", "completion", "zsh", "--"])).toContain("--auto-menu");
    expect(inspectCompletion(["repopilot", "completion", "zsh", "--"])).not.toContain("--repo");
    expect(inspectCompletion(["repopilot", "version", "--"])).not.toContain("--repo");
    expect(inspectCompletion(["repopilot", "--"])).not.toContain("--json");
    expect(inspectCompletion(["repopilot", "codex", "setup", "--"])).not.toContain("--skip-gemini");
    expect(inspectCompletion(["repopilot", "setup", "--"])).toContain("--skip-gemini");
    expect(inspectCompletion(["repopilot", "run", "--"])).toContain("--message-provider");
  });

  it("rejects unsupported shell names and options before returning executable shell output", async () => {
    for (const args of [
      ["completion"],
      ["completion", "bash"],
      ["completion", "zsh", "--repo", "/tmp"]
    ]) {
      expect((await runCli(["node", "repopilot", ...args])).exitCode).toBe(2);
    }
  });
});
