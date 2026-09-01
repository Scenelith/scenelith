export type MarketingLink = Readonly<{
  label: string;
  href: string;
}>;

export type MarketingLinkGroup = Readonly<{
  title: string;
  links: readonly MarketingLink[];
}>;

export type EditionMarketingChrome = Readonly<{
  homeHref: string;
  unauthenticatedPrimaryHref: string;
  navigation: readonly MarketingLink[];
  footerGroups: readonly MarketingLinkGroup[];
}>;
