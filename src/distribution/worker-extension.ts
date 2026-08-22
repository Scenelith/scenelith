/**
 * A distribution may attach one private queue to the shared worker lifecycle.
 * The public runtime has no additional queue.
 */
export const distributionWorker = {
  enabled(_role: string) {
    return false;
  },
  heartbeatRole: "distribution",
  async drain() {},
  async cleanup(_before: string) {},
};
