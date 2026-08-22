import type { EditionWorker } from "@/editions/contracts/worker";

export const editionWorker: EditionWorker = Object.freeze({
  enabled() { return false; },
  heartbeatRole: "edition",
  async drain() {},
  async cleanup() {},
});
