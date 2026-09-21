import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "@repopilot/shared";

export interface CommandDefinition {
  id: string;
  executable: string;
  fixedArguments?: readonly string[];
  allowedArgumentVectors?: readonly (readonly string[])[];
  workingDirectoryScopes?: readonly string[];
}

export interface CommandRequest {
  commandId: string;
  arguments?: readonly string[];
  workingDirectory?: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CommandAuthorization {
  allowed: boolean;
  reasons: string[];
  commandId: string;
  workingDirectory?: string;
}

export type CommandExecutionStatus =
  "completed" | "failed" | "denied" | "timed_out" | "output_limit" | "cancelled" | "spawn_error";

export interface CommandExecutionResult {
  commandId: string;
  status: CommandExecutionStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
  workingDirectory?: string;
  denialReasons?: string[];
  error?: string;
}

export interface LocalCommandExecutorOptions {
  repositoryRoot: string;
  commands: readonly CommandDefinition[];
  environment?: Readonly<Record<string, string>>;
  allowedEnvironmentVariables?: readonly string[];
  redactedValues?: readonly string[];
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
  terminationGraceMs?: number;
}

export interface ExecuteCommandOptions {
  signal?: AbortSignal;
}

export interface CommandExecutor {
  authorize(request: CommandRequest): Promise<CommandAuthorization>;
  execute(
    request: CommandRequest,
    options?: ExecuteCommandOptions
  ): Promise<CommandExecutionResult>;
}

interface AuthorizedCommand {
  definition: CommandDefinition;
  arguments: string[];
  workingDirectory: string;
  relativeWorkingDirectory: string;
  environment: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

const defaultTimeoutMs = 60_000;
const defaultMaxOutputBytes = 1_000_000;
const defaultTerminationGraceMs = 1_000;

export class LocalCommandExecutor implements CommandExecutor {
  private readonly repositoryRoot: string;
  private readonly commands: ReadonlyMap<string, CommandDefinition>;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly allowedEnvironmentVariables: ReadonlySet<string>;
  private readonly redactedValues: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly terminationGraceMs: number;

  constructor(options: LocalCommandExecutorOptions) {
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.commands = commandMap(options.commands);
    this.allowedEnvironmentVariables = new Set(options.allowedEnvironmentVariables ?? []);
    this.environment = filterEnvironment(
      options.environment ?? {},
      this.allowedEnvironmentVariables
    );
    this.redactedValues = (options.redactedValues ?? []).filter((value) => value.length >= 4);
    this.timeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? defaultTimeoutMs,
      "defaultTimeoutMs"
    );
    this.maxOutputBytes = positiveInteger(
      options.defaultMaxOutputBytes ?? defaultMaxOutputBytes,
      "defaultMaxOutputBytes"
    );
    this.terminationGraceMs = positiveInteger(
      options.terminationGraceMs ?? defaultTerminationGraceMs,
      "terminationGraceMs"
    );
  }

  async authorize(request: CommandRequest): Promise<CommandAuthorization> {
    const authorized = await this.resolve(request);
    if ("reasons" in authorized) return authorized;
    return {
      allowed: true,
      reasons: [],
      commandId: request.commandId,
      workingDirectory: authorized.relativeWorkingDirectory
    };
  }

  async execute(
    request: CommandRequest,
    options: ExecuteCommandOptions = {}
  ): Promise<CommandExecutionResult> {
    const startedAt = performance.now();
    const authorized = await this.resolve(request);
    if ("reasons" in authorized) {
      return {
        commandId: request.commandId,
        status: "denied",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: elapsed(startedAt),
        outputTruncated: false,
        denialReasons: authorized.reasons
      };
    }
    if (options.signal?.aborted) {
      return emptyResult(
        request.commandId,
        "cancelled",
        startedAt,
        authorized.relativeWorkingDirectory
      );
    }
    return await this.spawnAuthorized(authorized, options.signal, startedAt);
  }

