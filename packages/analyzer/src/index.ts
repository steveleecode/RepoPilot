import { spawnSync } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Evidence, Severity } from "@repopilot/shared";

export type LanguageName = "TypeScript" | "JavaScript" | "Python" | "Rust" | "Go";
export type PackageManagerName = "pnpm" | "yarn" | "npm";
export type ManifestKind =
  "package.json" | "pyproject.toml" | "requirements.txt" | "Cargo.toml" | "go.mod";

export interface DetectedFact<T> {
  value: T;
  evidence: Evidence[];
}

export interface RepositoryMetadata {
  rootPath: string;
  isGitRepository: DetectedFact<boolean>;
  currentBranch: DetectedFact<string | null>;
  isDirty: DetectedFact<boolean | null>;
  topLevelFiles: DetectedFact<string[]>;
  topLevelDirectories: DetectedFact<string[]>;
  scannedFileCount: DetectedFact<number>;
  scanTruncated: DetectedFact<boolean>;
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
  kind: ManifestKind;
  evidence: Evidence[];
}

export interface DetectedCommand {
  name: string;
  command: string;
  packagePath: string;
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

export interface DetectedWorkspace {
  kind: "pnpm" | "npm" | "yarn" | "turbo";
  configPath: string;
  packagePatterns: string[];
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
  workspaces: DetectedWorkspace[];
  scripts: DetectedCommand[];
  testFrameworks: DetectedTool[];
  formattingTools: DetectedTool[];
  lintingTools: DetectedTool[];
  typeCheckingTools: DetectedTool[];
  ciWorkflows: DetectedCiWorkflow[];
  agentInstructions: AgentInstructionFile[];
  warnings: AnalysisWarning[];
}

export interface AnalyzerOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxMetadataFileBytes?: number;
}

interface RepositoryScan {
  files: string[];
  directories: string[];
  warnings: AnalysisWarning[];
  truncated: boolean;
}

interface PackageJsonData {
  path: string;
  scripts: Record<string, string>;
  dependencies: Set<string>;
  workspacePatterns: string[];
}

const manifestNames = new Set<ManifestKind>([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod"
]);

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "test-results",
  "vendor"
]);

const toolDependencies = {
  test: new Map([
    ["vitest", "vitest"],
    ["jest", "jest"],
    ["mocha", "mocha"],
    ["ava", "ava"],
    ["@playwright/test", "playwright"],
    ["cypress", "cypress"]
  ]),
  format: new Map([
    ["prettier", "prettier"],
    ["@biomejs/biome", "biome"],
    ["dprint", "dprint"]
  ]),
  lint: new Map([
    ["eslint", "eslint"],
    ["@biomejs/biome", "biome"],
    ["oxlint", "oxlint"],
    ["stylelint", "stylelint"]
  ]),
  typecheck: new Map([
    ["typescript", "typescript"],
    ["pyright", "pyright"]
  ])
} as const;

