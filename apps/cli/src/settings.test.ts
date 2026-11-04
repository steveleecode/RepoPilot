import { describe, expect, it } from "vitest";
import { runCli } from "./index.js";

describe("personal settings", () => {
  it("describes personal completion without initializing a project", async () => {
    const result = await runCli(
      ["node", "repopilot", "settings", "--help"],
      "/does-not-exist/settings"
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("personal zsh completion");
    expect(result.output).toContain("Project setup remains repopilot setup");
  });
  it("rejects project arguments and automatic consent flags", async () => {
    for (const args of [["--repo", "/tmp"], ["--yes"], ["unexpected"]]) {
      expect((await runCli(["node", "repopilot", "settings", ...args])).exitCode).toBe(2);
    }
  });
  it.skipIf(Boolean(process.stdin.isTTY && process.stderr.isTTY))(
    "requires a terminal for the personal settings question",
    async () => {
      const result = await runCli(["node", "repopilot", "settings"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("interactive terminal");
    }
  );
});
