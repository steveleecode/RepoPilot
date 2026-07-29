import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Evidence, Severity } from "@repopilot/shared";

export type LanguageName = "TypeScript" | "JavaScript" | "Python" | "Rust" | "Go";
export type PackageManagerName = "pnpm" | "yarn" | "npm";

export interface DetectedFact<T> {
  value: T;
  evidence: Evidence[];
}

export interface RepositoryMetadata {
  rootPath: string;
  isGitRepository: DetectedFact<boolean>;
  topLevelFiles: DetectedFact<string[]>;
}

export interface DetectedLanguage {
  name: LanguageName;
  evidence: Evidence[];
}

export interface DetectedPackageManager {
  name: PackageManagerName;
  lockfile: string;
  evidence: Evidence[];
}

export interface DetectedManifest {
  path: string;
  kind: "package.json" | "pyproject.toml" | "requirements.txt" | "Cargo.toml" | "go.mod";
  evidence: Evidence[];
}

export interface DetectedCommand {
  name: string;
  command: string;
  evidence: Evidence[];
}

export interface DetectedTool {
  name: string;
  evidence: Evidence[];
}

export interface DetectedCiWorkflow {
  path: string;
  evidence: Evidence[];
}

export interface AgentInstructionFile {
  path: string;
  evidence: Evidence[];
}

export interface AnalysisWarning {
  severity: Severity;
  message: string;
  evidence?: Evidence[];
}

export interface RepositoryAnalysis {
  metadata: RepositoryMetadata;
  languages: DetectedLanguage[];
  packageManagers: DetectedPackageManager[];
  manifests: DetectedManifest[];
  scripts: DetectedCommand[];
  testFrameworks: DetectedTool[];
  formattingTools: DetectedTool[];
  lintingTools: DetectedTool[];
  typeCheckingTools: DetectedTool[];
  ciWorkflows: DetectedCiWorkflow[];
  agentInstructions: AgentInstructionFile[];
  warnings: AnalysisWarning[];
}

const manifestKinds = new Set<DetectedManifest["kind"]>([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod"
]);

export async function analyzeRepository(rootPath: string): Promise<RepositoryAnalysis> {
  const absoluteRoot = path.resolve(rootPath);
  const topLevelEntries = await safeReadDir(absoluteRoot);
  const topLevelFiles = topLevelEntries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.name);
  const topLevelNames = new Set(topLevelEntries.map((entry) => entry.name));
  const gitPath = path.join(absoluteRoot, ".git");
  const isGitRepository = await exists(gitPath);

  const manifests = [...manifestKinds]
    .filter((name) => topLevelNames.has(name))
    .map((kind) => ({
      path: kind,
      kind,
      evidence: [evidence(kind, "manifest", `Found ${kind} at the repository root.`)]
    }));

  const packageManagers: DetectedPackageManager[] = [];
  if (topLevelNames.has("pnpm-lock.yaml")) {
    packageManagers.push(lockfileManager("pnpm", "pnpm-lock.yaml"));
  }
  if (topLevelNames.has("yarn.lock")) {
    packageManagers.push(lockfileManager("yarn", "yarn.lock"));
  }
  if (topLevelNames.has("package-lock.json")) {
    packageManagers.push(lockfileManager("npm", "package-lock.json"));
  }

  const ciWorkflows = await detectWorkflows(absoluteRoot);
  const agentInstructions = topLevelNames.has("AGENTS.md")
    ? [
        {
          path: "AGENTS.md",
          evidence: [evidence("AGENTS.md", "filesystem", "Found root agent instruction file.")]
        }
      ]
    : [];

  return {
    metadata: {
      rootPath: absoluteRoot,
      isGitRepository: {
        value: isGitRepository,
        evidence: [
          evidence(
            ".git",
            "filesystem",
            isGitRepository
              ? "Found a .git entry at the repository root."
              : "No .git entry at the repository root."
          )
        ]
      },
      topLevelFiles: {
        value: topLevelFiles,
        evidence: [evidence(".", "filesystem", "Read top-level repository entries.")]
      }
    },
    languages: inferLanguages(manifests),
    packageManagers,
    manifests,
    scripts: [],
    testFrameworks: [],
    formattingTools: [],
    lintingTools: [],
    typeCheckingTools: [],
    ciWorkflows,
    agentInstructions,
    warnings: []
  };
}

function inferLanguages(manifests: DetectedManifest[]): DetectedLanguage[] {
  const languages = new Map<LanguageName, Evidence[]>();
  const add = (name: LanguageName, item: DetectedManifest) => {
    languages.set(name, [...(languages.get(name) ?? []), ...item.evidence]);
  };

  for (const item of manifests) {
    if (item.kind === "package.json") add("JavaScript", item);
    if (item.kind === "pyproject.toml" || item.kind === "requirements.txt") add("Python", item);
    if (item.kind === "Cargo.toml") add("Rust", item);
    if (item.kind === "go.mod") add("Go", item);
  }

  return [...languages.entries()].map(([name, itemEvidence]) => ({ name, evidence: itemEvidence }));
}

async function detectWorkflows(rootPath: string): Promise<DetectedCiWorkflow[]> {
  const workflowsRoot = path.join(rootPath, ".github", "workflows");
  const entries = await safeReadDir(workflowsRoot);
  return entries
    .filter((entry) => entry.type === "file" && /\.(ya?ml)$/u.test(entry.name))
    .map((entry) => ({
      path: `.github/workflows/${entry.name}`,
      evidence: [
        evidence(
          `.github/workflows/${entry.name}`,
          "workflow",
          "Found a GitHub Actions workflow file."
        )
      ]
    }));
}

function lockfileManager(name: PackageManagerName, lockfile: string): DetectedPackageManager {
  return {
    name,
    lockfile,
    evidence: [evidence(lockfile, "manifest", `Found ${lockfile} lockfile.`)]
  };
}

function evidence(
  sourcePath: string,
  sourceType: Evidence["sourceType"],
  description: string
): Evidence {
  return { sourcePath, sourceType, description };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadDir(
  directory: string
): Promise<Array<{ name: string; type: "file" | "directory" }>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file"
    }));
  } catch {
    return [];
  }
}

export async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