export async function analyzeRepository(
  rootPath: string,
  options: AnalyzerOptions = {}
): Promise<RepositoryAnalysis> {
  const absoluteRoot = path.resolve(rootPath);
  const maxDepth = options.maxDepth ?? 8;
  const maxEntries = options.maxEntries ?? 20_000;
  const maxMetadataFileBytes = options.maxMetadataFileBytes ?? 1_000_000;
  const topLevelEntries = await safeReadDir(absoluteRoot);
  const topLevelFiles = topLevelEntries
    .filter((entry) => entry.type === "file")
    .map((entry) => entry.name)
    .sort();
  const topLevelDirectories = topLevelEntries
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.name)
    .sort();
  const gitPath = path.join(absoluteRoot, ".git");
  const isGitRepository = await exists(gitPath);
  const scan = await scanRepositoryTree(absoluteRoot, maxDepth, maxEntries);
  const files = [...scan.files].sort();
  const fileSet = new Set(files);
  const warnings = [...scan.warnings];

  const manifests = files.flatMap((filePath): DetectedManifest[] => {
    const name = path.posix.basename(filePath);
    if (!manifestNames.has(name as ManifestKind)) return [];
    const kind = name as ManifestKind;
    return [
      {
        path: filePath,
        kind,
        evidence: [evidence(filePath, "manifest", `Found ${kind} manifest.`)]
      }
    ];
  });

  const packageManagers = detectPackageManagers(files);
  const packageJsonData = await readPackageJsonFiles(
    absoluteRoot,
    manifests.filter((manifest) => manifest.kind === "package.json"),
    maxMetadataFileBytes,
    warnings
  );
  const scripts = packageJsonData.flatMap((packageJson) =>
    Object.entries(packageJson.scripts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => ({
        name,
        command,
        packagePath: packageJson.path,
        evidence: [
          evidence(packageJson.path, "manifest", `Found package.json script named ${name}.`)
        ]
      }))
  );
  const gitMetadata = inspectGitMetadata(absoluteRoot, isGitRepository, warnings);

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
      currentBranch: gitMetadata.currentBranch,
      isDirty: gitMetadata.isDirty,
      topLevelFiles: {
        value: topLevelFiles,
        evidence: [evidence(".", "filesystem", "Read top-level repository files.")]
      },
      topLevelDirectories: {
        value: topLevelDirectories,
        evidence: [evidence(".", "filesystem", "Read top-level repository directories.")]
      },
      scannedFileCount: {
        value: files.length,
        evidence: [evidence(".", "filesystem", "Counted files during bounded metadata scan.")]
      },
      scanTruncated: {
        value: scan.truncated,
        evidence: [
          evidence(
            ".",
            "filesystem",
            scan.truncated
              ? "Repository metadata scan reached a configured traversal limit."
              : "Repository metadata scan completed within configured traversal limits."
          )
        ]
      }
    },
    languages: detectLanguages(files, manifests),
    packageManagers,
    manifests,
    workspaces: await detectWorkspaces(
      absoluteRoot,
      fileSet,
      packageJsonData,
      packageManagers,
      maxMetadataFileBytes,
      warnings
    ),
    scripts,
    testFrameworks: detectTools("test", files, packageJsonData),
    formattingTools: detectTools("format", files, packageJsonData),
    lintingTools: detectTools("lint", files, packageJsonData),
    typeCheckingTools: detectTools("typecheck", files, packageJsonData),
    ciWorkflows: files
      .filter((filePath) => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(filePath))
      .map((filePath) => ({
        path: filePath,
        evidence: [evidence(filePath, "workflow", "Found a GitHub Actions workflow file.")]
      })),
    agentInstructions: files
      .filter((filePath) => path.posix.basename(filePath) === "AGENTS.md")
      .map((filePath) => ({
        path: filePath,
        evidence: [evidence(filePath, "filesystem", "Found agent instruction file.")]
      })),
    warnings
  };
}

function detectPackageManagers(files: string[]): DetectedPackageManager[] {
  const lockfiles: Array<{ file: string; manager: PackageManagerName }> = [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "package-lock.json", manager: "npm" }
  ];
  return files.flatMap((filePath): DetectedPackageManager[] => {
    const match = lockfiles.find((candidate) => path.posix.basename(filePath) === candidate.file);
    if (!match) return [];
    return [
      {
        name: match.manager,
        lockfile: filePath,
        evidence: [evidence(filePath, "manifest", `Found ${match.file} lockfile.`)]
      }
    ];
  });
}

