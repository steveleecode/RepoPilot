import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { collectReleaseLicenses } from "./release-licenses.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release-artifacts");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cliManifest = JSON.parse(await readFile(path.join(root, "apps/cli/package.json"), "utf8"));
if (manifest.version !== cliManifest.version) throw new Error("Root and CLI versions differ.");
const version = manifest.version;
const temporary = await mkdtemp(path.join(tmpdir(), "repopilot-release-"));
const staging = path.join(temporary, "package");
const installed = path.join(temporary, "installed");
await mkdir(path.join(staging, "bin"), { recursive: true });
await mkdir(releaseRoot, { recursive: true });

try {
  const bundledInputs = new Set();
  async function bundle(options) {
    const result = await build({ ...options, metafile: true });
    for (const input of Object.keys(result.metafile.inputs)) bundledInputs.add(input);
  }
  const common = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    sourcemap: false,
    logLevel: "warning",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
    }
  };
  await bundle({
    ...common,
    entryPoints: [path.join(root, "apps/cli/src/index.ts")],
    outfile: path.join(staging, "bin/repopilot-core.mjs")
  });
  await bundle({
    ...common,
    entryPoints: [path.join(root, "packages/provider/src/change-broker.ts")],
    outfile: path.join(staging, "bin/change-broker.mjs")
  });
  await bundle({
    ...common,
    entryPoints: [path.join(root, "packages/provider/src/review-broker.ts")],
    outfile: path.join(staging, "bin/review-broker.mjs")
  });
  await bundle({
    ...common,
    entryPoints: [path.join(root, "apps/cli/src/install-entry.ts")],
    outfile: path.join(staging, "bin/install-completion-core.mjs")
  });
  await writeFile(
    path.join(staging, "package.json"),
    JSON.stringify(
      {
        name: "repopilot",
        version,
        description: manifest.description,
        license: "SEE LICENSE IN eula.txt",
        type: "module",
        bin: { repopilot: "./bin/repopilot.mjs" },
        scripts: { postinstall: "node ./bin/install-completion.mjs" },
        engines: { node: ">=22 <26" },
        files: ["bin", "README.md", "eula.txt", "THIRD_PARTY_NOTICES.txt"],
        private: false
      },
      null,
      2
    ) + "\n"
  );
  const eula = await readFile(path.join(root, "docs/legal/EULA.txt"), "utf8");
  await writeFile(path.join(staging, "eula.txt"), eula);
  const notices = await collectReleaseLicenses(bundledInputs, root);
  const reviewedNotices = await readFile(
    path.join(root, "docs/legal/THIRD_PARTY_NOTICES.txt"),
    "utf8"
  );
  if (notices.text !== reviewedNotices)
    throw new Error(
      "Bundled dependency notices changed; review and update docs/legal/THIRD_PARTY_NOTICES.txt."
    );
  await writeFile(path.join(staging, "THIRD_PARTY_NOTICES.txt"), notices.text);
  await writeFile(
    path.join(staging, "bin/repopilot.mjs"),
    `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
if (process.argv.length === 3 && process.argv[2] === "--license") {
  process.stdout.write(await readFile(new URL("../eula.txt", import.meta.url), "utf8"));
} else if (process.env.REPOPILOT_ACCEPT_EULA !== "1") {
  process.stderr.write("Read repopilot --license, then set REPOPILOT_ACCEPT_EULA=1 only if you agree to EULA v1.0. No command was run.\\n");
  process.exitCode = 1;
} else {
  const { runCli } = await import("./repopilot-core.mjs");
  const result = await runCli(process.argv);
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(result.output + "\\n");
  process.exitCode = result.exitCode;
}
`
  );
  await chmod(path.join(staging, "bin/repopilot.mjs"), 0o755);
  await writeFile(
    path.join(staging, "bin/install-completion.mjs"),
    `if (process.env.REPOPILOT_ACCEPT_EULA === "1") {
  await import("./install-completion-core.mjs");
} else {
  process.stdout.write("Read eula.txt before use; set REPOPILOT_ACCEPT_EULA=1 only if you agree. Shell setup skipped.\\n");
}
`
  );
  await writeFile(
    path.join(staging, "README.md"),
    `# RepoPilot ${version}\n\nSelf-contained local CLI release. Requires Node.js 22–25 and Git.\nProprietary software: read eula.txt before installation or use. Public source availability is not an open-source license.\nRun repopilot --license to read the terms. Set REPOPILOT_ACCEPT_EULA=1 only if you agree to EULA v1.0. Third-party terms are in THIRD_PARTY_NOTICES.txt.\nGlobal zsh installs enable completion by default. Set REPOPILOT_SKIP_COMPLETION_SETUP=1 to opt out. Run repopilot settings for personal completion configuration.\nSee https://github.com/steveleecode/RepoPilot for setup and security guidance.\n`
  );
  run(
    "npm",
    ["pack", staging, "--pack-destination", releaseRoot, "--ignore-scripts", "--json"],
    root
  );
  const archive = path.join(releaseRoot, `repopilot-${version}.tgz`);
  run(
    "npm",
    [
      "install",
      "--prefix",
      installed,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      archive
    ],
    root
  );
  const executable = path.join(installed, "node_modules/repopilot/bin/repopilot.mjs");
  const installedManifest = JSON.parse(
    await readFile(path.join(installed, "node_modules/repopilot/package.json"), "utf8")
  );
  if (
    installedManifest.license !== "SEE LICENSE IN eula.txt" ||
    (await readFile(path.join(installed, "node_modules/repopilot/eula.txt"), "utf8")) !== eula
  )
    throw new Error("Packaged CLI is missing its EULA or license metadata.");
  if (
    (await readFile(
      path.join(installed, "node_modules/repopilot/THIRD_PARTY_NOTICES.txt"),
      "utf8"
    )) !== notices.text
  )
    throw new Error("Packaged CLI is missing third-party notices.");
  const declined = spawnSync(
    process.execPath,
    [executable, "run", "Must not run", "--repo", installed],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, REPOPILOT_ACCEPT_EULA: "" }
    }
  );
  if (declined.error || declined.status !== 1 || !declined.stderr.includes("No command was run"))
    throw new Error("Packaged CLI did not reject missing EULA acceptance.");
  try {
    await lstat(path.join(installed, ".repopilot"));
    throw new Error("Unaccepted command created repository state.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const licenseDisplay = spawnSync(process.execPath, [executable, "--license"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, REPOPILOT_ACCEPT_EULA: "" }
  });
  if (licenseDisplay.error || licenseDisplay.status !== 0 || licenseDisplay.stdout !== eula)
    throw new Error("Packaged license display requires acceptance or differs from the EULA.");
  if (installedManifest.scripts?.postinstall !== "node ./bin/install-completion.mjs")
    throw new Error("Packaged CLI is missing its completion install hook.");
  run(
    process.execPath,
    [path.join(installed, "node_modules/repopilot/bin/install-completion.mjs")],
    root
  );
  const versionOutput = run(process.execPath, [executable, "version"], root).trim();
  if (versionOutput !== version)
    throw new Error(`Packaged CLI reported ${versionOutput}, expected ${version}.`);
  const fixture = path.join(temporary, "fixture");
  await mkdir(fixture);
  const smoke = JSON.parse(
    run(
      process.execPath,
      [executable, "run", "Smoke test", "--provider", "fake", "--repo", fixture, "--json"],
      root
    )
  );
  if (smoke.ok !== true || smoke.run?.status !== "completed")
    throw new Error("Packaged CLI workflow smoke test failed.");
  const providers = JSON.parse(
    run(process.execPath, [executable, "providers", "list", "--repo", fixture, "--json"], root)
  );
  if (!providers.providers?.some((provider) => provider.id === "codex"))
    throw new Error("Packaged CLI is missing the Codex provider.");
  const project = path.join(temporary, "sample-project");
  await mkdir(project);
  run("git", ["init", "-q"], project);
  run("git", ["remote", "add", "origin", "git@github.com:example/sample-project.git"], project);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "sample-project",
      version: "1.0.0",
      scripts: { check: "echo checked" }
    }) + "\n"
  );
  await writeFile(
    path.join(project, "package-lock.json"),
    JSON.stringify({
      name: "sample-project",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "sample-project", version: "1.0.0" } }
    }) + "\n"
  );
  const setup = run(
    process.execPath,
    [executable, "setup", "--repo", project, "--skip-gemini"],
    root
  );
  if (!setup.includes("RepoPilot setup complete"))
    throw new Error("Packaged CLI setup smoke test failed.");
  const status = JSON.parse(
    run(process.execPath, [executable, "config", "status", "--repo", project, "--json"], root)
  );
  if (!status.policyConfigured || !status.codexConfigured || status.geminiConfigured)
    throw new Error("Packaged CLI setup status smoke test failed.");
  const workflow = await readFile(path.join(project, ".github/workflows/repopilot-ci.yml"), "utf8");
  if (!workflow.includes("npm run check"))
    throw new Error("Packaged CLI GitHub CI setup smoke test failed.");
  const prompt = run(process.execPath, [executable, "codex", "prompt", "Add a filter"], root);
  if (!prompt.includes("Task: Add a filter"))
    throw new Error("Packaged CLI feature prompt smoke test failed.");
  // Exercise npm's global command shim and lifecycle in a disposable prefix, never the user's prefix.
  const globalPrefix = path.join(temporary, "global");
  run(
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      globalPrefix,
      "--offline",
      "--no-audit",
      "--no-fund",
      archive
    ],
    fixture
  );
  const globalCommand = path.join(globalPrefix, "bin/repopilot");
  if (run(globalCommand, ["version"], fixture).trim() !== version)
    throw new Error("Global CLI command smoke test failed.");
  run(
    "npm",
    ["uninstall", "--global", "--prefix", globalPrefix, "--offline", "repopilot"],
    fixture
  );
  for (const removed of [globalCommand, path.join(globalPrefix, "lib/node_modules/repopilot")]) {
    try {
      await lstat(removed);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Uninstall left a packaged CLI path behind: ${removed}`);
  }
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    path.join(releaseRoot, `repopilot-${version}.sha256`),
    `${digest}  repopilot-${version}.tgz\n`
  );
  process.stdout.write(
    `Release artifact: ${archive}\nSHA-256: ${digest}\nClean-install smoke test: passed\nIsolated global install/uninstall: passed\n`
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 2_000_000,
    env: {
      ...process.env,
      CI: "true",
      REPOPILOT_ACCEPT_EULA: "1",
      REPOPILOT_SKIP_COMPLETION_SETUP: "1",
      npm_config_cache: path.join(temporary, "npm-cache")
    }
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable} failed: ${result.stderr?.trim() || result.error?.message || result.status}`
    );
  return result.stdout;
}
