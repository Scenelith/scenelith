import assert from "node:assert/strict";
import test from "node:test";
import type { FrameEdge, FrameNode } from "../src/lib/types";
import { findTikTokSlideshowSources, matchesTikTokSlideshowSource } from "../src/lib/tiktok-slideshow-sources";

function node(id: string, kind: FrameNode["data"]["kind"], data: Partial<FrameNode["data"]> = {}): FrameNode {
  return { id, type: "frameNode", position: { x: 0, y: 0 }, data: { kind, title: id, ...data } };
}

function edge(source: string, target: string): FrameEdge {
  return { id: `${source}-${target}`, source, target };
}

test("TikTok videos never become slideshow sources from detected scene thumbnails", () => {
  const nodes = [
    node("video", "source", {
      postId: "123",
      sourceUrl: "https://www.tiktok.com/@creator/video/123",
      tiktokMediaType: "video",
      mediaType: "video",
      videoSegments: [
        { id: "a", index: 1, label: "Scene 01", role: "scene", start: 0, end: 2, confidence: 1, thumbnailAssetId: crypto.randomUUID() },
        { id: "b", index: 2, label: "Scene 02", role: "scene", start: 2, end: 4, confidence: 1, thumbnailAssetId: crypto.randomUUID() },
      ],
    }),
  ];
  assert.deepEqual(findTikTokSlideshowSources(nodes, []), []);
});

test("legacy TikTok video timelines are excluded without an explicit importer type", () => {
  const nodes = [node("video", "source", {
    postId: "123",
    sourceUrl: "https://www.tiktok.com/@creator/video/123",
    mediaType: "video",
    videoSegments: [{ id: "a", index: 1, label: "Scene 01", role: "scene", start: 0, end: 2, confidence: 1 }],
  })];
  assert.deepEqual(findTikTokSlideshowSources(nodes, []), []);
});

test("explicit slideshows use ordered image scenes and stable lineage", () => {
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const nodes = [
    node("slideshow", "source", { postId: "456", sourceUrl: "https://www.tiktok.com/@creator/photo/456", tiktokMediaType: "slideshow" }),
    node("slide-2", "scene", { title: "Screen 02", assetId: secondId, tiktokSourceNodeId: "slideshow" }),
    node("slide-1", "scene", { title: "Screen 01", assetId: firstId, tiktokSourceNodeId: "slideshow" }),
  ];
  const sources = findTikTokSlideshowSources(nodes, []);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].assetIds, [firstId, secondId]);
  assert.equal(matchesTikTokSlideshowSource(nodes, [], "slideshow", [firstId, secondId]), true);
  assert.equal(matchesTikTokSlideshowSource(nodes, [], "slideshow", [secondId, firstId]), false);
});

test("legacy imported slideshows remain available through canvas edges", () => {
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  const nodes = [
    node("slideshow", "source", { postId: "456", sourceUrl: "https://www.tiktok.com/@creator/photo/456" }),
    node("slide-1", "scene", { title: "Screen 01", assetId: firstId }),
    node("slide-2", "scene", { title: "Screen 02", assetId: secondId }),
  ];
  const sources = findTikTokSlideshowSources(nodes, [edge("slideshow", "slide-1"), edge("slideshow", "slide-2")]);
  assert.deepEqual(sources[0].assetIds, [firstId, secondId]);
});

test("a one-image TikTok photo post is still a slideshow automation source", () => {
  const assetId = crypto.randomUUID();
  const nodes = [
    node("static-post", "source", { postId: "789", sourceUrl: "https://www.tiktok.com/@creator/photo/789", tiktokMediaType: "slideshow" }),
    node("only-slide", "scene", { title: "Screen 01", assetId, tiktokSourceNodeId: "static-post" }),
  ];
  const sources = findTikTokSlideshowSources(nodes, []);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].assetIds, [assetId]);
  assert.equal(matchesTikTokSlideshowSource(nodes, [], "static-post", [assetId]), true);
});
