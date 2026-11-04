import { describe, expect, it } from "vitest";
import { createTerminalMarkdown } from "./terminal-markdown.js";

function render(chunks: string[], color = false) {
  let output = "";
  const renderer = createTerminalMarkdown((text) => {
    output += text;
  }, color);
  for (const chunk of chunks) renderer.write(chunk);
  renderer.flush();
  return output;
}

describe("terminal Markdown", () => {
  it("renders headings, emphasis, lists, quotes and visible link destinations", () => {
    expect(
      render([
        "## Next steps\n**Run tests** and `pnpm check`.\n- First\n  - Nested\n> Note\n[Docs](https://example.com)\n"
      ])
    ).toBe(
      "Next steps\nRun tests and pnpm check.\n• First\n  • Nested\n│ Note\nDocs (https://example.com)\n"
    );
  });
  it("preserves code literally even when fences and tokens arrive in fragments", () => {
    expect(render(["**Hel", "lo**\n`", "``ts\nconst x = '**literal**';\n", "```\nTail"])).toBe(
      "Hello\n  ts\n  const x = '**literal**';\n\nTail"
    );
  });
  it("styles terminal output and keeps plain output free of ANSI", () => {
    expect(render(["**Hello**"], true)).toContain("\u001b[1mHello\u001b[0m");
    expect(render(["**Hello**"])).toBe("Hello");
  });
  it("removes provider terminal controls including sequences split between chunks", () => {
    expect(render(["\u001b[", "2JHello\u001b]0;bad title\u0007\n"])).toBe("Hello\n");
  });
});
