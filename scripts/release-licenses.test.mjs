import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { collectReleaseLicenses } from "./release-licenses.mjs";

test("attributes nested package inputs once and preserves full license and notice text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-licenses-"));
  try {
    const dependency = path.join(root, "node_modules/example");
    await mkdir(path.join(dependency, "nested"), { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "example", version: "1.0.0", license: "MIT" })
    );
    await writeFile(path.join(dependency, "nested/package.json"), '{"type":"module"}');
    await writeFile(path.join(dependency, "LICENSE"), "Full permission and copyright text");
    await writeFile(path.join(dependency, "NOTICE.txt"), "Additional attribution");
    const result = await collectReleaseLicenses(
      ["node_modules/example/nested/a.js", "node_modules/example/b.js", "packages/own/src.ts"],
      root
    );
    assert.equal(result.records.length, 1);
    assert.match(result.text, /Full permission and copyright text/);
    assert.match(result.text, /Additional attribution/);
    assert.match(result.text, /example@1\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for missing license text and unreviewed license types", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-licenses-"));
  try {
    const dependency = path.join(root, "node_modules/example");
    await mkdir(dependency, { recursive: true });
    const manifest = { name: "example", version: "1.0.0", license: "ISC" };
    await writeFile(path.join(dependency, "package.json"), JSON.stringify(manifest));
    await assert.rejects(
      collectReleaseLicenses(["node_modules/example/index.js"], root),
      /Missing license text/
    );
    await writeFile(path.join(dependency, "LICENSE"), "Some terms");
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ ...manifest, license: "AGPL-3.0-only" })
    );
    await assert.rejects(
      collectReleaseLicenses(["node_modules/example/index.js"], root),
      /Release license review required/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
