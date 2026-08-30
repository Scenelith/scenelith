import { ArrowRight, Bot, Boxes, Image as ImageIcon, Network, ShieldCheck, Sparkles, Workflow } from "lucide-react";
import { baseUrl } from "@/lib/auth";
import { CopyMcpUrl } from "./CopyMcpUrl";
import styles from "./mcp.module.css";

export const dynamic = "force-dynamic";

export default function McpPage() {
  const endpoint = new URL("/api/mcp", baseUrl()).toString();
  return <main className={styles.shell}>
    <nav><a href="/canvas" className={styles.brand}><Sparkles size={16} />Scenelith</a><a href="/settings/mcp">Connected agents</a></nav>
    <section className={styles.hero}>
      <span className={styles.eyebrow}><Bot size={14} />Scenelith MCP</span>
      <h1>Let your AI agent work inside your creative platform.</h1>
      <p>One link connects compatible agents to canvases, identities, the asset library and automations. Scenelith opens in your browser so you can sign in and choose exactly what to allow.</p>
      <div className={styles.endpoint}><code>{endpoint}</code><CopyMcpUrl value={endpoint} /></div>
      <ol><li><span>1</span>Paste this link into your agent&apos;s MCP connection screen.</li><li><span>2</span>Your browser opens Scenelith. Sign in and press <strong>Allow access</strong>.</li><li><span>3</span>Return to the agent. No API key or manual token is needed.</li></ol>
    </section>
    <section className={styles.features}>
      <article><Network /><h2>Canvas</h2><p>Read complete graphs and safely patch nodes or edges without overwriting newer edits.</p></article>
      <article><ImageIcon /><h2>Library & identities</h2><p>Find generated and uploaded media, inspect references and create reusable identities.</p></article>
      <article><Workflow /><h2>Automation</h2><p>Inspect, create, publish, run and stop workflows with separate permissions for editing and execution.</p></article>
      <article><Boxes /><h2>Resource isolation</h2><p>Grant one workspace, choose specific canvases, and enable or withhold Library access separately.</p></article>
    </section>
    <section className={styles.security}><ShieldCheck size={23} /><div><h2>You stay in control</h2><p>Access is granted through OAuth, limited to approved canvases and capabilities, tied to this exact MCP endpoint, and revocable from Connected agents.</p></div><a href="/settings/mcp">Manage access <ArrowRight size={14} /></a></section>
  </main>;
}