function detectLanguages(files: string[], manifests: DetectedManifest[]): DetectedLanguage[] {
  const languages = new Map<LanguageName, Evidence[]>();
  const add = (name: LanguageName, itemEvidence: Evidence) => {
    const existing = languages.get(name) ?? [];
    if (!existing.some((item) => item.sourcePath === itemEvidence.sourcePath)) {
      languages.set(name, [...existing, itemEvidence]);
    }
  };
  for (const manifest of manifests) {
    if (manifest.kind === "package.json") add("JavaScript", manifest.evidence[0]!);
    if (manifest.kind === "pyproject.toml" || manifest.kind === "requirements.txt") {
      add("Python", manifest.evidence[0]!);
    }
    if (manifest.kind === "Cargo.toml") add("Rust", manifest.evidence[0]!);
    if (manifest.kind === "go.mod") add("Go", manifest.evidence[0]!);
  }
  for (const filePath of files) {
    if (
      /\.(?:ts|tsx|mts|cts)$/u.test(filePath) ||
      path.posix.basename(filePath) === "tsconfig.json"
    ) {
      add(
        "TypeScript",
        evidence(filePath, "filesystem", "Found TypeScript project metadata or file.")
      );
    } else if (/\.(?:js|jsx|mjs|cjs)$/u.test(filePath)) {
      add("JavaScript", evidence(filePath, "filesystem", "Found JavaScript file."));
    } else if (/\.py$/u.test(filePath)) {
      add("Python", evidence(filePath, "filesystem", "Found Python file."));
    } else if (/\.rs$/u.test(filePath)) {
      add("Rust", evidence(filePath, "filesystem", "Found Rust file."));
    } else if (/\.go$/u.test(filePath)) {
      add("Go", evidence(filePath, "filesystem", "Found Go file."));
    }
  }
  return [...languages.entries()].map(([name, languageEvidence]) => ({
    name,
    evidence: languageEvidence
  }));
}

async function readPackageJsonFiles(
  rootPath: string,
  manifests: DetectedManifest[],
  maxBytes: number,
  warnings: AnalysisWarning[]
): Promise<PackageJsonData[]> {
  const results: PackageJsonData[] = [];
  for (const manifest of manifests) {
    const content = await readMetadataFile(rootPath, manifest.path, maxBytes, warnings);
    if (content === undefined) continue;
    try {
      const raw = JSON.parse(content) as unknown;
      if (!isRecord(raw)) throw new Error("package.json root must be an object.");
      results.push({
        path: manifest.path,
        scripts: stringRecord(raw.scripts),
        dependencies: new Set([
          ...Object.keys(stringRecord(raw.dependencies)),
          ...Object.keys(stringRecord(raw.devDependencies)),
          ...Object.keys(stringRecord(raw.peerDependencies)),
          ...Object.keys(stringRecord(raw.optionalDependencies))
        ]),
        workspacePatterns: workspacePatterns(raw.workspaces)
      });
    } catch (error) {
      warnings.push({
        severity: "warning",
        message: `Could not parse ${manifest.path}: ${errorMessage(error)}`,
        evidence: [evidence(manifest.path, "manifest", "package.json parsing failed.")]
      });
    }
  }
  return results;
}

async function detectWorkspaces(
  rootPath: string,
  files: Set<string>,
  packageJsonData: PackageJsonData[],
  packageManagers: DetectedPackageManager[],
  maxBytes: number,
  warnings: AnalysisWarning[]
): Promise<DetectedWorkspace[]> {
  const workspaces: DetectedWorkspace[] = [];
  if (files.has("pnpm-workspace.yaml")) {
    const content = await readMetadataFile(rootPath, "pnpm-workspace.yaml", maxBytes, warnings);
    if (content !== undefined) {
      try {
        const raw = parseYaml(content) as unknown;
        const patterns =
          isRecord(raw) && Array.isArray(raw.packages) ? stringArray(raw.packages) : [];
        workspaces.push({
          kind: "pnpm",
          configPath: "pnpm-workspace.yaml",
          packagePatterns: patterns,
          evidence: [
            evidence("pnpm-workspace.yaml", "config", "Found pnpm workspace configuration.")
          ]
        });
      } catch (error) {
        warnings.push({
          severity: "warning",
          message: `Could not parse pnpm-workspace.yaml: ${errorMessage(error)}`,
          evidence: [evidence("pnpm-workspace.yaml", "config", "pnpm workspace parsing failed.")]
        });
      }
    }
  }
  const rootPackageJson = packageJsonData.find((item) => item.path === "package.json");
  if (rootPackageJson && rootPackageJson.workspacePatterns.length > 0) {
    const manager = packageManagers.find((item) => !item.lockfile.includes("/"))?.name ?? "npm";
    workspaces.push({
      kind: manager,
      configPath: "package.json",
      packagePatterns: rootPackageJson.workspacePatterns,
      evidence: [evidence("package.json", "manifest", "Found package.json workspace patterns.")]
    });
  }
  if (files.has("turbo.json")) {
    workspaces.push({
      kind: "turbo",
      configPath: "turbo.json",
      packagePatterns: [],
      evidence: [evidence("turbo.json", "config", "Found Turborepo configuration.")]
    });
  }
  return deduplicateWorkspaces(workspaces);
}

