import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const { validateCompatibilityVersions } = await import(new URL("../scripts/compatibility-policy.mjs", import.meta.url).href);

test("runtime metadata requires Node 24 and has no upper Pi major bound", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.engines.node, ">=24.0.0");
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai"]) {
    assert.equal(manifest.peerDependencies[`@earendil-works/${name}`], ">=1.0.0");
  }
});

test("compatibility selection accepts future stable Pi majors without installing them", () => {
  validateCompatibilityVersions(["1.0.0", "1.4.0", "2.0.0", "10.20.30"]);
  for (const value of ["0.99.2", "latest", "^1.0.0", "2", "2.0.0-beta.1", "01.0.0", "2.00.0", "2.0.0\n"]) {
    assert.throws(() => validateCompatibilityVersions([value]));
  }
});
