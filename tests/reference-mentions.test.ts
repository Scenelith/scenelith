import assert from "node:assert/strict";
import test from "node:test";
import { appendEditReferenceMention, editReferenceMentionToken } from "../src/lib/reference-mentions";

test("edit reference tokens stay readable and stable when selection order changes", () => {
  const token = editReferenceMentionToken("Olivia · After 01", "11111111-1111-4111-8111-111111111111");
  assert.match(token, /^@Olivia_After_01_[a-z0-9]{1,4}$/);
  assert.equal(token, editReferenceMentionToken("Olivia · After 01", "11111111-1111-4111-8111-111111111111"));
});

test("same-titled edit references receive distinct tokens", () => {
  assert.notEqual(
    editReferenceMentionToken("Canvas image", "11111111-1111-4111-8111-111111111111"),
    editReferenceMentionToken("Canvas image", "22222222-2222-4222-8222-222222222222"),
  );
});

test("every click on an attached edit reference appends its mention", () => {
  const title = "Olivia · After 01";
  const assetId = "11111111-1111-4111-8111-111111111111";
  const token = editReferenceMentionToken(title, assetId);
  assert.equal(appendEditReferenceMention("Change the pose", title, assetId), `Change the pose ${token}`);
  assert.equal(appendEditReferenceMention(`Change the pose ${token}`, title, assetId), `Change the pose ${token} ${token}`);
});
