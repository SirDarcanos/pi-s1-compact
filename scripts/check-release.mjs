import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const registry = "https://registry.npmjs.org/";

export function validateManifest(manifest, expectedVersion) {
  assert.match(expectedVersion ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Confirm an approved stable version");
  assert.equal(manifest.name, "pi-s1-compact");
  assert.equal(manifest.version, expectedVersion, "Expected version must match package.json; never bump automatically");
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert(manifest.keywords?.includes("pi-package"), "Pi discovery keyword is required");
  assert.equal(manifest.repository?.url, "git+https://github.com/SirDarcanos/pi-s1-compact.git");
  assert.deepEqual(manifest.publishConfig, { access: "public", registry });
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/s1-compact.ts"] });
  assert.deepEqual(manifest.files, ["extensions", "src", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE.md", "licenses"]);
  for (const hook of ["prepack", "prepare", "postpack", "prepublishOnly", "publish", "postpublish"]) {
    assert(!manifest.scripts?.[hook], `Review release lifecycle hook before enabling it: ${hook}`);
  }
}

export function validatePaths(paths, expected) {
  assert.equal(new Set(paths).size, paths.length, "Duplicate archive paths");
  for (const path of paths) {
    assert.match(path, /^package\/(?:extensions\/s1-compact\.ts|src\/(?:engine\/)?[a-z0-9-]+\.ts|licenses\/[a-z0-9-]+-MIT\.txt|README\.md|CHANGELOG\.md|LICENSE|NOTICE\.md|package\.json)$/, `Unexpected packed file: ${path}`);
  }
  assert.deepEqual([...paths].sort(), [...expected].sort(), "Archive must include every allowlisted checkout file and no extras");
}

function checkoutFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const full = join(path, entry.name);
    assert(entry.isDirectory() || entry.isFile(), `Symlinks and special files are not release inputs: ${full}`);
    return entry.isDirectory() ? checkoutFiles(full) : [full];
  });
}

export function checkTarball(tarball, manifest, expectedVersion) {
  const tar = args => execFileSync("tar", args, { maxBuffer: 8 * 1024 * 1024 });
  const listing = tar(["-tzf", tarball]).toString("utf8").trim().split("\n");
  // No extraction: reject links/special entries before reading members into memory.
  const types = tar(["-tvzf", tarball]).toString("utf8").trim().split("\n");
  assert(types.every(line => /^[d-]/.test(line)), "Only regular files and directories may be packed");
  const paths = listing.filter(path => !path.endsWith("/"));
  const expected = ["package.json", ...manifest.files.flatMap(path => {
    if (["extensions", "src", "licenses"].includes(path)) return checkoutFiles(join(root, path)).map(file => relative(root, file));
    return [path];
  })].map(path => `package/${path}`);
  validatePaths(paths, expected);
  for (const path of listing.filter(path => path.endsWith("/"))) {
    assert.match(path, /^package\/(?:extensions\/|src\/(?:engine\/)?|licenses\/)?$/, `Unexpected directory: ${path}`);
  }
  const packed = JSON.parse(tar(["-xOzf", tarball, "package/package.json"]).toString("utf8"));
  validateManifest(packed, expectedVersion);
  // pnpm 11 removes packageManager from the published manifest; no other drift is allowed.
  const expectedManifest = { ...manifest };
  delete expectedManifest.packageManager;
  assert.deepEqual(packed, expectedManifest, "Packed manifest differs from checked source");
  for (const path of paths.filter(path => path !== "package/package.json")) {
    assert.deepEqual(tar(["-xOzf", tarball, path]), readFileSync(join(root, path.slice("package/".length))), `Packed bytes differ from checked source: ${path}`);
  }
  console.log(`Release tarball verified: ${manifest.name}@${expectedVersion}, ${paths.length} allowlisted files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expectedVersion = process.env.EXPECTED_VERSION;
  validateManifest(manifest, expectedVersion);
  if (process.argv[2]) checkTarball(process.argv[2], manifest, expectedVersion);
  else console.log(`Release metadata verified: ${manifest.name}@${expectedVersion}`);
}