  private async resolve(
    request: CommandRequest
  ): Promise<AuthorizedCommand | CommandAuthorization> {
    const reasons: string[] = [];
    const definition = this.commands.get(request.commandId);
    if (!definition) {
      return {
        allowed: false,
        reasons: ["Command is not in the trusted catalog."],
        commandId: request.commandId
      };
    }

    const requestedArguments = [...(request.arguments ?? [])];
    if (!validStrings(requestedArguments)) reasons.push("Command arguments contain invalid bytes.");
    const variants = definition.allowedArgumentVectors ?? [[]];
    if (!variants.some((variant) => sameStrings(variant, requestedArguments))) {
      reasons.push("Command arguments are not an explicitly allowed variant.");
    }

    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? this.maxOutputBytes;
    if (!isPositiveInteger(timeoutMs)) reasons.push("Command timeout must be a positive integer.");
    else if (timeoutMs > this.timeoutMs)
      reasons.push("Command timeout exceeds the executor limit.");
    if (!isPositiveInteger(maxOutputBytes))
      reasons.push("Command output limit must be a positive integer.");
    else if (maxOutputBytes > this.maxOutputBytes)
      reasons.push("Command output limit exceeds the executor limit.");

    const environment = { ...this.environment };
    for (const [name, value] of Object.entries(request.environment ?? {})) {
      if (!this.allowedEnvironmentVariables.has(name)) {
        reasons.push(`Environment variable is not allowed: ${name}.`);
      } else if (!validEnvironmentEntry(name, value)) {
        reasons.push(`Environment variable is invalid: ${name}.`);
      } else {
        environment[name] = value;
      }
    }

    const requestedDirectory = request.workingDirectory ?? ".";
    let relativeWorkingDirectory = ".";
    let workingDirectory: string | undefined;
    try {
      relativeWorkingDirectory = normalizeWorkingDirectory(requestedDirectory);
      if (!isInAllowedScope(relativeWorkingDirectory, definition.workingDirectoryScopes ?? ["."])) {
        reasons.push("Working directory is outside the command's allowed scopes.");
      }
      const realRoot = await realpath(this.repositoryRoot);
      workingDirectory = await realpath(
        path.resolve(this.repositoryRoot, relativeWorkingDirectory)
      );
      if (!isWithin(realRoot, workingDirectory)) {
        reasons.push("Working directory resolves outside the repository root.");
      }
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : "Working directory is invalid.");
    }

    if (reasons.length > 0 || !workingDirectory) {
      return {
        allowed: false,
        reasons,
        commandId: request.commandId,
        workingDirectory: relativeWorkingDirectory
      };
    }

    return {
      definition,
      arguments: [...(definition.fixedArguments ?? []), ...requestedArguments],
      workingDirectory,
      relativeWorkingDirectory,
      environment,
      timeoutMs,
      maxOutputBytes
    };
  }

  private async spawnAuthorized(
    command: AuthorizedCommand,
    abortSignal: AbortSignal | undefined,
    startedAt: number
  ): Promise<CommandExecutionResult> {
    return await new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command.definition.executable, command.arguments, {
          cwd: command.workingDirectory,
          env: command.environment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
        child.stdin.end();
      } catch (error) {
        resolve(
          spawnErrorResult(
            command.definition.id,
            error,
            startedAt,
            command.relativeWorkingDirectory
          )
        );
        return;
      }

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let totalBytes = 0;
      let forcedStatus: CommandExecutionStatus | undefined;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const stop = (status: CommandExecutionStatus): void => {
        if (!forcedStatus) forcedStatus = status;
        child.kill("SIGTERM");
        forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), this.terminationGraceMs);
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = Math.max(0, command.maxOutputBytes - totalBytes);
        const accepted = chunk.subarray(0, remaining);
        totalBytes += accepted.byteLength;
        if (target === "stdout") stdout = Buffer.concat([stdout, accepted]);
        else stderr = Buffer.concat([stderr, accepted]);
        if (accepted.byteLength < chunk.byteLength) stop("output_limit");
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timer = setTimeout(() => stop("timed_out"), command.timeoutMs);
      const onAbort = (): void => stop("cancelled");
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (abortSignal?.aborted) onAbort();

