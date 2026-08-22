import test from "node:test";
import assert from "node:assert/strict";
import { incrementOperationalCounter, operationalCountersPrometheus } from "../src/lib/operational-telemetry";

test("operational counters aggregate stable labels without exposing event payloads", () => {
  incrementOperationalCounter(
    "scenelith_test_requests_total",
    "Test requests.",
    { result: "success", operation: "write" },
  );
  incrementOperationalCounter(
    "scenelith_test_requests_total",
    "Test requests.",
    { operation: "write", result: "success" },
    2,
  );

  const rendered = operationalCountersPrometheus();
  assert.match(rendered, /# TYPE scenelith_test_requests_total counter/);
  assert.match(rendered, /scenelith_test_requests_total\{operation="write",result="success"\} 3/);
});

test("operational counters reject unbounded or malformed metric names", () => {
  assert.throws(() => incrementOperationalCounter("provider-error", "Invalid.", {}, 1));
});
