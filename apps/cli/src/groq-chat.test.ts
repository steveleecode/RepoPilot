import { mkdir, readFile, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { defaultGroqModel, runInteractiveChat, streamChatReply } from "./gemini-chat.js";
import { loadChatKey, saveChatKey } from "./gemini-config.js";
import { runCli } from "./index.js";

const stream = (data: string) => new Response(`data: ${data}\r\n\r\ndata: [DONE]\r\n\r\n`);
const turn = [{ role: "user" as const, text: "Hello" }];

describe("Groq chat", () => {
  it("sends bounded history to Groq with header-only credentials and streams only content", async () => {
    let request: RequestInit | undefined;
    let url = "";
    const printed: string[] = [];
    const reply = await streamChatReply({
      provider: "groq",
      apiKey: "private-key",
      model: defaultGroqModel,
      history: [...turn, { role: "model", text: "Hi" }, ...turn],
      context: '{"languages":[]}',
      fetcher: (input, init) => {
        url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        request = init;
        return Promise.resolve(
          stream('{"choices":[{"delta":{"content":"Hello","reasoning":"hidden"}}]}')
        );
      },
      onText: (text) => {
        printed.push(text);
      }
    });
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer private-key");
    expect(new Headers(request?.headers).has("x-goog-api-key")).toBe(false);
    expect(request?.redirect).toBe("error");
    const body = typeof request?.body === "string" ? request.body : "";
    expect(body).not.toContain("private-key");
    expect(JSON.parse(body)).toMatchObject({
      model: "openai/gpt-oss-120b",
      stream: true,
      messages: [{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "user" }]
    });
    expect(printed).toEqual(["Hello"]);
    expect(reply).toBe("Hello");
  });

  it.each([401, 404, 429])("does not retry or expose raw HTTP %i errors", async (status) => {
    let calls = 0;
    const result = streamChatReply({
      provider: "groq",
      apiKey: "private-key",
      model: defaultGroqModel,
      history: turn,
      onText: () => undefined,
      fetcher: () => {
        calls++;
        return Promise.resolve(new Response("private-key", { status }));
      }
    });
    await expect(result).rejects.toThrow(`HTTP ${status}`);
    await expect(result).rejects.not.toThrow("private-key");
    expect(calls).toBe(1);
  });

  it("rejects unsafe model paths and missing credentials", async () => {
    for (const model of ["../secret", "org/model/extra", "org/model?key=x"]) {
      await expect(
        streamChatReply({
          provider: "groq",
          apiKey: "private-key",
          model,
          history: turn,
          onText: () => undefined
        })
      ).rejects.toThrow("Invalid Groq model");
    }
    await expect(
      streamChatReply({
        provider: "groq",
        apiKey: "",
        model: defaultGroqModel,
        history: turn,
        onText: () => undefined
      })
    ).rejects.toThrow("GROQ_API_KEY");
  });

  it("runs a Groq session with streamed output and no timeout notice", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    let sent = false;
    let exited = false;
    output.on("data", (chunk: Buffer) => {
      transcript += chunk.toString();
      if (!sent && transcript.includes("you> ")) {
        sent = true;
        input.write("Hello\n");
      }
      if (!exited && transcript.includes("Groq> Hello\n\n")) {
        exited = true;
        setTimeout(() => input.write("/exit\n"), 0);
      }
    });
    await runInteractiveChat({
      provider: "groq",
      repositoryRoot: tmpdir(),
      apiKey: "private-key",
      model: defaultGroqModel,
      includeContext: false,
      input,
      output,
      animate: false,
      fetcher: () => Promise.resolve(stream('{"choices":[{"delta":{"content":"Hello"}}]}'))
    });
    expect(transcript).toContain("RepoPilot Chat · Groq openai/gpt-oss-120b");
    expect(transcript).not.toContain("Waiting for Groq");
    expect(transcript).not.toContain("up to 2 minutes");
    expect(transcript).not.toContain("Gemini may be slower");
  });

  it("stores and rotates independent keys with private permissions and reports the default", async () => {
    const root = path.join(tmpdir(), `repopilot-groq-${crypto.randomUUID()}`);
    await mkdir(root);
    await saveChatKey(root, "gemini-secret-123456789", "gemini");
    await saveChatKey(root, "groq-secret-123456789", "groq");
    await saveChatKey(root, "groq-rotated-123456789", "groq");
    expect(await loadChatKey(root, "gemini")).toBe("gemini-secret-123456789");
    expect(await loadChatKey(root, "groq")).toBe("groq-rotated-123456789");
    expect(await readFile(path.join(root, ".repopilot/.env"), "utf8")).not.toContain("groq-secret");
    expect((await lstat(path.join(root, ".repopilot/.env"))).mode & 0o777).toBe(0o600);
    const result = await runCli(
      ["node", "repopilot", "config", "status", "--repo", root, "--json"],
      root
    );
    expect(JSON.parse(result.output)).toMatchObject({
      defaultChatProvider: "groq",
      groqConfigured: true,
      geminiConfigured: true
    });
    expect(result.output).not.toContain("secret");
    const linked = path.join(tmpdir(), `repopilot-linked-${crypto.randomUUID()}`);
    await mkdir(linked);
    await symlink(path.join(root, ".repopilot"), path.join(linked, ".repopilot"));
    await expect(saveChatKey(linked, "groq-secret-123456789", "groq")).rejects.toThrow("symlinked");
    await expect(saveChatKey(root, "groq-secret-123456789\nOTHER=x", "groq")).rejects.toThrow(
      "Groq API key must be a single"
    );
  });

  it("advertises provider selection and rejects unknown chat providers", async () => {
    const help = await runCli(["node", "repopilot", "chat", "--help"]);
    expect(help.output).toContain("--provider groq|gemini");
    const result = await runCli(["node", "repopilot", "chat", "--provider", "unknown"]);
    expect(result.output).toContain("Chat provider must be groq or gemini");
  });
});
