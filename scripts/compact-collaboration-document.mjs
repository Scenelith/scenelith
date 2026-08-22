const projectId = String(process.argv[2] || "").trim();
if (!projectId) throw new Error("Usage: npm run collaboration:compact -- <project-id>");

const baseUrl = process.env.COLLABORATION_INTERNAL_URL || "http://127.0.0.1:1234";
const secret = process.env.COLLABORATION_INTERNAL_SECRET;
if (!secret) throw new Error("COLLABORATION_INTERNAL_SECRET is required");

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/internal/documents/${encodeURIComponent(projectId)}/compact`, {
  method: "POST",
  headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
  body: "{}",
  signal: AbortSignal.timeout(60_000),
});
const body = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(String(body.error || `Checkpoint failed (${response.status})`));
console.log(JSON.stringify({ projectId, revision: body.revision, epoch: body.epoch, stateBytes: body.stateBytes, graphBytes: body.graphBytes }));
