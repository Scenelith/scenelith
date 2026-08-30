import { redirect } from "next/navigation";
import { ArrowLeft, Link2, Sparkles } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { listMcpOAuthConnections } from "@/lib/mcp/oauth";
import { ConnectionsPanel } from "./ConnectionsPanel";
import "./settings-mcp.css";

export const dynamic = "force-dynamic";

export default async function McpSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent("/settings/mcp")}`);
  return <main className="mcp-settings-shell">
    <nav><a href="/canvas"><ArrowLeft size={14} />Canvas</a><span><Sparkles size={14} />Scenelith</span></nav>
    <header><span><Link2 size={14} />Agent access</span><h1>Connected agents</h1><p>Review AI tools you approved and revoke access instantly. You never need to create or copy an API key.</p><a href="/mcp">Get the MCP link</a></header>
    <ConnectionsPanel initialConnections={await listMcpOAuthConnections(user.id)} />
  </main>;
}
