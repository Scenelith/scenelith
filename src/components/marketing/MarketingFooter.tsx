import Link from "next/link";
import { Circle } from "lucide-react";
import BrandMark from "@/components/BrandMark";
import { editionMarketingChrome } from "@/editions/current/marketing";
import styles from "./MarketingChrome.module.css";

type MarketingFooterProps = {
  authenticated?: boolean;
};

export default function MarketingFooter({ authenticated = false }: MarketingFooterProps) {
  const primaryHref = authenticated ? "/canvas" : editionMarketingChrome.unauthenticatedPrimaryHref;

  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerMain}>
          <section className={styles.footerBrand}>
            <Link className={styles.wordmark} href={editionMarketingChrome.homeHref}>
              <BrandMark /><span>SCENELITH</span>
            </Link>
            <p>A connected canvas for visual production. Keep references, prompts, images and motion in one workflow.</p>
            <Link className={styles.footerCta} href={primaryHref}>{authenticated ? "Return to canvas" : "Build your first workflow"}</Link>
          </section>

          <div className={styles.footerLinks}>
            {editionMarketingChrome.footerGroups.map((group) => (
              <section key={group.title}>
                <h2>{group.title}</h2>
                <ul>{group.links.map((item) => <li key={item.label}><a href={item.href}>{item.label}</a></li>)}</ul>
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
