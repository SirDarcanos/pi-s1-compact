import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

// Resolve through the SDK that consumes these packages, not an unrelated root copy.
const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

test("SDK dependency resolution uses the reviewed security patches", () => {
  for (const [name, expected] of [["undici", "8.12.2"], ["minimatch", "11.0.1"]]) {
    const manifest = JSON.parse(readFileSync(sdkRequire.resolve(`${name}/package.json`), "utf8"));
    assert.equal(manifest.version, expected);
  }
});

test("patched minimatch preserves the glob APIs used by Pi model and resource filters", () => {
  const { minimatch } = sdkRequire("minimatch");
  const cases = [
    ["anthropic/claude-sonnet", "anthropic/*", true],
    ["claude-sonnet", "*SONNET*", true],
    ["openai/gpt", "anthropic/*", false],
    ["extensions/s1-compact.ts", "extensions/*.ts", true],
    ["src/nested/one.ts", "**/*.ts", true],
    ["src/one.js", "**/*.ts", false],
    ["src/a.ts", "src/[ab].ts", true],
    ["src/c.ts", "src/[ab].ts", false],
  ] as const;
  for (const [value, pattern, expected] of cases) assert.equal(minimatch(value, pattern, { nocase: true }), expected, `${value} ${pattern}`);
});
