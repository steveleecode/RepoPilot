import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProposedFile } from "@repopilot/generator";
import type { Evidence } from "@repopilot/shared";
import { normalizeRelativePath } from "@repopilot/shared";

export type ValidationStatus = "passed" | "failed" | "skipped";
export type Repairability = "automatic" | "manual" | "none";

export interface ValidationFinding {
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
  evidence?: Evidence[];
}

export interface ExecutedCommand {
  command: string;
  exitCode: number;
  durationMs: number;
}

export interface ValidationResult {
  validatorId: string;
  status: ValidationStatus;
  summary: string;
  findings: ValidationFinding[];
  commandsExecuted: ExecutedCommand[];
  exitCode?: number;
  durationMs: number;
  evidence: Evidence[];
  repairability: Repairability;
}

export interface ValidationContext {
  repositoryRoot: string;
  proposedFiles: ProposedFile[];
  packageJson?: { scripts?: Record<string, string> };
}

export type Validator = (
  context: ValidationContext
) => Promise<ValidationResult> | ValidationResult;

export async function runValidationPipeline(
  validators: Validator[],
  context: ValidationContext
): Promise<ValidationResult[]> {
  return Promise.all(validators.map(async (validator) => Promise.resolve(validator(context))));
}

export const validateGeneratedJson: Validator = (context) => {
  const findings: ValidationFinding[] = [];
  for (const file of context.proposedFiles.filter((candidate) =>
    candidate.path.endsWith(".json")
  )) {
    try {
      JSON.parse(file.content);
    } catch (error) {
      findings.push({
        severity: "error",
        message: error instanceof Error ? error.message : "Invalid JSON.",
        path: file.path,
        evidence: file.provenance.evidence
      });
    }
  }
  return result(
    "generated-json",
    findings,
    findings.length === 0
      ? "Generated JSON parses successfully."
      : "Generated JSON contains errors."
  );
};

export const validateGeneratedYaml: Validator = (context) => {
  const findings: ValidationFinding[] = [];
  for (const file of context.proposedFiles.filter((candidate) =>
    /\.(ya?ml)$/u.test(candidate.path)
  )) {
    try {
      parseYaml(file.content);
    } catch (error) {
      findings.push({
        severity: "error",
        message: error instanceof Error ? error.message : "Invalid YAML.",
        path: file.path,
        evidence: file.provenance.evidence
      });
    }
  }
  return result(
    "generated-yaml",
    findings,
    findings.length === 0
      ? "Generated YAML parses successfully."
      : "Generated YAML contains errors."
  );
};

export function validateReferencedPathExists(paths: string[]): Validator {
  return (context) => {
    const findings = paths.flatMap((requestedPath): ValidationFinding[] => {
      const relativePath = normalizeRelativePath(requestedPath);
      const absolute = path.join(context.repositoryRoot, relativePath);
      const proposed = context.proposedFiles.some((file) => file.path === relativePath);
      if (proposed || existsSync(absolute)) return [];
      return [
        {
          severity: "error",
          message: `Referenced path does not exist: ${relativePath}`,
          path: relativePath
        }
      ];
    });
    return result(
      "referenced-path-exists",
      findings,
      findings.length === 0
        ? "Referenced paths exist."
        : "One or more referenced paths are missing."
    );
  };
}

export function validateReferencedPackageScripts(scriptNames: string[]): Validator {
  return (context) => {
    const scripts = context.packageJson?.scripts ?? {};
    const findings = scriptNames.flatMap((scriptName): ValidationFinding[] =>
      Object.hasOwn(scripts, scriptName)
        ? []
        : [{ severity: "error", message: `package.json script is missing: ${scriptName}` }]
    );
    return result(
      "referenced-package-scripts",
      findings,
      findings.length === 0
        ? "Referenced package.json scripts exist."
        : "Missing package.json scripts."
    );
  };
}

export const validateDuplicateProposedFilePaths: Validator = (context) => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const file of context.proposedFiles) {
    const normalized = normalizeRelativePath(file.path);
    if (seen.has(normalized)) duplicates.add(normalized);
    seen.add(normalized);
  }
  const findings = [...duplicates].map((filePath) => ({
    severity: "error" as const,
    message: `Duplicate proposed file path: ${filePath}`,
    path: filePath
  }));
  return result(
    "duplicate-proposed-file-paths",
    findings,
    findings.length === 0
      ? "No duplicate proposed file paths."
      : "Duplicate proposed file paths found."
  );
};

function result(
  validatorId: string,
  findings: ValidationFinding[],
  summary: string
): ValidationResult {
  const started = performance.now();
  return {
    validatorId,
    status: findings.some((finding) => finding.severity === "error") ? "failed" : "passed",
    summary,
    findings,
    commandsExecuted: [],
    durationMs: Math.max(0, performance.now() - started),
    evidence: [],
    repairability: findings.length > 0 ? "manual" : "none"
  };
}
