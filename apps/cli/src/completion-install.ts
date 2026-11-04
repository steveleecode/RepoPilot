import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const completionEnableLine = 'eval "$(repopilot completion zsh --auto-menu)"';
const maximumConfigBytes = 1_048_576;
const marker = "# >>> RepoPilot completion >>>";
const endMarker = "# <<< RepoPilot completion <<<";
export type CompletionInstallResult = "enabled" | "already_enabled" | "declined";

export interface CompletionInstallOptions {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  confirm: (target: string) => Promise<boolean>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function completionConfigPath(
  options: Pick<CompletionInstallOptions, "homeDirectory" | "environment"> = {}
): Promise<string> {
  if (process.platform === "win32")
    throw new Error("Automatic zsh completion setup is supported on macOS and Linux.");
  const environment = options.environment ?? process.env;
  const directory = environment.ZDOTDIR || options.homeDirectory || homedir();
  if (
    !path.isAbsolute(directory) ||
    [...directory].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error(
      "Completion requires an absolute home or ZDOTDIR path without control characters."
    );
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Completion configuration directory must be an existing regular directory.");
  return path.join(await realpath(directory), ".zshrc");
}

function configured(content: Buffer): boolean {
  const text = content.toString("utf8");
  const enabled = text.split(/\r?\n/u).some((line) => line.trim() === completionEnableLine);
  if (!enabled && (text.includes(marker) || text.includes(endMarker)))
    throw new Error(
      "An incomplete RepoPilot completion block requires manual inspection; startup content was not changed."
    );
  return enabled;
}

async function readConfiguration(target: string): Promise<Buffer> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error(
        "Completion requires a single-link regular .zshrc; configure symlinks and special files manually."
      );
  } catch (error) {
    if (missing(error)) return Buffer.alloc(0);
    throw error;
  }
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missing(error)) return Buffer.alloc(0);
    throw new Error(
      "Cannot safely read .zshrc; symlinks and inaccessible files require manual setup."
    );
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximumConfigBytes)
      throw new Error("Completion requires a regular .zshrc of at most 1 MiB.");
    if (process.getuid && info.uid !== process.getuid())
      throw new Error("Completion requires a .zshrc owned by the current user.");
    return await boundedContents(file);
  } finally {
    await file.close();
  }
}

async function boundedContents(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumConfigBytes + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  if (bytesRead > maximumConfigBytes)
    throw new Error("Completion requires a .zshrc of at most 1 MiB.");
  return buffer.subarray(0, bytesRead);
}

/** Append only after explicit consent; never source or execute startup configuration. */
export async function installZshCompletion(
  options: CompletionInstallOptions
): Promise<CompletionInstallResult> {
  const target = await completionConfigPath(options);
  if (configured(await readConfiguration(target))) return "already_enabled";
  if (!(await options.confirm(target))) return "declined";
  const lockPath = `${target}.repopilot.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      "Completion configuration is locked; inspect .zshrc.repopilot.lock before retrying."
    );
  }
  try {
    if (configured(await readConfiguration(target))) return "already_enabled";
    const file = await open(
      target,
      constants.O_RDWR |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > maximumConfigBytes)
        throw new Error("Completion requires a regular .zshrc of at most 1 MiB.");
      if (process.getuid && info.uid !== process.getuid())
        throw new Error("Completion requires a .zshrc owned by the current user.");
      const original = await boundedContents(file);
      if (configured(original)) return "already_enabled";
      const current = await lstat(target);
      if (current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino)
        throw new Error("Completion configuration changed; retry after inspection.");
      const prefix = original.length && original[original.length - 1] !== 10 ? "\n" : "";
      await file.write(`${prefix}\n${marker}\n${completionEnableLine}\n${endMarker}\n`);
      await file.sync();
      return "enabled";
    } finally {
      await file.close();
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function askCompletionConsent(
  input: Readable,
  output: Writable,
  target: string,
  timeoutMs = 30_000
): Promise<boolean> {
  const readline = createInterface({ input, terminal: false });
  let failed: (() => void) | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      failed = () => {
        clearTimeout(timer);
        resolve(false);
      };
      input.once("error", failed);
      output.once("error", failed);
      readline.once("error", failed);
      readline.once("line", (answer) => {
        clearTimeout(timer);
        resolve(/^(y|yes)$/iu.test(answer.trim()));
      });
      readline.once("close", () => {
        clearTimeout(timer);
        resolve(false);
      });
      output.write(`\nEnable RepoPilot command menus in ${target}? [y/N] `);
    });
  } finally {
    readline.close();
    if (failed) {
      input.off("error", failed);
      output.off("error", failed);
    }
  }
}

export async function setupCompletionInTerminal(
  options: {
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {}
): Promise<CompletionInstallResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      "Completion setup requires an interactive terminal. Run repopilot completion install zsh in your terminal."
    );
  return installZshCompletion({
    ...options,
    confirm: (target) => askCompletionConsent(input, output, target)
  });
}
