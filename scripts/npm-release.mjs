import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org";
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const versionPattern = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-${identifier}(?:\\.${identifier})*)?$`
);

export function validateRelease(version, tag) {
  const match =
    typeof version === "string" && version.length <= 100 && versionPattern.exec(version);
  if (
    !match ||
    match[0] !== version ||
    !match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part)))
  )
    throw new Error(
      "Use an exact version such as 0.3.1 or 0.4.0-rc.1 (no v prefix or build metadata)."
    );
  if (!["latest", "next"].includes(tag)) throw new Error("Release tag must be latest or next.");
  if (tag === "latest" && version.includes("-"))
    throw new Error("Prereleases must use the next tag, not latest.");
  return { version, tag, archive: `repopilot-${version}.tgz` };
}

export function renderNpmReadme(readme, { revision, version }) {
  validateRelease(version, "next");
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("README source revision must be a commit hash.");
  const repository = "steveleecode/RepoPilot";
  return readme
    .replace(/(!?)\[([^\]]*)\]\(([^\s)]+)\)/g, (match, image, label, target) => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return match;
      const relative = target.replace(/^\.\//, "");
      const base = image
        ? `https://raw.githubusercontent.com/${repository}/${revision}/`
        : `https://github.com/${repository}/blob/${revision}/`;
      return `${image}[${label}](${base}${relative})`;
    })
    .replace(/^\*\*v[^ ]+ · Developer preview\.\*\*/m, `**v${version} · Developer preview.**`);
}

export async function prepareRelease(root, requestedVersion, tag) {
  const paths = [path.join(root, "package.json"), path.join(root, "apps/cli/package.json")];
  const manifests = await Promise.all(
    paths.map(async (file) => JSON.parse(await readFile(file, "utf8")))
  );
  if (manifests[0].version !== manifests[1].version)
    throw new Error("Root and CLI versions differ; fix the source manifests first.");
  const release = validateRelease(requestedVersion || manifests[0].version, tag);
  for (let index = 0; index < paths.length; index++) {
    manifests[index].version = release.version;
    await writeFile(paths[index], JSON.stringify(manifests[index], null, 2) + "\n");
  }
  return release;
}

export async function requireUnpublished(version, fetchImpl = fetch) {
  validateRelease(version, "next");
  const response = await fetchImpl(`${registry}/repilot/${version}`, {
    signal: AbortSignal.timeout(15000),
    headers: { "cache-control": "no-cache" }
  });
  if (response.status === 404) return;
  if (response.ok)
    throw new Error(
      `repilot@${version} already exists. Choose a new version; npm versions are immutable.`
    );
  throw new Error(
    `Cannot check npm version availability (HTTP ${response.status}); publication stopped.`
  );
}

export async function verifyPublication({
  version,
  tag,
  integrity,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 30
}) {
  validateRelease(version, tag);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let waiting = false;
    for (const selector of [version, tag]) {
      let response;
      try {
        response = await fetchImpl(`${registry}/repilot/${selector}`, {
          signal: AbortSignal.timeout(15000),
          headers: { "cache-control": "no-cache" }
        });
      } catch {
        waiting = true;
        break;
      }
      if (response.status === 404 || response.status === 429 || response.status >= 500) {
        waiting = true;
        break;
      }
      if (!response.ok) throw new Error(`Registry verification failed (HTTP ${response.status}).`);
      const published = await response.json();
      if (published.name !== "repilot")
        throw new Error("Registry returned an unexpected package identity.");
      if (published.version !== version) {
        if (selector === version)
          throw new Error("Registry returned an unexpected release version.");
        waiting = true;
        break;
      }
      if (published.dist?.integrity !== integrity)
        throw new Error(
          "Published archive integrity differs from the validated release. Investigate before retrying."
        );
    }
    if (!waiting) return;
    if (attempt + 1 < attempts) await sleep(15000);
  }
  throw new Error(
    `npm accepted the upload but repilot@${version} and tag ${tag} could not both be verified. Do not blindly republish; inspect npm first.`
  );
}

async function main() {
  const command = process.argv[2];
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const tag = process.env.DIST_TAG || "latest";
  if (command === "prepare") {
    const release = await prepareRelease(root, process.env.RELEASE_VERSION, tag);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `version=${release.version}\narchive=${release.archive}\ntag=${release.tag}\n`
      );
    }
    console.log(`Prepared repilot@${release.version} (${release.tag}) in this checkout only.`);
    return;
  }
  const release = validateRelease(process.env.RELEASE_VERSION, tag);
  const directory = path.join(root, "release-artifacts");
  const archive = path.join(directory, release.archive);
  const contents = await readFile(archive);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const checksum = await readFile(
    path.join(directory, `repopilot-${release.version}.sha256`),
    "utf8"
  );
  if (checksum !== `${sha256}  ${release.archive}\n`)
    throw new Error("Archive checksum verification failed.");
  if (command === "check") {
    const result = spawnSync("npm", ["pack", archive, "--dry-run", "--ignore-scripts", "--json"], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 2000000
    });
    if (result.error || result.status !== 0)
      throw new Error("Cannot inspect the downloaded release archive.");
    const packed = JSON.parse(result.stdout)[0];
    if (packed.name !== "repilot" || packed.version !== release.version)
      throw new Error("Downloaded archive identity does not match the requested release.");
    await requireUnpublished(release.version);
    console.log(
      `Verified archive checksum, identity, and availability of repilot@${release.version}.`
    );
    return;
  }
  if (command === "verify") {
    const integrity = "sha512-" + createHash("sha512").update(contents).digest("base64");
    await verifyPublication({ ...release, integrity });
    const message = `Verified repilot@${release.version} (${release.tag}) on npm; published integrity matches the validated archive.`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `${message}\n\nhttps://www.npmjs.com/package/repilot/v/${release.version}\n`
      );
    }
    return;
  }
  throw new Error("Usage: node scripts/npm-release.mjs prepare|check|verify");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
