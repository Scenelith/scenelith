import assert from "node:assert/strict";
import { test } from "node:test";
import { taskCreditLabel } from "../src/lib/task-credit-label";
import type { TaskCreditUsage } from "../src/modules/usage/contracts";

const usage: TaskCreditUsage = { unit: "credits", unitLabel: "Account credits", status: "reserved", quotedCredits: 430, reservedCredits: 430, chargedCredits: 0, refundedCredits: 0, expiredCredits: 0 };

test("task labels separate launch reservations, actual spend and returned credits", () => {
  assert.equal(taskCreditLabel(undefined), null);
  assert.equal(taskCreditLabel(usage), "430 credits reserved");
  assert.equal(taskCreditLabel({ ...usage, status: "settled", reservedCredits: 0, chargedCredits: 430 }), "430 credits spent");
  assert.equal(taskCreditLabel({ ...usage, status: "refunded", reservedCredits: 0, refundedCredits: 378 }), "0 credits spent · 378 returned");
  assert.equal(taskCreditLabel({ ...usage, status: "not_charged", reservedCredits: 0 }), "0 credits spent");
  assert.equal(taskCreditLabel({ ...usage, status: "unavailable" }), "Credit usage unavailable");
});

test("expired subscription credits are not represented as credits returned to the balance", () => {
  assert.equal(taskCreditLabel({ ...usage, status: "refunded", reservedCredits: 0, refundedCredits: 30, expiredCredits: 400 }), "0 credits spent · 30 returned · 400 expired");
});
