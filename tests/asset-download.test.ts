import assert from "node:assert/strict";
import { test } from "node:test";
import { assetDownloadHref } from "../src/lib/asset-download";
test("downloads use authenticated attachment delivery and preserve variants", () => {
 const base="/api/assets/11111111-1111-4111-8111-111111111111";
 assert.equal(assetDownloadHref(base),base+"?download=1");
 assert.equal(assetDownloadHref(base+"?variant=original&download=0"),base+"?variant=original&download=1");
 for(const url of [null, "https://provider.example/image.png", "//evil.test/api/assets/11111111-1111-4111-8111-111111111111", "/api/assets/nope"])assert.equal(assetDownloadHref(url),null);
});
