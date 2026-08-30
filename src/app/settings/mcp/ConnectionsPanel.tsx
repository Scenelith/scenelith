"use client";

import { useState } from "react";
import { Bot, CircleOff, RefreshCw } from "lucide-react";

type Connection = { id: string; clientName: string; workspaceId: string | null; projectIds: string[] | null; projectNames: string[] | null; libraryAccess: boolean; scopes: string[]; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

function resourceSummary(connection: Connection) {
  if (!connection.projectNames) return connection.workspaceId ? "All canvases in one workspace" : "All accessible canvases";
  const visible = connection.projectNames.slice(0, 3).join(", ");
  const remaining = connection.projectNames.length - 3;
  return remaining > 0 ? `${visible} +${remaining} more` : visible;
}

function connectionTimestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function ConnectionsPanel({ initialConnections }: { initialConnections: Connection[] }) {
  const [connections, setConnections] = useState(initialConnections);
  const [pending, setPending] = useState("");
  const revoke = async (id: string) => {
    setPending(id);
    const response = await fetch("/api/mcp/connections", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ connectionId: id }) });
    if (response.ok) setConnections((items) => items.map((item) => item.id === id ? { ...item, revokedAt: new Date().toISOString() } : item));
    setPending("");
  };
  const active = connections.filter((connection) => !connection.revokedAt);
  return <div className="mcp-connections-list">
    {active.length ? active.map((connection) => <article key={connection.id}>
      <span className="mcp-connection-icon"><Bot size={18} /></span>
      <div><h2>{connection.clientName}</h2><p>{resourceSummary(connection)} · Library {connection.libraryAccess ? "on" : "off"}</p><small>{connection.lastUsedAt ? `Last used ${connectionTimestamp(connection.lastUsedAt)}` : `Connected ${connectionTimestamp(connection.createdAt)}`}</small></div>
      <button type="button" disabled={pending === connection.id} onClick={() => void revoke(connection.id)}>{pending === connection.id ? <RefreshCw size={14} /> : <CircleOff size={14} />}Revoke</button>
    </article>) : <div className="mcp-connections-empty"><Bot size={26} /><h2>No connected agents</h2><p>Paste your Scenelith MCP link into a compatible agent. The connection will appear here after you approve it.</p></div>}
  </div>;
}