function detectTools(
  category: keyof typeof toolDependencies,
  files: string[],
  packageJsonData: PackageJsonData[]
): DetectedTool[] {
  const tools = new Map<string, Evidence[]>();
  const add = (name: string, itemEvidence: Evidence) => {
    tools.set(name, [...(tools.get(name) ?? []), itemEvidence]);
  };
  for (const packageJson of packageJsonData) {
    for (const [dependency, tool] of toolDependencies[category]) {
      if (packageJson.dependencies.has(dependency)) {
        add(tool, evidence(packageJson.path, "manifest", `Found ${dependency} dependency.`));
      }
    }
  }
  for (const filePath of files) {
    const basename = path.posix.basename(filePath);
    const configuredTool = toolFromConfig(category, basename);
    if (configuredTool) add(configuredTool, evidence(filePath, "config", `Found ${basename}.`));
  }
  return [...tools.entries()].map(([name, toolEvidence]) => ({
    name,
    evidence: uniqueEvidence(toolEvidence)
  }));
}

function toolFromConfig(
  category: keyof typeof toolDependencies,
  basename: string
): string | undefined {
  if (category === "test") {
    if (/^vitest\.config\./u.test(basename)) return "vitest";
    if (/^jest\.config\./u.test(basename)) return "jest";
    if (/^playwright\.config\./u.test(basename)) return "playwright";
  }
  if (category === "format") {
    if (/^\.prettierrc/u.test(basename) || /^prettier\.config\./u.test(basename)) return "prettier";
    if (basename === "biome.json" || basename === "biome.jsonc") return "biome";
    if (basename === "dprint.json") return "dprint";
  }
  if (category === "lint") {
    if (/^eslint\.config\./u.test(basename) || /^\.eslintrc/u.test(basename)) return "eslint";
    if (basename === "biome.json" || basename === "biome.jsonc") return "biome";
    if (/^\.stylelintrc/u.test(basename) || /^stylelint\.config\./u.test(basename)) {
      return "stylelint";
    }
  }
  if (category === "typecheck") {
    if (basename === "tsconfig.json" || /^tsconfig\..+\.json$/u.test(basename)) return "typescript";
    if (basename === "pyrightconfig.json") return "pyright";
  }
  return undefined;
}

async function scanRepositoryTree(
  rootPath: string,
  maxDepth: number,
  maxEntries: number
): Promise<RepositoryScan> {
  const files: string[] = [];
  const directories: string[] = [];
  const warnings: AnalysisWarning[] = [];
  let visitedEntries = 0;
  let truncated = false;

  const visit = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (truncated) return;
    const absoluteDirectory = path.join(rootPath, relativeDirectory);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      warnings.push({
        severity: "warning",
        message: `Could not read directory ${relativeDirectory || "."}: ${errorMessage(error)}`,
        evidence: [evidence(relativeDirectory || ".", "filesystem", "Directory traversal failed.")]
      });
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visitedEntries += 1;
      if (visitedEntries > maxEntries) {
        truncated = true;
        warnings.push({
          severity: "warning",
          message: `Repository scan stopped after ${maxEntries} entries.`,
          evidence: [evidence(".", "filesystem", "Configured scan entry limit reached.")]
        });
        return;
      }
      const relativePath = toPosixPath(path.join(relativeDirectory, entry.name));
      if (entry.isSymbolicLink()) {
        warnings.push({
          severity: "info",
          message: `Skipped symbolic link during metadata scan: ${relativePath}`,
          evidence: [evidence(relativePath, "filesystem", "Symbolic link was not followed.")]
        });
        continue;
      }
      if (entry.isDirectory()) {
        directories.push(relativePath);
        if (ignoredDirectories.has(entry.name) || relativePath === ".repopilot/runs") continue;
        if (depth >= maxDepth) {
          truncated = true;
          warnings.push({
            severity: "warning",
            message: `Skipped ${relativePath} because the scan depth limit is ${maxDepth}.`,
            evidence: [evidence(relativePath, "filesystem", "Configured scan depth limit reached.")]
          });
          continue;
        }
        await visit(relativePath, depth + 1);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };

  await visit("", 0);
  return { files, directories, warnings, truncated };
}

