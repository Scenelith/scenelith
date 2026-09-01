import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Boxes,
  Cable,
  Image as ImageIcon,
  LockKeyhole,
  Network,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import MarketingHeader from "@/components/marketing/MarketingHeader";
import { baseUrl, getCurrentUser } from "@/lib/auth";
import { CopyMcpUrl } from "./CopyMcpUrl";
import styles from "./mcp.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MCP — Connect AI agents to Scenelith",
  description: "Connect compatible AI agents to Scenelith Canvas, Library, identities and Automations through one OAuth-secured MCP endpoint.",
};

export default async function McpPage() {
  const endpoint = new URL("/api/mcp", baseUrl()).toString();
  const authenticated = Boolean(await getCurrentUser());

  return (
    <div className={styles.page}>
      <MarketingHeader active="MCP" authenticated={authenticated} />

      <main>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}><Bot size={14} />SCENELITH MCP</span>
            <h1>Put your AI agent on the canvas.</h1>
            <p>
              One secure link gives compatible agents a place inside Scenelith — across canvases,
              identities, the asset library and automations. You choose what each connection can see and do.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href="#connect">Connect an agent <ArrowRight size={16} /></a>
              <a className={styles.secondaryAction} href="#capabilities">Explore capabilities</a>
            </div>
          </div>

          <div className={styles.connectionPanel} id="connect">
            <div className={styles.panelHeader}>
              <span><Cable size={14} />MCP CONNECTION</span>
              <span className={styles.liveState}><i />READY</span>
            </div>
            <div className={styles.endpoint}>
              <span>SERVER URL</span>
              <code>{endpoint}</code>
              <CopyMcpUrl value={endpoint} />
            </div>
            <ol className={styles.steps}>
              <li><span>01</span><div><strong>Add the link</strong><p>Paste it into your agent&apos;s MCP connection screen.</p></div></li>
              <li><span>02</span><div><strong>Approve access</strong><p>Scenelith opens in your browser. Sign in and choose the allowed resources.</p></div></li>
              <li><span>03</span><div><strong>Start building</strong><p>Return to the agent. No API key or manual token is needed.</p></div></li>
            </ol>
            <div className={styles.panelFoot}><LockKeyhole size={13} />OAuth 2.1 · scoped permissions · revocable access</div>
          </div>
        </section>

        <section className={styles.capabilityStrip} aria-label="MCP connection capabilities">
          <span><Network size={15} />CANVAS</span><i />
          <span><ImageIcon size={15} />LIBRARY</span><i />
          <span><Boxes size={15} />IDENTITIES</span><i />
          <span><Workflow size={15} />AUTOMATIONS</span>
        </section>

        <section className={styles.capabilities} id="capabilities">
          <header className={styles.sectionHeading}>
            <div><span>01 / CAPABILITIES</span><h2>Your creative system, available as tools.</h2></div>
            <p>Agents work with the same connected objects you use manually. They can inspect context first, make precise changes and keep results attached to the right workflow.</p>
          </header>

          <div className={styles.featureGrid}>
            <article>
              <span className={styles.featureNumber}>01</span><Network size={25} />
              <h3>Canvas</h3><p>Read complete graphs and safely patch nodes or edges without overwriting newer edits.</p><small>READ · CREATE · CONNECT · UPDATE</small>
            </article>
            <article>
              <span className={styles.featureNumber}>02</span><ImageIcon size={25} />
              <h3>Library &amp; identities</h3><p>Find uploaded or generated media, inspect references and place reusable identities into a workflow.</p><small>FIND · INSPECT · REUSE</small>
            </article>
            <article>
              <span className={styles.featureNumber}>03</span><Workflow size={25} />
              <h3>Automation</h3><p>Inspect, create, publish, run and stop workflows with separate permissions for editing and execution.</p><small>BUILD · PUBLISH · RUN · STOP</small>
            </article>
            <article>
              <span className={styles.featureNumber}>04</span><Boxes size={25} />
              <h3>Resource isolation</h3><p>Grant one workspace, choose specific canvases and enable or withhold Library access separately.</p><small>WORKSPACE · PROJECT · SCOPE</small>
            </article>
          </div>
        </section>

        <section className={styles.controlSection}>
          <div className={styles.controlCopy}>
            <span>02 / ACCESS</span><h2>Useful power.<br />Exact boundaries.</h2>
            <p>Every connection uses browser-based authorization. The agent receives only the capabilities and resources you approve, and you can remove that access from Scenelith at any time.</p>
            <Link href="/settings/mcp">Manage connected agents <ArrowRight size={15} /></Link>
          </div>

          <div className={styles.accessMap} aria-label="Agent access flow">
            <div className={styles.accessNode}>
              <Bot size={21} /><span><small>COMPATIBLE CLIENT</small><strong>Your AI agent</strong></span><em>REQUESTS ACCESS</em>
            </div>
            <div className={styles.accessRoute}><i /><span>OAUTH 2.1</span><i /></div>
            <div className={`${styles.accessNode} ${styles.approvalNode}`}>
              <ShieldCheck size={21} /><span><small>IN YOUR BROWSER</small><strong>You approve the scope</strong></span><em>YOU STAY IN CONTROL</em>
            </div>
            <div className={styles.scopeList}>
              <span><i />Chosen workspace</span><span><i />Approved canvases</span>
              <span><i />Selected capabilities</span><span><i />Optional Library access</span>
            </div>
          </div>
        </section>

        <section className={styles.finalCta}>
          <div><span>ONE LINK. YOUR RULES.</span><h2>Connect once. Revoke anytime.</h2></div>
          <p>Give your agent the context to do real creative work without handing over unrestricted access.</p>
          <a href="#connect">Copy the MCP link <ArrowRight size={16} /></a>
        </section>
      </main>
      <MarketingFooter authenticated={authenticated} />
    </div>
  );
}
