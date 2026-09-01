import Link from "next/link";
import BrandMark from "@/components/BrandMark";
import styles from "./MarketingChrome.module.css";

type MarketingHeaderProps = {
  active?: "MCP";
  authenticated?: boolean;
  marketingSite?: boolean;
};

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.75 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

export default function MarketingHeader({ active, authenticated = false, marketingSite = false }: MarketingHeaderProps) {
  const siteHref = (path: string) => marketingSite ? path : `https://scenelith.com${path}`;
  const primaryHref = authenticated ? "/canvas" : marketingSite ? "/login?mode=register" : "/login";

  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link className={styles.wordmark} href={marketingSite ? "/" : "/canvas"} aria-label="Scenelith home">
          <BrandMark title="Scenelith" />
          <span>SCENELITH</span>
        </Link>

        <nav className={styles.navigation} aria-label="Primary navigation">
          <a href={siteHref("/#product")}>Product</a>
          <a href="https://docs.scenelith.com">Models</a>
          <a href={siteHref("/pricing")}>Pricing</a>
          <a href={siteHref("/affiliates")}>Affiliates</a>
          <Link className={active === "MCP" ? styles.activeNavigation : undefined} href="/mcp">MCP</Link>
          <a href="https://docs.scenelith.com">Docs</a>
        </nav>

        <div className={styles.headerActions}>
          <a className={styles.github} href="https://github.com/Scenelith/scenelith" target="_blank" rel="noreferrer" aria-label="Scenelith on GitHub">
            <GitHubMark />
          </a>
          {!authenticated && <Link className={styles.signin} href="/login">Sign in</Link>}
          <Link className={styles.openCanvas} href={primaryHref}>{authenticated ? "Open canvas" : "Start creating"}</Link>
        </div>
      </div>
    </header>
  );
}