      const finish = (result: CommandExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      child.once("error", (error) => {
        finish(
          spawnErrorResult(
            command.definition.id,
            error,
            startedAt,
            command.relativeWorkingDirectory
          )
        );
      });
      child.once("close", (exitCode, signal) => {
        const status = forcedStatus ?? (exitCode === 0 ? "completed" : "failed");
        finish({
          commandId: command.definition.id,
          status,
          exitCode,
          signal,
          stdout: redact(stdout.toString("utf8"), this.redactedValues),
          stderr: redact(stderr.toString("utf8"), this.redactedValues),
          durationMs: elapsed(startedAt),
          outputTruncated: status === "output_limit",
          workingDirectory: command.relativeWorkingDirectory
        });
      });
    });
  }
}

function commandMap(
  commands: readonly CommandDefinition[]
): ReadonlyMap<string, CommandDefinition> {
  const result = new Map<string, CommandDefinition>();
  for (const command of commands) {
    if (!command.id.trim() || command.id !== command.id.trim() || result.has(command.id)) {
      throw new Error(`Command ID must be non-empty and unique: ${command.id}`);
    }
    if (!command.executable.trim() || command.executable.includes("\0")) {
      throw new Error(`Command executable is invalid: ${command.id}`);
    }
    if (!validStrings(command.fixedArguments ?? [])) {
      throw new Error(`Fixed command arguments are invalid: ${command.id}`);
    }
    for (const variant of command.allowedArgumentVectors ?? []) {
      if (!validStrings(variant)) throw new Error(`Allowed arguments are invalid: ${command.id}`);
    }
    for (const scope of command.workingDirectoryScopes ?? ["."]) normalizeWorkingDirectory(scope);
    result.set(command.id, {
      id: command.id,
      executable: command.executable,
      fixedArguments: [...(command.fixedArguments ?? [])],
      allowedArgumentVectors: (command.allowedArgumentVectors ?? [[]]).map((variant) => [
        ...variant
      ]),
      workingDirectoryScopes: [...(command.workingDirectoryScopes ?? ["."])]
    });
  }
  return result;
}

function filterEnvironment(
  environment: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!allowed.has(name)) throw new Error(`Environment variable is not allowed: ${name}.`);
    if (!validEnvironmentEntry(name, value)) {
      throw new Error(`Environment variable is invalid: ${name}.`);
    }
    result[name] = value;
  }
  return result;
}

function validEnvironmentEntry(name: string, value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !value.includes("\0");
}

function validStrings(values: readonly string[]): boolean {
  return values.every((value) => !value.includes("\0"));
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function normalizeWorkingDirectory(value: string): string {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("Working directory must be repository-relative.");
  }
  const normalized = normalizeRelativePath(value);
  return normalized || ".";
}

function isInAllowedScope(workingDirectory: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => {
    const normalizedScope = normalizeWorkingDirectory(scope);
    return (
      workingDirectory === normalizedScope || workingDirectory.startsWith(`${normalizedScope}/`)
    );
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function positiveInteger(value: number, label: string): number {
  if (!isPositiveInteger(value)) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function redact(value: string, explicitValues: readonly string[]): string {
  let redacted = value;
  for (const secret of explicitValues) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s;,]+/giu, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]");
}

function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function emptyResult(
  commandId: string,
  status: CommandExecutionStatus,
  startedAt: number,
  workingDirectory: string
): CommandExecutionResult {
  return {
    commandId,
    status,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    durationMs: elapsed(startedAt),
    outputTruncated: false,
    workingDirectory
  };
}

function spawnErrorResult(
  commandId: string,
  error: unknown,
  startedAt: number,
  workingDirectory: string
): CommandExecutionResult {
  return {
    ...emptyResult(commandId, "spawn_error", startedAt, workingDirectory),
    error: redact(error instanceof Error ? error.message : "Command failed to start.", [])
  };
}
