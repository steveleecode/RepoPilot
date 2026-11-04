import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Readable, Writable } from "node:stream";
import { analyzeRepository, type RepositoryAnalysis } from "@repopilot/analyzer";

import { createTerminalMarkdown } from "./terminal-markdown.js";

export type ChatTurn = { role: "user" | "model"; text: string };

export const defaultGroqModel = "openai/gpt-oss-120b";
export type ChatProvider = "groq" | "gemini";
export const defaultGeminiModel = "gemini-flash-latest";
const maxResponseBytes = 2_000_000;
const maxReplyCharacters = 60_000;
const maxHistoryTurns = 12;

const systemInstruction = `You are RepoPilot Chat, a read-only development advisor. Suggest practical next steps, tests, risks, and tradeoffs. Use only the user's messages and the supplied evidence-backed repository metadata. Do not claim to have inspected source code, run commands, changed files, or verified a suggestion. State uncertainty and ask for missing context when needed. Never ask for or reveal secrets. You cannot execute actions; proposals are suggestions for the human to review.`;

export function buildChatContext(analysis: RepositoryAnalysis): string {
  const fact = (name: string, evidence: { sourcePath: string }[]) => ({
    name,
    evidence: evidence
      .map((item) => item.sourcePath)
      .filter((item) => item.length <= 120 && /^[a-zA-Z0-9_./@-]+$/.test(item))
      .slice(0, 2)
  });
  const context = {
    languages: analysis.languages
      .slice(0, 8)
      .map((item) => fact(item.name, item.evidence))
      .filter((item) => item.evidence.length > 0),
    packageManagers: analysis.packageManagers
      .slice(0, 4)
      .map((item) => fact(item.name, item.evidence))
      .filter((item) => item.evidence.length > 0),
    testFrameworks: analysis.testFrameworks
      .slice(0, 8)
      .map((item) => fact(item.name, item.evidence))
      .filter((item) => item.evidence.length > 0),
    lintingTools: analysis.lintingTools
      .slice(0, 8)
      .map((item) => fact(item.name, item.evidence))
      .filter((item) => item.evidence.length > 0),
    ciWorkflows: analysis.ciWorkflows
      .slice(0, 8)
      .filter((item) => item.path.length <= 120 && /^[a-zA-Z0-9_./@-]+$/.test(item.path))
      .map((item) => fact(item.path, item.evidence))
      .filter((item) => item.evidence.length > 0)
  };
  return JSON.stringify(context);
}

export interface GeminiStreamOptions {
  provider?: ChatProvider;
  apiKey: string;
  model: string;
  history: ChatTurn[];
  context?: string;
  onText: (text: string) => void | Promise<void>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export async function streamGeminiReply(options: GeminiStreamOptions): Promise<string> {
  const groq = options.provider === "groq";
  const label = groq ? "Groq" : "Gemini";
  if (!options.apiKey) throw new Error(`${label.toUpperCase()}_API_KEY is not configured.`);
  if (
    !(
      groq ? /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/ : /^[a-zA-Z0-9._-]+$/
    ).test(options.model)
  )
    throw new Error(`Invalid ${label} model name.`);
  const history = options.history.slice(-maxHistoryTurns);
  if (history[0]?.role === "model") history.shift();
  if (history.length === 0 || history.at(-1)?.role !== "user")
    throw new Error("A user message is required.");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);
  const fetchWithRetry: typeof fetch = async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await (options.fetcher ?? fetch)(url, init);
      if (![502, 503, 504].includes(response.status) || attempt === 2) return response;
      await response.body?.cancel();
      await delay(1_000 * 2 ** attempt, undefined, { signal });
    }
  };
  const response = await fetchWithRetry(
    groq
      ? "https://api.groq.com/openai/v1/chat/completions"
      : `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(groq
          ? { Authorization: `Bearer ${options.apiKey}` }
          : { "x-goog-api-key": options.apiKey })
      },
      body: JSON.stringify(
        groq
          ? {
              model: options.model,
              stream: true,
              max_completion_tokens: 4096,
              messages: [
                {
                  role: "system",
                  content: `${systemInstruction}${options.context ? `\nRepository metadata: ${options.context}` : ""}`
                },
                ...history.map((turn) => ({
                  role: turn.role === "model" ? "assistant" : "user",
                  content: turn.text
                }))
              ]
            }
          : {
              systemInstruction: {
                parts: [
                  {
                    text: `${systemInstruction}${options.context ? `\nRepository metadata: ${options.context}` : ""}`
                  }
                ]
              },
              contents: history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }))
            }
      ),
      signal
    }
  );
  if ([502, 503, 504].includes(response.status))
    throw new Error(
      `${label} is temporarily unavailable (HTTP ${response.status}) after 3 attempts. Try again shortly, or choose another available model with repopilot chat --provider ${groq ? "groq" : "gemini"} --model <id>.`
    );
  if (groq && response.status === 404)
    throw new Error(
      "Groq model unavailable (HTTP 404). Select an available model with repopilot chat --provider groq --model <id>."
    );
  if (response.status === 404)
    throw new Error(
      `Gemini request failed (HTTP 404). Model "${options.model}" is unavailable or does not support this request. Try repopilot chat --provider gemini --model ${defaultGeminiModel}, or select a model available to your key in Google AI Studio.`
    );
  if (!response.ok)
    throw new Error(
      `${label} request failed (HTTP ${response.status}). ${response.status === 429 ? "Rate limit reached; wait before retrying or check your plan limits." : "Check the API key, model, and provider status."}`
    );
  if (!response.body) throw new Error(`${label} returned no response stream.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let eventLines: string[] = [];
  let reply = "";
  let bytes = 0;
  const dispatch = async (): Promise<void> => {
    const data = eventLines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    eventLines = [];
    if (!data || data === "[DONE]") return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      throw new Error(`${label} returned malformed streaming data.`);
    }
    if (!message || typeof message !== "object")
      throw new Error(`${label} returned malformed streaming data.`);
    const parts = groq
      ? [
          {
            text: (message as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta
              ?.content
          }
        ]
      : (message as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] })
          .candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (typeof part?.text !== "string") continue;
      reply += part.text;
      if (reply.length > maxReplyCharacters)
        throw new Error(`${label} reply exceeded the size limit.`);
      await options.onText(part.text);
    }
  };
  const consumeLines = async (chunk: string): Promise<void> => {
    pending += chunk;
    if (pending.length > maxResponseBytes)
      throw new Error(`${label} event exceeded the size limit.`);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line === "") await dispatch();
      else eventLines.push(line);
      newline = pending.indexOf("\n");
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error(`${label} response exceeded the size limit.`);
      await consumeLines(decoder.decode(value, { stream: true }));
    }
    await consumeLines(decoder.decode());
    if (pending) eventLines.push(pending);
    await dispatch();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!reply.trim())
    throw new Error(`${label} returned no text. The response may have been blocked.`);
  return reply;
}

