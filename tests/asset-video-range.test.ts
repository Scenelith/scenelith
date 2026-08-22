import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoByteRange } from "../src/app/api/assets/[id]/route";

test("video range parser supports editor seek and suffix requests", () => {
  assert.deepEqual(parseVideoByteRange("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseVideoByteRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseVideoByteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseVideoByteRange("bytes=900-2000", 1000), { start: 900, end: 999 });
});

test("video range parser rejects ranges that cannot describe one response", () => {
  assert.equal(parseVideoByteRange("bytes=1000-", 1000), null);
  assert.equal(parseVideoByteRange("bytes=200-100", 1000), null);
  assert.equal(parseVideoByteRange("bytes=0-1,4-5", 1000), null);
  assert.equal(parseVideoByteRange("items=0-1", 1000), null);
});
