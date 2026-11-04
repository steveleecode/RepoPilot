import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Derive attribution from actual bundled inputs rather than all workspace/dev dependencies.
export async function collectReleaseLicenses(inputs, root) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.split(path.sep).join("/").includes("node_modules/")) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (true) {
      let manifest;
      try {
        manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // Some packages include package.json files that only declare the module format.
      if (manifest?.name && manifest?.version) {
        packages.set(directory, manifest);
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`No package owner for bundled input: ${input}`);
      directory = parent;
    }
  }
  const records = [];
  for (const [directory, manifest] of packages) {
    if (!["MIT", "ISC"].includes(manifest.license))
      throw new Error(`Release license review required: ${manifest.name}@${manifest.version}`);
    const names = (await readdir(directory))
      .filter((name) => /^(licen[cs]e|copying|notice)([.-].*)?$/iu.test(name))
      .sort();
    if (!names.some((name) => /^(licen[cs]e|copying)([.-].*)?$/iu.test(name)))
      throw new Error(`Missing license text: ${manifest.name}@${manifest.version}`);
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        text: await readFile(path.join(directory, name), "utf8")
      }))
    );
    records.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      files
    });
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return {
    records,
    text:
      "REPOPILOT THIRD-PARTY NOTICES\n\n" +
      "These components retain their own licenses. The RepoPilot EULA does not restrict\n" +
      "the rights their licenses grant. Inventory derived from esbuild bundled inputs.\n\n" +
      records
        .map(
          (record) =>
            `${record.name}@${record.version} — ${record.license}\n` +
            record.files.map((file) => `\n--- ${file.name} ---\n${file.text.trim()}\n`).join("")
        )
        .join("\n")
  };
}