export interface InteractiveChatOptions {
  provider?: ChatProvider;
  repositoryRoot: string;
  apiKey: string;
  model: string;
  includeContext: boolean;
  input: Readable;
  output: Writable;
  fetcher?: typeof fetch;
  animate: boolean;
}

export async function runInteractiveGeminiChat(options: InteractiveChatOptions): Promise<void> {
  const provider = options.provider ?? "gemini";
  const label = provider === "groq" ? "Groq" : "Gemini";
  if (!options.apiKey)
    throw new Error(
      `${provider.toUpperCase()}_API_KEY is missing. Run repopilot config ${provider}.`
    );
  const context = options.includeContext
    ? buildChatContext(await analyzeRepository(options.repositoryRoot))
    : undefined;
  const history: ChatTurn[] = [];
  const terminal = options.animate;
  const rl = createInterface({ input: options.input, output: options.output, terminal });
  options.output.write(`RepoPilot Chat · ${label} ${options.model}\n`);
  options.output.write(
    `${context ? "Sending bounded repository metadata, not source code." : "Repository context disabled."} Type /help for commands.\n\n`
  );
  if (provider === "gemini")
    options.output.write(
      "Gemini may be slower than Groq, especially during high demand. Speed varies by model and service availability. Switch with repopilot chat --provider groq.\n\n"
    );
  try {
    while (true) {
      let question: string;
      try {
        question = (await rl.question("you> ")).trim();
      } catch {
        break;
      }
      if (!question) continue;
      if (question === "/exit" || question === "/quit") break;
      if (question === "/clear") {
        history.length = 0;
        options.output.write("Conversation cleared.\n");
        continue;
      }
      if (question === "/help") {
        options.output.write("/clear  Forget this session's chat history\n/exit   Leave chat\n");
        continue;
      }
      if (question.length > 6_000) {
        options.output.write("Message too long (maximum 6,000 characters).\n");
        continue;
      }
      options.output.write(`${label}> `);
      const renderer = createTerminalMarkdown(
        (text) => {
          options.output.write(text);
        },
        terminal && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"
      );
      try {
        const reply = await streamGeminiReply({
          provider,
          apiKey: options.apiKey,
          model: options.model,
          history: [...history, { role: "user", text: question }],
          ...(context ? { context } : {}),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
          onText: (text) => renderer.write(text)
        });
        renderer.flush();
        history.push({ role: "user", text: question }, { role: "model", text: reply });
        if (history.length > maxHistoryTurns) history.splice(0, history.length - maxHistoryTurns);
        options.output.write("\n\n");
      } catch (error) {
        renderer.flush();
        const message =
          error instanceof Error && error.name === "TimeoutError"
            ? `${label} timed out. Try again shortly or choose another model.`
            : error instanceof Error
              ? error.message
              : `${label} request failed.`;
        options.output.write(`\n${message}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}

export const streamChatReply = streamGeminiReply;
export const runInteractiveChat = runInteractiveGeminiChat;
