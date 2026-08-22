import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  createScenelithDocument,
  parseScenelithDocument,
  projectGraphFromScenelithDocument,
} from "../src/lib/scenelith-document";
import type { ProjectGraph } from "../src/lib/types";

const graph: ProjectGraph = {
  nodes: [
    {
      id: "private-source-id",
      type: "frameNode",
      position: { x: 10, y: 20 },
      data: {
        kind: "scene",
        title: "Source portrait",
        assetId: "1dcfcc0a-1423-41af-8c6c-842eb7a809af",
        imageUrl: "/api/assets/1dcfcc0a-1423-41af-8c6c-842eb7a809af",
        status: "ready",
        mediaType: "image",
      },
    },
    {
      id: "private-generator-id",
      type: "frameNode",
      position: { x: 420, y: 20 },
      data: {
        kind: "prompt",
        title: "Portrait generator",
        prompt: "Preserve the person and change the lighting to soft daylight.",
        modelId: "nano-banana-2",
        mediaType: "image",
        aspectRatio: "4:5",
        resolution: "1K",
        generatedOutputs: [{ url: "https://private.example/output.png", assetId: "private-output", mediaType: "image" }],
      },
    },
  ],
  edges: [{
    id: "private-edge-id",
    source: "private-source-id",
    target: "private-generator-id",
    sourceHandle: "output",
    targetHandle: "reference-image-input",
    data: { portType: "image", inputRole: "reference-image", clipAssetId: "private-clip", clipUrl: "/api/assets/private-clip" },
  }],
  viewport: { x: 0, y: 0, zoom: 1 },
};

test(".scenelith.json exports a portable graph without instance ids, assets or output URLs", () => {
  const document = createScenelithDocument({ title: "Portrait workflow", tags: ["portrait"], graph });
  const serialized = JSON.stringify(document);
  assert.equal(document.format, "scenelith.canvas");
  assert.equal(document.version, 1);
  assert.deepEqual(document.requirements.providers, ["kie"]);
  assert.deepEqual(document.inputs, [{ nodeId: "node-1", kind: "image", label: "Source portrait", required: true }]);
  assert.doesNotMatch(serialized, /private-source-id|private-generator-id|private-edge-id|private-output|private-clip/);
  assert.doesNotMatch(serialized, /assetId|imageUrl|outputUrl|generatedOutputs|\/api\/assets|private\.example/);
  assert.equal(document.graph.edges[0].source, "node-1");
  assert.equal(document.graph.edges[0].target, "node-2");
});

test("import assigns fresh graph ids and keeps portable topology", () => {
  const document = createScenelithDocument({ title: "Portrait workflow", graph });
  const imported = projectGraphFromScenelithDocument(parseScenelithDocument(JSON.parse(JSON.stringify(document))));
  assert.equal(imported.nodes.length, 2);
  assert.equal(imported.edges.length, 1);
  assert.notEqual(imported.nodes[0].id, "node-1");
  assert.equal(imported.edges[0].source, imported.nodes[0].id);
  assert.equal(imported.edges[0].target, imported.nodes[1].id);
  assert.match(String(imported.nodes[0].data.subtitle), /Input required/);
});

test("document parser fails closed on future versions, unknown fields and embedded credentials", () => {
  const document = createScenelithDocument({ title: "Safe", graph });
  const fakeCredential = ["sk", "or", "v1", "1234567890abcdef"].join("-");
  assert.throws(() => parseScenelithDocument({ ...document, version: 2 }), /Unsupported Scenelith document version/);
  assert.throws(() => parseScenelithDocument({ ...document, privateWorkspaceId: "hidden" }));
  assert.throws(() => parseScenelithDocument({ ...document, metadata: { ...document.metadata, description: `api_key=${fakeCredential}` } }), /credentials or API keys/);
});

test("every bundled recipe is a valid current Scenelith document", () => {
  const recipesRoot = join(process.cwd(), "recipes");
  const files = readdirSync(recipesRoot).filter((file) => file.endsWith(".scenelith.json"));
  assert.ok(files.length >= 2);
  for (const file of files) {
    const document = parseScenelithDocument(JSON.parse(readFileSync(join(recipesRoot, file), "utf8")));
    assert.ok(document.graph.nodes.length > 0, `${file} is empty`);
  }
});
