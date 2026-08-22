import assert from "node:assert/strict";
import test from "node:test";
import { identityDestinationRoles, identityHasGeneratedAsset } from "../src/components/AddToIdentityPopover";
import type { PersonaRecord } from "../src/lib/types";

function persona(roles: Array<"reference" | "before" | "after">): PersonaRecord {
  return {
    id: "persona",
    name: "Persona",
    notes: "",
    workspaceId: "workspace",
    createdAt: new Date(0).toISOString(),
    assets: roles.map((role, index) => ({ id: `${role}-${index}`, url: "/image.png", filename: "image.png", role, sortOrder: index })),
  };
}

test("single identities offer one clean Identity destination", () => {
  assert.deepEqual(identityDestinationRoles(persona(["reference", "reference"])), ["reference"]);
});

test("transformation identities offer Before and After destinations", () => {
  assert.deepEqual(identityDestinationRoles(persona(["before", "after"])), ["before", "after"]);
  assert.deepEqual(identityDestinationRoles(persona(["before"])), ["before", "after"]);
});

test("generated references are recognized per identity and destination", () => {
  const identity = persona(["before", "after"]);
  identity.assets[0].sourceAssetId = "generated-image";
  assert.equal(identityHasGeneratedAsset(identity, "before", "generated-image"), true);
  assert.equal(identityHasGeneratedAsset(identity, "after", "generated-image"), false);
  assert.equal(identityHasGeneratedAsset(identity, "before", "another-image"), false);
});
