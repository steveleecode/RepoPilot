import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  await build({
    ...common,
    entryPoints: [path.join(root, "apps/cli/src/index.ts")],
    outfile: path.join(staging, "bin/repopilot.mjs")
  });
  await build({
    ...common,
    entryPoints: [path.join(root, "packages/provider/src/change-broker.ts")],
    outfile: path.join(staging, "bin/change-broker.mjs")
  });
  await chmod(path.join(staging, "bin/repopilot.mjs"), 0o755);
  await writeFile(
    path.join(staging, "package.json"),
    JSON.stringify(
      {
        name: "repopilot",
        version,
        description: manifest.description,
        type: "module",
        bin: { repopilot: "./bin/repopilot.mjs" },
        engines: { node: ">=22 <26" },
        files: ["bin", "README.md"],
        private: false
      },
      null,
      2
    ) + "\n"
  );
  await writeFile(
    path.join(staging, "README.md"),
    `# RepoPilot ${version}\n\nSelf-contained local CLI release. Requires Node.js 22–25 and Git.\nSee https://github.com/steveleecode/RepoPilot for setup and security guidance.\n`
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
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(
    path.join(releaseRoot, `repopilot-${version}.sha256`),
    `${digest}  repopilot-${version}.tgz\n`
  );
  process.stdout.write(
    `Release artifact: ${archive}\nSHA-256: ${digest}\nClean-install smoke test: passed\n`
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
    env: { ...process.env, CI: "true", npm_config_cache: path.join(temporary, "npm-cache") }
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${executable} failed: ${result.stderr?.trim() || result.error?.message || result.status}`
    );
  return result.stdout;
}
