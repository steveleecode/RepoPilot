import { spawnSync } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";

const localDirectory = ".repopilot";
const envFile = ".env";
const maxEnvBytes = 65_536;

export const geminiEnvPath = path.posix.join(localDirectory, envFile);

async function typeOf(target: string): Promise<"missing" | "file" | "directory" | "symlink"> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function ensureLocalConfigDirectory(repositoryRoot: string): Promise<string> {
  const directory = path.join(repositoryRoot, localDirectory);
  const kind = await typeOf(directory);
  if (kind === "symlink") throw new Error("Refusing to use a symlinked .repopilot directory.");
  if (kind === "file") throw new Error(".repopilot must be a directory.");
  if (kind === "missing") await mkdir(directory);
  return directory;
}

async function ensureSecretIgnored(directory: string): Promise<void> {
  const ignorePath = path.join(directory, ".gitignore");
  const kind = await typeOf(ignorePath);
  if (kind === "symlink" || kind === "directory")
    throw new Error("Refusing to update a non-file .repopilot/.gitignore.");
  if (kind === "missing") {
    await writeFile(ignorePath, ".env\n.env.tmp-*\n", { flag: "wx" });
    return;
  }
  const existing = await readFile(ignorePath, "utf8");
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const missing = [".env", ".env.tmp-*"].filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  await appendFile(ignorePath, `${existing.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
}

export async function prepareGeminiEnv(repositoryRoot: string): Promise<void> {
  const directory = await ensureLocalConfigDirectory(repositoryRoot);
  assertUntracked(repositoryRoot);
  await ensureSecretIgnored(directory);
}

function assertUntracked(repositoryRoot: string): void {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", geminiEnvPath], {
    cwd: repositoryRoot,
    stdio: "ignore",
    timeout: 5_000
  });
  if (result.status === 0)
    throw new Error(".repopilot/.env is tracked by Git. Untrack it before saving a secret.");
  if (result.error) throw new Error("Could not verify Git tracking for .repopilot/.env.");
}

function validateKey(key: string): string {
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_.-]{16,512}$/.test(trimmed))
    throw new Error(
      "Gemini API key must be a single 16–512 character token (letters, numbers, _, -, or .)."
    );
  return trimmed;
}

export async function saveGeminiKey(repositoryRoot: string, key: string): Promise<void> {
  const value = validateKey(key);
  const directory = await ensureLocalConfigDirectory(repositoryRoot);
  const target = path.join(directory, envFile);
  const kind = await typeOf(target);
  if (kind === "symlink" || kind === "directory")
    throw new Error("Refusing to replace a non-file .repopilot/.env.");
  await prepareGeminiEnv(repositoryRoot);
  let lines: string[] = [];
  if (kind === "file") {
    const existing = await readFile(target, "utf8");
    if (Buffer.byteLength(existing) > maxEnvBytes) throw new Error(".repopilot/.env is too large.");
    lines = existing
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !/^\s*GEMINI_API_KEY\s*=/.test(line));
  }
  lines.push(`GEMINI_API_KEY=${value}`);
  const temporary = path.join(directory, `.env.tmp-${crypto.randomUUID()}`);
  try {
    await writeFile(temporary, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function loadGeminiKey(repositoryRoot: string): Promise<string | null> {
  const directory = path.join(repositoryRoot, localDirectory);
  if ((await typeOf(directory)) === "symlink")
    throw new Error("Refusing to use a symlinked .repopilot directory.");
  const target = path.join(directory, envFile);
  const kind = await typeOf(target);
  if (kind === "missing") return null;
  if (kind !== "file") throw new Error("Refusing to read a non-file .repopilot/.env.");
  assertUntracked(repositoryRoot);
  const { size } = await lstat(target);
  if (size > maxEnvBytes) throw new Error(".repopilot/.env is too large.");
  const content = await readFile(target, "utf8");
  const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
  return match ? validateKey(match[1] ?? "") : null;
}

export async function readKeyFromStdin(input: NodeJS.ReadableStream): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk))
      throw new Error("Gemini API key input must be text.");
    value += chunk.toString();
    if (value.length > 1_024) throw new Error("Gemini API key input is too large.");
  }
  return validateKey(value);
}

export async function promptGeminiKey(
  input: ReadStream,
  output: WriteStream
): Promise<string | null> {
  if (!input.isTTY || !output.isTTY)
    throw new Error("A terminal is required for hidden key entry.");
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else {
        try {
          resolve(value ? validateKey(value) : null);
        } catch (validationError) {
          reject(
            validationError instanceof Error
              ? validationError
              : new Error("Invalid Gemini API key input.")
          );
        }
      }
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new Error("Gemini key entry cancelled."));
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        if (/^[\x20-\x7e]$/.test(character) && value.length < 1_024) {
          value += character;
          output.write("*");
        }
      }
    };
    output.write("Gemini API key (hidden; Enter to skip): ");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
