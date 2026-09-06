import assert from "node:assert/strict";
import test from "node:test";
import { assertCanvasClientVersion, CANVAS_CLIENT_VERSION } from "../collaboration/client-version.mjs";

test("pre-deploy Canvas clients and tokens cannot join the new writable document", () => {
  for (const version of [undefined, null, 1, "2", CANVAS_CLIENT_VERSION + 1]) {
    assert.throws(() => assertCanvasClientVersion(version), (error: unknown) => {
      const result = error as { code: string; status: number; message: string };
      return result.code === "CANVAS_CLIENT_OUTDATED" && result.status === 426 && result.message.includes("Refresh");
    });
  }
  assert.doesNotThrow(() => assertCanvasClientVersion(CANVAS_CLIENT_VERSION));
});
