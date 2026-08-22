import assert from "node:assert/strict";
import test from "node:test";
import { mediaContentMatchesMime } from "../src/lib/media-content";

test("uploaded images must match their declared binary format", () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = new TextEncoder().encode("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");
  assert.equal(mediaContentMatchesMime(jpeg, "image/jpeg"), true);
  assert.equal(mediaContentMatchesMime(png, "image/png"), true);
  assert.equal(mediaContentMatchesMime(webp, "image/webp"), true);
  assert.equal(mediaContentMatchesMime(jpeg, "image/png"), false);
  assert.equal(mediaContentMatchesMime(png, "image/jpeg"), false);
  assert.equal(mediaContentMatchesMime(png, "image/webp"), false);
});

test("uploaded videos must be WebM or an ISO media container", () => {
  const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
  const mp4 = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const paddedMov = Uint8Array.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x72, 0x65, 0x65, 0x00, 0x00, 0x00, 0x0c, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
  assert.equal(mediaContentMatchesMime(webm, "video/webm"), true);
  assert.equal(mediaContentMatchesMime(mp4, "video/mp4"), true);
  assert.equal(mediaContentMatchesMime(mp4, "video/quicktime"), true);
  assert.equal(mediaContentMatchesMime(paddedMov, "video/quicktime"), true);
  assert.equal(mediaContentMatchesMime(webm, "video/mp4"), false);
  assert.equal(mediaContentMatchesMime(new TextEncoder().encode("not media"), "video/webm"), false);
});
