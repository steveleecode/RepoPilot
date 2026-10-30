import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { analyzeRepository } from "@repopilot/analyzer";
import { describe, expect, it } from "vitest";
import {
  buildChatContext,
  defaultGeminiModel,
  runInteractiveGeminiChat,
  streamGeminiReply
} from "./gemini-chat.js";

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("Gemini chat streaming", () => {
  it("runs an interactive session and exits without writing project files", async () => {
    const root = path.join(tmpdir(), `repopilot-chat-${crypto.randomUUID()}`);
    await mkdir(root);
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    let sentQuestion = false;
    let sentExit = false;
    output.on("data", (chunk: Buffer) => {
      transcript += chunk.toString("utf8");
      if (!sentQuestion && transcript.includes("you> ")) {
        sentQuestion = true;
        input.write("Suggest a test\n");
      }
      if (!sentExit && transcript.includes("Gemini> Hi\n\n")) {
        sentExit = true;
        setTimeout(() => input.write("/exit\n"), 0);
      }
    });
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        streamedResponse(['data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n'])
      );

    await runInteractiveGeminiChat({
      repositoryRoot: root,
      apiKey: "test-secret",
      model: defaultGeminiModel,
      includeContext: false,
      input,
      output,
      fetcher,
      animate: false
    });

    expect(transcript).toContain("Gemini> Hi");
    expect(transcript).toContain("Repository context disabled.");
  });

  it("shares evidence-backed tool metadata but not scripts or secret files", async () => {
    const root = path.join(tmpdir(), `repopilot-chat-${crypto.randomUUID()}`);
    await mkdir(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        devDependencies: { vitest: "1.0.0" },
        scripts: { test: "SECRET_VALUE=private-token vitest run" }
      })
    );
    await writeFile(path.join(root, ".env"), "GEMINI_API_KEY=private-token");

    const context = buildChatContext(await analyzeRepository(root));

    expect(context).toContain("vitest");
    expect(context).toContain("package.json");
    expect(context).not.toContain("private-token");
    expect(context).not.toContain(".env");
  });

  it("prints incremental SSE text and sends only the key in a header", async () => {
    let requestBody = "";
    let keyHeader = "";
    const printed: string[] = [];
    const fetcher: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      keyHeader = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      return Promise.resolve(
        streamedResponse([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n',
          '\ndata: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n'
        ])
      );
    };

    const reply = await streamGeminiReply({
      apiKey: "test-secret",
      model: defaultGeminiModel,
      history: [{ role: "user", text: "Suggest a test" }],
      onText: (text) => {
        printed.push(text);
      },
      fetcher
    });

    expect(reply).toBe("Hello world");
    expect(printed).toEqual(["Hello", " world"]);
    expect(keyHeader).toBe("test-secret");
    expect(requestBody).not.toContain("test-secret");
    expect(JSON.parse(requestBody)).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Suggest a test" }] }]
    });
  });

  it("preserves bounded conversation history for follow-up questions", async () => {
    let requestBody = "";
    const fetcher: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        streamedResponse(['data: {"candidates":[{"content":{"parts":[{"text":"Next"}]}}]}\n\n'])
      );
    };

    await streamGeminiReply({
      apiKey: "test-secret",
      model: defaultGeminiModel,
      history: [
        { role: "user", text: "First" },
        { role: "model", text: "First answer" },
        { role: "user", text: "Follow up" }
      ],
      context: '{"languages":[{"name":"TypeScript","evidence":["package.json"]}]}',
      onText: () => undefined,
      fetcher
    });

    const body = JSON.parse(requestBody) as {
      contents: Array<{ role: string }>;
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(body.contents.map((turn) => turn.role)).toEqual(["user", "model", "user"]);
    expect(body.systemInstruction.parts[0]?.text).toContain("package.json");
  });

  it("trims old history without starting with an orphaned model message", async () => {
    let requestBody = "";
    const fetcher: typeof fetch = (_input, init) => {
      requestBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(
        streamedResponse(['data: {"candidates":[{"content":{"parts":[{"text":"Okay"}]}}]}\n\n'])
      );
    };
    const history = Array.from({ length: 13 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("model" as const),
      text: `turn ${index}`
    }));

    await streamGeminiReply({
      apiKey: "test-secret",
      model: defaultGeminiModel,
      history,
      onText: () => undefined,
      fetcher
    });

    const body = JSON.parse(requestBody) as {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    };
    expect(body.contents[0]?.role).toBe("user");
    expect(body.contents.at(-1)?.parts[0]?.text).toBe("turn 12");
    expect(body.contents.length).toBeLessThanOrEqual(12);
  });

  it("reports HTTP failures without echoing the provider response or key", async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(new Response("private details", { status: 429 }));

    await expect(
      streamGeminiReply({
        apiKey: "test-secret",
        model: defaultGeminiModel,
        history: [{ role: "user", text: "Hello" }],
        onText: () => undefined,
        fetcher
      })
    ).rejects.toThrow("HTTP 429");
  });

  it("rejects missing keys and unsafe model names before requesting", async () => {
    await expect(
      streamGeminiReply({
        apiKey: "",
        model: defaultGeminiModel,
        history: [{ role: "user", text: "Hello" }],
        onText: () => undefined
      })
    ).rejects.toThrow("GEMINI_API_KEY");
    await expect(
      streamGeminiReply({
        apiKey: "test-secret",
        model: "../unsafe",
        history: [{ role: "user", text: "Hello" }],
        onText: () => undefined
      })
    ).rejects.toThrow("Invalid Gemini model");
  });
});
