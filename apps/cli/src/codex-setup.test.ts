import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptCodexSetup } from "./codex-setup.js";

describe("Codex setup wizard", () => {
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
