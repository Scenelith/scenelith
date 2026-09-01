import Link from "next/link";
import { Circle } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import styles from "./MarketingChrome.module.css";

type MarketingFooterProps = {
  authenticated?: boolean;
  marketingSite?: boolean;
};

export default function MarketingFooter({ authenticated = false, marketingSite = false }: MarketingFooterProps) {
  const siteHref = (path: string) => marketingSite ? path : `https://scenelith.com${path}`;
  const primaryHref = authenticated ? "/canvas" : marketingSite ? "/login?mode=register" : "/login";
  const footerGroups = [
    { title: "Product", links: [["Canvas", "/canvas"], ["MCP", "/mcp"], ["Pricing", siteHref("/pricing")], ["Affiliate program", siteHref("/affiliates")]] },
    { title: "Resources", links: [["Documentation", "https://docs.scenelith.com"], ["Connected agents", "/settings/mcp"], ["GitHub", "https://github.com/Scenelith/scenelith"]] },
    { title: "Company", links: [["Pricing", siteHref("/pricing")], ["Affiliates", siteHref("/affiliates")], ["Contact", "mailto:support@scenelith.com"]] },
    { title: "Legal", links: [["Privacy", siteHref("/privacy")], ["Terms", siteHref("/terms")]] },
  ] as const;

  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerMain}>
          <section className={styles.footerBrand}>
            <Link className={styles.wordmark} href={marketingSite ? "/" : "/canvas"}>
              <BrandMark /><span>SCENELITH</span>
            </Link>
            <p>A connected canvas for visual production. Keep references, prompts, images and motion in one workflow.</p>
            <Link className={styles.footerCta} href={primaryHref}>{authenticated ? "Return to canvas" : "Build your first workflow"}</Link>
          </section>

          <div className={styles.footerLinks}>
            {footerGroups.map((group) => (
              <section key={group.title}>
                <h2>{group.title}</h2>
                <ul>{group.links.map(([label, href]) => <li key={label}><a href={href}>{label}</a></li>)}</ul>
              </section>
            ))}
          </div>
        </div>

        <div className={styles.footerMeta}>
          <span>© {new Date().getFullYear()} SCENELITH</span>
          <span className={styles.footerStatus}><Circle size={8} fill="currentColor" /> Systems operational</span>
          <span>VISUAL WORKFLOWS · REMOTE</span>
        </div>
      </div>
      <div className={styles.footerSignal} aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
    </footer>
  );
}
