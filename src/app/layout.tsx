import type { Metadata } from "next";
import "./globals.css";
import "./theme.css";
import "@/distribution/extension.css";

export const metadata: Metadata = {
  title: "Scenelith — Creative Canvas",
  description: "A private node canvas for turning source content into original visual concepts.",
  icons: {
    icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