function inspectGitMetadata(
  rootPath: string,
  isRepository: boolean,
  warnings: AnalysisWarning[]
): Pick<RepositoryMetadata, "currentBranch" | "isDirty"> {
  const unavailable = (description: string) => ({
    value: null,
    evidence: [evidence(".git", "filesystem", description)]
  });
  if (!isRepository) {
    return {
      currentBranch: unavailable("Current branch is unavailable outside a Git repository."),
      isDirty: unavailable("Working-tree status is unavailable outside a Git repository.")
    };
  }
  const branch = runReadOnlyGit(rootPath, ["branch", "--show-current"]);
  const status = runReadOnlyGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (!branch.ok || !status.ok) {
    const gitError = !branch.ok ? branch.error : !status.ok ? status.error : "unknown error";
    warnings.push({
      severity: "warning",
      message: `Git metadata inspection failed: ${gitError}`,
      evidence: [evidence(".git", "filesystem", "Read-only Git inspection failed.")]
    });
  }
  return {
    currentBranch: {
      value: branch.ok && branch.output ? branch.output : null,
      evidence: [evidence(".git/HEAD", "filesystem", "Inspected the current Git branch.")]
    },
    isDirty: {
      value: status.ok ? status.output.length > 0 : null,
      evidence: [evidence(".git", "filesystem", "Inspected read-only Git working-tree status.")]
    }
  };
}

function runReadOnlyGit(
  cwd: string,
  args: string[]
): { ok: true; output: string } | { ok: false; error: string } {
  const result = spawnSync(
    "git",
    ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 1_000_000 }
  );
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      error: (result.error?.message ?? result.stderr.trim()) || `git exited with ${result.status}`
    };
  }
  return { ok: true, output: result.stdout.trim() };
}

async function readMetadataFile(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
  warnings: AnalysisWarning[]
): Promise<string | undefined> {
  const absolutePath = path.join(rootPath, relativePath);
  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.size > maxBytes) {
      warnings.push({
        severity: "warning",
        message: `Skipped oversized metadata file ${relativePath} (${fileStat.size} bytes).`,
        evidence: [evidence(relativePath, "filesystem", "Configured metadata size limit exceeded.")]
      });
      return undefined;
    }
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    warnings.push({
      severity: "warning",
      message: `Could not read metadata file ${relativePath}: ${errorMessage(error)}`,
      evidence: [evidence(relativePath, "filesystem", "Metadata file read failed.")]
    });
    return undefined;
  }
}

function evidence(
  sourcePath: string,
  sourceType: Evidence["sourceType"],
  description: string
): Evidence {
  return { sourcePath, sourceType, description };
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  if (isRecord(value) && Array.isArray(value.packages)) return stringArray(value.packages);
  return [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function stringArray(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function deduplicateWorkspaces(workspaces: DetectedWorkspace[]): DetectedWorkspace[] {
  const seen = new Set<string>();
  return workspaces.filter((workspace) => {
    const key = `${workspace.kind}:${workspace.configPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueEvidence(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sourcePath}:${item.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
