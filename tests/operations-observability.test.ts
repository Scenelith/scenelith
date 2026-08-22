import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_APPLICATION_MIGRATION,
  REQUIRED_COLLABORATION_MIGRATION,
} from "../src/lib/operations-observability";

function latestMigration(directory: string) {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().at(-1);
}

test("readiness tracks the latest application and collaboration migrations", () => {
  assert.equal(REQUIRED_APPLICATION_MIGRATION, latestMigration("database/migrations"));
  assert.equal(REQUIRED_COLLABORATION_MIGRATION, latestMigration("collaboration/migrations"));
});
