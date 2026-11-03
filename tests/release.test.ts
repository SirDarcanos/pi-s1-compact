import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const { validateManifest, validatePaths, checkTarball } = await import(new URL("../scripts/check-release.mjs", import.meta.url).href);
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("release preflight accepts the approved stable manifest without changing its version", () => {
  const before = JSON.stringify(manifest);
  validateManifest(manifest, manifest.version);
  assert.equal(JSON.stringify(manifest), before);
});

test("release preflight rejects absent, mismatched, prerelease and shell-shaped confirmations", () => {
  for (const version of [undefined, "", "9.9.9", "0.1.0-beta.1", "01.0.0", "0.1.0\n", "$(touch /tmp/not-executed)"]) {
    assert.throws(() => validateManifest(manifest, version));
  }
});

test("release preflight rejects wrong package identity, private packages and metadata drift", () => {
  for (const patch of [
    { name: "other-package" }, { private: true }, { license: "UNLICENSED" },
    { keywords: [] }, { repository: { url: "https://example.invalid/other" } },
    { publishConfig: { access: "public", registry: "https://example.invalid/" } },
    { pi: { extensions: ["./other.ts"] } }, { files: ["."] },
  ]) {
    assert.throws(() => validateManifest({ ...manifest, ...patch }, manifest.version));
  }
  for (const hook of ["prepack", "prepare", "postpack", "prepublishOnly", "publish", "postpublish"]) {
    assert.throws(() => validateManifest({ ...manifest, scripts: { ...manifest.scripts, [hook]: "unexpected-hook" } }, manifest.version));
  }
});

test("tarball file checks reject missing, unexpected, private, duplicate and traversal paths", () => {
  const files = ["package/package.json", "package/extensions/s1-compact.ts", "package/src/engine/client.ts", "package/LICENSE"];
  validatePaths(files, files);
  for (const bad of [
    files.slice(1), [...files, "package/.npmrc"], [...files, "package/src/.env"],
    [...files, "package/node_modules/secret.ts"], [...files, "package/src/../secret.ts"],
    [...files, "/absolute/path"], [...files, files[0]],
  ]) assert.throws(() => validatePaths(bad, files));
});

test("tarball verification rejects altered bytes, extra dependencies, missing files and links", t => {
  const dir = mkdtempSync(join(tmpdir(), "s1-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const packageDir = join(dir, "package");
  const tarball = join(dir, "release.tgz");
  for (const path of manifest.files) cpSync(join(root, path), join(packageDir, path), { recursive: true });
  const packedManifest = { ...manifest };
  delete packedManifest.packageManager;
  const writeManifest = (value: object) => writeFileSync(join(packageDir, "package.json"), JSON.stringify(value));
  const pack = () => execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
  writeManifest(packedManifest);
  pack();
  checkTarball(tarball, manifest, manifest.version);

  writeManifest({ ...packedManifest, dependencies: { "unexpected-package": "*" } });
  pack();
  assert.throws(() => checkTarball(tarball, manifest, manifest.version), /Packed manifest differs/);
  writeManifest(packedManifest);

  const readme = readFileSync(join(packageDir, "README.md"));
  writeFileSync(join(packageDir, "README.md"), "altered package contents");
  pack();
  assert.throws(() => checkTarball(tarball, manifest, manifest.version), /Packed bytes differ/);
  writeFileSync(join(packageDir, "README.md"), readme);

  rmSync(join(packageDir, "LICENSE"));
  pack();
  assert.throws(() => checkTarball(tarball, manifest, manifest.version), /every allowlisted checkout file/);
  symlinkSync(join(root, "LICENSE"), join(packageDir, "LICENSE"));
  pack();
  assert.throws(() => checkTarball(tarball, manifest, manifest.version), /Only regular files/);
});

test("release checker CLI fails closed without confirmation and accepts explicit expected version", () => {
  const script = new URL("../scripts/check-release.mjs", import.meta.url);
  for (const [version, expected] of [["", 1], [manifest.version, 0]] as const) {
    const result = spawnSync(process.execPath, [script.pathname], {
      encoding: "utf8", env: { ...process.env, EXPECTED_VERSION: version }, timeout: 10_000,
    });
    assert.equal(result.status, expected, result.stderr);
    if (!expected) assert.match(result.stdout, /Release metadata verified/);
  }
});
