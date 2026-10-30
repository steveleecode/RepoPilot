import { PassThrough } from "node:stream";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { featurePrompt, generateCodexSetup, promptCodexSetup } from "./codex-setup.js";

describe("Codex setup wizard", () => {
  it("gives specialists a question path through the orchestrator", async () => {
    const root = path.join(tmpdir(), `repopilot-questions-${crypto.randomUUID()}`);
    await mkdir(root);
    await generateCodexSetup(root, { agents: ["researcher", "developer", "reviewer"] });
    for (const id of ["researcher", "developer", "reviewer"]) {
      const toml = await readFile(path.join(root, `.codex/agents/${id}.toml`), "utf8");
      expect(toml).toContain("send the main Codex agent one concise question");
      expect(toml).toContain("Continue safe independent work while waiting");
    }
    const guide = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(guide).toContain("Ask the user a concise question");
    expect(guide).toContain("Never treat silence as approval");
    expect(featurePrompt("Add a filter")).toContain("Have specialists route questions through you");
  });

  it("lets users deselect defaults, add optional agents, and skip AI context", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const questions = [
      "Keep default agents [all]: ",
      "Add optional agents [none]: ",
      "Project/use-case description [skip]: ",
      "Ask Gemini to tailor selected agent focus? [y/N]: ",
      "Continue with this setup? [Y/n]: "
    ];
    const answers = ["1,3", "1,2", "React component library", "n", "y"];
    let seen = "";
    let next = 0;
    output.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (next < questions.length && seen.includes(questions[next]!)) {
        const answer = answers[next]!;
        next += 1;
        setImmediate(() => input.write(`${answer}\n`));
      }
    });
    const result = await promptCodexSetup(input, output);
    expect(result).toEqual({
      agents: ["researcher", "tester", "docs", "accessibility"],
      description: "React component library",
      useGemini: false
    });
  });
});
