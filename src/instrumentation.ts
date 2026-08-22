export async function register() {
  // Background work runs in the dedicated worker service. Web replicas only
  // validate requests and commit durable queue rows to PostgreSQL.
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.FRAMEFLOW_BUILD === "1") return;
}
