import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const requested = process.argv.slice(2);
const versions = requested.length ? requested : ["1.0.0", "1.4.0"];
const sdkPackages = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai"];
const suitePackages = [...sdkPackages, ...["pi-codemode", "pi-mcp", "pi-tui", "pi-telemetry", "chord"]
  .map(name => `@earendil-works/${name}`)];
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const version of versions) assert.match(version, /^1\.\d+\.\d+$/, "Use an exact stable Pi 1.x version");

function verifySuite(version, cwd, env) {
  const tree = spawnSync("pnpm", ["list", "--depth", "Infinity", "--json"], {
    cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (tree.error) throw tree.error;
  assert.equal(tree.status, 0, tree.stderr);
  function visit(node) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, dependency] of Object.entries(node[field] ?? {})) {
        if (suitePackages.includes(name)) assert.equal(dependency.version, version, `${name}: mixed transitive SDK`);
        visit(dependency);
      }
    }
  }
  for (const project of JSON.parse(tree.stdout)) visit(project);
  console.log(`SDK dependency tree verified at ${version}`);
}

function run(args, cwd, env) {
  const child = spawnSync("pnpm", args, { cwd, env, stdio: "inherit", timeout: 240_000 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed (${child.status ?? child.signal})`);
}

for (const version of versions) {
  const sandbox = mkdtempSync(join(tmpdir(), `pi-s1-compact-${version}-`));
  try {
    console.log(`\n=== Pi ${version}: isolated install, typecheck, and regression suites ===`);
    for (const path of ["extensions", "src", "tests", "scripts", "licenses", "docs", "README.md", "AGENTS.md",
      "LICENSE", "NOTICE.md", "CHANGELOG.md", "tsconfig.json", "pnpm-lock.yaml"]) {
      cpSync(join(root, path), join(sandbox, path), { recursive: true,
        filter: source => ![".git", ".pi", "node_modules"].includes(basename(source)) });
    }
    const isolated = structuredClone(manifest);
    for (const name of sdkPackages) isolated.devDependencies[name] = version;
    // Pi 1.0's published packages use caret dependencies. Pin the whole suite so
    // an older-baseline run cannot silently exercise newer transitive SDK code.
    // pnpm 11 reads overrides from pnpm-workspace.yaml, not package.json.
    writeFileSync(join(sandbox, "pnpm-workspace.yaml"), "packages:\n  - .\noverrides:\n"
      + suitePackages.map(name => `  ${JSON.stringify(name)}: ${JSON.stringify(version)}`).join("\n") + "\n");
    writeFileSync(join(sandbox, "package.json"), JSON.stringify(isolated, null, 2) + "\n");
    const env = { ...process.env, CI: "true", PI_NIMBLE_LIVE: "0", S1_COMPACT_EXPECT_PI_VERSION: version };
    run(["install", "--ignore-scripts", "--no-frozen-lockfile", "--prod=false"], sandbox, env);
    for (const name of sdkPackages) {
      const installed = JSON.parse(readFileSync(join(sandbox, "node_modules", name, "package.json"), "utf8"));
      assert.equal(installed.version, version, `${name}: wrong SDK resolved`);
    }
    verifySuite(version, sandbox, env);
    run(["check"], sandbox, env);
    console.log(`=== Pi ${version}: PASS ===`);
  } finally {
    // Only the temporary directory owned by this invocation is removed.
    rmSync(sandbox, { recursive: true, force: true });
  }
}
