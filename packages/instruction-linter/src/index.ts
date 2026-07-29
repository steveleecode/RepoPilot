import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeRelativePath } from "@repopilot/shared";

export type InstructionSeverity = "info" | "warning" | "error";

export interface InstructionLintFinding {
  ruleId: string;
  severity: InstructionSeverity;
  line?: number;
  explanation: string;
  suggestedRemediation: string;
}

export interface InstructionLintOptions {
  repositoryRoot: string;
  lineThreshold?: number;
  packageJson?: { scripts?: Record<string, string> };
}

export function lintInstructions(
  content: string,
  options: InstructionLintOptions
): InstructionLintFinding[] {
  const lines = content.split(/\r?\n/u);
  return [
    ...checkLineThreshold(lines, options.lineThreshold ?? 200),
    ...checkDuplicateHeadings(lines),
    ...checkDuplicateInstructionLines(lines),
    ...checkMissingPaths(lines, options.repositoryRoot),
    ...checkMissingPackageScripts(lines, options.packageJson?.scripts ?? {}),
    ...checkCommandConflicts(lines)
  ];
}

function checkLineThreshold(lines: string[], threshold: number): InstructionLintFinding[] {
  return lines.length > threshold
    ? [
        {
          ruleId: "line-threshold",
          severity: "warning",
          explanation: `Instruction file has ${lines.length} lines, exceeding the configured threshold of ${threshold}.`,
          suggestedRemediation:
            "Move durable policy into focused documentation and keep AGENTS.md immediately actionable."
        }
      ]
    : [];
}

function checkDuplicateHeadings(lines: string[]): InstructionLintFinding[] {
  const headings = new Map<string, number>();
  const findings: InstructionLintFinding[] = [];
  lines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
    if (!match?.[2]) return;
    const normalized = match[2].trim().toLowerCase();
    const firstLine = headings.get(normalized);
    if (firstLine) {
      findings.push({
        ruleId: "duplicate-heading",
        severity: "warning",
        line: index + 1,
        explanation: `Duplicate heading also appears on line ${firstLine}.`,
        suggestedRemediation: "Merge the duplicate heading sections or rename one section."
      });
    } else {
      headings.set(normalized, index + 1);
    }
  });
  return findings;
}

function checkDuplicateInstructionLines(lines: string[]): InstructionLintFinding[] {
  const seen = new Map<string, number>();
  const findings: InstructionLintFinding[] = [];
  lines.forEach((line, index) => {
    const normalized = line.trim();
    if (!normalized || normalized.startsWith("#")) return;
    const firstLine = seen.get(normalized);
    if (firstLine) {
      findings.push({
        ruleId: "duplicate-instruction-line",
        severity: "warning",
        line: index + 1,
        explanation: `Exact instruction line is duplicated from line ${firstLine}.`,
        suggestedRemediation: "Remove the duplicate line or consolidate the repeated guidance."
      });
    } else {
      seen.set(normalized, index + 1);
    }
  });
  return findings;
}

function checkMissingPaths(lines: string[], repositoryRoot: string): InstructionLintFinding[] {
  const findings: InstructionLintFinding[] = [];
  lines.forEach((line, index) => {
    for (const candidate of extractCodeSpans(line)) {
      if (!looksLikePath(candidate)) continue;
      const relativePath = normalizeRelativePath(candidate);
      if (!existsSync(path.join(repositoryRoot, relativePath))) {
        findings.push({
          ruleId: "missing-repository-path",
          severity: "error",
          line: index + 1,
          explanation: `Referenced repository path does not exist: ${relativePath}.`,
          suggestedRemediation: "Update the reference or create the documented path."
        });
      }
    }
  });
  return findings;
}

function checkMissingPackageScripts(
  lines: string[],
  scripts: Record<string, string>
): InstructionLintFinding[] {
  const findings: InstructionLintFinding[] = [];
  lines.forEach((line, index) => {
    for (const scriptName of extractPackageScripts(line)) {
      if (!Object.hasOwn(scripts, scriptName)) {
        findings.push({
          ruleId: "missing-package-script",
          severity: "error",
          line: index + 1,
          explanation: `Referenced package.json script does not exist: ${scriptName}.`,
          suggestedRemediation: "Update AGENTS.md or add the script to package.json."
        });
      }
    }
  });
  return findings;
}

function checkCommandConflicts(lines: string[]): InstructionLintFinding[] {
  const required = new Map<string, number>();
  const prohibited = new Map<string, number>();

  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const command of extractCodeSpans(line)) {
      if (/(must|always|required|require)\b/u.test(lower)) required.set(command, index + 1);
      if (/(must not|never|prohibit|do not|don't)\b/u.test(lower))
        prohibited.set(command, index + 1);
    }
  });

  const findings: InstructionLintFinding[] = [];
  for (const [command, requiredLine] of required) {
    const prohibitedLine = prohibited.get(command);
    if (!prohibitedLine) continue;
    findings.push({
      ruleId: "conflicting-command-instruction",
      severity: "error",
      line: prohibitedLine,
      explanation: `Command \`${command}\` is both required on line ${requiredLine} and prohibited on line ${prohibitedLine}.`,
      suggestedRemediation: "Clarify whether the command is required or prohibited."
    });
  }
  return findings;
}

function extractCodeSpans(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]?.trim()).filter(isPresent);
}

function extractPackageScripts(line: string): string[] {
  const scripts = new Set<string>();
  for (const code of extractCodeSpans(line)) {
    const match = /(?:pnpm|npm run|yarn)\s+([A-Za-z0-9:_-]+)/u.exec(code);
    if (match?.[1]) scripts.add(match[1]);
  }
  return [...scripts];
}

function looksLikePath(candidate: string): boolean {
  return (
    candidate.startsWith("./") ||
    candidate.includes("/") ||
    /\.(md|json|ya?ml|toml|ts|tsx|js|jsx|css)$/u.test(candidate)
  );
}

function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
