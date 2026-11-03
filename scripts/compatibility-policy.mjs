import assert from "node:assert/strict";

/** Accept exact stable Pi versions from the supported minimum, without a major cap. */
export function validateCompatibilityVersions(versions) {
  for (const version of versions) {
    assert.match(version, /^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use an exact stable Pi version >=1.0.0");
  }
}
