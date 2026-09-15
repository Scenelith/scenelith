import assert from "node:assert/strict";
import { after, test } from "node:test";
import { afterDatabaseCommit, closeRelationalPool, relationalDb as db } from "../src/lib/relational-db";

after(closeRelationalPool);

test("async work inherited from a completed transaction cannot reuse its released connection", async () => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let inherited!: Promise<unknown>;
  await db.transaction(async () => {
    inherited = (async () => {
      await gate;
      return await db.transaction(async () => await db.prepare("SELECT 42 AS value").get())();
    })();
  })();
  // This models pg retiring the admission connection during a long generation.
  await closeRelationalPool();
  resume();
  assert.deepEqual(await inherited, { value: 42 });
});

test("worker wakeups wait for the outer commit and are discarded on rollback", async () => {
  const seen: string[] = [];
  await db.transaction(async () => {
    afterDatabaseCommit(() => seen.push("outer"));
    await db.transaction(async () => afterDatabaseCommit(() => seen.push("nested")))();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(seen, []);
  })();
  assert.deepEqual(seen, ["outer", "nested"]);
  await assert.rejects(db.transaction(async () => {
    afterDatabaseCommit(() => seen.push("rolled back"));
    throw new Error("rollback");
  })(), /rollback/);
  assert.deepEqual(seen, ["outer", "nested"]);
});

test("after-commit work can open an independent transaction even before its caller returns", async () => {
  let work!: Promise<unknown>;
  await db.transaction(async () => {
    afterDatabaseCommit(() => { work = db.transaction(async () => db.prepare("SELECT 7 AS value").get())(); });
  })();
  assert.deepEqual(await work, { value: 7 });
});
