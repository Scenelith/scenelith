import assert from "node:assert/strict";
import test from "node:test";
import { canAccessTicket, canSeeFeature, canVoteForFeature, compareSupportQueue, nextTicketStatusAfterReply, sanitizeFeatureForViewer, supportTierRank } from "../src/lib/community-policy";
import type { FeatureRequestRecord } from "../src/lib/types";

const owner = { id: "owner", isAdmin: false };
const stranger = { id: "stranger", isAdmin: false };
const admin = { id: "admin", isAdmin: true };

test("support tickets are private to their owner and administrators", () => {
  assert.equal(canAccessTicket(owner, "owner"), true);
  assert.equal(canAccessTicket(stranger, "owner"), false);
  assert.equal(canAccessTicket(admin, "owner"), true);
});

test("pending and rejected features stay private until moderation", () => {
  assert.equal(canSeeFeature(owner, "owner", "pending"), true);
  assert.equal(canSeeFeature(stranger, "owner", "pending"), false);
  assert.equal(canSeeFeature(stranger, "owner", "rejected"), false);
  assert.equal(canSeeFeature(admin, "owner", "pending"), true);
  assert.equal(canSeeFeature(stranger, "owner", "approved"), true);
  assert.equal(canSeeFeature(owner, "owner", "approved", true), false);
  assert.equal(canSeeFeature(stranger, "owner", "approved", true), false);
  assert.equal(canSeeFeature(admin, "owner", "approved", true), true);
});

test("votes are accepted only while a public feature is actionable", () => {
  assert.equal(canVoteForFeature("pending"), false);
  assert.equal(canVoteForFeature("approved"), true);
  assert.equal(canVoteForFeature("planned"), true);
  assert.equal(canVoteForFeature("in_progress"), true);
  assert.equal(canVoteForFeature("shipped"), false);
  assert.equal(canVoteForFeature("rejected"), false);
});

test("public feature records do not expose author identity or private moderation notes", () => {
  const feature: FeatureRequestRecord = {
    id: "feature-1", userId: "owner", userName: "Owner", isOwner: false,
    title: "Feature", description: "A useful public feature", status: "approved", hidden: false,
    moderationNote: "Private note", voteCount: 2, hasVoted: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const publicRecord = sanitizeFeatureForViewer(feature, { id: "stranger", isAdmin: false });
  assert.equal(publicRecord.userId, "");
  assert.equal(publicRecord.userName, "");
  assert.equal(publicRecord.moderationNote, "");
  assert.equal(publicRecord.isOwner, false);

  const ownerRecord = sanitizeFeatureForViewer(feature, { id: "owner", isAdmin: false });
  assert.equal(ownerRecord.userId, "owner");
  assert.equal(ownerRecord.moderationNote, "Private note");
  assert.equal(ownerRecord.isOwner, true);
});

test("ticket replies move the conversation to the correct queue", () => {
  assert.equal(nextTicketStatusAfterReply(false, "resolved"), "open");
  assert.equal(nextTicketStatusAfterReply(true, "open"), "in_progress");
  assert.equal(nextTicketStatusAfterReply(true, "closed"), "closed");
});

test("admin support queue prioritizes higher support tiers", () => {
  const base = { priority: "urgent" as const, needsReply: true, status: "open" as const, updatedAt: "2026-08-01T00:00:00.000Z" };
  const community = { ...base, supportRank: supportTierRank("community") };
  const priority = { ...base, priority: "normal" as const, supportRank: supportTierRank("priority") };
  assert.ok(compareSupportQueue(priority, community) < 0);
});

test("admin support queue puts waiting and older conversations first within a tier", () => {
  const supportRank = supportTierRank("standard");
  const tickets = [
    { supportRank, priority: "normal" as const, needsReply: false, status: "in_progress" as const, updatedAt: "2026-08-03T00:00:00.000Z" },
    { supportRank, priority: "normal" as const, needsReply: true, status: "open" as const, updatedAt: "2026-08-02T00:00:00.000Z" },
    { supportRank, priority: "normal" as const, needsReply: true, status: "open" as const, updatedAt: "2026-08-01T00:00:00.000Z" },
  ];
  tickets.sort(compareSupportQueue);
  assert.equal(tickets[0].updatedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(tickets[2].needsReply, false);
});
