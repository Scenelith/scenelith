import type { EditionMarketingChrome } from "@/editions/contracts/marketing";

export const editionMarketingChrome = Object.freeze({
  homeHref: "/canvas",
  unauthenticatedPrimaryHref: "/login",
  navigation: [
    { label: "Product", href: "https://scenelith.com/#product" },
    { label: "Models", href: "https://docs.scenelith.com" },
    { label: "MCP", href: "/mcp" },
    { label: "Docs", href: "https://docs.scenelith.com" },
  ],
  footerGroups: [
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
  ],
} satisfies EditionMarketingChrome);
