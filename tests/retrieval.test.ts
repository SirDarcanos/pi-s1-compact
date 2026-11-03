import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { activeRetrievalTool, ENTRY_TYPE, ledger, original, reference, textOf, truncationLedger } from "../src/pruning.ts";
import { harness, flush } from "./harness.ts";

const context = (h: Awaited<ReturnType<typeof harness>>) => buildSessionContext(h.sm.getBranch()).messages;

test("primary retrieval and historical alias share the exact handler and parameters", async () => {
  const h = await harness();
  const primary = h.tools.get("s1_compact_read")!, legacy = h.tools.get("nimble_read")!;
  assert.ok(primary); assert.ok(legacy);
  assert.equal(primary.execute, legacy.execute);
  assert.equal(primary.parameters, legacy.parameters);
  const result = context(h).find(m => m.role === "toolResult")!;
  assert.equal(result.role, "toolResult");
  const ref = reference(result), bytes = textOf(result);
  h.sm.appendCustomEntry("pi-nimble-pruning", { version: 1, refs: [ref] });
  for (const tool of [primary, legacy]) {
    const read = await tool.execute("read", { ref, offset: 12, limit: 40 }, undefined as any, undefined as any, h.ctx as any);
    assert.ok((read.content[0] as any).text.endsWith(bytes.slice(12, 52)));
    await assert.rejects(tool.execute("read", { ref: "0".repeat(24) }, undefined as any, undefined as any, h.ctx as any), /not on this session branch/);
    await assert.rejects(tool.execute("read", { ref, offset: bytes.length + 1 }, undefined as any, undefined as any, h.ctx as any), /exceeds output length/);
  }
  await h.command("s1-compact-reset");
  assert.equal(ledger(h.sm.getBranch()).size, 0);
  assert.equal(textOf(original(h.sm.getBranch(), ref)!), bytes);
  const afterReset = await primary.execute("read", { ref, limit: 40 }, undefined as any, undefined as any, h.ctx as any);
  assert.ok((afterReset.content[0] as any).text.endsWith(bytes.slice(0, 40)));
});

for (const probability of [0, 1]) {
  for (const active of [["s1_compact_read"], ["nimble_read"], ["nimble_read", "s1_compact_read"]]) {
    test(`${probability ? "shortening" : "clearing"} supports allowlist ${active.join(", ")}`, async () => {
      const h = await harness({ probability }); h.active(active);
      await h.command("s1-compact");
      const refs = probability ? truncationLedger(h.sm.getBranch()) : ledger(h.sm.getBranch());
      assert.equal(refs.size, 1);
      const projected = await h.fire("context", { messages: context(h) });
      const output = projected.messages.find((m: any) => m.role === "toolResult");
      const expected = active.includes("s1_compact_read") ? "s1_compact_read" : "nimble_read";
      assert.match(textOf(output), new RegExp(`Retrieve with ${expected}\\(`));
      assert.match(textOf(output), /\[pi-s1-compact:/);
      assert.ok(!textOf(output).includes(expected === "nimble_read" ? "s1_compact_read(" : "nimble_read("));
      const ref = [...refs][0]!;
      assert.ok(original(h.sm.getBranch(), ref));
      // Switching the allowlist reprojects existing records without rewriting history.
      const entries = h.sm.getBranch().length;
      h.active(expected === "nimble_read" ? ["s1_compact_read"] : ["nimble_read"]);
      const switched = await h.fire("context", { messages: context(h) });
      assert.match(JSON.stringify(switched.messages), new RegExp(`Retrieve with ${expected === "nimble_read" ? "s1_compact_read" : "nimble_read"}`));
      assert.equal(h.sm.getBranch().length, entries);
      h.active([]);
      assert.equal(await h.fire("context", { messages: context(h) }), undefined);
    });
  }
}

test("neither retrieval tool active blocks manual and automatic scoring without masking history", async () => {
  const h = await harness(); h.active([]);
  await h.command("s1-compact"); await h.fire("turn_end"); await flush();
  assert.equal(h.sent.length, 0); assert.equal(ledger(h.sm.getBranch()).size, 0);
  await h.command("s1-compact-status");
  assert.match(h.notices.at(-1)!, /no active owned retrieval tool/);
  assert.equal(activeRetrievalTool([]), undefined);
});

test("losing both retrieval tools during scoring prevents late commits", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await harness({ classify: async (model, c) => {
    await gate;
    return { provider: model.provider, model: model.id, api: model.api, stopReason: "stop", timestamp: 0,
      answers: Object.fromEntries(Object.keys(c.questions).map(id => [id, { type: "bool", probability: 0 }])) };
  } });
  await h.fire("turn_end"); assert.equal(h.sent.length, 1);
  h.active([]); release(); await flush();
  assert.equal(ledger(h.sm.getBranch()).size, 0); assert.equal(truncationLedger(h.sm.getBranch()).size, 0);
  assert.ok(!h.sm.getBranch().some(entry => entry.type === "custom" && entry.customType === ENTRY_TYPE));
});
