import assert from "node:assert/strict";
import test from "node:test";
import {
  REQUIRED_APPLICATION_BASELINE,
  REQUIRED_COLLABORATION_MIGRATION,
} from "../src/lib/operations-observability";

test("readiness tracks the immutable application baseline and collaboration migration", () => {
  assert.equal(REQUIRED_APPLICATION_BASELINE, "core-v1");
  assert.equal(REQUIRED_COLLABORATION_MIGRATION, "004_document_tombstones.sql");
});
