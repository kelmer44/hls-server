import test from "node:test";
import assert from "node:assert/strict";
import { createContentSchedule } from "./content-schedule.js";

function files(schedule, count) {
  return Array.from({ length: count }, (_, sequence) => schedule.itemForSequence(sequence).file);
}

test("defaults preserve the existing six-chunk, two-break cycle", () => {
  const cycle = ["content-1.ts", "content-2.ts", "content-3.ts", "broadcast-ad-1.ts", "broadcast-ad-2.ts",
    "content-4.ts", "content-5.ts", "content-6.ts", "broadcast-ad-1.ts", "broadcast-ad-2.ts"];
  assert.deepEqual(files(createContentSchedule(), 30), [...cycle, ...cycle, ...cycle]);
});

test("content wraps independently of ad cadence", () => {
  const schedule = createContentSchedule({ maxUsableChunks: 3, chunksBetweenAdBreaks: 5 });
  assert.deepEqual(files(schedule, 14), [
    "content-1.ts", "content-2.ts", "content-3.ts", "content-1.ts", "content-2.ts",
    "broadcast-ad-1.ts", "broadcast-ad-2.ts",
    "content-3.ts", "content-1.ts", "content-2.ts", "content-3.ts", "content-1.ts",
    "broadcast-ad-1.ts", "broadcast-ad-2.ts"
  ]);
});

test("all 48 chunks and break ordinals remain stable over repeated cycles", () => {
  const schedule = createContentSchedule({ maxUsableChunks: "48", chunksBetweenAdBreaks: "24" });
  for (let ordinal = 0; ordinal < 100; ordinal++) {
    const start = ordinal * 26;
    for (let index = 0; index < 24; index++) {
      assert.equal(schedule.itemForSequence(start + index).file, `content-${(ordinal * 24 + index) % 48 + 1}.ts`);
    }
    assert.deepEqual(schedule.itemForSequence(start + 24), {
      type: "broadcast-ad", file: "broadcast-ad-1.ts", adBreakPosition: 0
    });
    assert.deepEqual(schedule.itemForSequence(start + 25), {
      type: "broadcast-ad", file: "broadcast-ad-2.ts", adBreakPosition: 1
    });
    assert.equal(schedule.adBreakOrdinal(start + 24), ordinal);
  }
});

test("one content chunk between breaks works", () => {
  assert.deepEqual(files(createContentSchedule({ maxUsableChunks: 1, chunksBetweenAdBreaks: 1 }), 6), [
    "content-1.ts", "broadcast-ad-1.ts", "broadcast-ad-2.ts",
    "content-1.ts", "broadcast-ad-1.ts", "broadcast-ad-2.ts"
  ]);
});

test("invalid settings fail with their config names", () => {
  for (const value of [0, -1, 1.5, "", "abc", true, Infinity, 49]) {
    assert.throws(() => createContentSchedule({ maxUsableChunks: value }), /maxUsableChunks/);
  }
  for (const value of [0, -1, 1.5, "", "abc", true, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createContentSchedule({ chunksBetweenAdBreaks: value }), /chunksBetweenAdBreaks/);
  }
});
