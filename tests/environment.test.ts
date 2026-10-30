import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { configuration } from "../src/pruning.ts";
import { compactEnvironmentValue, type CompactEnvironmentKey } from "../src/environment.ts";
import { NimbleClient } from "../src/engine/client.ts";

const settings: Array<[CompactEnvironmentKey, string, string]> = [
  ["URL", "http://127.0.0.1:11434/v1/systemone", "http://localhost:8000/v1/systemone"],
  ["API_KEY", "new-synthetic-key", "old-synthetic-key"], ["MODEL", "nimble:new", "nimble:old"],
  ["THRESHOLD", "0.3", "0.5"], ["TRIGGER_TOKENS", "60000", "100000"],
  ["KEEP_THRESHOLD", "0.1", "0.2"], ["KEEP_RECENT_TOKENS", "6000", "12000"],
  ["MAX_PAYBACK_TURNS", "30", "20"], ["TIMEOUT_MS", "5000", "30000"],
  ["TRUNCATE_MIN_CHARS", "2000", "4000"],
];

for (const [key, primary, fallback] of settings) {
  test(`S1 ${key} takes precedence while legacy-only configuration remains compatible`, () => {
    const current = `PI_S1_COMPACT_${key}`, legacy = key === "API_KEY" ? "NIMBLE_API_KEY" : `PI_NIMBLE_${key}`;
    assert.equal(compactEnvironmentValue({}, key), undefined);
    assert.equal(compactEnvironmentValue({ [legacy]: fallback }, key), fallback);
    assert.equal(compactEnvironmentValue({ [current]: primary, [legacy]: fallback }, key), primary);
    assert.equal(compactEnvironmentValue({ [current]: "", [legacy]: fallback }, key), "");
    assert.deepEqual(configuration({ [current]: primary, [legacy]: fallback }), configuration({ [legacy]: primary }));
  });
}

test("blank/invalid primary values use existing validation/defaults, never the legacy value", () => {
  const defaults = configuration({});
  for (const [key, , fallback] of settings) {
    const current = `PI_S1_COMPACT_${key}`, legacy = key === "API_KEY" ? "NIMBLE_API_KEY" : `PI_NIMBLE_${key}`;
    assert.deepEqual(configuration({ [current]: "", [legacy]: fallback }), configuration({ [legacy]: "" }));
  }
  assert.equal(configuration({ PI_S1_COMPACT_URL: "", PI_NIMBLE_URL: "https://legacy.invalid/v1/systemone" }).endpoint, "");
  assert.equal(configuration({ PI_S1_COMPACT_API_KEY: "", NIMBLE_API_KEY: "old-synthetic-key" }).apiKey, "");
  assert.equal(configuration({ PI_S1_COMPACT_THRESHOLD: "bad", PI_NIMBLE_THRESHOLD: "0.6" }).threshold, defaults.threshold);
  assert.equal(configuration({ PI_S1_COMPACT_TRIGGER_TOKENS: "1", PI_NIMBLE_TRIGGER_TOKENS: "60000" }).triggerTokens, defaults.triggerTokens);
  assert.equal(configuration({ PI_S1_COMPACT_TRUNCATE_MIN_CHARS: "0" }).truncateMinChars, 0);
});

test("new transport names retain whitespace handling and never borrow hosted credentials", () => {
  const cfg = configuration({ PI_S1_COMPACT_URL: " http://localhost:8000/v1/systemone ",
    PI_S1_COMPACT_API_KEY: " synthetic-key ", PI_S1_COMPACT_MODEL: " nimble:local ", TYPESAFE_API_KEY: "unrelated" });
  assert.equal(cfg.endpoint, "http://localhost:8000/v1/systemone");
  assert.equal(cfg.apiKey, "synthetic-key");
  assert.equal(cfg.model, "nimble:local");
  assert.equal(configuration({ TYPESAFE_API_KEY: "unrelated" }).apiKey, "");
});

test("standalone engine client honors primary environment names and explicit options still win", async () => {
  const keys = ["PI_S1_COMPACT_URL", "PI_S1_COMPACT_API_KEY", "PI_S1_COMPACT_MODEL", "PI_NIMBLE_URL", "NIMBLE_API_KEY", "PI_NIMBLE_MODEL"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  try {
    Object.assign(process.env, { PI_S1_COMPACT_URL: "http://127.0.0.1:8000/v1/systemone", PI_S1_COMPACT_API_KEY: "new-key", PI_S1_COMPACT_MODEL: "new-model",
      PI_NIMBLE_URL: "https://legacy.invalid/v1/systemone", NIMBLE_API_KEY: "old-key", PI_NIMBLE_MODEL: "old-model" });
    for (const explicit of [false, true]) {
      const client = new NimbleClient({ ...(explicit ? { baseUrl: "http://localhost:9000/v1/systemone", apiKey: "option-key", model: "option-model" } : {}),
        fetch: async (url, init) => {
          assert.equal(url, explicit ? "http://localhost:9000/v1/systemone" : "http://127.0.0.1:8000/v1/systemone");
          assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${explicit ? "option-key" : "new-key"}`);
          assert.equal(JSON.parse(String(init?.body)).model, explicit ? "option-model" : "new-model");
          return Response.json({ answers: {} });
        } });
      await client.ask({ goal: "Test", history: [] }, {});
    }
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("live-test opt-in supports both names while compatibility checks force both off", () => {
  assert.equal(compactEnvironmentValue({ PI_NIMBLE_LIVE: "1" }, "LIVE"), "1");
  assert.equal(compactEnvironmentValue({ PI_S1_COMPACT_LIVE: "0", PI_NIMBLE_LIVE: "1" }, "LIVE"), "0");
  const script = readFileSync(new URL("../scripts/check-compatibility.mjs", import.meta.url), "utf8");
  assert.match(script, /PI_S1_COMPACT_LIVE: "0"/);
  assert.match(script, /PI_NIMBLE_LIVE: "0"/);
});
