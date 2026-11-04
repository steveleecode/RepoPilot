import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareRelease,
  requireUnpublished,
  validateRelease,
  verifyPublication
} from "./npm-release.mjs";

const response = (status, value) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => value
});

test("release identity rejects shell/path input, invalid semver, and prereleases on latest", () => {
  assert.equal(validateRelease("0.3.1", "latest").archive, "repopilot-0.3.1.tgz");
  assert.equal(validateRelease("0.4.0-rc.1", "next").tag, "next");
  for (const version of [
    "v0.3.1",
    "01.2.3",
    "1.2.3-01",
    "../1.2.3",
    "1.2.3\nfoo",
    "1.2.3\n",
    "1.2.3\r\n",
    "$(id)",
    "1.2.3+metadata",
    "9007199254740992.0.0"
  ])
    assert.throws(() => validateRelease(version, "next"));
  assert.throws(() => validateRelease("0.4.0-rc.1", "latest"), /Prereleases/);
  assert.throws(() => validateRelease("0.3.1", "$(id)"), /tag/);
});

test("version overrides update both manifests only after identity validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repopilot-release-identity-"));
  try {
    await mkdir(`${root}/apps/cli`, { recursive: true });
    const original = JSON.stringify({ name: "source", version: "0.3.0", private: true }) + "\n";
    await writeFile(`${root}/package.json`, original);
    await writeFile(`${root}/apps/cli/package.json`, original);
    await assert.rejects(prepareRelease(root, "../bad", "latest"));
    assert.equal(await readFile(`${root}/package.json`, "utf8"), original);
    assert.equal(await readFile(`${root}/apps/cli/package.json`, "utf8"), original);
    const prepared = await prepareRelease(root, "0.3.1", "latest");
    assert.equal(prepared.version, "0.3.1");
    for (const file of ["package.json", "apps/cli/package.json"]) {
      const manifest = JSON.parse(await readFile(`${root}/${file}`, "utf8"));
      assert.equal(manifest.version, "0.3.1");
      assert.equal(manifest.private, true);
    }
    await writeFile(`${root}/apps/cli/package.json`, original);
    await assert.rejects(prepareRelease(root, "0.3.2", "latest"), /versions differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication availability fails closed on registry errors and existing versions", async () => {
  await requireUnpublished("0.3.1", async () => response(404));
  await assert.rejects(
    requireUnpublished("0.3.1", async () => response(200)),
    /already exists/
  );
  await assert.rejects(
    requireUnpublished("0.3.1", async () => response(500)),
    /publication stopped/
  );
  await assert.rejects(
    requireUnpublished("0.3.1", async () => {
      throw new Error("offline");
    }),
    /offline/
  );
});

test("verification waits for processed version and tag, never treating acceptance as availability", async () => {
  const published = { name: "repilot", version: "0.3.1", dist: { integrity: "sha512-test" } };
  const replies = [
    response(404),
    response(200, published),
    response(200, { ...published, version: "0.3.0" }),
    response(200, published),
    response(200, published)
  ];
  let sleeps = 0;
  await verifyPublication({
    version: "0.3.1",
    tag: "latest",
    integrity: "sha512-test",
    attempts: 3,
    fetchImpl: async () => replies.shift(),
    sleep: async () => {
      sleeps++;
    }
  });
  assert.equal(sleeps, 2);
  assert.equal(replies.length, 0);
});

test("verification rejects a mismatched archive and times out instead of claiming success", async () => {
  await assert.rejects(
    verifyPublication({
      version: "0.3.1",
      tag: "latest",
      integrity: "sha512-test",
      attempts: 1,
      fetchImpl: async () =>
        response(200, {
          name: "repilot",
          version: "0.3.1",
          dist: { integrity: "sha512-different" }
        })
    }),
    /integrity differs/
  );
  await assert.rejects(
    verifyPublication({
      version: "0.3.1",
      tag: "latest",
      integrity: "sha512-test",
      attempts: 1,
      fetchImpl: async () => response(404)
    }),
    /Do not blindly republish/
  );
  await assert.rejects(
    verifyPublication({
      version: "0.3.1",
      tag: "latest",
      integrity: "sha512-test",
      attempts: 1,
      fetchImpl: async () => response(403)
    }),
    /HTTP 403/
  );
});
