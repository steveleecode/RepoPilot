import { z } from "zod";

export const evidenceSourceTypeSchema = z.enum(["manifest", "config", "workflow", "filesystem"]);

export const evidenceSchema = z.object({
  sourcePath: z.string().min(1),
  sourceType: evidenceSourceTypeSchema,
  description: z.string().min(1)
});

export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export type Severity = "info" | "warning" | "error";

export interface RepoPilotError {
  code: string;
  message: string;
  cause?: unknown;
}

export type Result<T, E = RepoPilotError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: string, message: string, cause?: unknown): Result<never> {
  return { ok: false, error: { code, message, cause } };
}

export interface FileStat {
  path: string;
  type: "file" | "directory";
}

export interface FileSystemReader {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  list(path: string): Promise<FileStat[]>;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function normalizeRelativePath(path: string): string {
  const cleaned = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = cleaned.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    throw new Error(`Path traversal is not allowed: ${path}`);
  }
  return segments.join("/");
}
