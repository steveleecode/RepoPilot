import { describe, expect, it, vi } from "vitest";
import { generateCommitMessage } from "./commit-message.js";
const context = {
  objective: "Update greeting",
  summary: "Reviewed changes",
  changes: [{ path: "src/greeting.txt", action: "modify" }],
  checks: [{ commandId: "diff-check", status: "completed" }]
};
describe("commit message providers", () => {
  it("uses Codex structured metadata and rejects control characters", async () => {
    const codexTurn = vi.fn(() => Promise.resolve({ message: "fix: update greeting" }));
    expect(await generateCommitMessage("codex", context, { codexTurn })).toBe(
      "fix: update greeting"
    );
    expect(codexTurn).toHaveBeenCalledWith(
      expect.stringContaining('"path":"src/greeting.txt"'),
      expect.objectContaining({ type: "object" })
    );
    for (const message of [
      "fix: bad\nline",
      "fix: bad\u001b[0m",
      "fix: bad\u2028line",
      "not conventional"
    ])
      await expect(
        generateCommitMessage("codex", context, { codexTurn: () => Promise.resolve({ message }) })
      ).rejects.toThrow();
  });
  it("uses Groq structured output with every changed path and header-only credentials", async () => {
    const all = {
      ...context,
      changes: Array.from({ length: 150 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        action: "modify"
      }))
    };
    const fetcher = vi.fn<typeof fetch>((url, options) => {
      expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
      expect(options?.redirect).toBe("error");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer private-test-key");
      const body = JSON.parse(options?.body as string) as {
        model: string;
        response_format: { json_schema: { strict: boolean } };
        messages: [unknown, { content: string }];
      };
      expect(body.model).toBe("openai/gpt-oss-120b");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect((JSON.parse(body.messages[1].content) as { changes: unknown[] }).changes).toHaveLength(
        150
      );
      expect(options?.body).not.toContain("private-test-key");
      return Promise.resolve(
        Response.json({
          choices: [
            { message: { content: JSON.stringify({ message: "feat: update all modules" }) } }
          ]
        })
      );
    });
    expect(await generateCommitMessage("groq", all, { apiKey: "private-test-key", fetcher })).toBe(
      "feat: update all modules"
    );
    await expect(generateCommitMessage("groq", context)).rejects.toThrow("Groq key missing");
    for (const content of [
      '{"message":"not conventional"}',
      '{"message":"feat: okay","extra":true}',
      "invalid"
    ]) {
      await expect(
        generateCommitMessage("groq", context, {
          apiKey: "private-test-key",
          fetcher: () => Promise.resolve(Response.json({ choices: [{ message: { content } }] }))
        })
      ).rejects.toThrow();
    }
    await expect(
      generateCommitMessage("groq", context, {
        apiKey: "private-test-key",
        fetcher: () => Promise.resolve(new Response("private-test-key", { status: 429 }))
      })
    ).rejects.toThrow("Groq commit message generation failed");
    await expect(
      generateCommitMessage(
        "groq",
        { ...context, objective: "x".repeat(40_001) },
        { apiKey: "private-test-key", fetcher }
      )
    ).rejects.toThrow("metadata exceeds");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses bounded Gemini JSON Schema requests and redacts failed responses", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, options) => {
      expect(options?.redirect).toBe("error");
      const request = JSON.parse(options?.body as string) as {
        generationConfig: Record<string, unknown>;
      };
      expect(request.generationConfig).toHaveProperty("responseJsonSchema");
      return Promise.resolve(
        Response.json({
          candidates: [
            { content: { parts: [{ text: JSON.stringify({ message: "feat: update greeting" }) }] } }
          ]
        })
      );
    });
    expect(
      await generateCommitMessage("gemini", context, { apiKey: "private-test-key", fetcher })
    ).toBe("feat: update greeting");
    await expect(generateCommitMessage("gemini", context)).rejects.toThrow("key missing");
    await expect(
      generateCommitMessage("gemini", context, {
        apiKey: "private-test-key",
        fetcher: () => Promise.resolve(new Response("private-test-key", { status: 401 }))
      })
    ).rejects.toThrow("Gemini commit message generation failed");
    await expect(
      generateCommitMessage("gemini", context, {
        apiKey: "private-test-key",
        fetcher: () => Promise.resolve(new Response("x".repeat(20_000)))
      })
    ).rejects.toThrow("invalid response");
  });
});
