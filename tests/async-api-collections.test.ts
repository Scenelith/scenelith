import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hooksRoute = readFileSync(new URL("../src/app/api/hooks/route.ts", import.meta.url), "utf8");

test("hook endpoints resolve async collections before serializing them", () => {
  assert.doesNotMatch(hooksRoute, /hooks:\s*listHooks\(/);
  assert.equal(hooksRoute.match(/hooks:\s*await listHooks\(/g)?.length, 3);
});

test("generated hook writes finish before the refreshed collection is read", () => {
  assert.match(hooksRoute, /await transaction\(\);\s*return Response\.json\(\{ hooks: await listHooks/);
});
