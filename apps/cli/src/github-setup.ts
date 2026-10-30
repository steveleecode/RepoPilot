import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GithubSetupResult {
  detected: boolean;
  evidence: string[];
  created: string[];
  skipped: string[];
  guidance: string[];
}

async function kind(target: string): Promise<"missing" | "directory" | "file" | "symlink"> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) return "symlink";
    return info.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensureDirectory(target: string): Promise<void> {
  const state = await kind(target);
  if (state === "symlink" || state === "file")
    throw new Error(`Refusing to write through ${target}.`);
  if (state === "missing") await mkdir(target);
}

function git(root: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16_384
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isGithubRemote(value: string): boolean {
  return (
    /^(?:https:\/\/|ssh:\/\/git@)github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/.test(value) ||
    /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/.test(value)
  );
}

async function rootPackageScripts(root: string): Promise<Set<string>> {
  const manifest = path.join(root, "package.json");
  if ((await kind(manifest)) !== "file") return new Set();
  if ((await lstat(manifest)).size > 1_000_000) return new Set();
  const raw = await readFile(manifest, "utf8");
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || !("scripts" in data)) return new Set();
    const scripts = data.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return new Set();
    return new Set(
      Object.entries(scripts)
        .filter(([, value]) => typeof value === "string")
        .map(([name]) => name)
    );
  } catch {
    return new Set();
  }
}

export async function generateGithubReinforcement(root: string): Promise<GithubSetupResult> {
  const result: GithubSetupResult = {
    detected: false,
    evidence: [],
    created: [],
    skipped: [],
    guidance: []
  };
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top || (await realpath(top)) !== (await realpath(root))) return result;
  const remotes = git(root, ["remote"]);
  const names =
    remotes
      ?.split(/\r?\n/)
      .filter((name) => /^[A-Za-z0-9_.-]+$/.test(name) && !name.startsWith("-"))
      .slice(0, 20) ?? [];
  const matching = names.find((name) =>
    isGithubRemote(git(root, ["remote", "get-url", name]) ?? "")
  );
  if (!matching) return result;
  result.detected = true;
  result.evidence.push(`Git remote ${matching} points to github.com.`);

  const scripts = await rootPackageScripts(root);
  const manager =
    (await kind(path.join(root, "pnpm-lock.yaml"))) === "file"
      ? "pnpm"
      : (await kind(path.join(root, "package-lock.json"))) === "file"
        ? "npm"
        : null;
  const checks = scripts.has("check")
    ? ["check"]
    : ["lint", "test", "build"].filter((name) => scripts.has(name));
  if (!manager || checks.length === 0) {
    result.guidance.push(
      "No supported lockfile and root check scripts were found; add a CI workflow with explicit mandatory checks."
    );
    return result;
  }
  result.evidence.push(
    `${manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json"} and root package.json scripts: ${checks.join(", ")}.`
  );
  const github = path.join(root, ".github");
  const workflows = path.join(github, "workflows");
  await ensureDirectory(github);
  await ensureDirectory(workflows);
  const relative = ".github/workflows/repopilot-ci.yml";
  const target = path.join(root, relative);
  const setup =
    manager === "pnpm"
      ? "      - run: corepack enable\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: pnpm\n      - run: pnpm install --frozen-lockfile\n"
      : "      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          cache: npm\n      - run: npm ci\n";
  const commands = checks.map((name) => `      - run: ${manager} run ${name}\n`).join("");
  const content = `name: RepoPilot CI\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${setup}${commands}`;
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    result.created.push(relative);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    result.skipped.push(relative);
  }
  result.guidance.push(
    "After pushing this workflow, require the validate check in GitHub branch protection or a ruleset; setup cannot enable remote protection."
  );
  result.guidance.push(
    "Review the default branch, Node version, and generated commands before committing. Existing workflows are not modified."
  );
  return result;
}
