import assert from "node:assert/strict";
import { test } from "node:test";
import { submitGenerationWhenAvailable } from "../src/lib/generation-submission";

const request = { projectId: "canvas", nodeId: "image", prompt: "Portrait" };
const reply = (body: object, status = 200) => Response.json(body, { status });
function transport(responses: Response[]) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, options) => {
    calls.push(`${options?.method || "GET"} ${url}`);
    const response = responses.shift();
    assert.ok(response, "No unexpected submissions or retries");
    return response;
  };
  return { fetch, calls };
}

test("an occupied workspace waits with read-only checks and submits once when free", async () => {
  const { fetch, calls } = transport([reply({ available: 0 }), reply({ available: 0 }), reply({ available: 1 }), reply({ generationId: "new" })]);
  const delays: number[] = [];
  const result = await submitGenerationWhenAvailable(request, new AbortController().signal, { fetch, wait: async (ms) => { delays.push(ms); } });
  assert.equal(result.body.generationId, "new");
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["GET", "GET", "GET", "POST"]);
  assert.deepEqual(delays, [3000, 3000]);
});

test("another tab taking the last slot returns to capacity checks after admission 429", async () => {
  const { fetch, calls } = transport([
    reply({ available: 1 }), reply({ code: "GENERATION_CONCURRENCY_LIMIT", retryAfterMs: 4500 }, 429),
    reply({ available: 0 }), reply({ available: 1 }), reply({ generationId: "accepted" }),
  ]);
  const delays: number[] = [];
  const result = await submitGenerationWhenAvailable(request, new AbortController().signal, { fetch, wait: async (ms) => { delays.push(ms); } });
  assert.equal(result.body.generationId, "accepted");
  assert.deepEqual(calls.map((call) => call.split(" ")[0]), ["GET", "POST", "GET", "GET", "POST"]);
  assert.deepEqual(delays, [4500, 3000]);
});

test("provider rate limits and other rejections are not blindly retried", async () => {
  for (const status of [400, 402, 409, 429, 500]) {
    const { fetch, calls } = transport([reply({ available: 1 }), reply({ error: "Rejected", code: "PROVIDER_RATE_LIMIT" }, status)]);
    const result = await submitGenerationWhenAvailable(request, new AbortController().signal, { fetch });
    assert.equal(result.response.status, status);
    assert.equal(calls.length, 2);
  }
});

test("missing project access stops before any generation POST", async () => {
  const { fetch, calls } = transport([reply({ error: "Canvas not found" }, 404)]);
  await assert.rejects(submitGenerationWhenAvailable(request, new AbortController().signal, { fetch }), /Canvas not found/);
  assert.equal(calls.length, 1);
});

test("leaving a Canvas cancels a capacity wait without submitting later", async () => {
  const controller = new AbortController();
  const { fetch, calls } = transport([reply({ available: 0 })]);
  const pending = submitGenerationWhenAvailable(request, controller.signal, { fetch });
  // Let the response body be read and the cancellable waiting timer start.
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls.length, 1);
});
