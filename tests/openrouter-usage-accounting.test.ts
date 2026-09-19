import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createOpenRouterUsageTracker, withOpenRouterUsage, withOpenRouterModel, withOpenRouterOutputLimit,
  requestOpenRouter, requestOpenRouterText, openRouterUsagePending, summarizeOpenRouterUsage } from "../src/lib/openrouter";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = "test-accounting-key";
after(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey; });

function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

test("paid malformed JSON preserves actual model, tokens and cost before parsing fails", async () => {
  const tracker = createOpenRouterUsageTracker();
  const states: boolean[] = [];
  tracker.checkpoint = async () => { states.push(openRouterUsagePending(tracker)); };
  globalThis.fetch = async () => response({ id: "paid-invalid", model: "provider/actual", usage: { cost: "0.024", prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
    completion_tokens_details: { reasoning_tokens: 20 }, prompt_tokens_details: { cached_tokens: 50 } }, choices: [{ message: { content: "invalid json" } }] });
  await assert.rejects(withOpenRouterUsage(tracker, () => requestOpenRouter({})), /invalid structured data/);
  assert.deepEqual(states, [true, false]);
  assert.equal(tracker.entries[0].model, "provider/actual");
  assert.equal(tracker.entries[0].reasoningTokens, 20);
  assert.equal(summarizeOpenRouterUsage(tracker).costUsd, 0.024);
  assert.equal(summarizeOpenRouterUsage(tracker).totalTokens, 130);
});

test("missing cost is recovered from generation receipt rather than treated as zero", async () => {
  const tracker = createOpenRouterUsageTracker();
  globalThis.fetch = async (url) => String(url).includes("/generation?")
    ? response({ data: { total_cost: 0.07, native_tokens_prompt: 90, native_tokens_completion: 10 } })
    : response({ id: "receipt-1", choices: [{ message: { content: "result" } }] });
  assert.equal(await withOpenRouterUsage(tracker, () => requestOpenRouterText({})), "result");
  assert.equal(tracker.entries[0].costUsd, 0.07);
  assert.equal(tracker.entries[0].totalTokens, 100);
  assert.equal(openRouterUsagePending(tracker), false);
});

test("explicit zero-cost responses remain free and are not looked up again", async () => {
  const tracker = createOpenRouterUsageTracker(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response({ id: "cached", usage: { cost: 0, prompt_tokens: 0, completion_tokens: 0 }, choices: [{ message: { content: "cached" } }] }); };
  await withOpenRouterUsage(tracker, () => requestOpenRouterText({}));
  assert.equal(calls, 1); assert.equal(openRouterUsagePending(tracker), false);
});

test("missing receipt and transport loss stay pending instead of becoming free retries", async () => {
  const tracker = createOpenRouterUsageTracker();
  globalThis.fetch = async () => response({ choices: [{ message: { content: "unknown cost" } }] });
  await assert.rejects(withOpenRouterUsage(tracker, () => requestOpenRouterText({})), { code: "PROVIDER_USAGE_PENDING" });
  assert.equal(openRouterUsagePending(tracker), true);
  const interrupted = createOpenRouterUsageTracker();
  globalThis.fetch = async () => { throw new Error("connection reset"); };
  await assert.rejects(withOpenRouterUsage(interrupted, () => requestOpenRouterText({})), /connection reset/);
  assert.equal(openRouterUsagePending(interrupted), true);
});

test("unbilled rejection does not create a paid request", async () => {
  const tracker = createOpenRouterUsageTracker();
  globalThis.fetch = async () => response({ error: { message: "rejected" } }, 400);
  await assert.rejects(withOpenRouterUsage(tracker, () => requestOpenRouterText({})), /rejected/);
  assert.equal(openRouterUsagePending(tracker), false); assert.equal(tracker.entries.length, 0);
});

test("preauthorized output cap applies to the actual request and selected model", async () => {
  const tracker = createOpenRouterUsageTracker(); let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return response({ usage: { cost: 0 }, choices: [{ message: { content: "ok" } }] }); };
  await withOpenRouterUsage(tracker, () => withOpenRouterModel("qwen/qwen3.8-max", () => withOpenRouterOutputLimit(500, () => requestOpenRouterText({ max_tokens: 9000, stream: true }))));
  assert.deepEqual((body.provider as Record<string, unknown>).max_price, { prompt: 2, completion: 6 });
  assert.equal(body.max_tokens, 500); assert.equal(body.stream, false); assert.equal(body.model, "qwen/qwen3.8-max");
  assert.equal(tracker.entries[0].model, "qwen/qwen3.8-max");
});


test("server errors without a receipt retain authorization", async () => {
  const tracker = createOpenRouterUsageTracker();
  globalThis.fetch = async () => response({ error: { message: "upstream failed" } }, 502);
  await assert.rejects(withOpenRouterUsage(tracker, () => requestOpenRouterText({})), { code: "PROVIDER_USAGE_PENDING" });
  assert.equal(openRouterUsagePending(tracker), true);
});
