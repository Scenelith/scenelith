import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Boxes,
  Cable,
  Circle,
  Image as ImageIcon,
  LockKeyhole,
  Network,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { editionRuntimeProfile } from "@/editions/current/runtime";
import { baseUrl } from "@/lib/auth";
import { CopyMcpUrl } from "./CopyMcpUrl";
import styles from "./mcp.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "MCP — Connect AI agents to Scenelith",
  description: "Connect compatible AI agents to Scenelith Canvas, Library, identities and Automations through one OAuth-secured MCP endpoint.",
};

type LinkItem = { label: string; href: string };
type LinkGroup = { title: string; links: LinkItem[] };

const commonNavigation: LinkItem[] = [
  { label: "Product", href: "/#product" },
  { label: "MCP", href: "/mcp" },
  { label: "Docs", href: "https://docs.scenelith.com" },
];

const cloudNavigation: LinkItem[] = [
  { label: "Product", href: "/#product" },
  { label: "Models", href: "https://docs.scenelith.com" },
  { label: "Pricing", href: "/pricing" },
  { label: "Affiliates", href: "/affiliates" },
  { label: "MCP", href: "/mcp" },
  { label: "Docs", href: "https://docs.scenelith.com" },
];

const commonFooterGroups: LinkGroup[] = [
  {
    title: "Product",
    links: [
      { label: "Canvas", href: "/canvas" },
      { label: "MCP", href: "/mcp" },
      { label: "Connected agents", href: "/settings/mcp" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "https://docs.scenelith.com" },
      { label: "GitHub", href: "https://github.com/Scenelith/scenelith" },
      { label: "Discussions", href: "https://github.com/Scenelith/scenelith/discussions" },
    ],
  },
];

const cloudFooterGroups: LinkGroup[] = [
  {
    title: "Product",
    links: [
      { label: "Canvas", href: "/canvas" },
      { label: "MCP", href: "/mcp" },
      { label: "Pricing", href: "/pricing" },
      { label: "Affiliate program", href: "/affiliates" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "https://docs.scenelith.com" },
      { label: "Connected agents", href: "/settings/mcp" },
      { label: "GitHub", href: "https://github.com/Scenelith/scenelith" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Pricing", href: "/pricing" },
      { label: "Affiliates", href: "/affiliates" },
      { label: "Contact", href: "mailto:support@scenelith.com" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

function PageLink({ item, className }: { item: LinkItem; className?: string }) {
  if (item.href.startsWith("/")) return <Link className={className} href={item.href}>{item.label}</Link>;
  return <a className={className} href={item.href}>{item.label}</a>;
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

export default function McpPage() {
  const endpoint = new URL("/api/mcp", baseUrl()).toString();
  const hasMarketingSite = editionRuntimeProfile.capabilities.marketingSite;
  const navigation = hasMarketingSite ? cloudNavigation : commonNavigation;
  const footerGroups = hasMarketingSite ? cloudFooterGroups : commonFooterGroups;
  const homeHref = hasMarketingSite ? "/" : "/canvas";
  const canvasLabel = hasMarketingSite ? "Start creating" : "Open canvas";
  const canvasHref = hasMarketingSite ? "/login?mode=register" : "/canvas";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.wordmark} href={homeHref} aria-label="Scenelith home">
            <BrandMark title="Scenelith" />
            <span>SCENELITH</span>
          </Link>

          <nav className={styles.navigation} aria-label="Primary navigation">
            {navigation.map((item) => (
              <PageLink key={item.label} item={item} className={item.href === "/mcp" ? styles.activeNavigation : undefined} />
            ))}
          </nav>

          <div className={styles.headerActions}>
            <a className={styles.github} href="https://github.com/Scenelith/scenelith" target="_blank" rel="noreferrer" aria-label="Scenelith on GitHub">
              <GitHubMark />
            </a>
            <Link className={styles.connectedLink} href="/settings/mcp">Connected agents</Link>
            <Link className={styles.openCanvas} href={canvasHref}>{canvasLabel}</Link>
          </div>
        </div>
      </header>

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

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerMain}>
            <section className={styles.footerBrand}>
              <Link className={styles.wordmark} href={homeHref}><BrandMark /><span>SCENELITH</span></Link>
              <p>A connected canvas for visual production. Keep references, prompts, images and motion in one workflow.</p>
              <Link className={styles.footerCta} href={canvasHref}>{hasMarketingSite ? "Build your first workflow" : "Return to canvas"}</Link>
            </section>
            <div className={styles.footerLinks}>
              {footerGroups.map((group) => (
                <section key={group.title}><h2>{group.title}</h2><ul>{group.links.map((item) => <li key={item.label}><PageLink item={item} /></li>)}</ul></section>
              ))}
            </div>
          </div>
          <div className={styles.footerMeta}>
            <span>© {new Date().getFullYear()} SCENELITH</span>
            <span className={styles.footerStatus}><Circle size={8} fill="currentColor" />SYSTEMS OPERATIONAL</span>
            <span>VISUAL WORKFLOWS · REMOTE</span>
          </div>
        </div>
        <div className={styles.footerSignal} aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
      </footer>
    </div>
  );
}
